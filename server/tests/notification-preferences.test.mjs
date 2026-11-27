import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('..', import.meta.url);

test('phase 52 adds workspace-scoped notification preferences and delivery gating', async () => {
  const repo = await readFile(new URL('./normalized-repository.mjs', root), 'utf8');
  const app = await readFile(new URL('./app.mjs', root), 'utf8');
  const client = await readFile(new URL('../src/api/client.js', root), 'utf8');
  const migration = await readFile(new URL('./migrations/021_notification_preferences.sql', root), 'utf8');
  assert.match(migration, /workspace_notification_preferences/);
  assert.match(repo, /getNormalizedNotificationPreferences/);
  assert.match(repo, /notificationPreferenceAllows/);
  assert.match(repo, /notificationsEnabled/);
  assert.ok(app.includes('/notification-preferences'));
  assert.match(app, /021_notification_preferences\.sql/);
  assert.match(app, /requiredTables\.rows\[0\]\?\.count === 8/);
  assert.match(client, /updateNotificationPreferences/);
});
