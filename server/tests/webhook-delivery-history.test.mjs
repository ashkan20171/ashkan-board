import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(new URL('..', import.meta.url).pathname);
test('phase 54 adds webhook delivery history and retrieval support', async()=>{
 const migration=await readFile(resolve(root,'migrations/023_webhook_delivery_history.sql'),'utf8');
 const app=await readFile(resolve(root,'app.mjs'),'utf8');
 const repo=await readFile(resolve(root,'normalized-repository.mjs'),'utf8');
 assert.match(migration,/workspace_webhook_deliveries/);
 assert.match(app,/webhookDeliveries|listNormalizedWebhookDeliveries/);
 assert.match(repo,/listNormalizedWebhookDeliveries/);
 assert.match(repo,/recordNormalizedWebhookDeliveryAttempt/);
});
