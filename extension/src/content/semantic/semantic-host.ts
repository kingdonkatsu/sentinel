import { env, pipeline } from "@xenova/transformers";
import { ALL_DISTRESS_PHRASES } from "../analysers/distress-phrases";
import {
  SEMANTIC_HOST_REQUEST_TYPE,
  SEMANTIC_HOST_RESPONSE_TYPE,
  type SemanticHostRequest,
  type SemanticHostResponse,
  type SemanticHostResult,
} from "./semantic-host-bridge";

const ORT_WASM_FILENAMES = [
  "ort-wasm.wasm",
  "ort-wasm-threaded.wasm",
  "ort-wasm-simd.wasm",
  "ort-wasm-simd-threaded.wasm",
] as const;

const PHRASE_LIST_VERSION = 2;
const PHRASE_CACHE_KEY = "sentinel_phrase_embeddings_v2";

type EmbedderPipeline = {
  (
    texts: string | string[],
    options: Record<string, unknown>
  ): Promise<{ data: Float32Array; dims: number[] }>;
};

let embedder: EmbedderPipeline | null = null;
let embedderPromise: Promise<EmbedderPipeline> | null = null;
let phraseEmbeddings: Float32Array[] | null = null;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = event.data;

  if (
    event.source !== window.parent ||
    !request ||
    typeof request !== "object" ||
    (request as { type?: unknown }).type !== SEMANTIC_HOST_REQUEST_TYPE
  ) {
    return;
  }

  void handleRequest(event.origin, request as SemanticHostRequest);
});

async function handleRequest(
  targetOrigin: string,
  request: SemanticHostRequest
): Promise<void> {
  try {
    const result = await scoreTextWithTimeout(request.text, request.timeoutMs);
    postResponse(targetOrigin, {
      type: SEMANTIC_HOST_RESPONSE_TYPE,
      requestId: request.requestId,
      ok: true,
      result,
    });
  } catch (error) {
    const normalized = normalizeError(error);
    console.warn("[Sentinel] MiniLM-L6 host failed", normalized);
    postResponse(targetOrigin, {
      type: SEMANTIC_HOST_RESPONSE_TYPE,
      requestId: request.requestId,
      ok: false,
      error: normalized,
    });
  }
}

async function scoreTextWithTimeout(
  text: string,
  timeoutMs: number
): Promise<SemanticHostResult> {
  let timer: number | null = null;

  return Promise.race([
    scoreText(text),
    new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => {
        reject(new Error(`MiniLM timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  });
}

async function scoreText(text: string): Promise<SemanticHostResult> {
  const loadedEmbedder = await getEmbedder();
  const cachedPhraseEmbeddings = await getPhraseEmbeddings(loadedEmbedder);
  const output = await loadedEmbedder(text, {
    pooling: "mean",
    normalize: true,
  });
  const textEmbedding = tensorRows(output)[0];

  if (!textEmbedding) {
    throw new Error("MiniLM returned no text embedding");
  }

  return {
    maxSimilarity: maxCosineSimilarity(textEmbedding, cachedPhraseEmbeddings),
  };
}

async function getEmbedder(): Promise<EmbedderPipeline> {
  if (embedder) {
    return embedder;
  }

  if (embedderPromise) {
    return embedderPromise;
  }

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = chrome.runtime.getURL("models/");
  env.useBrowserCache = false;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.simd = false;
    env.backends.onnx.wasm.wasmPaths = Object.fromEntries(
      ORT_WASM_FILENAMES.map((fileName) => [
        fileName,
        chrome.runtime.getURL(`models/ort/${fileName}`),
      ])
    );
  }

  embedderPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
    .then((loadedPipeline) => {
      embedder = loadedPipeline as unknown as EmbedderPipeline;
      console.log("[Sentinel] MiniLM-L6 loaded");
      return embedder;
    })
    .catch((error) => {
      embedderPromise = null;
      throw error;
    });

  return embedderPromise;
}

async function getPhraseEmbeddings(
  loadedEmbedder: EmbedderPipeline
): Promise<Float32Array[]> {
  if (phraseEmbeddings) {
    return phraseEmbeddings;
  }

  const cached = await loadPhraseCache();
  if (cached) {
    phraseEmbeddings = cached;
    return cached;
  }

  const outputs = await loadedEmbedder(ALL_DISTRESS_PHRASES as unknown as string[], {
    pooling: "mean",
    normalize: true,
  });
  const embeddings = tensorRows(outputs);

  phraseEmbeddings = embeddings;
  await savePhraseCache(embeddings);
  return embeddings;
}

async function loadPhraseCache(): Promise<Float32Array[] | null> {
  try {
    const result = await chrome.storage.local.get(PHRASE_CACHE_KEY);
    const entry = result[PHRASE_CACHE_KEY] as
      | { version: number; data: number[][] }
      | undefined;
    if (!entry || entry.version !== PHRASE_LIST_VERSION) {
      return null;
    }

    return entry.data.map((item) => new Float32Array(item));
  } catch {
    return null;
  }
}

async function savePhraseCache(embeddings: Float32Array[]): Promise<void> {
  try {
    await chrome.storage.local.set({
      [PHRASE_CACHE_KEY]: {
        version: PHRASE_LIST_VERSION,
        data: embeddings.map((embedding) => Array.from(embedding)),
      },
    });
  } catch {
    // Cache failures are non-fatal.
  }
}

function maxCosineSimilarity(
  queryEmbedding: Float32Array,
  allPhraseEmbeddings: Float32Array[]
): number {
  let maxSimilarity = 0;

  for (const phraseEmbedding of allPhraseEmbeddings) {
    const similarity = cosineSimilarity(queryEmbedding, phraseEmbedding);
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }
  }

  return maxSimilarity;
}

function tensorRows(tensor: { data: Float32Array; dims: number[] }): Float32Array[] {
  const dims = Array.isArray(tensor.dims) ? tensor.dims : [];
  if (dims.length === 0) {
    return [];
  }

  if (dims.length === 1) {
    return [new Float32Array(tensor.data)];
  }

  const rowCount = dims[0] ?? 0;
  const rowSize = dims.slice(1).reduce((product, value) => product * value, 1);
  if (rowCount < 1 || rowSize < 1) {
    return [];
  }

  const rows: Float32Array[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const start = index * rowSize;
    const end = start + rowSize;
    rows.push(new Float32Array(tensor.data.slice(start, end)));
  }
  return rows;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function postResponse(targetOrigin: string, response: SemanticHostResponse): void {
  window.parent.postMessage(response, targetOrigin);
}

function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "MiniLM host failed unexpectedly";
  }
}
