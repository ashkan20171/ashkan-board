import { spawn } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { verifyManifest } from './backup-lib.mjs';

const backupDir = resolve(process.env.BACKUP_PATH || '');
const targetUrl = process.env.RESTORE_DATABASE_URL;
if (!process.env.BACKUP_PATH) throw new Error('BACKUP_PATH must point to a backup directory.');
if (!targetUrl) throw new Error('RESTORE_DATABASE_URL must explicitly identify the restore target.');
if (process.env.RESTORE_CONFIRM !== 'YES') throw new Error('Restore is destructive. Set RESTORE_CONFIRM=YES after verifying the target database.');
const manifest = await verifyManifest(backupDir);
const dumpPath = join(backupDir, manifest.database || 'database.dump');

function run(command, args, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

const pgEnv = { ...process.env };
if (process.env.PG_SSL === 'true') pgEnv.PGSSLMODE = 'verify-full';
await run(process.env.PG_RESTORE_BIN || 'pg_restore', ['--list', dumpPath]);
await run(process.env.PG_RESTORE_BIN || 'pg_restore', ['--dbname', targetUrl, '--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', dumpPath], pgEnv);
if (manifest.uploadsIncluded && process.env.RESTORE_UPLOAD_DIR) {
  const uploadSource = join(backupDir, 'uploads');
  const uploadTarget = resolve(process.env.RESTORE_UPLOAD_DIR);
  if (uploadTarget === uploadSource || uploadTarget.startsWith(`${uploadSource}/`)) throw new Error('RESTORE_UPLOAD_DIR must be outside the backup directory.');
  await mkdir(dirname(uploadTarget), { recursive: true });
  await cp(uploadSource, uploadTarget, { recursive: true, force: false, errorOnExist: true });
}
process.stdout.write('Restore completed. Validate the application and uploaded files before reopening traffic.\n');
