#!/bin/bash
# Final assembly: frames -> 1080p30 H.264 with mixed VO + music, loudness-normalized.
#   ./assemble.sh                 full video -> tapsmith-promo.mp4 (+ repo-root copy)
#   ./assemble.sh preview 8 28    frames for 8s..28s must exist -> preview.mp4 (quick section check)
# VO offsets (adelay) follow comp.html's T timeline / BEAT: each segment starts a
# beat into its scene. Keep them, comp.html and synth-music.py in sync.
set -euo pipefail
cd "$(dirname "$0")"
DUR=120.8

# 1. audio mix (VO segments placed on the timeline + music bed), normalized
ffmpeg -y -v error \
  -i vo/seg1.mp3 -i vo/seg2a.mp3 -i vo/seg2b.mp3 -i vo/seg3.mp3 -i vo/seg4.mp3 -i vo/seg5.mp3 \
  -i vo/seg6.mp3 -i vo/seg7.mp3 -i vo/seg8.mp3 -i vo/seg9.mp3 \
  -i music.wav \
  -filter_complex "\
[0:a]adelay=600|600[a1];\
[1:a]adelay=13000|13000[a2];\
[2:a]adelay=15350|15350[a3];\
[3:a]adelay=26000|26000[a4];\
[4:a]adelay=44600|44600[a5];\
[5:a]adelay=55900|55900[a6];\
[6:a]adelay=69000|69000[a7];\
[7:a]adelay=85800|85800[a8];\
[8:a]adelay=98400|98400[a9];\
[9:a]adelay=114500|114500[a10];\
[a1][a2][a3][a4][a5][a6][a7][a8][a9][a10]amix=inputs=10:normalize=0,volume=1.0[vo];\
[10:a]volume=0.9[mus];\
[vo][mus]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]" \
  -map "[aout]" -ar 48000 -t "$DUR" mix.wav

if [ "${1:-}" = "preview" ]; then
  FROM=${2:?from seconds}; TO=${3:?to seconds}
  START=$(python3 -c "print(round($FROM*30))"); LEN=$(python3 -c "print($TO-$FROM)")
  ffmpeg -y -v error -framerate 30 -start_number "$START" -i comp-frames/f%05d.jpg \
    -ss "$FROM" -t "$LEN" -i mix.wav \
    -filter_complex "[0:v]scale=1920:1080:flags=lanczos[vout]" -map "[vout]" -map 1:a \
    -t "$LEN" -c:v libx264 -crf 20 -preset fast -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart preview.mp4
  ffprobe -v quiet -show_entries format=duration -of default=nw=1 preview.mp4
  exit 0
fi

# 2. full mux
ffmpeg -y -framerate 30 -i comp-frames/f%05d.jpg -i mix.wav \
  -filter_complex "[0:v]scale=1920:1080:flags=lanczos[vout]" \
  -map "[vout]" -map 1:a \
  -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -profile:v high -movflags +faststart \
  -c:a aac -b:a 192k -ar 48000 \
  -t "$DUR" \
  tapsmith-promo.mp4

ffprobe -v quiet -show_entries format=duration,size -of default=nw=1 tapsmith-promo.mp4
# keep the repo-root copy (the one that gets shared) in sync
cp tapsmith-promo.mp4 ../../tapsmith-promo.mp4
