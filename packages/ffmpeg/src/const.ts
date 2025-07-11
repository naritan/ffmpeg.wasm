export const MIME_TYPE_JAVASCRIPT = "text/javascript";
export const MIME_TYPE_WASM = "application/wasm";

export const CORE_VERSION = "0.12.10";
export const CORE_URL = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd/ffmpeg-core.js`;

export enum FFMessageType {
  LOAD = "LOAD",
  EXEC = "EXEC",
  FFPROBE = "FFPROBE",
  WRITE_FILE = "WRITE_FILE",
  READ_FILE = "READ_FILE",
  DELETE_FILE = "DELETE_FILE",
  RENAME = "RENAME",
  CREATE_DIR = "CREATE_DIR",
  LIST_DIR = "LIST_DIR",
  DELETE_DIR = "DELETE_DIR",
  ERROR = "ERROR",

  DOWNLOAD = "DOWNLOAD",
  PROGRESS = "PROGRESS",
  LOG = "LOG",
  MOUNT = "MOUNT",
  UNMOUNT = "UNMOUNT",
  
  // WebCodecs integration
  WRITE_FRAME = "WRITE_FRAME",
  READ_FRAME = "READ_FRAME",
  INIT_FILTER = "INIT_FILTER",
  PROCESS_FRAME = "PROCESS_FRAME",
  CLOSE_FILTER = "CLOSE_FILTER",
}
