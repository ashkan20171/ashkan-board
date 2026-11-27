import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

test('MainDashboard provides workspace members to TaskDialog', async () => {
  const source = await readFile(resolve(root, 'src/App.jsx'), 'utf8');
  assert.match(source, /const \[members, setMembers\] = useState\(\[\]\);/);
  assert.match(source, /api\.members\(activeWorkspace\)/);
  assert.match(source, /members=\{members\}/);
});
