import { readStore, updateStore } from './store.mjs';

function assertCompatibilityMode() {
  if (process.env.DATABASE_URL && process.env.PERSISTENCE_MODE === 'normalized') {
    throw new Error('Legacy JSONB persistence is unavailable in normalized runtime mode.');
  }
}

export async function legacyReadStore() {
  assertCompatibilityMode();
  return readStore();
}

export async function legacyUpdateStore(mutator) {
  assertCompatibilityMode();
  return updateStore(mutator);
}
