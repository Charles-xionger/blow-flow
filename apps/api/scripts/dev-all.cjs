// Local Go stack: API and background processes share one foreground lifecycle.
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const processes = [
  ['api', 'dev'],
  ['generation', 'generation:worker'],
  ['script', 'script:worker'],
  ['agent-dispatcher', 'agent:dispatcher'],
];
const width = Math.max(...processes.map(([name]) => name.length));
const running = new Set();
let stopping = false;
let exitCode = 0;

function signal(child, name) {
  try { process.kill(-child.pid, name); } catch { /* Group already gone. */ }
}

function stop(code) {
  if (stopping) {
    for (const child of running) signal(child, 'SIGKILL');
    return;
  }
  stopping = true;
  exitCode = code;
  for (const child of running) signal(child, 'SIGINT');
  setTimeout(() => { for (const child of running) signal(child, 'SIGKILL'); }, 10_000).unref();
  if (running.size === 0) process.exit(exitCode);
}

for (const [name, script] of processes) {
  const prefix = `[${name.padEnd(width)}]`;
  const child = spawn('pnpm', ['run', '--silent', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  running.add(child);
  readline.createInterface({ input: child.stdout }).on('line', line => console.log(`${prefix} ${line}`));
  readline.createInterface({ input: child.stderr }).on('line', line => console.error(`${prefix} ${line}`));
  child.on('error', error => {
    console.error(`${prefix} could not start: ${error.message}`);
    running.delete(child);
    stop(1);
  });
  child.on('close', (code, signalName) => {
    running.delete(child);
    if (!stopping) {
      console.error(`${prefix} exited (${signalName ?? `code ${code}`}); stopping Go stack`);
      stop(code || 1);
    }
    if (running.size === 0) process.exit(exitCode);
  });
}

for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => stop(0));
