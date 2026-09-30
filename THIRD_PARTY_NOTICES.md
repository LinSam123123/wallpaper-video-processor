# Third-party runtime components

Wallpaper Video Processor does not bundle the following runtime components in
its installer. The application displays their source, version, download size,
and license before downloading them from the upstream URL. A download only
starts after explicit user confirmation and must match the pinned SHA-256
digest in `resources/dependencies.json`.

## FFmpeg 8.0.1 essentials build

- Windows build: https://www.gyan.dev/ffmpeg/builds/
- FFmpeg project and source: https://ffmpeg.org/
- License: GPL-3.0-or-later
- Legal information: https://ffmpeg.org/legal.html

The upstream Windows archive includes its `LICENSE` and `README.txt` files.

## Real-ESRGAN ncnn Vulkan 0.2.5.0

- Release archive: https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0
- Project and source: https://github.com/xinntao/Real-ESRGAN
- License: BSD-3-Clause
- License text: https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE

The upstream release archive supplies the executable and model files used by
the application, including `realesr-animevideov3`.

## RIFE ncnn Vulkan 20221029

- Release archive: https://github.com/nihui/rife-ncnn-vulkan/releases/tag/20221029
- Project and source: https://github.com/nihui/rife-ncnn-vulkan
- License: MIT
- License text: https://github.com/nihui/rife-ncnn-vulkan/blob/master/LICENSE
- Upstream RIFE project: https://github.com/hzwer/ECCV2022-RIFE

The optional upstream Windows archive supplies `rife-ncnn-vulkan.exe`, the
same-level `rife-v4.6/flownet.bin` and `rife-v4.6/flownet.param` model files,
ncnn, and their runtime files. RIFE and the ncnn port are
not embedded in the application installer; the application downloads the
pinned archive only after explicit user confirmation.

## ncnn

- Project and source: https://github.com/Tencent/ncnn
- License: BSD-3-Clause
- License and third-party notices: https://github.com/Tencent/ncnn/blob/master/LICENSE.txt

Video2X, Topaz Video AI, and VapourSynth are not distributed or downloaded by
this project.

## Bundled interface fonts

The desktop renderer embeds selected WOFF2 subsets from Fontsource. All are
licensed under the SIL Open Font License 1.1; the license permits bundling and
embedding with this application.

- Newsreader: Copyright 2020 The Newsreader Project Authors
- Source Sans 3: Copyright 2010, 2012 Adobe Systems Incorporated
- Noto Serif SC: Copyright Google Inc.
- Noto Sans SC: Copyright Google Inc.

The complete OFL 1.1 text is included with each npm package and in the desktop
resource notices at `resources/fonts/OFL-1.1.txt`.
