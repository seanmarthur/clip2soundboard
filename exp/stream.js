// Streaming 16k mono s16le out of ffmpeg into Node. Run: node exp/stream.js
const { spawn } = require('node:child_process');
const path = require('node:path');
const FF = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg');

const FRAME_SAMPLES = 512;            // 32 ms @16k
const FRAME_BYTES = FRAME_SAMPLES * 2;

// exact args: decode -> cleanup -> loudnorm -> resample to 16k mono -> raw s16le on stdout
const STDIO_ARGS = ['-hide_banner', '-nostats', '-v', 'error',
  '-i', path.join(__dirname, 'src_speech.mp4'),
  '-af', 'highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=16000',
  '-ac', '1', '-ar', '16000', '-f', 's16le', '-c:a', 'pcm_s16le', '-'];

function streamPcm({ pauseAfter = 0, resumeAfterMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FF, STDIO_ARGS, { stdio: ['ignore', 'pipe', 'pipe'] });
    let total = 0, leftover = Buffer.alloc(0), frames = 0, ragged = 0, chunks = 0;
    let paused = false;
    p.stderr.on('data', d => process.stderr.write('[ffmpeg] ' + d)); // MUST be consumed
    p.stdout.on('data', c => {
      chunks++;
      total += c.length;
      const buf = Buffer.concat([leftover, c]);
      const whole = Math.floor(buf.length / FRAME_BYTES);
      if (buf.length % FRAME_BYTES) ragged++;              // chunk split a frame
      for (let i = 0; i < whole; i++) { /* VAD would consume buf.subarray(i*FRAME_BYTES,(i+1)*FRAME_BYTES) */ }
      frames += whole;
      leftover = buf.subarray(whole * FRAME_BYTES);
      if (!paused && pauseAfter && total >= pauseAfter) {
        paused = true;
        p.stdout.pause();                                   // backpressure: ffmpeg blocks on write()
        setTimeout(() => { p.stdout.resume(); }, resumeAfterMs);
      }
    });
    p.on('error', reject);
    p.on('close', code => resolve({ code, total, frames, ragged, chunks, leftover: leftover.length }));
  });
}

(async () => {
  const a = await streamPcm();
  console.log('PASS1 plain:', JSON.stringify(a),
    'expected_bytes=', 16000 * 2 * 10);
  const b = await streamPcm({ pauseAfter: 32 * 1024, resumeAfterMs: 300 });
  console.log('PASS2 paused 300ms after 32KiB:', JSON.stringify(b));
})();
