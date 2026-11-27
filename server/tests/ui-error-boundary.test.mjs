import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('phase 76 exposes actionable, user-controlled UI error diagnostics', async () => {
  const boundary = await readFile(new URL('../../src/components/AppErrorBoundary.jsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../../src/App.css', import.meta.url), 'utf8');
  assert.match(boundary, /handleCopyReport/);
  assert.match(boundary, /navigator\.clipboard\.writeText\(report\)/);
  assert.match(boundary, /Show error details|نمایش جزئیات خطا/);
  assert.match(boundary, /not sent to a server|به سرور ارسال نمی‌شود/);
  assert.match(boundary, /role="status"/);
  assert.match(styles, /\.app-error-details/);
});
