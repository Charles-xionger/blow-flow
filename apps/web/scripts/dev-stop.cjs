// Find existing instances too, including workers left behind by an old dev:all.
const { execFileSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const root = realpathSync(path.join(__dirname, '..'));

function findTargets() {
  const cwdPids = new Set(execFileSync('lsof', ['-nP', '-a', '-d', 'cwd', '-t', root], {
    encoding: 'utf8',
  }).trim().split(/\s+/).map(Number));
  const rows = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim().split('\n');
  const targets = new Set();
  const children = new Map();
  for (const row of rows) {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pidText, parentText, command] = match;
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
    if (!cwdPids.has(pid) || !/^(?:\S*\/)?node\s/.test(command)) continue;
    const isWorkerOrLauncher = /\s(?:\.\/)?scripts\/(?:dev-all\.cjs|generation-worker\.cjs|(?:agent|script)-worker\.ts)$/.test(command);
    const isDevServer = /\s(?:\S*\/)?next\s+dev(?:\s|$)/.test(command);
    if (isWorkerOrLauncher || isDevServer) targets.add(pid);
  }
  // Set iteration includes newly added descendants such as next-server.
  for (const pid of targets) {
    for (const child of children.get(pid) ?? []) targets.add(child);
  }
  return targets;
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function stop() {
  const targets = findTargets();
  if (!targets.size) {
    console.log('No project development processes are running.');
    return;
  }
  console.log(`Stopping ${targets.size} project development processes...`);
  for (const pid of targets) signal(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 60; attempt++) {
    // A zombie has already exited even if its parent has not reaped it yet.
    const states = execFileSync('ps', ['-ax', '-o', 'pid=,stat='], { encoding: 'utf8' });
    const live = new Set(states.trim().split('\n').flatMap(row => {
      const [pid, state] = row.trim().split(/\s+/);
      return state.startsWith('Z') ? [] : [Number(pid)];
    }));
    for (const pid of targets) {
      if (!live.has(pid)) targets.delete(pid);
    }
    if (!targets.size) {
      console.log('Development processes stopped.');
      return;
    }
    if (attempt === 50) {
      for (const pid of targets) signal(pid, 'SIGKILL');
    }
    await delay(200);
  }
  throw new Error(`Processes still running: ${[...targets].join(', ')}`);
}

stop().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
