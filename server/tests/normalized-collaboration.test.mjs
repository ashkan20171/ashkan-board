import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findNormalizedTicket, listNormalizedComments, createNormalizedComment,
  deleteNormalizedComment, listNormalizedNotifications,
  markNormalizedNotificationRead, upsertNormalizedPresence,
  listNormalizedPresence, listNormalizedAttachments,
  createNormalizedAttachment, deleteNormalizedAttachment, notifyNormalizedWorkspace,
} from '../normalized-repository.mjs';

const makeClient = (handler = () => ({ rows: [], rowCount: 1 })) => {
  const calls = [];
  return { calls, query: async (sql, values = []) => { calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values }); return handler(sql, values); } };
};

test('normalized collaboration reads tickets, comments with authors, and notification inbox', async () => {
  const client = makeClient((sql) => {
    if (sql.includes('SELECT id,workspace_id,title FROM tickets')) return { rows: [{ id:'t1',workspace_id:'w1',title:'Ticket' }] };
    if (sql.includes('FROM ticket_comments c JOIN users')) return { rows: [{ id:'c1',workspace_id:'w1',ticket_id:'t1',author_id:'u1',body:'Hello',mentions:['u2'],created_at:new Date('2026-01-01'),user_id:'u1',user_email:'a@example.com',user_name:'A',user_created_at:new Date('2025-01-01') }] };
    if (sql.includes('COUNT(*)')) return { rows: [{ unread_count:1 }] };
    if (sql.includes('FROM workspace_notifications WHERE')) return { rows: [{ id:'n1',workspace_id:'w1',user_id:'u1',notification_type:'comment.created',title:'New',message:'Hello',created_at:new Date('2026-01-01'),read_at:null }] };
    return { rows: [], rowCount: 1 };
  });
  assert.equal((await findNormalizedTicket(client,'w1','t1')).title,'Ticket');
  const comments=await listNormalizedComments(client,'w1','t1');
  assert.equal(comments[0].author.name,'A');
  assert.deepEqual(comments[0].mentions,['u2']);
  const inbox=await listNormalizedNotifications(client,'w1','u1');
  assert.equal(inbox.unreadCount,1);
  assert.equal(inbox.notifications[0].type,'comment.created');
});

test('normalized comment creation writes comment, audit, and recipient notifications', async () => {
  const client=makeClient();
  const comment={id:'c1',workspaceId:'w1',ticketId:'t1',authorId:'u1',body:'Hello',mentions:['u2'],createdAt:'2026-01-01T00:00:00.000Z'};
  await createNormalizedComment(client,{comment,recipients:['u2'],auditId:'a1',ticketTitle:'Ticket',notificationFactory:(userId)=>({id:'n1',workspaceId:'w1',userId,actorId:'u1',type:'comment.created',title:'New',message:'Ticket: Hello',entityId:'t1',createdAt:comment.createdAt})});
  assert.ok(client.calls.some((c)=>c.sql.startsWith('INSERT INTO ticket_comments')));
  assert.ok(client.calls.some((c)=>c.sql.startsWith('INSERT INTO workspace_audit_logs')));
  assert.ok(client.calls.some((c)=>c.sql.startsWith('INSERT INTO workspace_notifications')));
});

test('normalized comment deletion is scoped to workspace and ticket and audits successful deletion', async () => {
  const client=makeClient((sql)=>sql.startsWith('DELETE FROM ticket_comments')?{rows:[{id:'c1'}],rowCount:1}:{rows:[],rowCount:1});
  assert.equal(await deleteNormalizedComment(client,{workspaceId:'w1',ticketId:'t1',commentId:'c1',auditId:'a1',actorId:'u1'}),true);
  assert.ok(client.calls[0].sql.includes('workspace_id=$1 AND ticket_id=$2 AND id=$3'));
  assert.ok(client.calls.some((c)=>c.sql.startsWith('INSERT INTO workspace_audit_logs')));
});

test('normalized notification read operations are recipient-scoped', async () => {
  const client=makeClient(()=>({rows:[],rowCount:3}));
  assert.equal(await markNormalizedNotificationRead(client,'w1','u1'),3);
  assert.equal(await markNormalizedNotificationRead(client,'w1','u1','n1'),true);
  assert.ok(client.calls.every((c)=>c.sql.includes('workspace_id=$1 AND user_id=$2')));
});

test('normalized presence upsert and attachment metadata CRUD use relational tables', async () => {
  const client=makeClient((sql)=>sql.startsWith('DELETE FROM ticket_attachments')?{rows:[{storage_name:'file.bin',name:'file.pdf'}],rowCount:1}:sql.includes('SELECT p.last_seen_at')?{rows:[{last_seen_at:new Date('2026-01-01'),id:'u1',email:'a@example.com',name:'A',created_at:new Date('2025-01-01') }]}:sql.includes('SELECT id,workspace_id,ticket_id,uploaded_by')?{rows:[{id:'f1',workspace_id:'w1',ticket_id:'t1',uploaded_by:'u1',name:'file.pdf',mime_type:'application/pdf',size_bytes:'42',storage_name:'file.bin',created_at:new Date('2026-01-01') }]}:{rows:[],rowCount:1});
  await upsertNormalizedPresence(client,'w1','u1',new Date('2026-01-01'));
  assert.equal((await listNormalizedPresence(client,'w1',new Date('2026-01-01T00:01:00Z'))).length,1);
  const files=await listNormalizedAttachments(client,'w1','t1');
  assert.equal(files[0].size,42);
  await createNormalizedAttachment(client,{attachment:{id:'f2',workspaceId:'w1',ticketId:'t1',uploadedBy:'u1',name:'new.pdf',mimeType:'application/pdf',size:12,storageName:'new.bin',contentSha256:'a'.repeat(64),createdAt:'2026-01-01'},auditId:'a2'});
  assert.equal((await deleteNormalizedAttachment(client,{workspaceId:'w1',ticketId:'t1',attachmentId:'f1',auditId:'a3',actorId:'u1'})).storage_name,'file.bin');
  assert.ok(client.calls.some((c)=>c.sql.includes('ON CONFLICT(workspace_id,user_id) DO UPDATE')));
  const attachmentInsert=client.calls.find((c)=>c.sql.startsWith('INSERT INTO ticket_attachments'));
  assert.ok(attachmentInsert);
  assert.equal(attachmentInsert.values[9], 'a'.repeat(64));
});


test('ticket activity fan-out inserts one notification per other workspace member', async () => {
  const client=makeClient((sql)=>sql.startsWith('SELECT user_id FROM workspace_memberships')?{rows:[{user_id:'u2'},{user_id:'u3'}],rowCount:2}:{rows:[],rowCount:1});
  const count=await notifyNormalizedWorkspace(client,{workspaceId:'w1',actorId:'u1',type:'ticket.updated',title:'Task updated',message:'Ticket',entityId:'t1'});
  assert.equal(count,2);
  assert.equal(client.calls.filter((call)=>call.sql.startsWith('INSERT INTO workspace_notifications')).length,2);
  assert.ok(client.calls[0].sql.includes('user_id<>$2'));
});
