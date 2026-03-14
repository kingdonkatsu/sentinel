export const OCR_HOST_REQUEST_TYPE = "sentinel:ocr-host-request";
export const OCR_HOST_RESPONSE_TYPE = "sentinel:ocr-host-response";

export interface OcrHostRequest {
  type: typeof OCR_HOST_REQUEST_TYPE;
  requestId: string;
  media: OcrHostMedia;
  timeoutMs: number;
}

export interface OcrHostResult {
  captureHeight: number;
  captureWidth: number;
  confidence: number | null;
  confidentWordCount: number;
  sourceHeight: number;
  sourceWidth: number;
  strategy: string;
  text: string;
  totalWordCount: number;
}

export type OcrHostMedia = OcrHostImageMedia | OcrHostVideoMedia;

export interface OcrHostImageMedia {
  kind: "image";
  url: string;
  maxHeight: number;
  maxWidth: number;
}

export interface OcrHostVideoMedia {
  kind: "video";
  currentTime: number;
  maxHeight: number;
  maxWidth: number;
  url: string;
}

export interface OcrHostResponse {
  type: typeof OCR_HOST_RESPONSE_TYPE;
  requestId: string;
  ok: boolean;
  error?: string;
  result?: OcrHostResult;
}
