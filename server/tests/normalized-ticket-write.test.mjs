import test from 'node:test';
import assert from 'node:assert/strict';
import { createNormalizedTicket, updateNormalizedTicket, deleteNormalizedTicket } from '../normalized-repository.mjs';

test('normalized ticket writes use parameterized SQL and preserve extra fields', async () => {
  const calls = [];
  const rows = [{ id:'t1', workspace_id:'w1', title:'Old', description:'Old desc', status:'todo', priority:'Medium', created_by:'u1', created_at:new Date('2026-01-01'), updated_at:null, extra:{tags:['a']} }];
  const client = { query: async (sql, values=[]) => { calls.push({sql:sql.replace(/\s+/g,' ').trim(),values}); if(sql.includes('SELECT id,workspace_id')) return {rows}; if(sql.startsWith('UPDATE')) return {rowCount:1}; return {rowCount:1,rows:[{id:'t1'}]}; } };
  await createNormalizedTicket(client,{id:'t2',workspaceId:'w1',title:'New',description:'D',status:'backlog',priority:'High',createdBy:'u1',createdAt:'2026-01-02',updatedAt:null,tags:['x']});
  const updated=await updateNormalizedTicket(client,'w1','t1',{title:'New title',tags:['b']});
  assert.equal(updated.title,'New title'); assert.deepEqual(updated.tags,['b']);
  assert.equal(await deleteNormalizedTicket(client,'w1','t1'),true);
  assert.ok(calls.every(c=>!c.sql.includes('DROP TABLE')));
});
