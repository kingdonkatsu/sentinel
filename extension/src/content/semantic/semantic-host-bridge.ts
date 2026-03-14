export const SEMANTIC_HOST_REQUEST_TYPE = "sentinel:semantic-host-request";
export const SEMANTIC_HOST_RESPONSE_TYPE = "sentinel:semantic-host-response";

export interface SemanticHostRequest {
  type: typeof SEMANTIC_HOST_REQUEST_TYPE;
  requestId: string;
  text: string;
  timeoutMs: number;
}

export interface SemanticHostResult {
  maxSimilarity: number;
}

export interface SemanticHostResponse {
  type: typeof SEMANTIC_HOST_RESPONSE_TYPE;
  requestId: string;
  ok: boolean;
  error?: string;
  result?: SemanticHostResult;
}
