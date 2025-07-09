import type { FFmpegCoreModule } from "@ffmpeg/types";

// Emscripten runtime methods
export interface EmscriptenModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  getValue(ptr: number, type: string): any;
  setValue(ptr: number, value: any, type: string): void;
  stringToUTF8(str: string, ptr: number, maxBytesToWrite: number): void;
  lengthBytesUTF8(str: string): number;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}

// WebCodecs C functions
export interface WebCodecsFunctions {
  _write_frame(dataPtr: number, size: number, timestamp: number): number;
  _read_frame(bufferPtr: number, bufferSize: number, timestampPtr: number): number;
  _init_filter(filterPtr: number, inputWidth: number, inputHeight: number, outputWidth: number, outputHeight: number): number;
  _process_frame(inputPtr: number, inputSize: number, timestamp: number, outputPtr: number, outputSize: number): number;
  _close_filter(): void;
}

// Extended FFmpeg core module
export type FFmpegCoreModuleExtended = FFmpegCoreModule & EmscriptenModule & WebCodecsFunctions;