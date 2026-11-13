import { execFileSync } from 'node:child_process';
const output = execFileSync('gofmt', ['-l', 'cmd', 'internal'], { encoding: 'utf8' });
if (output.trim()) { console.error(output); process.exitCode = 1; }
