import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const appPath = resolve(new URL('./app.mjs', import.meta.url).pathname);
const legacyPath = resolve(new URL('./legacy-persistence.mjs', import.meta.url).pathname);
const appSource = await readFile(appPath, 'utf8');
const legacySource = await readFile(legacyPath, 'utf8');
const lines = appSource.split(/\r?\n/);

const directLegacyCalls = [];
for (let index = 0; index < lines.length; index += 1) {
  if (/\b(?:readStore|updateStore)\s*\(/.test(lines[index])) directLegacyCalls.push({ line: index + 1, code: lines[index].trim() });
}

const adapterCalls = (appSource.match(/\b(?:legacyReadStore|legacyUpdateStore)\s*\(/g) || []).length;
const routeMarkers = lines
  .map((line, index) => ({ line: index + 1, code: line.trim() }))
  .filter(({ code }) => code.includes("path === '/api/") || code.includes('const .*Route = path.match'));

const requiredSignals = [
  'normalizedPersistence()',
  "PERSISTENCE_MODE === 'normalized'",
  "import { legacyReadStore, legacyUpdateStore } from './legacy-persistence.mjs';",
];
const missingSignals = requiredSignals.filter((signal) => !appSource.includes(signal));
const normalizedGuardCount = (appSource.match(/normalizedPersistence\(\)/g) || []).length;
const adapterGuards = (legacySource.match(/assertCompatibilityMode\(\)/g) || []).length;
const directLegacyCount = directLegacyCalls.length;

const report = {
  status: missingSignals.length === 0 && normalizedGuardCount >= 10 && adapterGuards >= 2 && directLegacyCount === 0 ? 'ok' : 'failed',
  checkedAt: new Date().toISOString(),
  source: 'server/app.mjs',
  directLegacyAggregateCallCount: directLegacyCount,
  legacyCompatibilityAdapterCallCount: adapterCalls,
  legacyAggregateCalls: directLegacyCalls,
  normalizedGuardCount,
  adapterGuards,
  routeMarkerCount: routeMarkers.length,
  missingSignals,
  policy: 'Application routes are isolated from direct JSONB aggregate access. Compatibility-mode persistence is contained in a dedicated adapter and fails closed when normalized runtime is enabled.',
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== 'ok') process.exitCode = 1;
