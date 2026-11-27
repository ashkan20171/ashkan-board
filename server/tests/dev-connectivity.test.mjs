import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);

test('dev launcher waits for the API before starting Vite', async () => {
  const source = await readFile(new URL('../scripts/dev.mjs', root), 'utf8');
  assert.match(source, /waitForApi/);
  assert.match(source, /probeApi/);
  assert.match(source, /api\/health\/live/);
  assert.match(source, /starting Vite/i);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /Reusing the already-running healthy API/);
});

test('frontend explains an HTTP 502 as an unreachable development API', async () => {
  const source = await readFile(new URL('../src/api/client.js', root), 'utf8');
  assert.match(source, /response\.status === 502/);
  assert.match(source, /development proxy cannot reach/);
  assert.match(source, /127\.0\.0\.1:4000/);
});

test('registration exposes a safe persistence-unavailable response', async () => {
  const source = await readFile(new URL('./app.mjs', root), 'utf8');
  assert.match(source, /PERSISTENCE_UNAVAILABLE/);
  assert.match(source, /auth\.register\.persistence_unavailable/);
});


test('vite proxy uses IPv4 loopback for the API target', async () => {
  const source = await readFile(new URL('../vite.config.js', root), 'utf8');
  assert.match(source, /target: 'http:\/\/127\.0\.0\.1:4000'/);
});
