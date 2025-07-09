#include <libavformat/avio.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <emscripten.h>

// Frame buffer structure
typedef struct {
    uint8_t *data;
    int size;
    int64_t timestamp;
} FrameBuffer;

// Ring buffer for frames
typedef struct {
    FrameBuffer *frames;
    int capacity;
    int read_pos;
    int write_pos;
    int count;
} RingBuffer;

// Filter context
typedef struct {
    AVFilterGraph *filter_graph;
    AVFilterContext *buffersrc_ctx;
    AVFilterContext *buffersink_ctx;
    int input_width;
    int input_height;
    int output_width;
    int output_height;
} FilterContext;

static RingBuffer frame_buffer = {0};
static FilterContext filter_ctx = {0};

// JavaScript callbacks
EM_JS(int, js_read_frame, (uint8_t *buf, int buf_size), {
    if (Module.readFrame) {
        return Module.readFrame(buf, buf_size);
    }
    return -1;
});

EM_JS(int, js_write_frame, (uint8_t *buf, int size, int64_t timestamp), {
    if (Module.writeFrame) {
        return Module.writeFrame(buf, size, timestamp);
    }
    return -1;
});

// Initialize ring buffer
int init_ring_buffer(int capacity) {
    frame_buffer.frames = (FrameBuffer *)calloc(capacity, sizeof(FrameBuffer));
    if (!frame_buffer.frames) return -1;
    
    frame_buffer.capacity = capacity;
    frame_buffer.read_pos = 0;
    frame_buffer.write_pos = 0;
    frame_buffer.count = 0;
    
    return 0;
}

// Clean up ring buffer
void free_ring_buffer() {
    if (frame_buffer.frames) {
        for (int i = 0; i < frame_buffer.capacity; i++) {
            if (frame_buffer.frames[i].data) {
                free(frame_buffer.frames[i].data);
            }
        }
        free(frame_buffer.frames);
        frame_buffer.frames = NULL;
    }
}

// Write frame to buffer
EMSCRIPTEN_KEEPALIVE
int write_frame(uint8_t *data, int size, int64_t timestamp) {
    if (frame_buffer.count >= frame_buffer.capacity) {
        return -1; // Buffer full
    }
    
    FrameBuffer *frame = &frame_buffer.frames[frame_buffer.write_pos];
    
    // Free old data if exists
    if (frame->data) {
        free(frame->data);
    }
    
    // Allocate and copy new data
    frame->data = (uint8_t *)malloc(size);
    if (!frame->data) return -1;
    
    memcpy(frame->data, data, size);
    frame->size = size;
    frame->timestamp = timestamp;
    
    frame_buffer.write_pos = (frame_buffer.write_pos + 1) % frame_buffer.capacity;
    frame_buffer.count++;
    
    return 0;
}

// Read frame from buffer
EMSCRIPTEN_KEEPALIVE
int read_frame(uint8_t *buf, int buf_size, int64_t *timestamp) {
    if (frame_buffer.count == 0) {
        return -1; // Buffer empty
    }
    
    FrameBuffer *frame = &frame_buffer.frames[frame_buffer.read_pos];
    
    if (frame->size > buf_size) {
        return -1; // Buffer too small
    }
    
    memcpy(buf, frame->data, frame->size);
    *timestamp = frame->timestamp;
    
    int size = frame->size;
    
    // Free frame data
    free(frame->data);
    frame->data = NULL;
    frame->size = 0;
    
    frame_buffer.read_pos = (frame_buffer.read_pos + 1) % frame_buffer.capacity;
    frame_buffer.count--;
    
    return size;
}

// Initialize filter graph
EMSCRIPTEN_KEEPALIVE
int init_filter(const char *filter_desc, 
                int in_width, int in_height, 
                int out_width, int out_height) {
    int ret;
    char args[512];
    
    // Create filter graph
    filter_ctx.filter_graph = avfilter_graph_alloc();
    if (!filter_ctx.filter_graph) {
        return -1;
    }
    
    // Create buffer source
    const AVFilter *buffersrc = avfilter_get_by_name("buffer");
    snprintf(args, sizeof(args),
             "video_size=%dx%d:pix_fmt=%d:time_base=1/30",
             in_width, in_height, AV_PIX_FMT_YUV420P);
    
    ret = avfilter_graph_create_filter(&filter_ctx.buffersrc_ctx, buffersrc, "in",
                                       args, NULL, filter_ctx.filter_graph);
    if (ret < 0) {
        goto fail;
    }
    
    // Create buffer sink
    const AVFilter *buffersink = avfilter_get_by_name("buffersink");
    ret = avfilter_graph_create_filter(&filter_ctx.buffersink_ctx, buffersink, "out",
                                       NULL, NULL, filter_ctx.filter_graph);
    if (ret < 0) {
        goto fail;
    }
    
    // Set output pixel format
    enum AVPixelFormat pix_fmts[] = { AV_PIX_FMT_YUV420P, AV_PIX_FMT_NONE };
    ret = av_opt_set_int_list(filter_ctx.buffersink_ctx, "pix_fmts", pix_fmts,
                              AV_PIX_FMT_NONE, AV_OPT_SEARCH_CHILDREN);
    if (ret < 0) {
        goto fail;
    }
    
    // Parse filter graph
    AVFilterInOut *outputs = avfilter_inout_alloc();
    AVFilterInOut *inputs = avfilter_inout_alloc();
    
    outputs->name = av_strdup("in");
    outputs->filter_ctx = filter_ctx.buffersrc_ctx;
    outputs->pad_idx = 0;
    outputs->next = NULL;
    
    inputs->name = av_strdup("out");
    inputs->filter_ctx = filter_ctx.buffersink_ctx;
    inputs->pad_idx = 0;
    inputs->next = NULL;
    
    ret = avfilter_graph_parse_ptr(filter_ctx.filter_graph, filter_desc,
                                   &inputs, &outputs, NULL);
    if (ret < 0) {
        goto fail;
    }
    
    ret = avfilter_graph_config(filter_ctx.filter_graph, NULL);
    if (ret < 0) {
        goto fail;
    }
    
    filter_ctx.input_width = in_width;
    filter_ctx.input_height = in_height;
    filter_ctx.output_width = out_width;
    filter_ctx.output_height = out_height;
    
    // Initialize ring buffer
    init_ring_buffer(30); // Buffer for 30 frames
    
    return 0;
    
fail:
    if (filter_ctx.filter_graph) {
        avfilter_graph_free(&filter_ctx.filter_graph);
    }
    return ret;
}

// Process frame through filter
EMSCRIPTEN_KEEPALIVE
int process_frame(uint8_t *input_data, int input_size, int64_t timestamp,
                  uint8_t *output_data, int output_size) {
    AVFrame *frame = av_frame_alloc();
    AVFrame *filt_frame = av_frame_alloc();
    int ret;
    
    if (!frame || !filt_frame) {
        ret = -1;
        goto end;
    }
    
    // Setup input frame
    frame->format = AV_PIX_FMT_YUV420P;
    frame->width = filter_ctx.input_width;
    frame->height = filter_ctx.input_height;
    frame->pts = timestamp;
    
    ret = av_frame_get_buffer(frame, 32);
    if (ret < 0) {
        goto end;
    }
    
    // Copy input data to frame
    // Assuming I420 format
    int y_size = filter_ctx.input_width * filter_ctx.input_height;
    int uv_size = y_size / 4;
    
    memcpy(frame->data[0], input_data, y_size);
    memcpy(frame->data[1], input_data + y_size, uv_size);
    memcpy(frame->data[2], input_data + y_size + uv_size, uv_size);
    
    // Push frame to filter
    ret = av_buffersrc_add_frame_flags(filter_ctx.buffersrc_ctx, frame, 0);
    if (ret < 0) {
        goto end;
    }
    
    // Pull filtered frame
    ret = av_buffersink_get_frame(filter_ctx.buffersink_ctx, filt_frame);
    if (ret < 0) {
        goto end;
    }
    
    // Copy output data
    int out_y_size = filter_ctx.output_width * filter_ctx.output_height;
    int out_uv_size = out_y_size / 4;
    int total_size = out_y_size + out_uv_size * 2;
    
    if (total_size > output_size) {
        ret = -1;
        goto end;
    }
    
    memcpy(output_data, filt_frame->data[0], out_y_size);
    memcpy(output_data + out_y_size, filt_frame->data[1], out_uv_size);
    memcpy(output_data + out_y_size + out_uv_size, filt_frame->data[2], out_uv_size);
    
    ret = total_size;
    
end:
    av_frame_free(&frame);
    av_frame_free(&filt_frame);
    return ret;
}

// Close filter
EMSCRIPTEN_KEEPALIVE
void close_filter() {
    if (filter_ctx.filter_graph) {
        avfilter_graph_free(&filter_ctx.filter_graph);
        filter_ctx.filter_graph = NULL;
    }
    
    free_ring_buffer();
}

// Custom AVIO callbacks for WebCodecs integration
static int webcodec_read_packet(void *opaque, uint8_t *buf, int buf_size) {
    return js_read_frame(buf, buf_size);
}

static int webcodec_write_packet(void *opaque, uint8_t *buf, int buf_size) {
    return js_write_frame(buf, buf_size, 0);
}

// Create custom AVIO context for reading
AVIOContext *create_webcodec_read_context() {
    uint8_t *buffer = (uint8_t *)av_malloc(4096);
    if (!buffer) return NULL;
    
    AVIOContext *avio_ctx = avio_alloc_context(
        buffer, 4096, 0, NULL,
        webcodec_read_packet, NULL, NULL
    );
    
    return avio_ctx;
}

// Create custom AVIO context for writing
AVIOContext *create_webcodec_write_context() {
    uint8_t *buffer = (uint8_t *)av_malloc(4096);
    if (!buffer) return NULL;
    
    AVIOContext *avio_ctx = avio_alloc_context(
        buffer, 4096, 1, NULL,
        NULL, webcodec_write_packet, NULL
    );
    
    return avio_ctx;
}