import { spawn } from 'node:child_process';
import process from 'node:process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(process.cwd());
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = new Map();
let shuttingDown = false;

function spawnCommand(label, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (process.platform === 'win32') {
    const script = label === 'api'
      ? resolve(projectRoot, 'server/app.mjs')
      : resolve(projectRoot, 'node_modules/vite/bin/vite.js');
    if (!existsSync(script)) throw new Error(`${label} entrypoint not found: ${script}`);
    return spawn(process.execPath, [script], {
      cwd: projectRoot,
      stdio: 'inherit',
      env,
      windowsHide: false,
    });
  }
  return spawn(npm, args, { cwd: projectRoot, stdio: 'inherit', env });
}

function start(label, args, env = {}) {
  let child;
  try {
    child = spawnCommand(label, args, env);
  } catch (error) {
    console.error(`[dev] ${label} failed to start: ${error.message}`);
    shutdown(1);
    return null;
  }
  children.set(label, child);
  console.log(`[dev] ${label} process started (pid=${child.pid ?? 'unknown'})`);
  child.once('error', (error) => {
    if (shuttingDown) return;
    console.error(`[dev] ${label} process error: ${error.code || 'SPAWN_ERROR'} ${error.message}`);
    shutdown(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(label);
    if (shuttingDown) return;
    console.error(`[dev] ${label} process exited before dev session completed (code=${code ?? 'null'}, signal=${signal ?? 'none'})`);
    shutdown(code || 1);
  });
  return child;
}

async function probeApi(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForApi(url, child) {
  const deadline = Date.now() + Number(process.env.DEV_API_STARTUP_TIMEOUT_MS || 30000);
  let lastError = 'API did not respond yet.';
  while (Date.now() < deadline) {
    if (!child || child.exitCode !== null || child.signalCode) {
      console.error('[dev] API process exited before the health endpoint became ready.');
      return false;
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        console.log(`[dev] API is healthy at ${url}`);
        return true;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  console.error(`[dev] API startup check failed after timeout: ${lastError}`);
  console.error('[dev] Check the API process output above. Verify PORT, DATABASE_URL/PERSISTENCE_MODE, migrations, and the pg driver when PostgreSQL mode is enabled.');
  return false;
}

function killChild(label, child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
  console.log(`[dev] stopping ${label} process (pid=${child.pid ?? 'unknown'})`);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [label, child] of children) killChild(label, child);
  setTimeout(() => process.exit(code), 750).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const apiPort = Number(process.env.PORT || 4000);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
  console.error(`[dev] Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}
const apiUrl = `http://127.0.0.1:${apiPort}/api/health/live`;
console.log(`[dev] Project root: ${projectRoot}`);
console.log(`[dev] Checking AshkanBoard API at ${apiUrl}`);

if (!(await probeApi(apiUrl))) {
  console.log(`[dev] No healthy API found; starting AshkanBoard API on http://127.0.0.1:${apiPort}`);
  const api = start('api', ['run', 'api'], { PORT: String(apiPort) });
  if (!(await waitForApi(apiUrl, api))) shutdown(1);
} else {
  console.log('[dev] Reusing the already-running healthy API; no second API process will be started.');
}

if (!shuttingDown) {
  console.log('[dev] API is ready; starting Vite on http://127.0.0.1:5173');
  start('vite', ['run', 'dev:client']);
}
