// Web alone leaves background tasks queued; run all workers together.
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const processes = [
  ['web', 'dev'],
  ['generation', 'generation:worker'],
  ['agent', 'agent:worker'],
  ['script', 'script:worker'],
];
const width = Math.max(...processes.map(([name]) => name.length));
let stopping = false;
let exitCode = 0;
const running = new Set();
// Each child leads its own process group so a stop reaches next/tsx under the pnpm wrapper.
function signal(child, name) {
  try { process.kill(-child.pid, name); } catch { /* Group already gone. */ }
}
for (const [name, script] of processes) {
  const prefix = `[${name.padEnd(width)}]`;
  const child = spawn('pnpm', ['run', '--silent', script], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  running.add(child);
  readline.createInterface({ input: child.stdout }).on('line', line => console.log(`${prefix} ${line}`));
  readline.createInterface({ input: child.stderr }).on('line', line => console.error(`${prefix} ${line}`));
  child.on('error', error => {
    console.error(`${prefix} could not start: ${error.message}`);
    running.delete(child);
    stop(1);
  });
  // 'close' waits for output to drain. Any exit we did not ask for leaves the stack incomplete.
  child.on('close', (code, signalName) => {
    running.delete(child);
    if (!stopping) {
      console.error(`${prefix} exited (${signalName ?? `code ${code}`}); stopping all processes`);
      stop(code || 1);
    }
    if (running.size === 0) process.exit(exitCode);
  });
}
function stop(code) {
  if (stopping) {
    // Second request: stop waiting for graceful shutdown.
    for (const child of running) signal(child, 'SIGKILL');
    return;
  }
  stopping = true;
  exitCode = code;
  for (const child of running) signal(child, 'SIGINT');
  setTimeout(() => { for (const child of running) signal(child, 'SIGKILL'); }, 10_000).unref();
  if (running.size === 0) process.exit(exitCode);
}
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => stop(0));
