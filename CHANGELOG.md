# Changelog

All notable changes to Wallpaper Video Processor are documented here.

## [0.4.5] - 2026-09-30

The v0.4.5 build was accepted on 2026-07-23 and first published on GitHub on 2026-09-30.

### Added

- JobSpec v4 with explicit upscale and interpolation backend/model fields.
- Automatic AI bypass when the target does not require enlargement.
- Representative-frame tile selection, locked tile execution, and full-stage rebuild after OOM fallback.
- Cache invalidation keyed by tools, model weights, tile, detector revision, and processing revision.
- Exact duplicate hold plus diagnostic location of cadence, flash, text/particle, dissolve, and hard-cut risks.
- Recoverable cache lifecycle, cancellation recovery, full decode verification, and black/frozen output checks.

### Changed

- Standard processing is Real-ESRGAN AnimeVideo v3 with optional RIFE v4.6.
- Desktop encoding now defaults to `libx264 High / CRF 17 / slow` for quality and smaller files.
- NVIDIA NVENC remains available only as an explicit fast encoding option.

### Not included

- Experimental models, evaluation outputs, and internal benchmark artifacts are not distributed.
