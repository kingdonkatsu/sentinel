declare module "@xenova/transformers" {
  export const env: {
    allowRemoteModels?: boolean;
    localModelPath?: string;
    [key: string]: unknown;
  };

  export function pipeline(
    task: string,
    model: string
  ): Promise<(...args: any[]) => Promise<any>>;
}

declare module "@vladmandic/face-api" {
  export const nets: any;
  export class TinyFaceDetectorOptions {}
  export function detectAllFaces(...args: any[]): any;
}

declare module "@tensorflow/tfjs" {
  export type GraphModel = any;
  export type LayersModel = any;
  export function setBackend(name: string): Promise<void>;
  export function ready(): Promise<void>;
  export function loadGraphModel(url: string): Promise<any>;
}
