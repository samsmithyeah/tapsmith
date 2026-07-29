#!/bin/bash
# Final assembly: frames -> 1080p30 H.264 with mixed VO + music, loudness-normalized.
set -euo pipefail
cd "$(dirname "$0")"

ffmpeg -y -framerate 30 -i comp-frames/f%05d.jpg \
  -i vo/seg1.mp3 -i vo/seg2.mp3 -i vo/seg3.mp3 -i vo/seg4.mp3 -i vo/seg5.mp3 -i vo/seg6.mp3 -i vo/seg7.mp3 -i vo/seg8.mp3 \
  -i music.wav \
  -filter_complex "\
[1:a]adelay=600|600[a1];\
[2:a]adelay=12500|12500[a2];\
[3:a]adelay=25800|25800[a3];\
[4:a]adelay=44400|44400[a4];\
[5:a]adelay=55800|55800[a5];\
[6:a]adelay=71900|71900[a6];\
[7:a]adelay=84500|84500[a7];\
[8:a]adelay=96200|96200[a8];\
[a1][a2][a3][a4][a5][a6][a7][a8]amix=inputs=8:normalize=0,volume=1.0[vo];\
[9:a]volume=0.9[mus];\
[vo][mus]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout];\
[0:v]scale=1920:1080:flags=lanczos[vout]" \
  -map "[vout]" -map "[aout]" \
  -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -profile:v high -movflags +faststart \
  -c:a aac -b:a 192k -ar 48000 \
  -t 102.5 \
  tapsmith-promo.mp4

ffprobe -v quiet -show_entries format=duration,size -of default=nw=1 tapsmith-promo.mp4
# keep the repo-root copy (the one that gets shared) in sync
cp tapsmith-promo.mp4 ../../tapsmith-promo.mp4
