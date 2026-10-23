const { spawn } = require('node:child_process');
const FF = require('ffmpeg-static');
// Case A: stdout piped but never read (no 'data' listener) -> Node paused, kernel pipe fills
const a = spawn(FF, ['-hide_banner','-v','error','-i','exp/long_src.wav','-ac','1','-f','s16le','-'], { stdio:['ignore','pipe','ignore'] });
// Case B: both stdout and stderr piped, stdout read slowly-ish but stderr never read -> stderr fills after enough logs
const b = spawn(FF, ['-hide_banner','-v','debug','-i','exp/long_src.wav','-ac','1','-f','s16le','-'], { stdio:['ignore','pipe','pipe'] });
b.stdout.on('data', () => {}); // stdout consumed; stderr never consumed
setTimeout(() => {
  const st = p => p.exitCode===null&&p.signalCode===null ? 'RUNNING (blocked)' : 'exited '+p.exitCode;
  console.log('A stdout-unread :', st(a));
  console.log('B stderr-unread :', st(b));
  a.kill('KILL'); b.kill('KILL');
  setTimeout(()=>process.exit(0),300);
}, 3000);
