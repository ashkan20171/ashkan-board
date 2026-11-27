import { spawn } from 'node:child_process';
import { mkdir, cp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { listFiles } from './backup-lib.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const backupRoot = resolve(process.env.BACKUP_DIR || './backups');
const uploadRoot = resolve(process.env.UPLOAD_DIR || './data/uploads');
const stamp = new Date().toISOString().replaceAll(':', '-');
const target = join(backupRoot, `ashkan-${stamp}-${randomUUID().slice(0, 8)}`);

function run(command, args, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

await mkdir(backupRoot, { recursive: true, mode: 0o700 });
await mkdir(target, { recursive: false, mode: 0o700 });
try {
  const dbFile = join(target, 'database.dump');
  const pgEnv = { ...process.env };
  if (process.env.PG_SSL === 'true') pgEnv.PGSSLMODE = 'verify-full';
  await run(process.env.PG_DUMP_BIN || 'pg_dump', ['--dbname', databaseUrl, '--format=custom', '--no-owner', '--no-acl', '--file', dbFile], pgEnv);
  await run(process.env.PG_RESTORE_BIN || 'pg_restore', ['--list', dbFile]);
  const uploadExists = await import('node:fs/promises').then(({ access }) => access(uploadRoot).then(() => true).catch(() => false));
  if (uploadExists) await cp(uploadRoot, join(target, 'uploads'), { recursive: true, errorOnExist: true, force: false });
  const files = await listFiles(target);
  const manifest = { format: 'ashkanboard-backup', version: 1, createdAt: new Date().toISOString(), database: 'database.dump', uploadsIncluded: uploadExists, files };
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`Backup created: ${target}\n`);
} catch (error) {
  process.stderr.write(`Backup failed: ${error.message}\nPartial backup retained for inspection: ${target}\n`);
  process.exitCode = 1;
}
