#!/bin/bash
# Synthetic Sources used by research/ffmpeg-pipeline-experiments.md.
# Run from exp/:  ./gen-sources.sh   (regenerates every input the doc measures)
set -e
FF=../node_modules/ffmpeg-static/ffmpeg
A="aevalsrc"
# 4.5s silence + known 0.3s sine burst at t=1.000-1.300, peak -13.7 dBFS
$FF -hide_banner -f lavfi -i "aevalsrc='0.2*sin(2*PI*440*t)*between(t,1,1.3)':d=4.5:s=44100" \
  -ac 1 -c:a aac -b:a 128k -map a -ar 44100 src_burst.mp4 -y
# 10s: statement 0-5, pause 5.0-5.2, statement 5.2-8.2, white noise throughout (floor ~-36 dBFS)
$FF -hide_banner -f lavfi -i "aevalsrc='0.3*(0.6+0.4*sin(2*PI*3*t))*(0.4*sin(2*PI*220*t)+0.2*sin(2*PI*660*t)+0.1*sin(2*PI*1100*t))*between(t,0,5)+0.3*(0.6+0.4*sin(2*PI*3*t))*(0.4*sin(2*PI*220*t)+0.2*sin(2*PI*660*t)+0.1*sin(2*PI*1100*t))*between(t,5.2,8.2)':d=10:s=44100" \
  -f lavfi -i "anoisesrc=colour=white:amplitude=0.05:d=10:seed=42" \
  -filter_complex "[0:a][1:a]amix=inputs=2:normalize=0,highpass=f=60" -ac 1 -c:a aac -b:a 128k src_stmt.mp4 -y
# 10s speech-like: fundamental sweep 170->220Hz + harmonics x3/x5/x7, 4.5Hz syllable envelope
$FF -hide_banner -f lavfi -i "aevalsrc='(0.55+0.45*sin(2*PI*4.5*t))*(sin(2*PI*(170+50*t)*t)+0.6*sin(2*PI*3*(170+50*t)*t)+0.4*sin(2*PI*5*(170+50*t)*t)+0.2*sin(2*PI*7*(170+50*t)*t))':d=10:s=44100" \
  -ac 1 -c:a aac -b:a 128k src_speech.mp4 -y
# 10s onset probe: exact digital silence 0-3.000, speech-like 3.000-10
$FF -hide_banner -f lavfi -i "aevalsrc='(0.55+0.45*sin(2*PI*4.5*t))*between(t,3,10)*(sin(2*PI*170*t)+0.6*sin(2*PI*510*t)+0.4*sin(2*PI*850*t))':d=10:s=44100" \
  -ac 1 -c:a aac -b:a 128k src_onset.mp4 -y
$FF -hide_banner -i src_onset.mp4 -c:a libmp3lame -b:a 128k src_onset.mp3 -y
# burst+noise probe: known 1.000-1.300 burst over -36 dBFS noise
$FF -hide_banner -f lavfi -i "aevalsrc='0.2*sin(2*PI*440*t)*between(t,1,1.3)':d=4.5:s=44100" \
  -f lavfi -i "anoisesrc=colour=white:amplitude=0.035:d=4.5:seed=7" \
  -filter_complex "[0:a][1:a]amix=normalize=0,aresample=16000" -ac 1 -c:a pcm_s16le n_burst_raw.wav -y
# onset-over-noise probe: statement 1.000-6.000 over white noise floor (-43.8 dBFS RMS)
$FF -hide_banner -f lavfi -i "aevalsrc='0.25*sin(2*PI*400*t)*between(t,1,6)':d=7:s=16000" \
  -f lavfi -i "anoisesrc=colour=white:amplitude=0.02:d=7:seed=3" \
  -filter_complex "[0:a][1:a]amix=normalize=0" -ac 1 -c:a pcm_s16le ons_raw.wav -y
# clips the doc measures
$FF -hide_banner -ss 1.0 -t 0.3 -i src_burst.mp4 -c:a libmp3lame -b:a 128k -y clip_burst.mp3
$FF -hide_banner -t 5 -i src_stmt.mp4 -c:a libmp3lame -b:a 128k -y clip_5s.mp3
$FF -hide_banner -t 3 -i src_speech.mp4 -c:a libmp3lame -b:a 128k -y clip_3s.mp3
for d in 0.3 0.5 1 2 5; do
  $FF -hide_banner -ss 1.0 -t $d -i src_burst.mp4 -c:a libmp3lame -b:a 128k -y b_$d.mp3
done
echo "sources generated"
