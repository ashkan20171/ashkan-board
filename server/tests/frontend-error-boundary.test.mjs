import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);

test('React application is wrapped in a recoverable top-level error boundary', async () => {
  const [main, boundary, styles] = await Promise.all([
    readFile(new URL('src/main.jsx', root), 'utf8'),
    readFile(new URL('src/components/AppErrorBoundary.jsx', root), 'utf8'),
    readFile(new URL('src/App.css', root), 'utf8'),
  ]);
  assert.match(main, /import AppErrorBoundary from '\.\/components\/AppErrorBoundary\.jsx'/);
  assert.match(main, /<AppErrorBoundary>[\s\S]*<App \/>[\s\S]*<\/AppErrorBoundary>/);
  assert.match(boundary, /static getDerivedStateFromError\(error\)/);
  assert.match(boundary, /componentDidCatch\(error, info\)/);
  assert.match(boundary, /handleRetry/);
  assert.match(boundary, /window\.location\.reload\(\)/);
  assert.match(boundary, /role="alert"/);
  assert.match(styles, /\.app-error-screen/);
});
