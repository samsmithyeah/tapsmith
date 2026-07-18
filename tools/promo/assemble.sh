#!/bin/bash
# Final assembly: frames -> 1080p30 H.264 with mixed VO + music, loudness-normalized.
set -euo pipefail
cd "$(dirname "$0")"

ffmpeg -y -framerate 30 -i comp-frames/f%05d.jpg \
  -i vo/seg1.mp3 -i vo/seg2.mp3 -i vo/seg3.mp3 -i vo/seg4.mp3 -i vo/seg5.mp3 -i vo/seg6.mp3 \
  -i music.wav \
  -filter_complex "\
[1:a]adelay=5400|5400[a1];\
[2:a]adelay=14200|14200[a2];\
[3:a]adelay=24600|24600[a3];\
[4:a]adelay=47200|47200[a4];\
[5:a]adelay=63900|63900[a5];\
[6:a]adelay=73800|73800[a6];\
[a1][a2][a3][a4][a5][a6]amix=inputs=6:normalize=0,volume=1.0[vo];\
[7:a]volume=0.9[mus];\
[vo][mus]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout];\
[0:v]scale=1920:1080:flags=lanczos[vout]" \
  -map "[vout]" -map "[aout]" \
  -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -profile:v high -movflags +faststart \
  -c:a aac -b:a 192k -ar 48000 \
  -t 80.5 \
  tapsmith-promo.mp4

ffprobe -v quiet -show_entries format=duration,size -of default=nw=1 tapsmith-promo.mp4
