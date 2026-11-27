import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

 test('register, authenticate, isolate workspace tickets and enforce viewer role', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ashkan-api-'));
  process.env.DATA_FILE = join(dir, 'store.json'); process.env.JWT_SECRET = 'test-secret-with-at-least-thirty-two-characters'; process.env.CORS_ORIGIN = 'http://localhost:5173';
  const { createAppServer: create } = await import(`../app.mjs?test=${Date.now()}`);
  const server = create(); await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const register = await fetch(`${base}/api/auth/register`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({name:'Test User',email:'test@example.com',password:'a-very-long-test-password'}) });
  assert.equal(register.status, 201); const session = await register.json();
  const headers = { authorization:`Bearer ${session.accessToken}`, 'content-type':'application/json' };
  const workspaceCreate = await fetch(`${base}/api/workspaces`, { method:'POST', headers, body:JSON.stringify({name:'Research', description:'Research workspace'}) });
  assert.equal(workspaceCreate.status, 201); const createdWorkspace = (await workspaceCreate.json()).workspace;
  const createTicket = await fetch(`${base}/api/workspaces/${session.workspace.id}/tickets`, { method:'POST', headers, body:JSON.stringify({title:'First task', priority:'High', tags:['api'], estimateHours:3}) });
  assert.equal(createTicket.status, 201); const created = (await createTicket.json()).ticket; assert.equal(created.estimateHours, 3); assert.deepEqual(created.tags, ['api']);
  const update = await fetch(`${base}/api/workspaces/${session.workspace.id}/tickets/${created.id}`, { method:'PATCH', headers, body:JSON.stringify({status:'in-progress', timeSpentHours:1.5}) });
  assert.equal(update.status, 200); assert.equal((await update.json()).ticket.timeSpentHours, 1.5);
  const emptyList = await fetch(`${base}/api/workspaces/${createdWorkspace.id}/tickets`, { headers }); assert.equal((await emptyList.json()).tickets.length, 0);
  const list = await fetch(`${base}/api/workspaces/${session.workspace.id}/tickets`, { headers });
  assert.equal((await list.json()).tickets.length, 1);
  const invalid = await fetch(`${base}/api/workspaces/not-owned/tickets`, { headers });
  assert.equal(invalid.status, 403);
 });

test('refresh token rotation, replay detection, password reset and server audit trail', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ashkan-security-'));
  process.env.DATA_FILE = join(dir, 'store.json'); process.env.JWT_SECRET = 'another-test-secret-with-at-least-thirty-two-characters'; process.env.CORS_ORIGIN = 'http://localhost:5173'; process.env.NODE_ENV = 'development';
  const { createAppServer: create } = await import(`../app.mjs?security-test=${Date.now()}`);
  const server = create(); await new Promise((resolve) => server.listen(0, resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const post = (path, value, token) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
  const registered = await post('/api/auth/register', { name: 'Security User', email: 'security@example.com', password: 'a-very-long-test-password' }); assert.equal(registered.status, 201); const session = await registered.json();
  const rotated = await post('/api/auth/refresh', { refreshToken: session.refreshToken }); assert.equal(rotated.status, 200); const next = await rotated.json(); assert.ok(next.accessToken); assert.notEqual(next.refreshToken, session.refreshToken);
  const replay = await post('/api/auth/refresh', { refreshToken: session.refreshToken }); assert.equal(replay.status, 401);
  const afterReplay = await post('/api/auth/refresh', { refreshToken: next.refreshToken }); assert.equal(afterReplay.status, 401);
  const forgot = await post('/api/auth/password/forgot', { email: 'security@example.com' }); const forgotPayload = await forgot.json(); assert.equal(forgot.status, 200); assert.ok(forgotPayload.developmentResetToken);
  const reset = await post('/api/auth/password/reset', { token: forgotPayload.developmentResetToken, password: 'a-different-long-password' }); assert.equal(reset.status, 200);
  const login = await post('/api/auth/login', { email: 'security@example.com', password: 'a-different-long-password' }); assert.equal(login.status, 200); const loggedIn = await login.json();
  const createTicket = await post(`/api/workspaces/${session.workspace.id}/tickets`, { title: 'Audited task' }, loggedIn.accessToken); assert.equal(createTicket.status, 201);
  const inviteeRegister = await post('/api/auth/register', { name: 'Invitee User', email: 'invitee@example.com', password: 'another-very-long-password' }); assert.equal(inviteeRegister.status, 201); const invitee = await inviteeRegister.json();
  const invitationResponse = await post(`/api/workspaces/${session.workspace.id}/invitations`, { email: 'invitee@example.com', role: 'viewer' }, loggedIn.accessToken); assert.equal(invitationResponse.status, 201); const invitation = await invitationResponse.json();
  const accept = await post('/api/invitations/accept', { token: invitation.developmentInvitationToken }, invitee.accessToken); assert.equal(accept.status, 200);
  const inviteeWorkspaces = await fetch(`${base}/api/workspaces`, { headers: { authorization: `Bearer ${invitee.accessToken}` } }); assert.equal((await inviteeWorkspaces.json()).workspaces.length, 2);
  const audit = await fetch(`${base}/api/workspaces/${session.workspace.id}/audit`, { headers: { authorization: `Bearer ${loggedIn.accessToken}` } }); assert.equal(audit.status, 200); const events = (await audit.json()).events; assert.ok(events.some((event) => event.action === 'ticket.created'));
});

test('workspace notifications and idempotent ticket import dry-run/commit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ashkan-phase13-'));
  process.env.DATA_FILE = join(dir, 'store.json'); process.env.JWT_SECRET = 'phase-thirteen-test-secret-with-32-chars'; process.env.CORS_ORIGIN = 'http://localhost:5173'; process.env.NODE_ENV = 'development';
  const { createAppServer: create } = await import(`../app.mjs?phase13=${Date.now()}`);
  const server = create(); await new Promise((resolve) => server.listen(0, resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const post = (path, value, token) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
  const ownerResponse = await post('/api/auth/register', { name: 'Owner User', email: 'owner13@example.com', password: 'phase-thirteen-password-strong' }); const owner = await ownerResponse.json();
  const memberResponse = await post('/api/auth/register', { name: 'Member User', email: 'member13@example.com', password: 'phase-thirteen-password-strong' }); const member = await memberResponse.json();
  const ownerHeaders = { authorization: `Bearer ${owner.accessToken}`, 'content-type': 'application/json' };
  const invite = await post(`/api/workspaces/${owner.workspace.id}/invitations`, { email: 'member13@example.com', role: 'member' }, owner.accessToken); const inviteData = await invite.json();
  await post('/api/invitations/accept', { token: inviteData.developmentInvitationToken }, member.accessToken);
  const created = await post(`/api/workspaces/${owner.workspace.id}/tickets`, { title: 'Notify the team' }, owner.accessToken); assert.equal(created.status, 201);
  const inbox = await fetch(`${base}/api/workspaces/${owner.workspace.id}/notifications`, { headers: { authorization: `Bearer ${member.accessToken}` } }); const inboxData = await inbox.json(); assert.equal(inboxData.unreadCount, 1); assert.equal(inboxData.notifications[0].type, 'ticket.created');
  const batch = { batchKey: 'legacy-export-001', tickets: [{ id: 'old-1', title: 'Imported issue', priority: 'High' }, { id: 'old-2', title: '' }] };
  const dryRun = await post(`/api/workspaces/${owner.workspace.id}/imports/tickets`, batch, owner.accessToken); const dry = await dryRun.json(); assert.equal(dry.valid, 1); assert.equal(dry.invalid, 1);
  const validBatch = { batchKey: 'legacy-export-002', tickets: [{ id: 'old-3', title: 'Imported issue', priority: 'High', tags: ['legacy'] }] };
  const commit = await post(`/api/workspaces/${owner.workspace.id}/imports/tickets`, { ...validBatch, mode: 'commit' }, owner.accessToken); assert.equal(commit.status, 201); assert.equal((await commit.json()).imported, 1);
  const duplicate = await post(`/api/workspaces/${owner.workspace.id}/imports/tickets`, { ...validBatch, mode: 'commit' }, owner.accessToken); assert.equal((await duplicate.json()).duplicate, true);
  const markRead = await fetch(`${base}/api/workspaces/${owner.workspace.id}/notifications/read-all`, { method: 'PATCH', headers: { authorization: `Bearer ${member.accessToken}` } }); assert.equal(markRead.status, 200);
});

test('ticket comments are workspace-scoped, mention members and update profile', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ashkan-phase15-'));
  process.env.DATA_FILE = join(dir, 'store.json'); process.env.JWT_SECRET = 'phase-fifteen-test-secret-with-32-chars'; process.env.CORS_ORIGIN = 'http://localhost:5173'; process.env.NODE_ENV = 'development';
  const { createAppServer: create } = await import(`../app.mjs?phase15=${Date.now()}`);
  const server = create(); await new Promise((resolve) => server.listen(0, resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const post = (path, value, token) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
  const owner = await (await post('/api/auth/register', { name: 'Discussion Owner', email: 'discussion-owner@example.com', password: 'phase-fifteen-password-strong' })).json();
  const member = await (await post('/api/auth/register', { name: 'Discussion Member', email: 'discussion-member@example.com', password: 'phase-fifteen-password-strong' })).json();
  const invite = await post(`/api/workspaces/${owner.workspace.id}/invitations`, { email: 'discussion-member@example.com', role: 'member' }, owner.accessToken); const invitePayload = await invite.json();
  await post('/api/invitations/accept', { token: invitePayload.developmentInvitationToken }, member.accessToken);
  const ticketResponse = await post(`/api/workspaces/${owner.workspace.id}/tickets`, { title: 'Shared discussion' }, owner.accessToken); const ticket = (await ticketResponse.json()).ticket;
  const commentResponse = await post(`/api/workspaces/${owner.workspace.id}/tickets/${ticket.id}/comments`, { body: 'Please review this change.', mentions: [member.user.id] }, owner.accessToken);
  assert.equal(commentResponse.status, 201); const comment = (await commentResponse.json()).comment; assert.equal(comment.author.name, 'Discussion Owner');
  const thread = await fetch(`${base}/api/workspaces/${owner.workspace.id}/tickets/${ticket.id}/comments`, { headers: { authorization: `Bearer ${member.accessToken}` } }); assert.equal(thread.status, 200); assert.equal((await thread.json()).comments.length, 1);
  const inbox = await fetch(`${base}/api/workspaces/${owner.workspace.id}/notifications`, { headers: { authorization: `Bearer ${member.accessToken}` } }); assert.ok((await inbox.json()).notifications.some((item) => item.type === 'comment.created'));
  const profile = await fetch(`${base}/api/auth/me`, { method: 'PATCH', headers: { authorization: `Bearer ${member.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Updated Member Name' }) }); assert.equal(profile.status, 200); assert.equal((await profile.json()).user.name, 'Updated Member Name');
  const invalid = await post(`/api/workspaces/${owner.workspace.id}/tickets/${ticket.id}/comments`, { body: ' ' }, owner.accessToken); assert.equal(invalid.status, 400);
  const removed = await fetch(`${base}/api/workspaces/${owner.workspace.id}/tickets/${ticket.id}/comments/${comment.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${owner.accessToken}` } }); assert.equal(removed.status, 204);
  const afterDelete = await fetch(`${base}/api/workspaces/${owner.workspace.id}/tickets/${ticket.id}/comments`, { headers: { authorization: `Bearer ${owner.accessToken}` } }); assert.equal((await afterDelete.json()).comments.length, 0);
});

test('live workspace events, online presence, and secure ticket attachments', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ashkan-phase16-'));
  process.env.DATA_FILE = join(dir, 'store.json'); process.env.UPLOAD_DIR = join(dir, 'uploads'); process.env.JWT_SECRET = 'phase-sixteen-test-secret-with-32-chars'; process.env.CORS_ORIGIN = 'http://localhost:5173'; process.env.NODE_ENV = 'development';
  const { createAppServer: create } = await import(`../app.mjs?phase16=${Date.now()}`);
  const server = create(); await new Promise((resolve) => server.listen(0, resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const post = (path, value, token) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
  const owner = await (await post('/api/auth/register', { name: 'Live Owner', email: 'live-owner@example.com', password: 'phase-sixteen-password-strong' })).json();
  const member = await (await post('/api/auth/register', { name: 'Live Member', email: 'live-member@example.com', password: 'phase-sixteen-password-strong' })).json();
  const invite = await post(`/api/workspaces/${owner.workspace.id}/invitations`, { email: 'live-member@example.com', role: 'member' }, owner.accessToken); const invitePayload = await invite.json();
  await post('/api/invitations/accept', { token: invitePayload.developmentInvitationToken }, member.accessToken);
  const heartbeat = await post(`/api/workspaces/${owner.workspace.id}/presence`, {}, member.accessToken); assert.equal(heartbeat.status, 200);
  const presence = await fetch(`${base}/api/workspaces/${owner.workspace.id}/presence`, { headers: { authorization: `Bearer ${owner.accessToken}` } }); assert.equal((await presence.json()).online.length, 1);
  const eventAbort = new AbortController(); const events = await fetch(`${base}/api/workspaces/${owner.workspace.id}/events`, { headers: { authorization: `Bearer ${member.accessToken}` }, signal: eventAbort.signal }); assert.equal(events.status, 200); assert.match(events.headers.get('content-type'), /text\/event-stream/);
  const reader = events.body.getReader(); const initial = await reader.read(); assert.match(new TextDecoder().decode(initial.value), /connected/);
  const ticketResponse = await post(`/api/workspaces/${owner.workspace.id}/tickets`, { title: 'Attachment target' }, owner.accessToken); const ticket = (await ticketResponse.json()).ticket; const pushedEvent = await reader.read(); assert.match(new TextDecoder().decode(pushedEvent.value), /ticket.created/);
  const upload = await post(`/api/workspaces/${owner.workspace.id}/tickets/${ticket.id}/attachments`, { name: 'notes.txt', mimeType: 'text/plain', data: 'data:text/plain;base64,SGVsbG8gQXNoa2Fu' }, owner.accessToken); assert.equal(upload.status, 201); const attachment = (await upload.json()).attachment; assert.equal(attachment.size, 12);
  const download = await fetch(`${base}/api/workspaces/${owner.workspace.id}/tickets/${ticket.id}/attachments/${attachment.id}`, { headers: { authorization: `Bearer ${member.accessToken}` } }); assert.equal(await download.text(), 'Hello Ashkan');
  const textInlineAttempt = await fetch(`${base}/api/workspaces/${owner.workspace.id}/tickets/${ticket.id}/attachments/${attachment.id}?inline=1`, { headers: { authorization: `Bearer ${member.accessToken}` } }); assert.match(textInlineAttempt.headers.get('content-disposition'), /^attachment;/);
  const inlineUpload = await post(`/api/workspaces/${owner.workspace.id}/tickets/${ticket.id}/attachments`, { name: 'preview.pdf', mimeType: 'application/pdf', data: 'data:application/pdf;base64,JVBERi0xLjQK' }, owner.accessToken); assert.equal(inlineUpload.status, 201); const pdf = (await inlineUpload.json()).attachment;
  const safeDownload = await fetch(`${base}/api/workspaces/${owner.workspace.id}/tickets/${ticket.id}/attachments/${pdf.id}`, { headers: { authorization: `Bearer ${owner.accessToken}` } }); assert.match(safeDownload.headers.get('content-disposition'), /^attachment;/);
  const inlinePreview = await fetch(`${base}/api/workspaces/${owner.workspace.id}/tickets/${ticket.id}/attachments/${pdf.id}?inline=1`, { headers: { authorization: `Bearer ${owner.accessToken}` } }); assert.match(inlinePreview.headers.get('content-disposition'), /^inline;/); assert.equal(await inlinePreview.text(), '%PDF-1.4\n');
  const invalid = await post(`/api/workspaces/${owner.workspace.id}/tickets/${ticket.id}/attachments`, { name: 'script.js', mimeType: 'application/javascript', data: 'data:application/javascript;base64,YWxlcnQoMSk=' }, owner.accessToken); assert.equal(invalid.status, 400);
  eventAbort.abort();
});

test('configured email provider receives password-reset messages without leaking credentials', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ashkan-phase18-email-'));
  process.env.DATA_FILE = join(dir, 'store.json');
  process.env.JWT_SECRET = 'phase-eighteen-email-test-secret-32';
  process.env.CORS_ORIGIN = 'http://localhost:5173';
  process.env.NODE_ENV = 'test';
  process.env.EMAIL_API_KEY = 'test-provider-key';
  process.env.EMAIL_FROM = 'AshkanBoard <test@example.com>';
  process.env.EMAIL_PROVIDER_URL = 'https://email-provider.test/send';
  process.env.APP_BASE_URL = 'http://localhost:5173';
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    if (String(url) === process.env.EMAIL_PROVIDER_URL) {
      sent.push({ url: String(url), options, payload: JSON.parse(options.body) });
      return new Response(JSON.stringify({ id: 'mail_test_001' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(url, options);
  };
  const { createAppServer: create } = await import(`../app.mjs?phase18email=${Date.now()}`);
  const server = create(); await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const key of ['EMAIL_API_KEY','EMAIL_FROM','EMAIL_PROVIDER_URL','APP_BASE_URL']) delete process.env[key];
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const post = (path, value, token) => originalFetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
  const registered = await post('/api/auth/register', { name: 'Email Test', email: 'email-test@example.com', password: 'phase-eighteen-password-strong' });
  assert.equal(registered.status, 201);
  const account = await registered.json();
  const forgot = await post('/api/auth/password/forgot', { email: 'email-test@example.com' });
  assert.equal(forgot.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.to[0], 'email-test@example.com');
  assert.match(sent[0].payload.text, /reset-password\?token=/);
  assert.equal(sent[0].options.headers.authorization, 'Bearer test-provider-key');
  assert.ok((await forgot.json()).developmentResetToken);
  const health = await originalFetch(`${base}/api/health`);
  const healthPayload = await health.json();
  assert.equal(healthPayload.email, 'configured');
  assert.ok(healthPayload.uptimeSeconds >= 0);
  const readiness = await originalFetch(`${base}/api/health/ready`);
  assert.equal(readiness.status, 200);
  assert.equal((await readiness.json()).status, 'ready');
  assert.ok(readiness.headers.get('x-request-id'));
  assert.ok(account.accessToken);
});

test('ticket query endpoint provides search, filtering, sorting and pagination metadata', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ashkan-phase20-query-'));
  process.env.DATA_FILE = join(dir, 'store.json'); process.env.JWT_SECRET = 'phase-twenty-test-secret-with-at-least-32'; process.env.CORS_ORIGIN = 'http://localhost:5173'; process.env.NODE_ENV = 'development'; delete process.env.DATABASE_URL; process.env.PERSISTENCE_MODE = 'json';
  const { createAppServer: create } = await import(`../app.mjs?phase20-query=${Date.now()}`);
  const server = create(); await new Promise((resolve) => server.listen(0, resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const post = (path, value, token) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
  const registered = await post('/api/auth/register', { name: 'Query User', email: 'query@example.com', password: 'phase-twenty-password-long-enough' });
  const session = await registered.json();
  for (const [title, status, priority] of [['Alpha roadmap', 'todo', 'High'], ['Beta design', 'done', 'Low'], ['Gamma roadmap', 'todo', 'Medium']]) {
    const created = await post(`/api/workspaces/${session.workspace.id}/tickets`, { title, status, priority }, session.accessToken);
    assert.equal(created.status, 201);
  }
  const response = await fetch(`${base}/api/workspaces/${session.workspace.id}/tickets/query?page=1&pageSize=1&search=roadmap&status=todo&sort=title&direction=asc`, { headers: { authorization: `Bearer ${session.accessToken}` } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.tickets.length, 1);
  assert.equal(payload.tickets[0].title, 'Alpha roadmap');
  assert.deepEqual(payload.pagination, { page: 1, pageSize: 1, total: 2, totalPages: 2, hasNext: true, hasPrevious: false });
});

test('phase 22 normalized identity repository uses relational users, workspaces, and memberships', async () => {
  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM users WHERE id')) return { rows: [{ id: 'u1', email: 'owner@example.com', name: 'Owner', created_at: '2026-01-01T00:00:00.000Z' }] };
    if (sql.includes('FROM users WHERE email')) return { rows: [{ id: 'u1', email: 'owner@example.com', name: 'Owner', password_hash: 'hash', created_at: '2026-01-01T00:00:00.000Z' }] };
    if (sql.includes('FROM workspaces w')) return { rows: [{ id: 'w1', name: 'Workspace', description: 'Demo', created_at: '2026-01-02T00:00:00.000Z', role: 'owner' }] };
    if (sql.includes('FROM workspace_memberships WHERE') || sql.includes('FROM workspace_memberships m LEFT JOIN workspace_roles')) return { rows: [{ workspace_id: 'w1', user_id: 'u1', role: 'owner', joined_at: '2026-01-02T00:00:00.000Z', permissions: ['read','create','update','delete','members','roles','audit'] }] };
    if (sql.includes('FROM workspace_memberships m JOIN users')) return { rows: [{ user_id: 'u1', workspace_id: 'w1', role: 'owner', joined_at: '2026-01-02T00:00:00.000Z', id: 'u1', email: 'owner@example.com', name: 'Owner', created_at: '2026-01-01T00:00:00.000Z' }] };
    if (sql.includes('FROM workspaces WHERE')) return { rows: [{ id: 'w1', name: 'Workspace', description: 'Demo', created_at: '2026-01-02T00:00:00.000Z' }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  }};
  const repo = await import(`../normalized-repository.mjs?phase22repo=${Date.now()}`);
  assert.equal((await repo.findNormalizedUserById(client, 'u1')).email, 'owner@example.com');
  assert.equal((await repo.findNormalizedUserByEmail(client, 'owner@example.com')).passwordHash, 'hash');
  assert.equal((await repo.listNormalizedWorkspacesForUser(client, 'u1'))[0].role, 'owner');
  assert.equal((await repo.findNormalizedMembership(client, 'u1', 'w1')).role, 'owner');
  assert.equal((await repo.listNormalizedMembers(client, 'w1'))[0].user.name, 'Owner');
  assert.equal((await repo.findNormalizedWorkspace(client, 'w1')).name, 'Workspace');
  assert.ok(calls.length === 6);
});

test('workspace export is authenticated, workspace-scoped and omits account secrets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ashkan-phase27-export-'));
  process.env.DATA_FILE = join(dir, 'store.json'); process.env.JWT_SECRET = 'phase-twenty-seven-export-secret-32'; process.env.CORS_ORIGIN = 'http://localhost:5173'; process.env.NODE_ENV = 'test';
  const { createAppServer: create } = await import(`../app.mjs?phase27-export=${Date.now()}`);
  const server = create(); await new Promise((resolve) => server.listen(0, resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const register = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Export Owner', email: 'export-owner@example.com', password: 'phase-twenty-seven-password' }) });
  const session = await register.json();
  const created = await fetch(`${base}/api/workspaces/${session.workspace.id}/tickets`, { method: 'POST', headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Export-safe task' }) });
  assert.equal(created.status, 201);
  const response = await fetch(`${base}/api/workspaces/${session.workspace.id}/export`, { headers: { authorization: `Bearer ${session.accessToken}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment; filename=ashkan-workspace-/);
  const exported = await response.json();
  assert.equal(exported.format, 'ashkanboard-workspace-export');
  assert.equal(exported.tickets[0].title, 'Export-safe task');
  assert.equal('passwordHash' in exported.members[0].user, false);
  assert.ok(exported.exclusions.includes('password hashes'));
  const forbidden = await fetch(`${base}/api/workspaces/not-a-member/export`, { headers: { authorization: `Bearer ${session.accessToken}` } });
  assert.equal(forbidden.status, 403);
});
