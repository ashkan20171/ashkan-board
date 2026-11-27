import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('..', import.meta.url);
test('phase 55 adds webhook secret rotation and versioned timestamp signatures', async () => {
 const migration=await readFile(new URL('./migrations/024_webhook_secret_rotation.sql',root),'utf8');
 const repo=await readFile(new URL('./normalized-repository.mjs',root),'utf8');
 const app=await readFile(new URL('./app.mjs',root),'utf8');
 const client=await readFile(new URL('../src/api/client.js',root),'utf8');
 const ui=await readFile(new URL('../src/App.jsx',root),'utf8');
 assert.match(migration,/secret_version/); assert.match(migration,/secret_rotated_at/);
 assert.match(repo,/rotateNormalizedWebhookSecret/);
 assert.match(app,/rotate-secret/); assert.match(app,/x-ashkan-signature-version/); assert.match(app,/t=\$\{timestamp\},v1=/);
 assert.match(client,/rotateWebhookSecret/); assert.match(ui,/Rotate secret|تعویض Secret/);
});
