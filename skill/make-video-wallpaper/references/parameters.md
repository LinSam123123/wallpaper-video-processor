# Parameters and CLI Reference

Use this reference when creating a job, invoking the wrapper, parsing JSON Lines, or explaining a stable error code.

## CLI discovery

Invoke `../scripts/invoke-wallpaper-video.ps1` with each CLI token as a separate PowerShell argument. The wrapper searches in this order:

1. `WALLPAPER_VIDEO_CLI`, containing one exact CLI file path or command name and no embedded arguments.
2. The installed Windows `wallpaper-video.ps1` console launcher, with `wallpaper-video.cmd` as a compatibility fallback. The wrapper never invokes the GUI-subsystem executable directly.
3. The source checkout's `apps/cli/dist/index.js`, invoked with `node.exe`. When the checkout contains a `runtime` directory and no `--cache` argument was supplied, the wrapper uses that development cache automatically.
4. The CLI bundled inside the skill. It uses `node.exe` from `PATH` or the Codex bundled runtime.

The wrapper never downloads dependencies, modifies `PATH`, or evaluates a command string. A missing CLI or Node.js returns exit code 3 with `E_DEPENDENCY_MISSING` on stderr.

## Commands

```text
doctor [--json] [--cache PATH]
inspect --input VIDEO [--json] [--ffprobe PATH]
preview --config JOB.json [--preview-mode segment|loop-boundary] [--turn start|end] [--center SEC] [--frames N] [--output VIDEO] [--work-dir PATH] [--json]
diagnostic-preview --config JOB.json --output-dir PATH [--preview-mode segment|loop-boundary] [--turn start|end] [--center SEC] [--frames N] [--work-dir PATH] [--json]
loop-preview --config JOB.json --output-dir PATH [--frames N] [--work-dir PATH] [--json]
process --config JOB.json [--work-dir PATH] [--json]
verify --input VIDEO --expected JSON_OR_PATH [--json]
cache-status --work-dir PATH [--cache-policy POLICY] [--cache-limit-bytes N] [--json]
cache-cleanup --work-dir PATH [--cache-policy POLICY] [--cache-limit-bytes N] [--force] [--json]
cache-delete --work-dir PATH --frame-cache-key KEY [--json]
```

Every command also accepts `--ffmpeg PATH`, `--ffprobe PATH`, `--realesrgan PATH`, `--rife PATH`, and `--cache PATH`. A RIFE override points to `rife-ncnn-vulkan.exe` from the official archive; its `rife-v4.6` directory, including `flownet.bin` and `flownet.param`, must remain directly beside the executable. Processing commands accept `--work-dir PATH`, `--cache-policy cleanup-on-success|keep-24-hours|keep-all`, and `--cache-limit-bytes N`; a relative work path resolves from the caller's current directory. Use `--json` for automation. Long processing commands write compact JSON Lines: progress objects first, then the final result. Errors are serialized to stderr as `{ "code", "message", "details"? }`.

`doctor --json` reports `capabilities.jobSpecVersions: [1, 2, 3, 4]`, `capabilities.previewModes: ["segment", "loop-boundary"]`, and an `h264Nvenc` result from a real 256x256 FFmpeg encoding probe. Check these fields before generating a v4 job for an installed CLI of unknown age.

## JobSpec v4

```json
{
  "version": 4,
  "inputPath": "D:/videos/source.mp4",
  "outputPath": "D:/videos/source.wallpaper.mp4",
  "sourceRange": { "startFrame": 120, "endFrameExclusive": 600 },
  "target": { "width": 2560, "height": 1600 },
  "aspectMode": "cover",
  "focus": { "x": 0.5, "y": 0.5 },
  "loopMode": "pingpong",
  "upscale": {
    "backend": "realesrgan-ncnn-vulkan",
    "model": "realesr-animevideov3",
    "tile": 384,
    "gpuId": "auto",
    "aiScale": "auto",
    "batchSize": 64
  },
  "sourceFps": "auto",
  "interpolation": {
    "mode": "none",
    "factor": 1,
    "backend": "rife-ncnn-vulkan",
    "model": "rife-v4.6",
    "memoryMode": "auto",
    "sceneCutMode": "hold"
  },
  "encoding": {
    "codec": "h264",
    "encoder": "libx264",
    "profile": "high",
    "crf": 17,
    "preset": "slow",
    "pixelFormat": "yuv420p",
    "removeAudio": true
  }
}
```

JobSpec v4 requires `sourceRange` and explicit backend/model pairs. JobSpec v3 remains accepted with its flat `upscaleMode`, `model`, `tile`, `gpuId`, `aiScale`, and `batchSize` fields and always normalizes to the current ncnn backends. JobSpec v1 and v2 process the complete input because those schemas have no source range; v1 normalizes to interpolation off and v2 retains its interpolation settings.

- `inputPath`, `outputPath`: non-empty and different. Relative values resolve from the config file's directory. Existing incomplete output files are rejected; an already complete cached job is verified and returned as resumed. The v0.4.5 desktop selects the next available numbered final path before submission, but CLI and Core never rename or overwrite an occupied JobSpec output automatically.
- `sourceRange`: required in v3 and v4. `startFrame` is a zero-based inclusive safe integer and `endFrameExclusive` is a zero-based exclusive safe integer. The interval must contain at least one frame (`endFrameExclusive > startFrame`) and fit within the FFprobe frame count. v1/v2 reject this field. Inspection derives `video.frameRateMode` from decoded frame timestamps; ranged jobs require `constant`, while `variable` and `unknown` fail with `E_UNSUPPORTED_MEDIA`.
- `target.width`, `target.height`: even integers from 2 through 16384. Common targets are 2560x1600, 2560x1440, and 3840x2160. H.264 NVENC supports at most 4096 on either axis; larger NVENC targets fail before frame extraction with `E_ENCODER_UNSUPPORTED_RESOLUTION`.
- `aspectMode`: default to `cover` (crop-to-fill), which crops as needed to fill the display. Use `blur-background` only when preserving the complete foreground over a filled blurred copy is preferable; use `contain` to preserve all content with black padding.
- `focus.x`, `focus.y`: normalized 0..1 crop or pad focus. Use 0.5,0.5 unless the subject is off-center.
- `loopMode`: `pingpong` or `none`. Without interpolation, N source frames emit `max(1, 2N-2)` ping-pong frames. With factor k, the unique forward track has `k(N-1)+1` frames and ping-pong emits `2k(N-1)` frames for N greater than 1. For N=720, k=2, and 24 fps, expect 2876 frames at 48 fps and about 59.9167 seconds.
- `upscale.backend/model`: pair `lanczos/lanczos`, `realesrgan-ncnn-vulkan/realesr-animevideov3` for anime, or `realesrgan-ncnn-vulkan/realesrgan-x4plus` for general/live-action material.
- `upscale.tile`: 0 for automatic, or a multiple of 32 from 32 through 4096. Default 384. A representative source frame probes the fallback order and locks the first working tile before batch processing. Each attempted tile has a separate enhanced-frame directory; an unexpected later OOM deletes the failed tile's enhanced set, clears task completion, and rebuilds every requested frame with one smaller tile.
- `gpuId`: `"auto"`, or a GPU index from 0 through 31. Default `"auto"` lets Real-ESRGAN select its normal device.
- `upscale.aiScale`: `"auto"`, `2`, `3`, or `4`. Automatic mode first returns x1 and bypasses standard Real-ESRGAN when the target needs no enlargement. Otherwise it chooses the lowest supported AI scale whose remaining ordinary enlargement is no greater than 1.20. For 1136x800 to 2560x1600 `cover`, AnimeVideo v3 at 2x leaves about 1.127x Lanczos enlargement. `realesrgan-x4plus` accepts only `auto` or explicit 4x.
- `batchSize`: `32` or `64`, default `64`. This is the maximum number of frame files linked into one Real-ESRGAN input directory and processed by one child process; it is not a neural-network tensor batch size.
- `sourceFps`: `auto`, or a positive number no greater than 240. Prefer `auto` to preserve source cadence.
- `interpolation.backend/model`: pair `rife-ncnn-vulkan/rife-v4.6`. Exact consecutive duplicates and hard cuts become holds. Two-/three-frame cadence, near duplicates, flashes, gradual transitions, and high-variation text/particle regions are reported in `frameRiskAnalysis` for review without changing cadence.
- `interpolation.mode`: `none` or `rife`. RIFE runs on forward source-resolution frames before upscaling; the ping-pong reverse reuses those exact results.
- `interpolation.factor`: `1` when disabled or `2` for RIFE. Output FPS is source FPS multiplied by the factor. The first v2 implementation intentionally does not perform fractional 24-to-60 conversion.
- `interpolation.model`: legacy v1-v3 jobs are fixed to `rife-v4.6`; v4 derives the allowed model from the backend/model pair above.
- `interpolation.memoryMode`: `auto`, `standard`, or `uhd`. UHD estimates flow at reduced scale and is not a tiled 5K-memory guarantee.
- `interpolation.sceneCutMode`: fixed to `hold`; detected hard cuts use a source-frame hold instead of synthesizing a cross-scene image.
- `encoding.encoder`: `libx264` or `h264_nvenc`, default `libx264`. NVENC is an explicit fast-mode selection and requires a compatible NVIDIA driver, FFmpeg build, successful doctor probe, and a target no larger than 4096 on either axis. CLI and desktop JobSpecs do not accept `auto`. Both encoders normalize final frame metadata to square-pixel, limited-range BT.709 before encoding.
- `encoding`: v1 fixes codec `h264`, profile `high`, pixel format `yuv420p`, and `removeAudio: true`; CRF is 0..51 and preset is `medium`, `slow`, or `slower`.

## Product boundary

Wallpaper Video Processor v0.4 is a file-based wallpaper post-processor, not a video generator or ComfyUI client. LTX and Wan 2.2 workflows may generate upstream candidate videos, but this tool does not connect to ComfyUI, submit workflow graphs, or manage those models. Export a normal video file first, then inspect, select, preview, upscale/interpolate, encode, and verify it here.

## Work directory and reuse

When `--work-dir` is omitted, preview, diagnostic preview, and process use `<dirname(outputPath)>/.ai-video-wallpaper-work`. The work root holds large temporary frames, resumable job state, reusable interpolation frames, and enhanced-frame caches; `--cache` remains the separate dependency/tool cache. Reuse the exact same work root across commands.

The default cache policy is `cleanup-on-success` with a 50 GiB LRU limit. A final process cache becomes eligible only after encode, FFprobe verification, atomic output publish, active-cache release, and job-lock release. Preview, failed, and cancelled caches are recoverable for 24 hours. `keep-24-hours` retains successful caches for the same TTL; `keep-all` disables TTL but still honors the configured LRU limit. Metadata records `createdAt`, `lastAccessAt`, `sizeBytes`, `status`, `activeJobIds`, `frameCacheKey`, and `inputFingerprint`. Old unrecognized caches are marked `legacy` and never silently reused.

The v4 frame-cache key includes the processing revision, frame-risk detector revision, concrete backends/models, requested tile, actual AI scale, tool file identities, and SHA-256 summaries of active model weights. A runtime, model, tile, or detector upgrade therefore cannot reuse older enhanced/interpolated frames. If a persisted job points at an older frame-cache key, its interpolation/upscale completion sets and selected tile are reset.

Cleanup runs at desktop startup, before new tasks, and after successful tasks. It skips active/shared caches, rejects symlink or junction roots, confines paths to the work root, atomically renames selected caches to `.trash-<id>`, then recursively removes the quarantined directory. `--force` ignores TTL for inactive caches but never overrides active-job protection.

Core or desktop cancellation and cleanup operations must receive the same work root used to start the task. The wrapper exposes Ctrl+C for an active CLI process but has no standalone `cancel` or `cleanup` command.

## Preview and verification

`verify` always performs a complete FFmpeg decode with `-xerror` after FFprobe inspection. Its result includes `health.fullDecodeCompleted`, detected black/frozen segments, and catastrophic black/freeze flags. Brief transitions and short holds are reported but do not fail verification; output that is effectively black or frozen for its complete duration fails. A decode error also fails even when the container metadata is readable.

`preview` and `diagnostic-preview` support the same preview controls:

- `--preview-mode segment` is the default. `--center SEC` selects an absolute timestamp in the original source and is clamped to the v3/v4 source range. Without `--center`, ordinary `preview` uses the selected range midpoint; `diagnostic-preview` scans the complete selected range and centers all four variants on the highest-priority review risk, falling back to the midpoint when no risk is found.
- `--preview-mode loop-boundary` puts the inspected boundary at the output preview midpoint. It cannot be combined with `--center`.
- For `loopMode: pingpong`, a boundary preview accepts `--turn start|end`; omitting `--turn` defaults to `end`. `start` inspects the reverse-to-forward turn at the range head, while `end` inspects the forward-to-reverse turn at the range tail.
- For `loopMode: none`, a boundary preview inspects the direct tail-to-head seam that an external repeating player will show. Do not pass `--turn`.
- `--turn` is invalid with a segment preview and invalid for a direct seam.
- `--frames N` is an explicit positive source-frame count. When it is omitted, the CLI rounds the inspected source FPS multiplied by two, so the preview is about two seconds for 24, 25, 30, or other source rates instead of always using 48 source frames. A segment is clipped when the selected range is shorter. RIFE 2x doubles encoded FPS and output frame count while preserving approximately the same duration.

Without `--output`, `preview` writes `<job-output-base>.preview.<ext>` and refuses to replace an existing preview. The JSON result reports `previewMode`, optional `turn`, contributing `sourceRanges`, and boundary metadata when applicable.

`diagnostic-preview` creates A no-RIFE Lanczos, B no-RIFE AI 2x plus Lanczos, C no-RIFE AI 3x plus downscale, and D RIFE 2x plus AI 2x. Its final result contains each output path, elapsed milliseconds, cache bytes, actual AI scale, media properties, verification result, shared preview/boundary metadata, the full `frameRiskAnalysis`, and the optional `selectedRiskPreview` used for automatic centering.

`loop-preview` creates all three loop checks in one command: the ping-pong end turn, ping-pong start turn, and direct tail-to-head seam. It preserves the selected source range, aspect mode, focus, and source FPS, limits the long edge to 960 pixels, uses Lanczos with libx264 CRF 23, and always disables Real-ESRGAN and RIFE. The result reports the lightweight target and each named variant's loop mode, media, source ranges, centered boundary, verification result, and elapsed time. Only `--frames` is accepted as a preview selector because all boundaries are generated together.

The `--expected` value may be compact inline JSON or a JSON file path. Prefer a file to avoid shell quoting. Supported fields are `width`, `height`, `sampleAspectRatio` (`1:1`), `frameRate`, `frameCount`, `durationSeconds`, `codec` (`h264`), `pixelFormat` (`yuv420p`), `colorSpace` (`bt709`), `colorPrimaries` (`bt709`), `colorTransfer` (`bt709`), `colorRange` (`tv`), `audio` (`none` or `any`), `durationToleranceSeconds`, and `frameRateTolerance`.

## Progress and exit codes

A progress line has `{ "jobId", "phase", "current", "total", "percent", "etaMs", "message" }`. Phases are `prepare`, `inspect`, `extract`, `interpolate`, `upscale`, `sequence`, `encode`, `verify`, and `complete`.

- Exit 0: success.
- Exit 1: processing, I/O, dependency integrity, or other runtime failure.
- Exit 2: `E_INVALID_ARGUMENT` or `E_INVALID_CONFIG`.
- Exit 3: `E_DEPENDENCY_MISSING`. The `doctor` command itself exits 0 and reports readiness in its JSON `ok` field so callers can still inspect every missing tool.
- Exit 4: `E_VERIFICATION_FAILED` or checks returned `passed: false`.
- Exit 130: `E_CANCELLED` after Ctrl+C.

## Stable error codes

| Code | Meaning |
| --- | --- |
| `E_INVALID_ARGUMENT` | A CLI flag or command is missing, unexpected, or malformed. |
| `E_INVALID_CONFIG` | JobSpec or verification JSON violates a supported schema or a v3/v4 source range is invalid. |
| `E_INPUT_NOT_FOUND` | The input path does not exist. |
| `E_OUTPUT_EXISTS` | A non-resumable output or preview already exists. |
| `E_DEPENDENCY_MISSING` | A required executable or model is unavailable. |
| `E_DEPENDENCY_MANIFEST` | The fixed dependency manifest is absent or invalid. |
| `E_DOWNLOAD_FAILED` | An explicitly approved dependency download failed. |
| `E_CHECKSUM_MISMATCH` | A dependency artifact failed SHA-256 verification. |
| `E_UNSAFE_ARCHIVE` | Dependency extraction detected traversal, links, or another unsafe entry. |
| `E_PROCESS_FAILED` | FFmpeg, ffprobe, Real-ESRGAN, or a child process failed. |
| `E_MEDIA_INSPECTION_FAILED` | ffprobe could not return usable media metadata. |
| `E_UNSUPPORTED_MEDIA` | The input lacks a supported video stream or required metadata. |
| `E_ENCODER_UNSUPPORTED_RESOLUTION` | The selected encoder cannot open the requested target dimensions. |
| `E_INSUFFICIENT_SPACE` | The work or output volume lacks estimated free space. |
| `E_CANCELLED` | The user cancelled the task. |
| `E_JOB_STATE` | Cached state is invalid or does not match this job. |
| `E_VERIFICATION_FAILED` | Encoded media does not satisfy expected properties. |
| `E_IO` | A filesystem or uncategorized runtime operation failed. |
