/* Local Go launcher: reuse the monorepo's Next-style environment loading. */
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadEnvConfig } = require('@next/env');

function loadEnvironment(root, app, development, initial = process.env) {
  const shell = { ...initial };
  const repository = { ...loadEnvConfig(root, development, console, true).parsedEnv };
  const application = { ...loadEnvConfig(app, development, console, true).parsedEnv };
  return { ...repository, ...application, ...shell };
}

if (require.main === module) {
  const app = path.resolve(__dirname, '..');
  const root = path.resolve(app, '../..');
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Command required');
  const env = loadEnvironment(root, app, process.env.NODE_ENV !== 'production');
  const child = spawn(command, args, { cwd: app, env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

module.exports = { loadEnvironment };
