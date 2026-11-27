import test from 'node:test';
import assert from 'node:assert/strict';
import { readStore, updateStore } from '../store.mjs';

test('normalized mode fails closed instead of reading the legacy JSONB aggregate', async () => {
  const previous = { database: process.env.DATABASE_URL, mode: process.env.PERSISTENCE_MODE };
  process.env.DATABASE_URL = 'postgres://normalized-mode-guard-test';
  process.env.PERSISTENCE_MODE = 'normalized';
  try {
    await assert.rejects(readStore(), /Legacy JSONB aggregate reads are disabled/);
  } finally {
    if (previous.database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.database;
    if (previous.mode === undefined) delete process.env.PERSISTENCE_MODE; else process.env.PERSISTENCE_MODE = previous.mode;
  }
});

test('normalized mode fails closed instead of writing the legacy JSONB aggregate', async () => {
  const previous = { database: process.env.DATABASE_URL, mode: process.env.PERSISTENCE_MODE };
  process.env.DATABASE_URL = 'postgres://normalized-mode-guard-test';
  process.env.PERSISTENCE_MODE = 'normalized';
  try {
    await assert.rejects(updateStore(() => {}), /Legacy JSONB aggregate writes are disabled/);
  } finally {
    if (previous.database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.database;
    if (previous.mode === undefined) delete process.env.PERSISTENCE_MODE; else process.env.PERSISTENCE_MODE = previous.mode;
  }
});
