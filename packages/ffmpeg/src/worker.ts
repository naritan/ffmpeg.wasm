/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import type { FFmpegCoreModuleFactory } from "@ffmpeg/types";
import type { FFmpegCoreModuleExtended } from "./ffmpeg-core-extended";
import type {
  FFMessageEvent,
  FFMessageLoadConfig,
  FFMessageExecData,
  FFMessageWriteFileData,
  FFMessageReadFileData,
  FFMessageDeleteFileData,
  FFMessageRenameData,
  FFMessageCreateDirData,
  FFMessageListDirData,
  FFMessageDeleteDirData,
  FFMessageMountData,
  FFMessageUnmountData,
  FFMessageWriteFrameData,
  FFMessageInitFilterData,
  FFMessageProcessFrameData,
  CallbackData,
  IsFirst,
  OK,
  ExitCode,
  FSNode,
  FileData,
} from "./types";
import { CORE_URL, FFMessageType } from "./const.js";
import {
  ERROR_UNKNOWN_MESSAGE_TYPE,
  ERROR_NOT_LOADED,
  ERROR_IMPORT_FAILURE,
} from "./errors.js";

declare global {
  interface WorkerGlobalScope {
    createFFmpegCore: FFmpegCoreModuleFactory;
  }
}

interface ImportedFFmpegCoreModuleFactory {
  default: FFmpegCoreModuleFactory;
}

let ffmpeg: FFmpegCoreModuleExtended;

const load = async ({
  coreURL: _coreURL,
  wasmURL: _wasmURL,
  workerURL: _workerURL,
}: FFMessageLoadConfig): Promise<IsFirst> => {
  const first = !ffmpeg;

  try {
    if (!_coreURL) _coreURL = CORE_URL;
    // when web worker type is `classic`.
    importScripts(_coreURL);
  } catch {
    if (!_coreURL || _coreURL === CORE_URL) _coreURL = CORE_URL.replace('/umd/', '/esm/');
    // when web worker type is `module`.
    (self as WorkerGlobalScope).createFFmpegCore = (
      (await import(
        /* @vite-ignore */ _coreURL
      )) as ImportedFFmpegCoreModuleFactory
    ).default;

    if (!(self as WorkerGlobalScope).createFFmpegCore) {
      throw ERROR_IMPORT_FAILURE;
    }
  }

  const coreURL = _coreURL;
  const wasmURL = _wasmURL ? _wasmURL : _coreURL.replace(/.js$/g, ".wasm");
  const workerURL = _workerURL
    ? _workerURL
    : _coreURL.replace(/.js$/g, ".worker.js");

  ffmpeg = await (self as WorkerGlobalScope).createFFmpegCore({
    // Fix `Overload resolution failed.` when using multi-threaded ffmpeg-core.
    // Encoded wasmURL and workerURL in the URL as a hack to fix locateFile issue.
    mainScriptUrlOrBlob: `${coreURL}#${btoa(
      JSON.stringify({ wasmURL, workerURL })
    )}`,
  }) as FFmpegCoreModuleExtended;
  ffmpeg.setLogger((data) =>
    self.postMessage({ type: FFMessageType.LOG, data })
  );
  ffmpeg.setProgress((data) =>
    self.postMessage({
      type: FFMessageType.PROGRESS,
      data,
    })
  );
  return first;
};

const exec = ({ args, timeout = -1 }: FFMessageExecData): ExitCode => {
  ffmpeg.setTimeout(timeout);
  ffmpeg.exec(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
};

const ffprobe = ({ args, timeout = -1 }: FFMessageExecData): ExitCode => {
  ffmpeg.setTimeout(timeout);
  ffmpeg.ffprobe(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
};

const writeFile = ({ path, data }: FFMessageWriteFileData): OK => {
  ffmpeg.FS.writeFile(path, data);
  return true;
};

const readFile = ({ path, encoding }: FFMessageReadFileData): FileData =>
  ffmpeg.FS.readFile(path, { encoding });

// TODO: check if deletion works.
const deleteFile = ({ path }: FFMessageDeleteFileData): OK => {
  ffmpeg.FS.unlink(path);
  return true;
};

const rename = ({ oldPath, newPath }: FFMessageRenameData): OK => {
  ffmpeg.FS.rename(oldPath, newPath);
  return true;
};

// TODO: check if creation works.
const createDir = ({ path }: FFMessageCreateDirData): OK => {
  ffmpeg.FS.mkdir(path);
  return true;
};

const listDir = ({ path }: FFMessageListDirData): FSNode[] => {
  const names = ffmpeg.FS.readdir(path);
  const nodes: FSNode[] = [];
  for (const name of names) {
    const stat = ffmpeg.FS.stat(`${path}/${name}`);
    const isDir = ffmpeg.FS.isDir(stat.mode);
    nodes.push({ name, isDir });
  }
  return nodes;
};

// TODO: check if deletion works.
const deleteDir = ({ path }: FFMessageDeleteDirData): OK => {
  ffmpeg.FS.rmdir(path);
  return true;
};

const mount = ({ fsType, options, mountPoint }: FFMessageMountData): OK => {
  const str = fsType as keyof typeof ffmpeg.FS.filesystems;
  const fs = ffmpeg.FS.filesystems[str];
  if (!fs) return false;
  ffmpeg.FS.mount(fs, options, mountPoint);
  return true;
};

const unmount = ({ mountPoint }: FFMessageUnmountData): OK => {
  ffmpeg.FS.unmount(mountPoint);
  return true;
};

// WebCodecs integration functions
let frameBuffer: Array<{ data: Uint8Array; timestamp: number }> = [];
let filterContext: any = null;

const writeFrame = ({ frameData, timestamp }: { frameData: Uint8Array; timestamp: number }): OK => {
  if (!ffmpeg) return false;
  
  // Allocate memory for frame data
  const dataPtr = ffmpeg._malloc(frameData.length);
  ffmpeg.HEAPU8.set(frameData, dataPtr);
  
  // Call C function
  const result = ffmpeg._write_frame(dataPtr, frameData.length, timestamp);
  
  // Free memory
  ffmpeg._free(dataPtr);
  
  return result === 0;
};

const readFrame = (): { frameData: Uint8Array; timestamp: number } | null => {
  if (!ffmpeg) return null;
  
  // Allocate buffer for reading frame
  const bufferSize = 1920 * 1080 * 3 / 2; // Max size for 1080p YUV420
  const bufferPtr = ffmpeg._malloc(bufferSize);
  const timestampPtr = ffmpeg._malloc(8); // int64_t
  
  // Call C function
  const size = ffmpeg._read_frame(bufferPtr, bufferSize, timestampPtr);
  
  if (size <= 0) {
    ffmpeg._free(bufferPtr);
    ffmpeg._free(timestampPtr);
    return null;
  }
  
  // Read data
  const frameData = new Uint8Array(ffmpeg.HEAPU8.buffer, bufferPtr, size);
  const timestamp = ffmpeg.getValue(timestampPtr, 'i64');
  
  // Copy data before freeing
  const result = {
    frameData: new Uint8Array(frameData),
    timestamp: timestamp
  };
  
  // Free memory
  ffmpeg._free(bufferPtr);
  ffmpeg._free(timestampPtr);
  
  return result;
};

const initFilter = ({ 
  filterGraph, 
  inputWidth, 
  inputHeight, 
  outputWidth, 
  outputHeight 
}: {
  filterGraph: string;
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
}): OK => {
  if (!ffmpeg) return false;
  
  // Convert string to C string
  const filterPtr = ffmpeg._malloc(filterGraph.length + 1);
  ffmpeg.stringToUTF8(filterGraph, filterPtr, filterGraph.length + 1);
  
  // Call C function
  const result = ffmpeg._init_filter(
    filterPtr,
    inputWidth,
    inputHeight,
    outputWidth,
    outputHeight
  );
  
  // Free memory
  ffmpeg._free(filterPtr);
  
  return result === 0;
};

const processFrame = ({ 
  frameData, 
  timestamp 
}: { 
  frameData: Uint8Array; 
  timestamp: number 
}): { frameData: Uint8Array; timestamp: number } => {
  if (!ffmpeg) throw new Error("FFmpeg not loaded");
  
  // Allocate memory for input and output
  const inputPtr = ffmpeg._malloc(frameData.length);
  const outputSize = 1920 * 1080 * 3 / 2; // Max size for output
  const outputPtr = ffmpeg._malloc(outputSize);
  
  // Copy input data
  ffmpeg.HEAPU8.set(frameData, inputPtr);
  
  // Call C function
  const resultSize = ffmpeg._process_frame(
    inputPtr,
    frameData.length,
    timestamp,
    outputPtr,
    outputSize
  );
  
  if (resultSize <= 0) {
    ffmpeg._free(inputPtr);
    ffmpeg._free(outputPtr);
    throw new Error("Frame processing failed");
  }
  
  // Read output data
  const outputData = new Uint8Array(ffmpeg.HEAPU8.buffer, outputPtr, resultSize);
  const result = {
    frameData: new Uint8Array(outputData),
    timestamp: timestamp
  };
  
  // Free memory
  ffmpeg._free(inputPtr);
  ffmpeg._free(outputPtr);
  
  return result;
};

const closeFilter = (): OK => {
  if (!ffmpeg) return false;
  
  // Call C function
  ffmpeg._close_filter();
  
  filterContext = null;
  frameBuffer = [];
  return true;
};

self.onmessage = async ({
  data: { id, type, data: _data },
}: FFMessageEvent): Promise<void> => {
  const trans = [];
  let data: CallbackData;
  try {
    if (type !== FFMessageType.LOAD && !ffmpeg) throw ERROR_NOT_LOADED; // eslint-disable-line

    switch (type) {
      case FFMessageType.LOAD:
        data = await load(_data as FFMessageLoadConfig);
        break;
      case FFMessageType.EXEC:
        data = exec(_data as FFMessageExecData);
        break;
      case FFMessageType.FFPROBE:
        data = ffprobe(_data as FFMessageExecData);
        break;
      case FFMessageType.WRITE_FILE:
        data = writeFile(_data as FFMessageWriteFileData);
        break;
      case FFMessageType.READ_FILE:
        data = readFile(_data as FFMessageReadFileData);
        break;
      case FFMessageType.DELETE_FILE:
        data = deleteFile(_data as FFMessageDeleteFileData);
        break;
      case FFMessageType.RENAME:
        data = rename(_data as FFMessageRenameData);
        break;
      case FFMessageType.CREATE_DIR:
        data = createDir(_data as FFMessageCreateDirData);
        break;
      case FFMessageType.LIST_DIR:
        data = listDir(_data as FFMessageListDirData);
        break;
      case FFMessageType.DELETE_DIR:
        data = deleteDir(_data as FFMessageDeleteDirData);
        break;
      case FFMessageType.MOUNT:
        data = mount(_data as FFMessageMountData);
        break;
      case FFMessageType.UNMOUNT:
        data = unmount(_data as FFMessageUnmountData);
        break;
      case FFMessageType.WRITE_FRAME:
        data = writeFrame(_data as any);
        break;
      case FFMessageType.READ_FRAME:
        data = readFrame();
        break;
      case FFMessageType.INIT_FILTER:
        data = initFilter(_data as any);
        break;
      case FFMessageType.PROCESS_FRAME:
        data = processFrame(_data as any);
        break;
      case FFMessageType.CLOSE_FILTER:
        data = closeFilter();
        break;
      default:
        throw ERROR_UNKNOWN_MESSAGE_TYPE;
    }
  } catch (e) {
    self.postMessage({
      id,
      type: FFMessageType.ERROR,
      data: (e as Error).toString(),
    });
    return;
  }
  if (data instanceof Uint8Array) {
    trans.push(data.buffer);
  }
  self.postMessage({ id, type, data }, trans);
};
