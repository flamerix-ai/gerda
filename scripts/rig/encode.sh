#!/usr/bin/env bash
# encode.sh — final delivery encode of a raw wf-recorder capture.
#
#   scripts/rig/encode.sh <raw.mp4> <out.mp4> [scale]
#
# The proven deliverable settings: h264 / crf 20 / preset slow / yuv420p / +faststart /
# no audio — small, web-embeddable, seek-fast. `scale` optionally resizes:
#   (omitted) keep source resolution
#   1440|1080|720   scale to that HEIGHT, width auto (even), lanczos
# Recording is best done at the target resolution (set the headless output + the
# instance options.txt overrideWidth/Height, see capture_rig.sh -R / the film skill);
# downscaling here is a fallback, never an upscale.
set -euo pipefail

RAW="${1:?usage: encode.sh <raw.mp4> <out.mp4> [1440|1080|720]}"
OUT="${2:?out.mp4 required}"
SCALE="${3:-}"
[ -f "$RAW" ] || { echo "encode.sh: no such raw file: $RAW" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "encode.sh: ffmpeg not on PATH — run under 'nix develop .#capture'" >&2; exit 1; }

VF=()
case "$SCALE" in
  "")            : ;;
  1440|1080|720) VF=(-vf "scale=-2:${SCALE}:flags=lanczos") ;;
  *)             echo "encode.sh: scale must be 1440|1080|720 (got '$SCALE')" >&2; exit 1 ;;
esac

echo "encode.sh: $RAW → $OUT ${SCALE:+(→${SCALE}p)}"
ffmpeg -y -i "$RAW" "${VF[@]}" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart -an "$OUT"
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,r_frame_rate:format=duration,size \
  -of default=noprint_wrappers=1 "$OUT"
