// Preserve repository configuration/data while allowing app-local overrides.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadEnvConfig } = require('@next/env');

function loadEnvironment(root, app, development) {
  const initial = { ...process.env };
  // @next/env caches and resets to its initial environment on forced reload.
  // Capture each layer separately, then merge: shell > app > repository.
  const repository = { ...loadEnvConfig(root, development, console, true).parsedEnv };
  const application = { ...loadEnvConfig(app, development, console, true).parsedEnv };
  Object.assign(process.env, repository, application, initial);
  process.env.DATABASE_PATH = path.resolve(root, process.env.DATABASE_PATH || 'data/canvas.db');
}

if (require.main === module) {
  const root = path.resolve(__dirname, '../../..');
  const [command, ...args] = process.argv.slice(2);
  const development = command === 'next' ? args[0] === 'dev' : process.env.NODE_ENV !== 'production';
  loadEnvironment(root, path.resolve(__dirname, '..'), development);
  const entry = { next: require.resolve('next/dist/bin/next'), tsx: require.resolve('tsx/cli') }[command];
  if (!entry && command !== 'node') throw new Error('Unsupported application command');
  const child = spawn(process.execPath, entry ? [entry, ...args] : args, { stdio: 'inherit', env: process.env });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
module.exports = { loadEnvironment };
