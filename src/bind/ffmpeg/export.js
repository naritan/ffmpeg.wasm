const EXPORTED_FUNCTIONS = [
  "_ffmpeg",
  "_abort",
  "_malloc",
  "_ffprobe",
  "_write_frame",
  "_read_frame",
  "_init_filter",
  "_process_frame",
  "_close_filter"
];

console.log(EXPORTED_FUNCTIONS.join(","));
