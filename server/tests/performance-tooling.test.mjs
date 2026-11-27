import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarizeTableStats } from '../performance-audit.mjs';

const root = new URL('..', import.meta.url);

test('performance migration adds trigram search and workspace query indexes', async () => {
  const sql = await readFile(new URL('./migrations/015_performance_indexes.sql', root), 'utf8');
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pg_trgm/i);
  assert.match(sql, /tickets_title_trgm_idx[\s\S]*gin_trgm_ops/i);
  assert.match(sql, /tickets_description_trgm_idx[\s\S]*gin_trgm_ops/i);
  assert.match(sql, /tickets_workspace_status_created_id_idx/i);
  assert.match(sql, /workspace_notifications_unread_user_created_idx[\s\S]*WHERE read_at IS NULL/i);
});

test('performance audit reports numeric table counters safely', () => {
  assert.deepEqual(summarizeTableStats([{ relname: 'tickets', n_live_tup: '120', n_dead_tup: '3', seq_scan: '9', idx_scan: '80' }]), [
    { table: 'tickets', liveRows: 120, deadRows: 3, sequentialScans: 9, indexScans: 80 },
  ]);
  assert.deepEqual(summarizeTableStats([]), []);
});

test('load smoke runner requires credentials and has bounded workload defaults', async () => {
  const source = await readFile(new URL('./ops/load-smoke.mjs', root), 'utf8');
  assert.match(source, /PERF_BASE_URL/);
  assert.match(source, /PERF_TOKEN/);
  assert.match(source, /PERF_WORKSPACE_ID/);
  assert.match(source, /Math\.min\(100, Number\.parseInt\(process\.env\.PERF_CONCURRENCY/);
  assert.match(source, /p95/);
});

test('ticket editor is lazy-loaded to split its code from the initial board bundle', async () => {
  const source = await readFile(new URL('../src/App.jsx', root), 'utf8');
  assert.match(source, /lazy\(\(\) => import\('\.\/components\/TaskDialog'\)\)/);
  assert.match(source, /<Suspense fallback=/);
});
