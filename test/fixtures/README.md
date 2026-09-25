# Test fixtures

Small real media files the FFprobe and FFmpeg tests run against. The tests
use the real binaries, so these files must be real media, not stand-ins.

| File | Content | Size | SHA-256 | Used for |
| --- | --- | --- | --- | --- |
| `sample-8s.mp4` | H.264 in MP4, 320x240, 30 fps, **8.000 s**; FFmpeg `testsrc` | 39,863 B | `494956e297e20a6c7fa8459504dc9a81fcf79efa428aae08a9cb05631f2d7552` | A readable video: accepted, and 8 frames at 1 fps |
| `audio-only.m4a` | AAC in an MP4-family container, 2.0 s sine, **no video stream** | 18,783 B | `e35a8d90e919de67a2679b629c71970b0d4950faf1e52fc896c1ecffa031a227` | The right container with nothing to extract |
| `sample-0.5s.mp4` | H.264 in MP4, 160x120, 30 fps, **0.5 s**; FFmpeg `testsrc` | 4,849 B | `9ccf00d1ca1054e16795577202f3f5369bcda04055b6d74fd4b4aee103044530` | Shorter than one second: still 1 frame at 1 fps |
| `sample-2.5s.mp4` | H.264 in MP4, 160x120, 30 fps, **2.5 s**; FFmpeg `testsrc` | 13,652 B | `258c4385bebc57ed82785ea4b600dc6dfa70ef84b8632c60e2bf93ad01c7b72d` | Not a whole number of seconds: FFmpeg 8.1.2 emits 3 frames at 1 fps |

## Provenance

`sample-8s.mp4` is a byte-for-byte copy of `fiap-x-platform/fixtures/sample-8s.mp4`;
that repository's `fixtures/README.md` records the pinned-digest command that
made it. It is copied rather than referenced so this repository's tests do not
depend on a sibling checkout.

The others were generated once in a throwaway `node:22-alpine` container with
Alpine's `ffmpeg` package (FFmpeg 8.1.2), using the same command form as the
platform fixture:

```sh
ffmpeg -v error -f lavfi -i sine=frequency=440:duration=2 -c:a aac audio-only.m4a
ffmpeg -v error -f lavfi -i testsrc=duration=0.5:size=160x120:rate=30 -c:v libx264 -pix_fmt yuv420p sample-0.5s.mp4
ffmpeg -v error -f lavfi -i testsrc=duration=2.5:size=160x120:rate=30 -c:v libx264 -pix_fmt yuv420p sample-2.5s.mp4
```

A different FFmpeg build may produce different bytes; the properties in the
table are what the tests depend on, not the checksums.
