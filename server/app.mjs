// Compatibility note: notification preferences were introduced by 021_notification_preferences.sql; Phase 53 readiness advances to 022.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getPostgresPool, closePostgresPool } from './store.mjs';
import { createMetrics, createRateLimiter, safeTokenEqual } from './observability.mjs';
import { legacyReadStore, legacyUpdateStore } from './legacy-persistence.mjs';
import { listNormalizedTickets, createNormalizedTicket, updateNormalizedTicket, deleteNormalizedTicket, findNormalizedUserById, findNormalizedUserByEmail, listNormalizedWorkspacesForUser, findNormalizedMembership, listNormalizedMembers, findNormalizedWorkspace, createNormalizedAccount, updateNormalizedUser, createNormalizedWorkspace, addNormalizedMembership, updateNormalizedMembershipRole, removeNormalizedMembership, insertNormalizedAudit, listNormalizedAudit, createNormalizedPasswordReset, consumeNormalizedPasswordReset, createNormalizedRefreshToken, rotateNormalizedRefreshToken, revokeNormalizedRefreshFamily, revokeNormalizedUserSessions, createNormalizedInvitation, acceptNormalizedInvitation, findNormalizedTicket, listNormalizedComments, createNormalizedComment, deleteNormalizedComment, listNormalizedNotifications, markNormalizedNotificationRead, getNormalizedNotificationPreferences, upsertNormalizedNotificationPreferences, upsertNormalizedPresence, listNormalizedPresence, listNormalizedAttachments, createNormalizedAttachment, deleteNormalizedAttachment, notifyNormalizedWorkspace, findNormalizedImportBatch, commitNormalizedTicketImport, exportNormalizedWorkspace, findOidcIdentity, linkOidcIdentity, touchOidcIdentity, seedNormalizedWorkspaceRoles, listNormalizedRoles, createNormalizedRole, updateNormalizedRole, deleteNormalizedRole, listNormalizedRoleMappings, createNormalizedRoleMapping, updateNormalizedRoleMapping, deleteNormalizedRoleMapping, applyNormalizedRoleMappings, listNormalizedWebhooks, createNormalizedWebhook, updateNormalizedWebhook, deleteNormalizedWebhook, getNormalizedWebhookSecret, rotateNormalizedWebhookSecret, recordNormalizedWebhookDelivery, recordNormalizedWebhookDeliveryAttempt, updateNormalizedWebhookRetryPolicy, updateNormalizedWebhookRetentionPolicy, purgeExpiredNormalizedWebhookDeliveries, getNormalizedWebhookRetentionStats, getNormalizedWebhookRetentionPreview, updateNormalizedWebhookCircuitPolicy, recoverNormalizedWebhookCircuit, recoverDueNormalizedWebhookCircuits, getNormalizedWebhookDelivery, listNormalizedWebhookDeliveries, searchNormalizedWebhookDeliveries, listNormalizedWebhookDeadLetters, requeueNormalizedWebhookDeadLetter, discardNormalizedWebhookDeadLetter, discardNormalizedWebhookDeadLetters, getNormalizedWebhookDeliverySummary, claimNormalizedWebhookRetries, clearNormalizedWebhookRetryLock, getNormalizedSecuritySettings, setNormalizedTotpSecret, enableNormalizedTotp, disableNormalizedTotp, insertNormalizedSecurityEvent, listNormalizedSecurityEvents, listNormalizedUserSessions, revokeNormalizedSessionFamily } from './normalized-repository.mjs';
import { emailConfigured, sendEmail, escapeHtml } from './email.mjs';
import { hashPassword, verifyPassword, signToken, verifyToken, randomToken, hashToken, generateTotpSecret, verifyTotp, encryptSecret, decryptSecret, signMfaChallenge, verifyMfaChallenge } from './security.mjs';
import { getCachedWorkspaceTickets, invalidateWorkspaceTicketCache, cacheDiagnostics } from './cache.mjs';
import { oidcConfigured, oidcPublicConfig, createOidcAuthorization, exchangeOidcCode } from './oidc.mjs';
import { scimAuthConfigured, scimTokenValid, scimListUsers, scimGetUser, scimCreateUser, scimPatchUser, scimDeleteUser, scimListGroups, scimGetGroup, scimCreateGroup, scimPatchGroup, scimDeleteGroup } from './scim-repository.mjs';
const PORT = Number(process.env.PORT || 4000); const ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
const startedAt = Date.now();
const metrics = createMetrics();
const rateLimiter = createRateLimiter({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  maxRequests: Number(process.env.RATE_LIMIT_MAX || 120),
  maxKeys: Number(process.env.RATE_LIMIT_MAX_KEYS || 10_000),
});
const production = process.env.NODE_ENV === 'production';
const normalizedPersistence = () => Boolean(process.env.DATABASE_URL && process.env.PERSISTENCE_MODE === 'normalized');
if (production && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET.startsWith('replace-with-'))) {
  throw new Error('Production requires a unique JWT_SECRET with at least 32 characters.');
}
if (production && (!process.env.DATABASE_URL || !process.env.CORS_ORIGIN || !process.env.APP_BASE_URL)) {
  throw new Error('Production requires DATABASE_URL, CORS_ORIGIN, and APP_BASE_URL.');
}
if (process.env.METRICS_ENABLED === 'true' && (!process.env.METRICS_TOKEN || process.env.METRICS_TOKEN.length < 32)) {
  throw new Error('Enabled metrics require METRICS_TOKEN with at least 32 characters.');
}
function logEvent(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ level, event, at: new Date().toISOString(), ...fields })}\n`);
}
const liveClients = new Map();
function publish(workspaceId, event) { for (const client of liveClients.get(workspaceId) || []) { try { client.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* disconnected client */ } } }
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end(JSON.stringify(body)); };
function rateLimit(req) { return rateLimiter.allow(req.socket.remoteAddress || 'unknown'); }
async function body(req) { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 8_000_000) throw Object.assign(new Error('Request body too large'), { status: 413 }); } try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); } }
function cleanUser(user) { return user && ({ id: user.id, email: user.email, name: user.name, createdAt: user.createdAt }); }
function membership(data, userId, workspaceId) { return data.memberships.find((m) => m.userId === userId && m.workspaceId === workspaceId); }
const permissions = { owner: ['read','create','update','delete','members','roles','audit'], admin: ['read','create','update','delete','members','audit'], member: ['read','create','update'], viewer: ['read'] };
function allowed(res, member, action) { const granted = Array.isArray(member?.permissions) && member.permissions.length ? member.permissions : permissions[member?.role] || []; if (!member || !granted.includes(action)) { json(res, 403, { error: 'Insufficient workspace permission' }); return false; } return true; }
async function normalizedTransaction(work) { const pool = await getPostgresPool(); const client = await pool.connect(); try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
async function withClientTransaction(client, work) { try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK'); throw error; } }
async function authenticate(req, res) { const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1]; const claims = verifyToken(token); if (!claims) { json(res, 401, { error: 'Authentication required' }); return null; } if (normalizedPersistence()) { try { const pool = await getPostgresPool(); const client = await pool.connect(); try { const user = await findNormalizedUserById(client, claims.sub); if (!user) { json(res, 401, { error: 'Account no longer exists' }); return null; } return user; } finally { client.release(); } } catch { return json(res, 503, { error: 'Identity store unavailable' }), null; } } const data = await legacyReadStore(); const user = data.users.find((entry) => entry.id === claims.sub); if (!user) { json(res, 401, { error: 'Account no longer exists' }); return null; } return user; }
function audit(data, user, workspaceId, action, entityType, entityId, metadata = {}) { data.auditLogs.push({ id: randomUUID(), workspaceId, actorId: user.id, action, entityType, entityId, metadata, createdAt: new Date().toISOString() }); if (data.auditLogs.length > 5000) data.auditLogs.splice(0, data.auditLogs.length - 5000); }
function notifyWorkspace(data, user, workspaceId, type, title, message, entityId = null) {
 const recipients = data.memberships.filter((entry) => entry.workspaceId === workspaceId && entry.userId !== user.id);
 const now = new Date().toISOString();
 for (const recipient of recipients) data.notifications.push({ id: randomUUID(), workspaceId, userId: recipient.userId, actorId: user.id, type, title: String(title).slice(0, 160), message: String(message || '').slice(0, 500), entityId, createdAt: now, readAt: null });
 if (data.notifications.length > 10000) data.notifications.splice(0, data.notifications.length - 10000);
 publish(workspaceId, { type, entityId, at: now });
}
function sessionFor(user, familyId = randomUUID()) { const refreshToken = randomToken(); return { accessToken: signToken(user), refreshToken, refreshRecord: { id: randomUUID(), userId: user.id, familyId, tokenHash: hashToken(refreshToken), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), revokedAt: null } }; }
async function securityEvent(userId, eventType, req, metadata = {}) { if (!normalizedPersistence()) return; try { await normalizedTransaction((client) => insertNormalizedSecurityEvent(client, { id: randomUUID(), userId, eventType, ipAddress: req.socket.remoteAddress || null, userAgent: String(req.headers['user-agent'] || '').slice(0, 500), metadata })); } catch (error) { logEvent('error','security_event.persist_failed',{eventType,message:error.message}); } }
export function createAppServer() {
 return createServer(async (req, res) => {
  const requestId = randomUUID();
  const requestStarted = Date.now();
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('x-dns-prefetch-control', 'off');
  res.setHeader('x-permitted-cross-domain-policies', 'none');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  if (production) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  metrics.begin();
  let requestRecorded = false;
  const recordRequest = (status) => {
    if (requestRecorded) return;
    requestRecorded = true;
    const durationMs = Date.now() - requestStarted;
    metrics.finish(req.method || 'UNKNOWN', status, durationMs);
    logEvent(status >= 500 ? 'error' : 'info', 'http.request', { requestId, method: req.method, path: (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch { return '/invalid-url'; } })(), status, durationMs });
  };
  res.on('finish', () => recordRequest(res.statusCode));
  res.on('close', () => { if (!res.writableFinished) recordRequest(499); });
  if (req.headers.origin && req.headers.origin !== ORIGIN) return json(res, 403, { error: 'Origin not allowed' });
  res.setHeader('access-control-allow-origin', ORIGIN); res.setHeader('vary', 'Origin'); res.setHeader('access-control-allow-headers', 'content-type, authorization'); res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!rateLimit(req)) return json(res, 429, { error: 'Rate limit exceeded' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const path = url.pathname;
  try {
   if (req.method === 'GET' && path === '/api/metrics') {
    if (process.env.METRICS_ENABLED !== 'true') return json(res, 404, { error: 'Not found' });
    const supplied = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!safeTokenEqual(process.env.METRICS_TOKEN, supplied)) return json(res, 401, { error: 'Metrics authentication required' });
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(metrics.render(cacheDiagnostics()));
   }
   if (req.method === 'GET' && path === '/api/health') return json(res, 200, { status: 'ok', service: 'ashkan-board-api', persistence: process.env.DATABASE_URL ? (process.env.PERSISTENCE_MODE === 'normalized' ? 'postgres-normalized-runtime' : 'postgres-jsonb-compatibility') : 'json-file', email: emailConfigured() ? 'configured' : 'not-configured', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), cache: cacheDiagnostics(), features: ['workspace-notifications','ticket-import-dry-run','idempotent-ticket-import','ticket-comments','profile-update','sse-events','presence','ticket-attachments','attachment-inline-preview','structured-logging','liveness-probe','readiness-probe','normalized-relational-identity-workspace-ticket','normalized-refresh-sessions','normalized-workspace-invitations','normalized-comments-notifications-presence-attachments-audit','normalized-idempotent-ticket-import','workspace-json-export','prometheus-metrics','redis-ticket-query-cache','enterprise-2fa','oidc-sso','session-family-revocation'], time: new Date().toISOString() });
   if (req.method === 'GET' && path === '/api/health/live') return json(res, 200, { status: 'alive', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), time: new Date().toISOString() });
   if (req.method === 'GET' && path === '/api/health/ready') {
    if (!process.env.DATABASE_URL) return json(res, 200, { status: 'ready', persistence: 'json-file' });
    try {
      const pool = await getPostgresPool();
      await pool.query('SELECT 1');
      const migrations = await pool.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
      const latestMigration = migrations.rows[0]?.version || null;
      const requiredTables = await pool.query(`SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [['users','workspaces','tickets','workspace_roles','workspace_role_mappings','workspace_webhooks','workspace_webhook_deliveries','schema_migrations']]);
      const legacy = await pool.query("SELECT to_regclass('ashkan_app_state') IS NOT NULL AS present");
      const normalized = process.env.PERSISTENCE_MODE === 'normalized';
      const productionPolicy = process.env.NODE_ENV === 'production';
      const ready = normalized && requiredTables.rows[0]?.count === 8 && latestMigration === '030_webhook_delivery_retention.sql' && !legacy.rows[0]?.present;
      if (productionPolicy && !ready) return json(res, 503, { status: 'not-ready', dependency: 'database-schema', persistence: process.env.PERSISTENCE_MODE || 'not-set', latestMigration, requiredTableCount: requiredTables.rows[0]?.count || 0, legacyAggregatePresent: Boolean(legacy.rows[0]?.present) });
      return json(res, 200, { status: 'ready', persistence: normalized ? 'postgres-normalized-runtime' : 'postgres-compatibility', latestMigration, legacyAggregatePresent: Boolean(legacy.rows[0]?.present) });
    } catch (error) { return json(res, 503, { status: 'not-ready', dependency: 'database', error: process.env.NODE_ENV === 'production' ? undefined : error.message }); }
   }
   if (path.startsWith('/scim/v2/')) {
    const auth = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!scimAuthConfigured() || !scimTokenValid(auth)) return json(res, 401, { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'SCIM authentication failed', status: '401' });
    if (!normalizedPersistence()) return json(res, 503, { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'SCIM requires normalized PostgreSQL persistence', status: '503' });
    const baseUrl = `${process.env.APP_BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`}/scim/v2`;
    const resource = path.replace(/^\/scim\/v2\//, '');
    if (req.method === 'GET' && resource === 'ServiceProviderConfig') return json(res, 200, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: 100 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: true }, authenticationSchemes: [{ type: 'oauthbearertoken', name: 'SCIM Bearer Token', description: 'Bearer token configured by the SCIM_BEARER_TOKEN environment variable' }] });
    if (req.method === 'GET' && resource === 'ResourceTypes') return json(res, 200, { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: 'urn:ietf:params:scim:schemas:core:2.0:User' }, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: 'urn:ietf:params:scim:schemas:core:2.0:Group' }] });
    const parts = resource.split('/').filter(Boolean);
    const collection = parts[0]; const id = parts[1];
    res.setHeader('content-type', 'application/scim+json; charset=utf-8');
    const pool = await getPostgresPool(); const client = await pool.connect();
    try {
      if (collection === 'Users') {
        if (req.method === 'GET' && !id) return json(res, 200, await scimListUsers(client, { filter: new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('filter'), startIndex: Number(new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('startIndex') || 1), count: Number(new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('count') || 100), baseUrl }));
        if (req.method === 'GET' && id) { const found=await scimGetUser(client,id,baseUrl); return found ? json(res,200,found) : json(res,404,{schemas:['urn:ietf:params:scim:api:messages:2.0:Error'],detail:'User not found',status:'404'}); }
        if (req.method === 'POST') { const input=await body(req); const email=String(input.userName || input.emails?.find((e)=>e.primary)?.value || input.emails?.[0]?.value || '').trim().toLowerCase(); const name=String(input.displayName || input.name?.formatted || email.split('@')[0] || '').trim(); if(!email || !name) return json(res,400,{schemas:['urn:ietf:params:scim:api:messages:2.0:Error'],detail:'userName/email and displayName are required',status:'400'}); const result=await normalizedTransaction(async(tx)=>scimCreateUser(tx,{externalId:String(input.externalId || randomUUID()),email,name,active:input.active !== false,passwordHash:await hashPassword(randomToken(32)),baseUrl})); return json(res,result.created?201:200,result.resource); }
        if (req.method === 'PATCH' && id) { const input=await body(req); const result=await normalizedTransaction((tx)=>scimPatchUser(tx,id,input.Operations || input.operations || [],baseUrl)); return result ? json(res,200,result) : json(res,404,{schemas:['urn:ietf:params:scim:api:messages:2.0:Error'],detail:'User not found',status:'404'}); }
        if (req.method === 'DELETE' && id) { const removed=await normalizedTransaction((tx)=>scimDeleteUser(tx,id)); return removed ? (res.statusCode=204,res.end()) : json(res,404,{schemas:['urn:ietf:params:scim:api:messages:2.0:Error'],detail:'User not found',status:'404'}); }
      }
      if (collection === 'Groups') {
        if (req.method === 'GET' && !id) { const u=new URL(req.url,`http://${req.headers.host||'localhost'}`); return json(res,200,await scimListGroups(client,{startIndex:Number(u.searchParams.get('startIndex')||1),count:Number(u.searchParams.get('count')||100),baseUrl})); }
        if (req.method === 'GET' && id) { const found=await scimGetGroup(client,id,baseUrl); return found ? json(res,200,found) : json(res,404,{schemas:['urn:ietf:params:scim:api:messages:2.0:Error'],detail:'Group not found',status:'404'}); }
        if (req.method === 'POST') { const input=await body(req); const result=await normalizedTransaction((tx)=>scimCreateGroup(tx,{externalId:String(input.externalId || randomUUID()),displayName:String(input.displayName || 'SCIM Workspace').slice(0,160),members:Array.isArray(input.members)?input.members:[],baseUrl})); return json(res,201,result); }
        if (req.method === 'PATCH' && id) { const input=await body(req); const result=await normalizedTransaction((tx)=>scimPatchGroup(tx,id,input.Operations || input.operations || [],baseUrl)); return result ? json(res,200,result) : json(res,404,{schemas:['urn:ietf:params:scim:api:messages:2.0:Error'],detail:'Group not found',status:'404'}); }
        if (req.method === 'DELETE' && id) { const removed=await normalizedTransaction((tx)=>scimDeleteGroup(tx,id)); return removed ? (res.statusCode=204,res.end()) : json(res,404,{schemas:['urn:ietf:params:scim:api:messages:2.0:Error'],detail:'Group not found',status:'404'}); }
      }
      return json(res,404,{schemas:['urn:ietf:params:scim:api:messages:2.0:Error'],detail:'SCIM resource not found',status:'404'});
    } finally { client.release(); }
   }
   if (req.method === 'GET' && path === '/api/auth/oidc/config') return json(res, 200, oidcPublicConfig());
   if (req.method === 'GET' && path === '/api/auth/oidc/start') {
    if (!oidcConfigured()) return json(res, 404, { error: 'Enterprise SSO is not configured' });
    try { return res.writeHead(302, { location: await createOidcAuthorization(), 'cache-control': 'no-store' }), res.end(); } catch (error) { logEvent('error', 'oidc.start_failed', { message: error.message }); return json(res, 503, { error: 'Identity provider is unavailable' }); }
   }
   if (req.method === 'GET' && path === '/api/auth/oidc/callback') {
    const query = new URL(req.url, 'http://localhost').searchParams; const code = query.get('code'); const state = query.get('state'); const providerError = query.get('error');
    if (providerError) return res.writeHead(302, { location: `${process.env.APP_BASE_URL || ORIGIN}/?ssoError=${encodeURIComponent(providerError)}` }).end();
    if (!code || !state || !normalizedPersistence()) return json(res, 400, { error: 'Invalid enterprise SSO callback' });
    try {
      const identity = await exchangeOidcCode(code, state); const pool = await getPostgresPool(); const client = await pool.connect(); let user; let workspace;
      try {
        await client.query('BEGIN'); const linked = await findOidcIdentity(client, identity.provider, identity.subject);
        if (linked) user = linked.user;
        else {
          user = await findNormalizedUserByEmail(client, identity.email);
          if (!user) { user = { id: randomUUID(), email: identity.email, name: identity.name, passwordHash: await hashPassword(randomToken(32)), createdAt: new Date().toISOString() }; workspace = { id: randomUUID(), name: `${identity.name}'s workspace`, description: '', createdAt: new Date().toISOString() }; await createNormalizedAccount(client, { user, workspace, membership: { userId: user.id, workspaceId: workspace.id, role: 'owner', joinedAt: workspace.createdAt } }); }
          await linkOidcIdentity(client, { id: randomUUID(), userId: user.id, issuer: identity.provider, subject: identity.subject, email: identity.email });
        }
        if (!workspace) { const workspaces = await listNormalizedWorkspacesForUser(client, user.id); workspace = workspaces[0] || null; }
        if (workspace) await applyNormalizedRoleMappings(client, { workspaceId: workspace.id, userId: user.id, source: 'oidc', claims: identity.claims || {} });
        const session = sessionFor(user); await createNormalizedRefreshToken(client, session.refreshRecord); await client.query('COMMIT');
        await securityEvent(user.id, 'oidc.login.success', req, { issuer: identity.provider });
        const redirect = new URL(`${process.env.APP_BASE_URL || ORIGIN}/`); redirect.searchParams.set('sso', 'success'); redirect.searchParams.set('accessToken', session.accessToken); redirect.searchParams.set('refreshToken', session.refreshToken); return res.writeHead(302, { location: redirect.toString(), 'cache-control': 'no-store' }).end();
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } catch (error) { logEvent('error', 'oidc.callback_failed', { message: error.message }); return res.writeHead(302, { location: `${process.env.APP_BASE_URL || ORIGIN}/?ssoError=${encodeURIComponent('identity_provider_error')}` }).end(); }
   }
   if (req.method === 'POST' && path === '/api/auth/register') {
    const input = await body(req); const email = String(input.email || '').trim().toLowerCase(); const name = String(input.name || '').trim(); const password = String(input.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email) || name.length < 2 || password.length < 12) return json(res, 400, { error: 'Provide a valid email, a name, and a password of at least 12 characters.' });
    if (normalizedPersistence()) {
      const user = { id: randomUUID(), email, name, passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
      const workspace = { id: randomUUID(), name: `${name}'s workspace`, description: '', createdAt: new Date().toISOString() };
      const member = { userId: user.id, workspaceId: workspace.id, role: 'owner', joinedAt: workspace.createdAt };
      const session = sessionFor(user);
      try { await normalizedTransaction(async (client) => { await createNormalizedAccount(client, { user, workspace, membership: member }); await createNormalizedRefreshToken(client, session.refreshRecord); }); }
      catch (error) {
        if (error.code === '23505') return json(res, 409, { error: 'Email already registered' });
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN' || error.code === '28P01' || error.code === '3D000' || error.code === '42P01' || error.message?.includes("Cannot find package 'pg'")) {
          logEvent('error', 'auth.register.persistence_unavailable', { requestId, code: error.code || 'PG_DRIVER_OR_DATABASE_ERROR' });
          return json(res, 503, { error: 'Registration is temporarily unavailable because the PostgreSQL persistence service is not ready.', code: 'PERSISTENCE_UNAVAILABLE', requestId });
        }
        throw error;
      }
      return json(res, 201, { user: cleanUser(user), workspace: { ...workspace, role: 'owner' }, accessToken: session.accessToken, refreshToken: session.refreshToken });
    }
    const result = await legacyUpdateStore(async (data) => { if (data.users.some((u) => u.email === email)) throw Object.assign(new Error('Email already registered'), { status: 409 }); const user = { id: randomUUID(), email, name, passwordHash: await hashPassword(password), createdAt: new Date().toISOString() }; const workspace = { id: randomUUID(), name: `${name}'s workspace`, createdAt: new Date().toISOString() }; data.users.push(user); data.workspaces.push(workspace); data.memberships.push({ userId: user.id, workspaceId: workspace.id, role: 'owner' }); const session = sessionFor(user); data.refreshTokens.push(session.refreshRecord); return { user: cleanUser(user), workspace, accessToken: session.accessToken, refreshToken: session.refreshToken }; });
    return json(res, 201, result);
   }
   if (req.method === 'POST' && path === '/api/auth/login') {
    const input = await body(req); const email = String(input.email || '').trim().toLowerCase();
    const user = normalizedPersistence() ? await (async () => { const pool = await getPostgresPool(); const client = await pool.connect(); try { return await findNormalizedUserByEmail(client, email); } finally { client.release(); } })() : (await legacyReadStore()).users.find((u) => u.email === email);
    if (!user || !(await verifyPassword(String(input.password || ''), user.passwordHash))) { await securityEvent(user?.id || null, 'login.failed', req, { reason: 'invalid_credentials' }); return json(res, 401, { error: 'Invalid email or password' }); }
    if (normalizedPersistence()) {
      const pool = await getPostgresPool(); const client = await pool.connect(); let settings;
      try { settings = await getNormalizedSecuritySettings(client, user.id); } finally { client.release(); }
      if (settings?.totpEnabled) {
        const challenge = verifyMfaChallenge(input.mfaChallenge);
        if (!challenge || challenge.sub !== user.id) { await securityEvent(user.id, 'mfa.challenge_issued', req); return json(res, 401, { error: 'Multi-factor authentication required', mfaRequired: true, mfaChallenge: signMfaChallenge(user) }); }
        const secret = decryptSecret(settings.totpSecretEnc);
        if (!verifyTotp(secret, input.otp)) { await securityEvent(user.id, 'mfa.failed', req); return json(res, 401, { error: 'Invalid authentication code', mfaRequired: true, mfaChallenge: input.mfaChallenge }); }
        await securityEvent(user.id, 'mfa.success', req);
      }
    }
    const session = sessionFor(user);
    if (normalizedPersistence()) await normalizedTransaction((client) => createNormalizedRefreshToken(client, session.refreshRecord));
    else await legacyUpdateStore((store) => store.refreshTokens.push(session.refreshRecord));
    await securityEvent(user.id, 'login.success', req);
    return json(res, 200, { user: cleanUser(user), accessToken: session.accessToken, refreshToken: session.refreshToken });
   }
   if (req.method === 'POST' && path === '/api/auth/refresh') {
    const input = await body(req); const tokenHash = hashToken(input.refreshToken || ''); let result;
    if (normalizedPersistence()) result = await normalizedTransaction((client) => rotateNormalizedRefreshToken(client, tokenHash, sessionFor));
    else await legacyUpdateStore((data) => { const record = data.refreshTokens.find((item) => item.tokenHash === tokenHash); if (!record) return; if (record.revokedAt || new Date(record.expiresAt) <= new Date()) { data.refreshTokens.filter((item) => item.familyId === record.familyId).forEach((item) => { item.revokedAt ||= new Date().toISOString(); }); return; } record.revokedAt = new Date().toISOString(); const user = data.users.find((item) => item.id === record.userId); if (!user) return; const session = sessionFor(user, record.familyId); data.refreshTokens.push(session.refreshRecord); result = { user: cleanUser(user), accessToken: session.accessToken, refreshToken: session.refreshToken }; });
    return result ? json(res, 200, result) : json(res, 401, { error: 'Refresh token is invalid, expired, or already used. Please sign in again.' });
   }
   if (req.method === 'POST' && path === '/api/auth/logout') {
    const input = await body(req); const tokenHash = hashToken(input.refreshToken || '');
    if (normalizedPersistence()) await normalizedTransaction((client) => revokeNormalizedRefreshFamily(client, tokenHash));
    else await legacyUpdateStore((data) => { const record = data.refreshTokens.find((item) => item.tokenHash === tokenHash); if (record) data.refreshTokens.filter((item) => item.familyId === record.familyId).forEach((item) => { item.revokedAt ||= new Date().toISOString(); }); });
    return json(res, 200, { ok: true });
   }
   if (req.method === 'POST' && path === '/api/auth/password/forgot') {
    const input = await body(req); const email = String(input.email || '').trim().toLowerCase(); let resetToken; let resetRecipient;
    if (normalizedPersistence()) {
      const pool = await getPostgresPool(); const client = await pool.connect();
      try { resetRecipient = await findNormalizedUserByEmail(client, email); } finally { client.release(); }
      if (resetRecipient) { resetToken = randomToken(32); const createdAt = new Date(); await normalizedTransaction((tx) => createNormalizedPasswordReset(tx, { id: randomUUID(), userId: resetRecipient.id, tokenHash: hashToken(resetToken), createdAt, expiresAt: new Date(createdAt.getTime() + 15 * 60_000) })); }
    } else {
      await legacyUpdateStore((data) => { const user = data.users.find((item) => item.email === email); if (!user) return; resetToken = randomToken(32); resetRecipient = user; data.passwordResets = data.passwordResets.filter((item) => item.userId !== user.id || item.usedAt || Date.parse(item.expiresAt) <= Date.now()); data.passwordResets.push({ id: randomUUID(), userId: user.id, tokenHash: hashToken(resetToken), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), usedAt: null, createdAt: new Date().toISOString() }); });
    }
    if (resetToken && emailConfigured()) { const link = `${(process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(resetToken)}`; try { await sendEmail({ to: resetRecipient.email, subject: 'Reset your AshkanBoard password', text: `Hello ${resetRecipient.name},\n\nUse this link within 15 minutes to reset your password: ${link}`, html: `<p>Hello ${escapeHtml(resetRecipient.name)},</p><p><a href="${escapeHtml(link)}">Reset your AshkanBoard password</a></p><p>This link expires in 15 minutes.</p>` }); } catch (error) { logEvent('error', 'email.delivery_failed', { purpose: 'password_reset', requestId, message: error.message }); } }
    const response = { ok: true, message: 'If the account exists, password reset instructions have been created.' }; if (resetToken && !production) response.developmentResetToken = resetToken; return json(res, 200, response);
   }
   if (req.method === 'POST' && path === '/api/auth/password/reset') {
    const input = await body(req); const tokenHash = hashToken(input.token || ''); const password = String(input.password || ''); if (password.length < 12) return json(res, 400, { error: 'Password must be at least 12 characters.' }); const passwordHash = await hashPassword(password); let changed = false;
    if (normalizedPersistence()) {
      const userId = await normalizedTransaction((client) => consumeNormalizedPasswordReset(client, tokenHash, passwordHash));
      if (userId) changed = true;
    } else {
      await legacyUpdateStore((data) => { const record = data.passwordResets.find((item) => item.tokenHash === tokenHash && !item.usedAt && new Date(item.expiresAt) > new Date()); if (!record) return; record.usedAt = new Date().toISOString(); const account = data.users.find((item) => item.id === record.userId); if (!account) return; account.passwordHash = passwordHash; data.refreshTokens.filter((item) => item.userId === account.id).forEach((item) => { item.revokedAt ||= new Date().toISOString(); }); changed = true; });
    }
    return changed ? json(res, 200, { ok: true }) : json(res, 400, { error: 'Reset token is invalid or expired.' });
   }
   const user = await authenticate(req, res); if (!user) return;
   const presenceRoute = path.match(/^\/api\/workspaces\/([^/]+)\/presence$/);
   if (presenceRoute) { const [, workspaceId] = presenceRoute;
    if (normalizedPersistence()) { const pool = await getPostgresPool(); const client = await pool.connect(); try { if (!allowed(res, await findNormalizedMembership(client,user.id,workspaceId), 'read')) return;
      if (req.method === 'POST') { await withClientTransaction(client,(tx)=>upsertNormalizedPresence(tx,workspaceId,user.id)); publish(workspaceId,{type:'presence.updated',userId:user.id}); return json(res,200,{ok:true}); }
      if (req.method === 'GET') return json(res,200,{online:await listNormalizedPresence(client,workspaceId)});
    } finally { client.release(); } }
    const snapshot = await legacyReadStore(); if (!allowed(res, membership(snapshot, user.id, workspaceId), 'read')) return;
    if (req.method === 'POST') { await legacyUpdateStore((data) => { data.presence ||= []; data.presence = data.presence.filter((item) => Date.parse(item.lastSeenAt) > Date.now() - 86_400_000 && (item.userId !== user.id || item.workspaceId !== workspaceId)); data.presence.push({ userId: user.id, workspaceId, lastSeenAt: new Date().toISOString() }); }); publish(workspaceId, { type: 'presence.updated', userId: user.id }); return json(res, 200, { ok: true }); }
    if (req.method === 'GET') { const cutoff = Date.now() - 60_000; const online = (snapshot.presence || []).filter((item) => item.workspaceId === workspaceId && Date.parse(item.lastSeenAt) > cutoff).map((item) => ({ user: cleanUser(snapshot.users.find((entry) => entry.id === item.userId)), lastSeenAt: item.lastSeenAt })).filter((item) => item.user); return json(res, 200, { online }); }
   }
   const eventsRoute = path.match(/^\/api\/workspaces\/([^/]+)\/events$/);
   if (eventsRoute && req.method === 'GET') { const [, workspaceId] = eventsRoute; if (normalizedPersistence()) { const pool = await getPostgresPool(); const client = await pool.connect(); try { if (!allowed(res, await findNormalizedMembership(client,user.id,workspaceId), 'read')) return; } finally { client.release(); } } else { const snapshot = await legacyReadStore(); if (!allowed(res, membership(snapshot, user.id, workspaceId), 'read')) return; } res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'access-control-allow-origin': ORIGIN }); res.write(`data: ${JSON.stringify({ type: 'connected', at: new Date().toISOString() })}\n\n`); if (!liveClients.has(workspaceId)) liveClients.set(workspaceId, new Set()); liveClients.get(workspaceId).add(res); const heartbeat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { clearInterval(heartbeat); } }, 20_000); const connectionExpiry = setTimeout(() => res.end(), 14 * 60_000); connectionExpiry.unref?.(); res.on('close', () => { clearInterval(heartbeat); clearTimeout(connectionExpiry); liveClients.get(workspaceId)?.delete(res); if (!liveClients.get(workspaceId)?.size) liveClients.delete(workspaceId); }); return; }
   const attachmentRoute = path.match(/^\/api\/workspaces\/([^/]+)\/tickets\/([^/]+)\/attachments(?:\/([^/]+))?$/);
   if (attachmentRoute) { const [, workspaceId, ticketId, attachmentId] = attachmentRoute;
    if (normalizedPersistence()) { const pool=await getPostgresPool(); const client=await pool.connect(); try {
      const member=await findNormalizedMembership(client,user.id,workspaceId); if(!allowed(res,member,req.method==='GET'?'read':req.method==='DELETE'?'update':'create')) return;
      const ticket=await findNormalizedTicket(client,workspaceId,ticketId); if(!ticket) return json(res,404,{error:'Ticket not found'});
      if(req.method==='GET'&&!attachmentId) { const attachments=await listNormalizedAttachments(client,workspaceId,ticketId); return json(res,200,{attachments:attachments.map(({storageName,...item})=>item)}); }
      if(req.method==='POST'&&!attachmentId) { const input=await body(req); const name=String(input.name||'').replace(/[\\/\r\n\0]/g,'').trim().slice(0,160); const mimeType=String(input.mimeType||''); const allowedTypes=['application/pdf','image/png','image/jpeg','image/webp','text/plain','text/csv']; const encoded=String(input.data||'').replace(/^data:[^,]*;base64,/,''); if(!name||!allowedTypes.includes(mimeType)||!encoded||encoded.length>6_800_000) return json(res,400,{error:'Unsupported file or file exceeds the 5 MB limit.'}); const buffer=Buffer.from(encoded,'base64'); if(!buffer.length||buffer.length>5*1024*1024) return json(res,400,{error:'File must be smaller than 5 MB.'}); const signatures={'application/pdf':buffer.subarray(0,5).toString()==='%PDF-','image/png':buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'image/jpeg':buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff,'image/webp':buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP','text/plain':!buffer.includes(0),'text/csv':!buffer.includes(0)}; if(!signatures[mimeType]) return json(res,400,{error:'File content does not match its declared type.'}); const id=randomUUID(); const storageName=`${id}.bin`; const dir=resolve(process.env.UPLOAD_DIR||'./data/uploads'); await mkdir(dir,{recursive:true}); await writeFile(join(dir,storageName),buffer,{flag:'wx',mode:0o600}); const attachment={id,workspaceId,ticketId,uploadedBy:user.id,name,mimeType,size:buffer.length,storageName,contentSha256:createHash('sha256').update(buffer).digest('hex'),createdAt:new Date().toISOString()}; try { await withClientTransaction(client,(tx)=>createNormalizedAttachment(tx,{attachment,auditId:randomUUID()})); } catch(error) { await unlink(join(dir,storageName)).catch(()=>{}); throw error; } const {storageName:omitted,contentSha256:checksumOmitted,...safe}=attachment; publish(workspaceId,{type:'attachment.created',entityId:ticketId}); return json(res,201,{attachment:safe}); }
      if(attachmentId&&req.method==='GET') { const item=(await listNormalizedAttachments(client,workspaceId,ticketId)).find((entry)=>entry.id===attachmentId); if(!item) return json(res,404,{error:'Attachment not found'}); const bytes=await readFile(join(resolve(process.env.UPLOAD_DIR||'./data/uploads'),item.storageName)); res.writeHead(200,{'content-type':item.mimeType,'content-length':bytes.length,'content-disposition':`${url.searchParams.get('inline')==='1'&&['application/pdf','image/png','image/jpeg','image/webp'].includes(item.mimeType)?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name)}`,'x-content-type-options':'nosniff','cache-control':'private, no-store'}); return res.end(bytes); }
      if(attachmentId&&req.method==='DELETE') { const deleted=await withClientTransaction(client,(tx)=>deleteNormalizedAttachment(tx,{workspaceId,ticketId,attachmentId,auditId:randomUUID(),actorId:user.id})); if(!deleted) return json(res,404,{error:'Attachment not found'}); await unlink(join(resolve(process.env.UPLOAD_DIR||'./data/uploads'),deleted.storage_name)).catch(()=>{}); publish(workspaceId,{type:'attachment.deleted',entityId:ticketId}); res.writeHead(204); return res.end(); }
    } finally { client.release(); } }
    const snapshot = await legacyReadStore(); if (!allowed(res, membership(snapshot, user.id, workspaceId), req.method === 'GET' ? 'read' : req.method === 'DELETE' ? 'update' : 'create')) return; const ticket = snapshot.tickets.find((item) => item.id === ticketId && item.workspaceId === workspaceId); if (!ticket) return json(res, 404, { error: 'Ticket not found' });
    if (req.method === 'GET' && !attachmentId) return json(res, 200, { attachments: (snapshot.attachments || []).filter((item) => item.workspaceId === workspaceId && item.ticketId === ticketId).map(({ storageName, ...item }) => item) });
    if (req.method === 'POST' && !attachmentId) { const input = await body(req); const name = String(input.name || '').replace(/[\\/\r\n\0]/g, '').trim().slice(0, 160); const mimeType = String(input.mimeType || ''); const allowedTypes = ['application/pdf','image/png','image/jpeg','image/webp','text/plain','text/csv']; const encoded = String(input.data || '').replace(/^data:[^,]*;base64,/, ''); if (!name || !allowedTypes.includes(mimeType) || !encoded || encoded.length > 6_800_000) return json(res, 400, { error: 'Unsupported file or file exceeds the 5 MB limit.' }); const buffer = Buffer.from(encoded, 'base64'); if (!buffer.length || buffer.length > 5 * 1024 * 1024) return json(res, 400, { error: 'File must be smaller than 5 MB.' }); const signatures = { 'application/pdf': buffer.subarray(0, 5).toString() === '%PDF-', 'image/png': buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'image/jpeg': buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff, 'image/webp': buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP', 'text/plain': !buffer.includes(0), 'text/csv': !buffer.includes(0) }; if (!signatures[mimeType]) return json(res, 400, { error: 'File content does not match its declared type.' }); const id = randomUUID(); const storageName = `${id}.bin`; const dir = resolve(process.env.UPLOAD_DIR || './data/uploads'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, storageName), buffer, { flag: 'wx', mode: 0o600 }); const attachment = { id, workspaceId, ticketId, uploadedBy: user.id, name, mimeType, size: buffer.length, storageName, contentSha256: createHash('sha256').update(buffer).digest('hex'), createdAt: new Date().toISOString() }; await legacyUpdateStore((data) => { data.attachments ||= []; data.attachments.push(attachment); audit(data, user, workspaceId, 'attachment.uploaded', 'attachment', id, { ticketId, name }); }); const { storageName: omitted, contentSha256: checksumOmitted, ...safe } = attachment; publish(workspaceId, { type: 'attachment.created', entityId: ticketId }); return json(res, 201, { attachment: safe }); }
    if (attachmentId && req.method === 'GET') { const item = (snapshot.attachments || []).find((entry) => entry.id === attachmentId && entry.ticketId === ticketId && entry.workspaceId === workspaceId); if (!item) return json(res, 404, { error: 'Attachment not found' }); const dir = resolve(process.env.UPLOAD_DIR || './data/uploads'); const bytes = await readFile(join(dir, item.storageName)); res.writeHead(200, { 'content-type': item.mimeType, 'content-length': bytes.length, 'content-disposition': `${url.searchParams.get('inline') === '1' && ['application/pdf','image/png','image/jpeg','image/webp'].includes(item.mimeType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' }); return res.end(bytes); }
    if (attachmentId && req.method === 'DELETE') { const item = (snapshot.attachments || []).find((entry) => entry.id === attachmentId && entry.ticketId === ticketId && entry.workspaceId === workspaceId); if (!item) return json(res, 404, { error: 'Attachment not found' }); await legacyUpdateStore((data) => { data.attachments = (data.attachments || []).filter((entry) => entry.id !== attachmentId); audit(data, user, workspaceId, 'attachment.deleted', 'attachment', attachmentId, { ticketId }); }); await unlink(join(resolve(process.env.UPLOAD_DIR || './data/uploads'), item.storageName)).catch(() => {}); publish(workspaceId, { type: 'attachment.deleted', entityId: ticketId }); res.writeHead(204); return res.end(); }
   }

   if (req.method === 'GET' && path === '/api/auth/security') {
    if (!normalizedPersistence()) return json(res, 200, { twoFactorEnabled: false, sessions: [], events: [] });
    const pool = await getPostgresPool(); const client = await pool.connect(); try { const settings = await getNormalizedSecuritySettings(client, user.id); return json(res, 200, { twoFactorEnabled: Boolean(settings?.totpEnabled), sessions: await listNormalizedUserSessions(client, user.id), events: await listNormalizedSecurityEvents(client, user.id, 50) }); } finally { client.release(); }
   }
   if (req.method === 'POST' && path === '/api/auth/2fa/setup') {
    if (!normalizedPersistence()) return json(res, 503, { error: 'Two-factor authentication requires normalized PostgreSQL persistence.' });
    const secret = generateTotpSecret(); const issuer = encodeURIComponent('AshkanBoard'); const label = encodeURIComponent(user.email); const otpauthUri = `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
    await normalizedTransaction((client) => setNormalizedTotpSecret(client, user.id, encryptSecret(secret))); await securityEvent(user.id, 'mfa.setup_started', req); return json(res, 200, { secret, otpauthUri });
   }
   if (req.method === 'POST' && path === '/api/auth/2fa/verify') {
    if (!normalizedPersistence()) return json(res, 503, { error: 'Two-factor authentication requires normalized PostgreSQL persistence.' });
    const input = await body(req); const pool = await getPostgresPool(); const client = await pool.connect(); try { const settings = await getNormalizedSecuritySettings(client, user.id); if (!settings?.totpSecretEnc) return json(res, 400, { error: 'Start two-factor setup first.' }); if (!verifyTotp(decryptSecret(settings.totpSecretEnc), input.otp)) return json(res, 400, { error: 'Invalid authentication code.' }); await withClientTransaction(client, (tx) => enableNormalizedTotp(tx, user.id)); } finally { client.release(); } await securityEvent(user.id, 'mfa.enabled', req); return json(res, 200, { ok: true, enabled: true });
   }
   if (req.method === 'DELETE' && path === '/api/auth/2fa') {
    if (!normalizedPersistence()) return json(res, 503, { error: 'Two-factor authentication requires normalized PostgreSQL persistence.' }); await normalizedTransaction((client) => disableNormalizedTotp(client, user.id)); await securityEvent(user.id, 'mfa.disabled', req); return json(res, 200, { ok: true, enabled: false });
   }
   if (req.method === 'GET' && path === '/api/auth/sessions') {
    if (!normalizedPersistence()) return json(res, 200, { sessions: [] }); const pool = await getPostgresPool(); const client = await pool.connect(); try { return json(res, 200, { sessions: await listNormalizedUserSessions(client, user.id) }); } finally { client.release(); }
   }
   const sessionRevokeRoute = path.match(/^\/api\/auth\/sessions\/([^/]+)\/revoke$/);
   if (sessionRevokeRoute && req.method === 'POST') {
    if (!normalizedPersistence()) return json(res, 503, { error: 'Session management requires normalized PostgreSQL persistence.' });
    const familyId = sessionRevokeRoute[1];
    if (!/^[0-9a-f-]{36}$/i.test(familyId)) return json(res, 400, { error: 'Invalid session identifier.' });
    const revoked = await normalizedTransaction((client) => revokeNormalizedSessionFamily(client, user.id, familyId));
    if (!revoked) return json(res, 404, { error: 'Session not found or already revoked.' });
    await securityEvent(user.id, 'session.revoked', req, { familyId });
    return json(res, 200, { ok: true, revoked });
   }
   if (req.method === 'POST' && path === '/api/auth/sessions/revoke-all') {
    if (!normalizedPersistence()) return json(res, 503, { error: 'Session management requires normalized PostgreSQL persistence.' }); await normalizedTransaction((client) => revokeNormalizedUserSessions(client, user.id)); await securityEvent(user.id, 'sessions.revoked_all', req); return json(res, 200, { ok: true });
   }
   if (req.method === 'GET' && path === '/api/auth/me') return json(res, 200, { user: cleanUser(user) });
   if (req.method === 'PATCH' && path === '/api/auth/me') { const input = await body(req); const name = String(input.name || '').trim(); if (name.length < 2 || name.length > 80) return json(res, 400, { error: 'Display name must be between 2 and 80 characters.' }); if (normalizedPersistence()) { const updated = await normalizedTransaction((client) => updateNormalizedUser(client, user.id, { name })); if (!updated) return json(res, 404, { error: 'User not found' }); return json(res, 200, { user: updated }); } let updated; await legacyUpdateStore((store) => { const record = store.users.find((item) => item.id === user.id); record.name = name; updated = cleanUser(record); }); return json(res, 200, { user: updated }); }
   if (req.method === 'GET' && path === '/api/workspaces') { if (normalizedPersistence()) { const pool = await getPostgresPool(); const client = await pool.connect(); try { return json(res, 200, { workspaces: await listNormalizedWorkspacesForUser(client, user.id) }); } finally { client.release(); } } const data = await legacyReadStore(); const memberships = data.memberships.filter((m) => m.userId === user.id); return json(res, 200, { workspaces: memberships.map((m) => ({ ...data.workspaces.find((w) => w.id === m.workspaceId), role: m.role })) }); }
   if (req.method === 'POST' && path === '/api/workspaces') { const input = await body(req); const name = String(input.name || '').trim(); if (name.length < 2 || name.length > 80) return json(res, 400, { error: 'Workspace name must be between 2 and 80 characters.' }); const workspace = { id: randomUUID(), name, description: String(input.description || '').slice(0, 240), createdAt: new Date().toISOString() }; if (normalizedPersistence()) { const created = await normalizedTransaction((client) => createNormalizedWorkspace(client, workspace, user.id)); return json(res, 201, { workspace: created }); } await legacyUpdateStore((store) => { store.workspaces.push(workspace); store.memberships.push({ userId: user.id, workspaceId: workspace.id, role: 'owner' }); }); return json(res, 201, { workspace: { ...workspace, role: 'owner' } }); }
   if (req.method === 'POST' && path === '/api/invitations/accept') {
    const input = await body(req); const tokenHash = hashToken(input.token || ''); let accepted;
    if (normalizedPersistence()) {
      accepted = await normalizedTransaction((client) => acceptNormalizedInvitation(client, { tokenHash, userId: user.id, email: user.email, auditId: randomUUID() }));
    } else {
      await legacyUpdateStore((data) => { const invite = data.invitations.find((item) => item.tokenHash === tokenHash && !item.acceptedAt && new Date(item.expiresAt) > new Date()); if (!invite) return; const invitee = data.users.find((item) => item.id === user.id); if (!invitee || invitee.email !== invite.email) return; if (membership(data, user.id, invite.workspaceId)) { invite.acceptedAt = new Date().toISOString(); accepted = { workspaceId: invite.workspaceId, alreadyMember: true }; return; } data.memberships.push({ userId: user.id, workspaceId: invite.workspaceId, role: invite.role, joinedAt: new Date().toISOString() }); invite.acceptedAt = new Date().toISOString(); audit(data, user, invite.workspaceId, 'member.invitation_accepted', 'membership', user.id, { role: invite.role }); accepted = { workspaceId: invite.workspaceId, role: invite.role }; });
    }
    return accepted ? json(res, 200, { invitation: accepted }) : json(res, 400, { error: 'Invitation is invalid, expired, or belongs to another email address.' });
   }
   const inviteRoute = path.match(/^\/api\/workspaces\/([^/]+)\/invitations$/);
   if (inviteRoute && req.method === 'POST') {
    const workspaceId = inviteRoute[1]; const input = await body(req); const email = String(input.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: 'A valid email address is required.' });
    const role = ['admin','member','viewer'].includes(input.role) ? input.role : 'member';
    const token = randomToken(32); const createdAt = new Date(); const invitation = { id: randomUUID(), workspaceId, email, role, tokenHash: hashToken(token), invitedBy: user.id, createdAt, expiresAt: new Date(createdAt.getTime() + 7 * 86400_000), auditId: randomUUID() };
    if (normalizedPersistence()) {
      const outcome = await normalizedTransaction(async (client) => {
        const inviter = await findNormalizedMembership(client, user.id, workspaceId);
        if (!permissions[inviter?.role]?.includes('members')) return { status: 403 };
        const target = await findNormalizedUserByEmail(client, email);
        if (!target) return { status: 404 };
        const existing = await findNormalizedMembership(client, target.id, workspaceId);
        if (existing) return { status: 409 };
        await createNormalizedInvitation(client, invitation);
        return { status: 201 };
      });
      if (outcome.status === 403) return json(res, 403, { error: 'Insufficient workspace permission' });
      if (outcome.status === 404) return json(res, 404, { error: 'The invited user must create an account before accepting this invitation.' });
      if (outcome.status === 409) return json(res, 409, { error: 'User is already a workspace member.' });
    } else {
      const data = await legacyReadStore(); if (!allowed(res, membership(data, user.id, workspaceId), 'members')) return;
      const target = data.users.find((item) => item.email === email); if (!target) return json(res, 404, { error: 'The invited user must create an account before accepting this invitation.' });
      if (membership(data, target.id, workspaceId)) return json(res, 409, { error: 'User is already a workspace member.' });
      await legacyUpdateStore((store) => { store.invitations = store.invitations.filter((item) => !(item.workspaceId === workspaceId && item.email === email && !item.acceptedAt)); store.invitations.push({ ...invitation, createdAt: createdAt.toISOString(), expiresAt: invitation.expiresAt.toISOString(), auditId: undefined }); audit(store, user, workspaceId, 'member.invited', 'invitation', email, { role }); });
    }
    if (emailConfigured()) { const link = `${(process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '')}/accept-invitation?token=${encodeURIComponent(token)}`; try { await sendEmail({ to: email, subject: 'You are invited to AshkanBoard', text: `You have been invited to join a workspace as ${role}. Accept within 7 days: ${link}`, html: `<p>You have been invited to join a workspace as <strong>${escapeHtml(role)}</strong>.</p><p><a href="${escapeHtml(link)}">Accept invitation</a></p><p>This link expires in 7 days.</p>` }); } catch (error) { logEvent('error', 'email.delivery_failed', { purpose: 'workspace_invitation', requestId, message: error.message }); } }
    const result = { ok: true, expiresInDays: 7 }; if (!production) result.developmentInvitationToken = token; return json(res, 201, result);
   }
   const memberRoute = path.match(/^\/api\/workspaces\/([^/]+)\/members(?:\/([^/]+))?$/);
   if (memberRoute) {
    const [, workspaceId, targetUserId] = memberRoute;
    if (normalizedPersistence()) {
      const pool = await getPostgresPool(); const client = await pool.connect(); let clientReleased = false;
      try {
        const current = await findNormalizedMembership(client, user.id, workspaceId);
        if (req.method === 'GET' && !targetUserId) { if (!allowed(res, current, 'members')) return; return json(res, 200, { members: await listNormalizedMembers(client, workspaceId) }); }
        if (req.method === 'POST' && !targetUserId) {
          if (!allowed(res, current, 'members')) return;
          const input = await body(req); const email = String(input.email || '').trim().toLowerCase();
          if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: 'A valid email address is required.' });
          const target = await findNormalizedUserByEmail(client, email);
          if (!target) return json(res, 404, { error: 'User not found. The invite-by-email workflow requires an existing account.' });
          const requestedRole = String(input.role || 'member').trim().toLowerCase();
          const roleExists = await client.query('SELECT 1 FROM workspace_roles WHERE workspace_id=$1 AND role_key=$2', [workspaceId, requestedRole]);
          const role = roleExists.rowCount ? requestedRole : 'member';
          const joinedAt = new Date().toISOString();
          const added = await withClientTransaction(client, async (tx) => {
            const membershipRow = await addNormalizedMembership(tx, { workspaceId, userId: target.id, role, joinedAt });
            if (membershipRow) await insertNormalizedAudit(tx, { id: randomUUID(), workspaceId, actorId: user.id, action: 'member.added', entityType: 'membership', entityId: target.id, metadata: { email, role } });
            return membershipRow;
          });
          if (!added) return json(res, 409, { error: 'User is already a workspace member.' });
          client.release(); clientReleased = true;
          return json(res, 201, { member: { user: cleanUser(target), role, joinedAt } });
        }
        if (req.method === 'PATCH' && targetUserId) {
          if (!allowed(res, current, 'roles')) return;
          const input = await body(req); const role = String(input.role || '').trim().toLowerCase();
          const roleExists = await client.query('SELECT 1 FROM workspace_roles WHERE workspace_id=$1 AND role_key=$2', [workspaceId, role]);
          if (!roleExists.rowCount) return json(res, 400, { error: 'Invalid role.' });
          if (targetUserId === user.id) return json(res, 400, { error: 'You cannot change your own role.' });
          const updated = await withClientTransaction(client, async (tx) => {
            const row = await updateNormalizedMembershipRole(tx, workspaceId, targetUserId, role);
            if (row) await insertNormalizedAudit(tx, { id: randomUUID(), workspaceId, actorId: user.id, action: 'member.role_changed', entityType: 'membership', entityId: targetUserId, metadata: { role } });
            return row;
          });
          if (!updated) return json(res, 404, { error: 'Member not found or role cannot be changed.' });
          client.release(); clientReleased = true;
          return json(res, 200, { ok: true, role });
        }
        if (req.method === 'DELETE' && targetUserId) {
          if (!allowed(res, current, 'members')) return;
          const removed = await withClientTransaction(client, async (tx) => {
            const didRemove = await removeNormalizedMembership(tx, workspaceId, targetUserId);
            if (didRemove) await insertNormalizedAudit(tx, { id: randomUUID(), workspaceId, actorId: user.id, action: 'member.removed', entityType: 'membership', entityId: targetUserId });
            return didRemove;
          });
          if (!removed) return json(res, 404, { error: 'Member not found or owner cannot be removed.' });
          client.release(); clientReleased = true;
          res.writeHead(204); return res.end();
        }
      } finally { if (!clientReleased) client.release(); }
    }
    if (req.method === 'GET' && !targetUserId) { const data = await legacyReadStore(); const current = membership(data, user.id, workspaceId); if (!allowed(res, current, 'members')) return; const members = data.memberships.filter((m) => m.workspaceId === workspaceId).map((m) => ({ ...m, user: cleanUser(data.users.find((u) => u.id === m.userId)) })); return json(res, 200, { members }); }
    if (req.method === 'POST' && !targetUserId) { const currentData = await legacyReadStore(); if (!allowed(res, membership(currentData, user.id, workspaceId), 'members')) return; const input = await body(req); const email = String(input.email || '').trim().toLowerCase(); const target = currentData.users.find((u) => u.email === email); if (!target) return json(res, 404, { error: 'User not found. The invite-by-email workflow requires an existing account in this phase.' }); if (membership(currentData, target.id, workspaceId)) return json(res, 409, { error: 'User is already a workspace member.' }); const role = ['admin','member','viewer'].includes(input.role) ? input.role : 'member'; await legacyUpdateStore((data) => { data.memberships.push({ userId: target.id, workspaceId, role, joinedAt: new Date().toISOString() }); audit(data, user, workspaceId, 'member.added', 'membership', target.id, { email, role }); }); return json(res, 201, { member: { user: cleanUser(target), role } }); }
    if (req.method === 'PATCH' && targetUserId) { const data = await legacyReadStore(); if (!allowed(res, membership(data, user.id, workspaceId), 'roles')) return; const input = await body(req); const role = input.role; if (!['admin','member','viewer'].includes(role)) return json(res, 400, { error: 'Invalid role.' }); if (targetUserId === user.id) return json(res, 400, { error: 'You cannot change your own role.' }); let updated = false; await legacyUpdateStore((store) => { const target = membership(store, targetUserId, workspaceId); if (!target || target.role === 'owner') return; target.role = role; audit(store, user, workspaceId, 'member.role_changed', 'membership', targetUserId, { role }); updated = true; }); return updated ? json(res, 200, { ok: true, role }) : json(res, 404, { error: 'Member not found or role cannot be changed.' }); }
    if (req.method === 'DELETE' && targetUserId) { const data = await legacyReadStore(); if (!allowed(res, membership(data, user.id, workspaceId), 'members')) return; let removed = false; await legacyUpdateStore((store) => { const target = membership(store, targetUserId, workspaceId); if (!target || target.role === 'owner') return; store.memberships = store.memberships.filter((m) => !(m.userId === targetUserId && m.workspaceId === workspaceId)); audit(store, user, workspaceId, 'member.removed', 'membership', targetUserId); removed = true; }); return removed ? json(res, 204, null) : json(res, 404, { error: 'Member not found or owner cannot be removed.' }); }
   }
   const rolesRoute = path.match(/^\/api\/workspaces\/([^/]+)\/roles(?:\/([^/]+))?$/);
   if (rolesRoute) {
    if (!normalizedPersistence()) return json(res, 503, { error: 'Advanced RBAC requires normalized PostgreSQL persistence.' });
    const [, workspaceId, roleKey] = rolesRoute;
    const pool = await getPostgresPool(); const client = await pool.connect();
    try {
      const current = await findNormalizedMembership(client, user.id, workspaceId);
      if (req.method === 'GET' && !roleKey) { if (!allowed(res, current, 'roles')) return; return json(res, 200, { roles: await listNormalizedRoles(client, workspaceId) }); }
      if (req.method === 'POST' && !roleKey) {
        if (!allowed(res, current, 'roles')) return;
        const input = await body(req); const key = String(input.key || '').trim().toLowerCase(); const name = String(input.name || '').trim();
        const permissionsInput = Array.isArray(input.permissions) ? [...new Set(input.permissions.map((item) => String(item).trim()).filter(Boolean))] : [];
        if (!/^[a-z][a-z0-9_-]{1,39}$/.test(key) || ['owner','admin','member','viewer'].includes(key)) return json(res, 400, { error: 'Role key is invalid or reserved.' });
        if (name.length < 2 || name.length > 80) return json(res, 400, { error: 'Role name must be between 2 and 80 characters.' });
        const allowedPermissions = new Set(['read','create','update','delete','members','roles','audit']);
        if (permissionsInput.some((item) => !allowedPermissions.has(item))) return json(res, 400, { error: 'One or more permissions are invalid.' });
        try { const role = await createNormalizedRole(client, { workspaceId, key, name, permissions: permissionsInput }); return json(res, 201, { role }); }
        catch (error) { if (error.code === '23505') return json(res, 409, { error: 'A role with this key already exists.' }); throw error; }
      }
      if (req.method === 'PATCH' && roleKey) {
        if (!allowed(res, current, 'roles')) return;
        const input = await body(req); const name = input.name === undefined ? undefined : String(input.name || '').trim(); const permissionsInput = input.permissions === undefined ? undefined : [...new Set((Array.isArray(input.permissions) ? input.permissions : []).map((item) => String(item).trim()).filter(Boolean))];
        const allowedPermissions = new Set(['read','create','update','delete','members','roles','audit']);
        if (name !== undefined && (name.length < 2 || name.length > 80)) return json(res, 400, { error: 'Role name must be between 2 and 80 characters.' });
        if (permissionsInput?.some((item) => !allowedPermissions.has(item))) return json(res, 400, { error: 'One or more permissions are invalid.' });
        const role = await updateNormalizedRole(client, workspaceId, roleKey, { name, permissions: permissionsInput }); return role ? json(res, 200, { role }) : json(res, 404, { error: 'Custom role not found or cannot be changed.' });
      }
      if (req.method === 'DELETE' && roleKey) {
        if (!allowed(res, current, 'roles')) return;
        const assigned = await client.query('SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND role=$2 LIMIT 1',[workspaceId,roleKey]);
        if (assigned.rowCount) return json(res, 409, { error: 'Role is assigned to one or more members.' });
        const removed = await deleteNormalizedRole(client, workspaceId, roleKey); return removed ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Custom role not found or cannot be deleted.' });
      }
    } finally { client.release(); }
   }
   const roleMappingsRoute = path.match(/^\/api\/workspaces\/([^/]+)\/role-mappings(?:\/([^/]+))?$/);
   if (roleMappingsRoute) {
    if (!normalizedPersistence()) return json(res, 503, { error: 'Identity role mappings require normalized PostgreSQL persistence.' });
    const [, workspaceId, mappingId] = roleMappingsRoute;
    const pool = await getPostgresPool(); const client = await pool.connect();
    try {
      const current = await findNormalizedMembership(client, user.id, workspaceId);
      if (!allowed(res, current, 'roles')) return;
      if (req.method === 'GET' && !mappingId) return json(res, 200, { mappings: await listNormalizedRoleMappings(client, workspaceId) });
      if (req.method === 'POST' && !mappingId) {
        const input = await body(req); const source = String(input.source || '').trim().toLowerCase(); const claim = String(input.claim || '').trim(); const matchValue = String(input.matchValue || '').trim(); const roleKey = String(input.roleKey || '').trim(); const priority = Number.isInteger(input.priority) ? input.priority : Number(input.priority ?? 100); const enabled = input.enabled !== false;
        if (!['oidc','scim'].includes(source) || !claim || claim.length > 80 || !matchValue || matchValue.length > 200 || !/^[a-z][a-z0-9_-]{1,39}$/.test(roleKey) || !Number.isInteger(priority) || priority < 0 || priority > 10000) return json(res,400,{error:'Invalid role mapping.'});
        const role = await client.query('SELECT 1 FROM workspace_roles WHERE workspace_id=$1 AND role_key=$2',[workspaceId,roleKey]); if (!role.rowCount) return json(res,400,{error:'Role does not exist in this workspace.'});
        try { return json(res,201,{mapping:await createNormalizedRoleMapping(client,{workspaceId,source,claim,matchValue,roleKey,priority,enabled})}); } catch(error) { if(error.code==='23505') return json(res,409,{error:'This mapping already exists.'}); throw error; }
      }
      if (req.method === 'PATCH' && mappingId) { const input=await body(req); const mapping=await updateNormalizedRoleMapping(client,mappingId,{source:input.source,claim:input.claim,matchValue:input.matchValue,roleKey:input.roleKey,priority:input.priority,enabled:input.enabled}); return mapping ? json(res,200,{mapping}) : json(res,404,{error:'Mapping not found.'}); }
      if (req.method === 'DELETE' && mappingId) return (await deleteNormalizedRoleMapping(client,mappingId)) ? json(res,200,{ok:true}) : json(res,404,{error:'Mapping not found.'});
    } finally { client.release(); }
   }
   const webhooksRoute = path.match(/^\/api\/workspaces\/([^/]+)\/webhooks(?:\/([^/]+))?$/);
   if (webhooksRoute) {
    const [, workspaceId, webhookId] = webhooksRoute;
    const pool = await getPostgresPool(); const client = await pool.connect();
    try {
      const current = await findNormalizedMembership(client, user.id, workspaceId);
      if (!allowed(res, current, 'roles')) return;
      const allowedEvents = new Set(['ticket.created','ticket.updated','ticket.deleted','comment.created','comment.deleted','member.updated','notification.created']);
      if (req.method === 'GET' && !webhookId) return json(res, 200, { webhooks: await listNormalizedWebhooks(client, workspaceId) });
      if (req.method === 'POST' && !webhookId) {
        const input = await body(req); const name=String(input.name||'').trim(); const endpointUrl=String(input.endpointUrl||'').trim(); const events=Array.isArray(input.events)?[...new Set(input.events.map(String).filter((e)=>allowedEvents.has(e)))]:[];
        let parsed; try { parsed=new URL(endpointUrl); } catch { return json(res,400,{error:'Invalid webhook URL.'}); }
        if (!name || name.length>80 || !/^https?:$/.test(parsed.protocol) || (production && parsed.protocol!=='https:') || !events.length || events.length>20) return json(res,400,{error:'Invalid webhook configuration.'});
        const secret=randomToken(); const secretHash=hashToken(secret); const secretEnc=encryptSecret(secret);
        try { const webhook=await createNormalizedWebhook(client,{workspaceId,name,endpointUrl,secretHash,secretEnc,events,createdBy:user.id}); return json(res,201,{webhook,secret}); } catch(error) { if(error.code==='23505') return json(res,409,{error:'A webhook with this name already exists.'}); throw error; }
      }
      if (req.method === 'DELETE' && webhookId) return (await deleteNormalizedWebhook(client,webhookId)) ? json(res,200,{ok:true}) : json(res,404,{error:'Webhook not found.'});
      if (req.method === 'GET' && webhookId) {
        const rows=await client.query('SELECT id FROM workspace_webhooks WHERE id=$1 AND workspace_id=$2',[webhookId,workspaceId]); if(!rows.rows[0]) return json(res,404,{error:'Webhook not found.'});
        if (url.searchParams.get('action') === 'stats') return json(res,200,{summary:await getNormalizedWebhookDeliverySummary(client,webhookId)});
        if (url.searchParams.get('action') === 'retention-stats') return json(res,200,{retention:await getNormalizedWebhookRetentionStats(client,webhookId)});
        if (url.searchParams.get('action') === 'retention-preview') return json(res,200,{retention:await getNormalizedWebhookRetentionPreview(client,webhookId)});
        if (url.searchParams.get('action') === 'retention-policy-preview') { const nextDays=Number(url.searchParams.get('days')); if (!Number.isInteger(nextDays) || nextDays<1 || nextDays>3650) return json(res,400,{error:'Invalid retention preview days.'}); return json(res,200,{impact:await getNormalizedWebhookRetentionPolicyImpact(client,webhookId,nextDays)}); }
        if (url.searchParams.get('action') === 'delivery-search') { const rawBool=(value)=>value===null?null:value==='true'?true:value==='false'?false:undefined; const delivered=rawBool(url.searchParams.get('delivered')); const deadLettered=rawBool(url.searchParams.get('deadLettered')); if (delivered===undefined || deadLettered===undefined) return json(res,400,{error:'Invalid delivery search boolean filter.'}); const limit=Number(url.searchParams.get('limit')||50); const offset=Number(url.searchParams.get('offset')||0); if (!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0) return json(res,400,{error:'Invalid delivery search pagination.'}); const result=await searchNormalizedWebhookDeliveries(client,webhookId,{status:url.searchParams.get('status'),delivered,deadLettered,eventType:url.searchParams.get('eventType'),from:url.searchParams.get('from'),to:url.searchParams.get('to'),limit,offset}); return json(res,200,result); }
        if (url.searchParams.get('action') === 'dead-letter') return json(res,200,{deliveries:await listNormalizedWebhookDeadLetters(client,webhookId,url.searchParams.get('limit'))});
        return json(res,200,{deliveries:await listNormalizedWebhookDeliveries(client,webhookId,url.searchParams.get('limit'))});
      }
      if (req.method === 'POST' && webhookId && url.searchParams.get('action') === 'requeue-dead-letter') {
        if (!allowed(res, await findNormalizedMembership(client,user.id,workspaceId), 'update')) return;
        const deliveryId=url.searchParams.get('deliveryId');
        const delivery=await requeueNormalizedWebhookDeadLetter(client,webhookId,deliveryId);
        if (!delivery) return json(res,404,{error:'Dead-letter delivery not found.'});
        logEvent('info','webhook.dead_letter.requeued',{webhookId,workspaceId,deliveryId,userId:user.id});
        return json(res,200,{delivery});
      }
      if (req.method === 'DELETE' && webhookId && url.searchParams.get('action') === 'discard-dead-letter') {
        if (!allowed(res, await findNormalizedMembership(client,user.id,workspaceId), 'update')) return;
        const deliveryId=url.searchParams.get('deliveryId');
        const delivery=await discardNormalizedWebhookDeadLetter(client,webhookId,deliveryId);
        if (!delivery) return json(res,404,{error:'Dead-letter delivery not found.'});
        logEvent('info','webhook.dead_letter.discarded',{webhookId,workspaceId,deliveryId,userId:user.id});
        return json(res,200,{ok:true});
      }
      if (req.method === 'DELETE' && webhookId && url.searchParams.get('action') === 'discard-dead-letters') {
        if (!allowed(res, await findNormalizedMembership(client,user.id,workspaceId), 'update')) return;
        const limitRaw=url.searchParams.get('limit'); const limit=limitRaw===null ? 100 : Number(limitRaw);
        if (!Number.isInteger(limit) || limit<1 || limit>500) return json(res,400,{error:'Invalid dead-letter discard limit.'});
        const deliveries=await discardNormalizedWebhookDeadLetters(client,webhookId,limit);
        if (deliveries.length) logEvent('info','webhook.dead_letter.bulk_discarded',{webhookId,workspaceId,count:deliveries.length,userId:user.id});
        return json(res,200,{ok:true,discardedCount:deliveries.length});
      }
      if (req.method === 'POST' && webhookId && url.searchParams.get('action') === 'requeue-dead-letters') {
        if (!allowed(res, await findNormalizedMembership(client,user.id,workspaceId), 'update')) return;
        const limitRaw=url.searchParams.get('limit'); const limit=limitRaw===null ? 100 : Number(limitRaw);
        if (!Number.isInteger(limit) || limit<1 || limit>500) return json(res,400,{error:'Invalid dead-letter requeue limit.'});
        const deliveries=await requeueNormalizedWebhookDeadLetters(client,webhookId,limit);
        if (deliveries.length) logEvent('info','webhook.dead_letter.bulk_requeued',{webhookId,workspaceId,count:deliveries.length,userId:user.id});
        return json(res,200,{ok:true,requeuedCount:deliveries.length,deliveries});
      }
      if (req.method === 'POST' && webhookId && url.searchParams.get('action') === 'recover-circuit') {
        if (!allowed(res, await findNormalizedMembership(client,user.id,workspaceId), 'update')) return;
        const rows=await client.query('SELECT id FROM workspace_webhooks WHERE id=$1 AND workspace_id=$2',[webhookId,workspaceId]); if(!rows.rows[0]) return json(res,404,{error:'Webhook not found.'});
        const webhook=await recoverNormalizedWebhookCircuit(client,webhookId);
        if (!webhook) return json(res,409,{error:'Webhook circuit is not currently open.'});
        logEvent('info','webhook.circuit.recovered',{webhookId,workspaceId,userId:user.id});
        return json(res,200,{webhook});
      }
      if (req.method === 'PATCH' && webhookId && url.searchParams.get('action') === 'circuit-policy') {
        const input=await body(req); const failureThreshold=Number(input.failureThreshold); const circuitRecoverySeconds=Number(input.circuitRecoverySeconds);
        if (!Number.isInteger(failureThreshold) || failureThreshold<1 || failureThreshold>100 || !Number.isInteger(circuitRecoverySeconds) || circuitRecoverySeconds<30 || circuitRecoverySeconds>86400 || typeof input.circuitBreakerEnabled !== 'boolean') return json(res,400,{error:'Invalid circuit breaker policy.'});
        const rows=await client.query('SELECT id FROM workspace_webhooks WHERE id=$1 AND workspace_id=$2',[webhookId,workspaceId]); if(!rows.rows[0]) return json(res,404,{error:'Webhook not found.'});
        const webhook=await updateNormalizedWebhookCircuitPolicy(client,webhookId,{circuitBreakerEnabled:input.circuitBreakerEnabled,failureThreshold,circuitRecoverySeconds});
        return json(res,200,{webhook});
      }
      if (req.method === 'PATCH' && webhookId && url.searchParams.get('action') === 'retention-policy') {
        const input=await body(req); const deliveryRetentionDays=Number(input.deliveryRetentionDays);
        if (!Number.isInteger(deliveryRetentionDays) || deliveryRetentionDays<1 || deliveryRetentionDays>3650) return json(res,400,{error:'Invalid delivery retention policy.'});
        const rows=await client.query('SELECT id FROM workspace_webhooks WHERE id=$1 AND workspace_id=$2',[webhookId,workspaceId]); if(!rows.rows[0]) return json(res,404,{error:'Webhook not found.'});
        return json(res,200,{webhook:await updateNormalizedWebhookRetentionPolicy(client,webhookId,{deliveryRetentionDays})});
      }
      if (req.method === 'POST' && webhookId && url.searchParams.get('action') === 'purge-retention') {
        if (!allowed(res, await findNormalizedMembership(client,user.id,workspaceId), 'update')) return;
        const limitRaw=url.searchParams.get('limit'); const limit=limitRaw===null ? 500 : Number(limitRaw);
        if (!Number.isInteger(limit) || limit<1 || limit>5000) return json(res,400,{error:'Invalid purge limit.'});
        const deleted=await purgeExpiredNormalizedWebhookDeliveries(client,{limit,webhookId});
        if (deleted.length) logEvent('info','webhook.delivery.retention_manual_purged',{count:deleted.length,webhookId,workspaceId,userId:user.id});
        return json(res,200,{ok:true,deletedCount:deleted.length,deliveryIds:deleted.map((item)=>item.id)});
      }
      if (req.method === 'PATCH' && webhookId && url.searchParams.get('action') === 'retry-policy') {
        const input=await body(req); const maxAttempts=Number(input.maxAttempts); const retryDelaySeconds=Number(input.retryDelaySeconds);
        if (!Number.isInteger(maxAttempts) || maxAttempts<1 || maxAttempts>10 || !Number.isInteger(retryDelaySeconds) || retryDelaySeconds<0 || retryDelaySeconds>86400) return json(res,400,{error:'Invalid retry policy.'});
        const rows=await client.query('SELECT id FROM workspace_webhooks WHERE id=$1 AND workspace_id=$2',[webhookId,workspaceId]); if(!rows.rows[0]) return json(res,404,{error:'Webhook not found.'});
        return json(res,200,{webhook:await updateNormalizedWebhookRetryPolicy(client,webhookId,{maxAttempts,retryDelaySeconds})});
      }
      if (req.method === 'PATCH' && webhookId) { const input=await body(req); const webhook=await updateNormalizedWebhook(client,webhookId,{name:input.name,endpointUrl:input.endpointUrl,events:Array.isArray(input.events)?input.events:undefined,enabled:typeof input.enabled==='boolean'?input.enabled:undefined}); return webhook ? json(res,200,{webhook}) : json(res,404,{error:'Webhook not found.'}); }
      if (req.method === 'POST' && webhookId && url.searchParams.get('action') === 'rotate-secret') {
        const rows=await client.query('SELECT id FROM workspace_webhooks WHERE id=$1 AND workspace_id=$2',[webhookId,workspaceId]); if(!rows.rows[0]) return json(res,404,{error:'Webhook not found.'});
        const secret=randomToken(); const rotated=await rotateNormalizedWebhookSecret(client,webhookId,{secretHash:hashToken(secret),secretEnc:encryptSecret(secret)}); return json(res,200,{secret,webhook:rotated});
      }
      if (req.method === 'POST' && webhookId && url.searchParams.get('action') === 'replay') {
        if (!allowed(res, await findNormalizedMembership(client,user.id,workspaceId), 'update')) return;
        const deliveryId=url.searchParams.get('deliveryId');
        const delivery=await getNormalizedWebhookDelivery(client,webhookId,deliveryId);
        if (!delivery) return json(res,404,{error:'Delivery not found.'});
        const policyRows=await client.query('SELECT max_attempts AS "maxAttempts",retry_delay_seconds AS "retryDelaySeconds" FROM workspace_webhooks WHERE id=$1 AND workspace_id=$2',[webhookId,workspaceId]);
        const policy=policyRows.rows[0]; if (!policy) return json(res,404,{error:'Webhook not found.'});
        if (delivery.deadLettered || delivery.attempt >= Number(policy.maxAttempts)) return json(res,409,{error:'Delivery has reached the configured retry limit and is dead-lettered.'});
        if (!delivery.payload) return json(res,409,{error:'This delivery has no stored payload and cannot be replayed.'});
        const rows=await client.query('SELECT id,endpoint_url AS "endpointUrl" FROM workspace_webhooks WHERE id=$1 AND workspace_id=$2',[webhookId,workspaceId]);
        const webhook=rows.rows[0]; if(!webhook) return json(res,404,{error:'Webhook not found.'});
        const secretRecord=await getNormalizedWebhookSecret(client,webhookId); const webhookSecret=decryptSecret(secretRecord?.secretEnc); const timestamp=Math.floor(Date.now()/1000);
        const replayPayload={...delivery.payload,replayOf:delivery.id,replayedAt:new Date().toISOString()};
        const signature=createHash('sha256').update(`${timestamp}.${webhookSecret}.${JSON.stringify(replayPayload)}`).digest('hex');
        try { const response=await fetch(webhook.endpointUrl,{method:'POST',headers:{'content-type':'application/json','user-agent':'AshkanBoard-Webhooks/1.0','x-ashkan-event':delivery.eventType,'x-ashkan-replay':'true','x-ashkan-signature-version':'1','x-ashkan-signature':`t=${timestamp},v1=${signature}`},body:JSON.stringify(replayPayload),signal:AbortSignal.timeout(5000)}); await recordNormalizedWebhookDelivery(client,webhookId,{status:response.status,delivered:response.ok}); await recordNormalizedWebhookDeliveryAttempt(client,{webhookId,eventType:delivery.eventType,status:response.status,delivered:response.ok,attempt:delivery.attempt+1,payload:replayPayload,deadLettered:!response.ok && delivery.attempt+1>=Number(policy.maxAttempts),nextRetryAt:!response.ok && delivery.attempt+1<Number(policy.maxAttempts)?new Date(Date.now()+Number(policy.retryDelaySeconds)*1000):null}); return json(res,response.ok?200:502,{ok:response.ok,status:response.status,replayedFrom:delivery.id}); } catch(error) { await recordNormalizedWebhookDelivery(client,webhookId,{status:null,delivered:false}); await recordNormalizedWebhookDeliveryAttempt(client,{webhookId,eventType:delivery.eventType,status:null,delivered:false,attempt:delivery.attempt+1,errorMessage:error.message,payload:replayPayload,deadLettered:delivery.attempt+1>=Number(policy.maxAttempts),nextRetryAt:delivery.attempt+1<Number(policy.maxAttempts)?new Date(Date.now()+Number(policy.retryDelaySeconds)*1000):null}); return json(res,502,{error:'Webhook replay failed.'}); }
      }
      if (req.method === 'POST' && webhookId) {
        const rows=await client.query('SELECT id,workspace_id AS "workspaceId",name,endpoint_url AS "endpointUrl",events,enabled FROM workspace_webhooks WHERE id=$1 AND workspace_id=$2',[webhookId,workspaceId]); const webhook=rows.rows[0]; if(!webhook) return json(res,404,{error:'Webhook not found.'});
        const payload={id:randomUUID(),event:'webhook.test',workspaceId,occurredAt:new Date().toISOString(),data:{message:'AshkanBoard webhook test'}}; const secretRecord=await getNormalizedWebhookSecret(client,webhookId); const webhookSecret=decryptSecret(secretRecord?.secretEnc); const timestamp=Math.floor(Date.now()/1000);
        const signature=createHash('sha256').update(`${timestamp}.${webhookSecret}.${JSON.stringify(payload)}`).digest('hex');
        try { const response=await fetch(webhook.endpointUrl,{method:'POST',headers:{'content-type':'application/json','user-agent':'AshkanBoard-Webhooks/1.0','x-ashkan-event':'webhook.test','x-ashkan-signature-version':'1','x-ashkan-signature':`t=${timestamp},v1=${signature}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(5000)}); await recordNormalizedWebhookDelivery(client,webhookId,{status:response.status,delivered:response.ok}); await recordNormalizedWebhookDeliveryAttempt(client,{webhookId,eventType:'webhook.test',status:response.status,delivered:response.ok,attempt:1,payload}); return json(res,response.ok?200:502,{ok:response.ok,status:response.status,signatureVersion:1}); } catch(error) { await recordNormalizedWebhookDelivery(client,webhookId,{status:null,delivered:false}); await recordNormalizedWebhookDeliveryAttempt(client,{webhookId,eventType:'webhook.test',status:null,delivered:false,attempt:1,errorMessage:error.message,payload}); return json(res,502,{error:'Webhook delivery failed.'}); }
      }
    } finally { client.release(); }
   }
   const notificationPreferencesRoute = path.match(/^\/api\/workspaces\/([^/]+)\/notification-preferences$/);
   if (notificationPreferencesRoute) {
    const [, workspaceId] = notificationPreferencesRoute;
    const pool = await getPostgresPool(); const client = await pool.connect();
    try {
      const current = await findNormalizedMembership(client, user.id, workspaceId);
      if (!current) return json(res, 403, { error: 'Workspace access required.' });
      if (req.method === 'GET') return json(res, 200, { preferences: await getNormalizedNotificationPreferences(client, workspaceId, user.id) });
      if (req.method === 'PATCH') {
        const input = await body(req);
        const allowedKeys = ['notificationsEnabled','mentionEnabled','ticketUpdatesEnabled','commentsEnabled','systemEnabled'];
        if (Object.keys(input).some((key) => !allowedKeys.includes(key) || typeof input[key] !== 'boolean')) return json(res, 400, { error: 'Notification preferences must contain only boolean fields.' });
        return json(res, 200, { preferences: await upsertNormalizedNotificationPreferences(client, workspaceId, user.id, input) });
      }
      return json(res, 405, { error: 'Method not allowed' });
    } finally { client.release(); }
   }
   const notificationsRoute = path.match(/^\/api\/workspaces\/([^/]+)\/notifications(?:\/([^/]+))?$/);
   if (notificationsRoute) {
    const [, workspaceId, notificationId] = notificationsRoute;
    if (normalizedPersistence()) { const pool=await getPostgresPool(); const client=await pool.connect(); try { if (!allowed(res,await findNormalizedMembership(client,user.id,workspaceId),'read')) return;
      if (req.method==='GET' && !notificationId) return json(res,200,await listNormalizedNotifications(client,workspaceId,user.id));
      if (req.method==='PATCH' && notificationId==='read-all') { const updated=await withClientTransaction(client,(tx)=>markNormalizedNotificationRead(tx,workspaceId,user.id)); return json(res,200,{ok:true,updated}); }
      if (req.method==='PATCH' && notificationId) { const updated=await withClientTransaction(client,(tx)=>markNormalizedNotificationRead(tx,workspaceId,user.id,notificationId)); return updated?json(res,200,{ok:true}):json(res,404,{error:'Notification not found'}); }
    } finally { client.release(); } }
    const data = await legacyReadStore(); if (!allowed(res, membership(data, user.id, workspaceId), 'read')) return;
    if (req.method === 'GET' && !notificationId) { const items = data.notifications.filter((item) => item.workspaceId === workspaceId && item.userId === user.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,100); return json(res, 200, { notifications: items, unreadCount: items.filter((item) => !item.readAt).length }); }
    if (req.method === 'PATCH' && notificationId === 'read-all') { let count = 0; await legacyUpdateStore((store) => { for (const item of store.notifications) if (item.workspaceId === workspaceId && item.userId === user.id && !item.readAt) { item.readAt = new Date().toISOString(); count++; } }); return json(res, 200, { ok: true, updated: count }); }
    if (req.method === 'PATCH' && notificationId) { let updated = false; await legacyUpdateStore((store) => { const item = store.notifications.find((entry) => entry.id === notificationId && entry.workspaceId === workspaceId && entry.userId === user.id); if (item) { item.readAt ||= new Date().toISOString(); updated = true; } }); return updated ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Notification not found' }); }
   }
   const importRoute = path.match(/^\/api\/workspaces\/([^/]+)\/imports\/tickets$/);
   if (importRoute && req.method === 'POST') {
    const workspaceId = importRoute[1];
    const input = await body(req); const mode = input.mode === 'commit' ? 'commit' : 'dry-run'; const batchKey = String(input.batchKey || '').trim(); const source = Array.isArray(input.tickets) ? input.tickets : [];
    if (!batchKey || batchKey.length > 120 || source.length > 2000) return json(res, 400, { error: 'A batchKey and no more than 2000 tickets are required.' });
    const valid = []; const errors = [];
    source.forEach((item, index) => { const title = String(item?.title || '').trim(); if (!title || title.length > 200) errors.push({ index, error: 'Title is required and must be at most 200 characters.' }); else valid.push({ sourceId: String(item.id || '').slice(0,120), title, description: String(item.description || '').slice(0,10000), status: ['backlog','todo','in-progress','qa','done'].includes(item.status) ? item.status : 'backlog', priority: ['High','Medium','Low'].includes(item.priority) ? item.priority : 'Medium', type: item.type, dueDate: item.dueDate, tags: Array.isArray(item.tags) ? item.tags.slice(0,30).map((tag) => String(tag).slice(0,40)) : [] }); });
    if (normalizedPersistence()) {
      const pool = await getPostgresPool(); const client = await pool.connect();
      try {
        const member = await findNormalizedMembership(client, user.id, workspaceId);
        if (!allowed(res, member, 'create')) return;
        const existingBatch = await findNormalizedImportBatch(client, workspaceId, batchKey);
        if (mode === 'dry-run') return json(res, 200, { mode, total: source.length, valid: valid.length, invalid: errors.length, errors, alreadyImported: Boolean(existingBatch) });
        if (errors.length) return json(res, 400, { error: 'Import contains invalid tickets.', errors });
        const result = await withClientTransaction(client, (tx) => commitNormalizedTicketImport(tx, { workspaceId, batchKey, importedBy: user.id, tickets: valid }));
        if (!result.duplicate) await invalidateWorkspaceTicketCache(workspaceId);
        if (result.duplicate) return json(res, 200, { mode, imported: 0, duplicate: true, batchId: result.batchId });
        for (const ticket of result.tickets) publish(workspaceId, { type: 'ticket.created', entityId: ticket.id });
        return json(res, 201, { mode, imported: result.imported, batchId: result.batchId, tickets: result.tickets });
      } finally { client.release(); }
    }
    const data = await legacyReadStore(); const member = membership(data, user.id, workspaceId); if (!allowed(res, member, 'create')) return;
    const existingBatch = data.importBatches.find((batch) => batch.workspaceId === workspaceId && batch.batchKey === batchKey);
    if (mode === 'dry-run') return json(res, 200, { mode, total: source.length, valid: valid.length, invalid: errors.length, errors, alreadyImported: Boolean(existingBatch) });
    if (errors.length) return json(res, 400, { error: 'Import contains invalid tickets.', errors });
    if (existingBatch) return json(res, 200, { mode, imported: 0, duplicate: true, batchId: existingBatch.id });
    const created = []; await legacyUpdateStore((store) => { for (const item of valid) { const ticket = { id: randomUUID(), workspaceId, title: item.title, description: item.description, status: item.status, priority: item.priority, type: item.type, dueDate: item.dueDate, tags: item.tags, createdBy: user.id, createdAt: new Date().toISOString(), updatedAt: null }; store.tickets.push(ticket); created.push(ticket); } const batch = { id: randomUUID(), workspaceId, batchKey, importedCount: created.length, importedBy: user.id, createdAt: new Date().toISOString() }; store.importBatches.push(batch); audit(store, user, workspaceId, 'tickets.imported', 'import_batch', batch.id, { count: created.length }); });
    return json(res, 201, { mode, imported: created.length, tickets: created });
   }
   const auditRoute = path.match(/^\/api\/workspaces\/([^/]+)\/audit$/); if (auditRoute && req.method === 'GET') {
    const workspaceId = auditRoute[1];
    const params = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
    const filters = { limit: params.get('limit') || 200, actorId: params.get('actorId') || '', action: params.get('action') || '', entityType: params.get('entityType') || '', from: params.get('from') || '', to: params.get('to') || '' };
    if (normalizedPersistence()) { const pool = await getPostgresPool(); const client = await pool.connect(); try { if (!allowed(res, await findNormalizedMembership(client, user.id, workspaceId), 'audit')) return; return json(res, 200, { events: await listNormalizedAudit(client, workspaceId, filters), filters }); } finally { client.release(); } }
    const data = await legacyReadStore(); if (!allowed(res, membership(data, user.id, workspaceId), 'audit')) return;
    const events = data.auditLogs.filter((e) => e.workspaceId === workspaceId && (!filters.actorId || e.actorId === filters.actorId) && (!filters.action || e.action === filters.action) && (!filters.entityType || e.entityType === filters.entityType) && (!filters.from || e.createdAt >= filters.from) && (!filters.to || e.createdAt <= filters.to)).slice(-Math.min(500, Number.parseInt(filters.limit, 10) || 200)).reverse();
    return json(res, 200, { events, filters });
  }
   const commentsRoute = path.match(/^\/api\/workspaces\/([^/]+)\/tickets\/([^/]+)\/comments(?:\/([^/]+))?$/);
   if (commentsRoute) {
    const [, workspaceId, ticketId, commentId] = commentsRoute;
    if (normalizedPersistence()) { const pool=await getPostgresPool(); const client=await pool.connect(); try {
      const member=await findNormalizedMembership(client,user.id,workspaceId); if (!allowed(res,member,req.method==='GET'?'read':req.method==='DELETE'?'update':'create')) return;
      const ticket=await findNormalizedTicket(client,workspaceId,ticketId); if (!ticket) return json(res,404,{error:'Ticket not found'});
      if (req.method==='GET' && !commentId) return json(res,200,{comments:await listNormalizedComments(client,workspaceId,ticketId)});
      if (req.method==='POST' && !commentId) { const input=await body(req); const text=String(input.body||'').trim(); if(!text||text.length>5000) return json(res,400,{error:'Comment must contain 1 to 5000 characters.'}); const memberRows=await client.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1',[workspaceId]); const memberIds=new Set(memberRows.rows.map((r)=>r.user_id)); const mentionIds=[...new Set(Array.isArray(input.mentions)?input.mentions.filter((id)=>memberIds.has(id)):[])].slice(0,20); const comment={id:randomUUID(),workspaceId,ticketId,authorId:user.id,body:text,mentions:mentionIds,createdAt:new Date().toISOString()}; const recipients=(mentionIds.length?mentionIds:memberRows.rows.map((r)=>r.user_id)).filter((id)=>id!==user.id); await withClientTransaction(client,(tx)=>createNormalizedComment(tx,{comment,recipients,auditId:randomUUID(),ticketTitle:ticket.title,notificationFactory:(recipientId)=>({id:randomUUID(),workspaceId,userId:recipientId,actorId:user.id,type:'comment.created',title:'New comment',message:`${ticket.title}: ${text.slice(0,160)}`,entityId:ticketId,createdAt:comment.createdAt})})); publish(workspaceId,{type:'comment.created',entityId:ticketId}); return json(res,201,{comment:{...comment,author:cleanUser(user)}}); }
      if (req.method==='DELETE' && commentId) { const found=await client.query('SELECT author_id FROM ticket_comments WHERE workspace_id=$1 AND ticket_id=$2 AND id=$3',[workspaceId,ticketId,commentId]); const existing=found.rows[0]; if(!existing) return json(res,404,{error:'Comment not found'}); if(existing.author_id!==user.id&&!['owner','admin'].includes(member.role)) return json(res,403,{error:'Only the author or workspace admin can delete this comment.'}); const deleted=await withClientTransaction(client,(tx)=>deleteNormalizedComment(tx,{workspaceId,ticketId,commentId,auditId:randomUUID(),actorId:user.id})); if(!deleted) return json(res,404,{error:'Comment not found'}); publish(workspaceId,{type:'comment.deleted',entityId:ticketId}); res.writeHead(204); return res.end(); }
    } finally { client.release(); } }
    const snapshot = await legacyReadStore(); const member = membership(snapshot, user.id, workspaceId); if (!allowed(res, member, req.method === 'GET' ? 'read' : req.method === 'DELETE' ? 'update' : 'create')) return;
    const ticket = snapshot.tickets.find((item) => item.id === ticketId && item.workspaceId === workspaceId); if (!ticket) return json(res, 404, { error: 'Ticket not found' });
    if (req.method === 'GET' && !commentId) { const comments = snapshot.comments.filter((item) => item.workspaceId === workspaceId && item.ticketId === ticketId).sort((a,b) => a.createdAt.localeCompare(b.createdAt)).map((item) => ({ ...item, author: cleanUser(snapshot.users.find((entry) => entry.id === item.authorId)) })); return json(res, 200, { comments }); }
    if (req.method === 'POST' && !commentId) { const input = await body(req); const text = String(input.body || '').trim(); if (!text || text.length > 5000) return json(res, 400, { error: 'Comment must contain 1 to 5000 characters.' }); const mentionIds = [...new Set(Array.isArray(input.mentions) ? input.mentions.filter((id) => snapshot.memberships.some((entry) => entry.workspaceId === workspaceId && entry.userId === id)) : [])].slice(0, 20); const comment = { id: randomUUID(), workspaceId, ticketId, authorId: user.id, body: text, mentions: mentionIds, createdAt: new Date().toISOString() }; await legacyUpdateStore((store) => { store.comments.push(comment); audit(store, user, workspaceId, 'comment.created', 'comment', comment.id, { ticketId, title: ticket.title }); const recipients = mentionIds.length ? mentionIds : store.memberships.filter((entry) => entry.workspaceId === workspaceId && entry.userId !== user.id).map((entry) => entry.userId); for (const userId of recipients) if (userId !== user.id) store.notifications.push({ id: randomUUID(), workspaceId, userId, actorId: user.id, type: 'comment.created', title: 'New comment', message: `${ticket.title}: ${text.slice(0, 160)}`, entityId: ticketId, createdAt: comment.createdAt, readAt: null }); }); publish(workspaceId, { type: 'comment.created', entityId: ticketId }); return json(res, 201, { comment: { ...comment, author: cleanUser(user) } }); }
    if (req.method === 'DELETE' && commentId) { const existing = snapshot.comments.find((item) => item.id === commentId && item.ticketId === ticketId && item.workspaceId === workspaceId); if (!existing) return json(res, 404, { error: 'Comment not found' }); if (existing.authorId !== user.id && !['owner','admin'].includes(member.role)) return json(res, 403, { error: 'Only the author or workspace admin can delete this comment.' }); await legacyUpdateStore((store) => { store.comments = store.comments.filter((item) => item.id !== commentId); audit(store, user, workspaceId, 'comment.deleted', 'comment', commentId, { ticketId }); }); res.writeHead(204); return res.end(); }
   }
   const ticketQueryRoute = path.match(/^\/api\/workspaces\/([^/]+)\/tickets\/query$/);
   if (ticketQueryRoute && req.method === 'GET') {
    const [, workspaceId] = ticketQueryRoute;
    let snapshot = null; let queryMember;
    if (normalizedPersistence()) { const pool=await getPostgresPool(); const client=await pool.connect(); try { queryMember=await findNormalizedMembership(client,user.id,workspaceId); } finally { client.release(); } } else { snapshot=await legacyReadStore(); queryMember=membership(snapshot,user.id,workspaceId); }
    if (!allowed(res, queryMember, 'read')) return;
    const options = { page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize'), search: url.searchParams.get('search'), status: url.searchParams.get('status'), priority: url.searchParams.get('priority'), sort: url.searchParams.get('sort'), direction: url.searchParams.get('direction') };
    if (process.env.DATABASE_URL && process.env.PERSISTENCE_MODE === 'normalized') {
      const pool = await getPostgresPool();
      const result = await getCachedWorkspaceTickets(workspaceId, options, () => listNormalizedTickets(pool, workspaceId, options));
      return json(res, 200, result);
    }
    const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, Number.parseInt(options.pageSize, 10) || 25));
    const search = String(options.search || '').trim().toLowerCase();
    const filtered = snapshot.tickets.filter((ticket) => ticket.workspaceId === workspaceId
      && (!['backlog','todo','in-progress','qa','done'].includes(options.status) || ticket.status === options.status)
      && (!['High','Medium','Low'].includes(options.priority) || ticket.priority === options.priority)
      && (!search || `${ticket.title} ${ticket.description || ''}`.toLowerCase().includes(search)));
    const sort = ['title','status','priority','createdAt','updatedAt'].includes(options.sort) ? options.sort : 'createdAt';
    const direction = String(options.direction).toLowerCase() === 'asc' ? 1 : -1;
    filtered.sort((a, b) => String(a[sort] || '').localeCompare(String(b[sort] || '')) * direction || a.id.localeCompare(b.id));
    const total = filtered.length; const tickets = filtered.slice((page - 1) * pageSize, page * pageSize);
    return json(res, 200, { tickets, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrevious: page > 1 } });
   }
   const ticketMatch = path.match(/^\/api\/workspaces\/([^/]+)\/tickets(?:\/([^/]+))?$/);
   if (ticketMatch) {
    const [, workspaceId, ticketId] = ticketMatch;
    let data = null; let member;
    if (normalizedPersistence()) { const pool=await getPostgresPool(); const client=await pool.connect(); try { member=await findNormalizedMembership(client,user.id,workspaceId); } finally { client.release(); } } else { data=await legacyReadStore(); member=membership(data,user.id,workspaceId); }
    if (req.method === 'GET') {
      if (!allowed(res, member, 'read')) return;
      if (process.env.DATABASE_URL && process.env.PERSISTENCE_MODE === 'normalized') {
        const pool = await getPostgresPool();
        const ticketOptions = { page: 1, pageSize: 100 };
        const result = await getCachedWorkspaceTickets(workspaceId, ticketOptions, () => listNormalizedTickets(pool, workspaceId, ticketOptions));
        return json(res, 200, { tickets: result.tickets });
      }
      return json(res, 200, { tickets: data.tickets.filter((t) => t.workspaceId === workspaceId) });
    }
    if (req.method === 'POST' && !ticketId) {
      if (!allowed(res, member, 'create')) return;
      const input = await body(req);
      const title = String(input.title || '').trim();
      if (!title || title.length > 200) return json(res, 400, { error: 'Ticket title is required and must be at most 200 characters.' });
      const ticket = {
        ...Object.fromEntries(['type','dueDate','assigneeId','projectId','tests','tags','comments','estimateHours','timeSpentHours','dependsOn','recurrence'].filter((key) => input[key] !== undefined).map((key) => [key, input[key]])),
        id: randomUUID(), title, description: String(input.description || '').slice(0, 10000),
        status: ['backlog','todo','in-progress','qa','done'].includes(input.status) ? input.status : 'backlog',
        priority: ['High','Medium','Low'].includes(input.priority) ? input.priority : 'Medium',
        workspaceId, createdBy: user.id, createdAt: new Date().toISOString(), updatedAt: null,
      };
      if (process.env.DATABASE_URL && process.env.PERSISTENCE_MODE === 'normalized') {
        const pool = await getPostgresPool(); const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await createNormalizedTicket(client, ticket);
          await client.query('INSERT INTO workspace_audit_logs(id,workspace_id,actor_id,action,entity_type,entity_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [randomUUID(), workspaceId, user.id, 'ticket.created', 'ticket', ticket.id, JSON.stringify({ title }), ticket.createdAt]);
          await notifyNormalizedWorkspace(client,{workspaceId,actorId:user.id,type:'ticket.created',title:'New task created',message:title,entityId:ticket.id,createdAt:ticket.createdAt});
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
        await invalidateWorkspaceTicketCache(workspaceId);
        publish(workspaceId, { type: 'ticket.created', entityId: ticket.id, at: ticket.createdAt });
        return json(res, 201, { ticket });
      }
      await legacyUpdateStore((store) => { store.tickets.push(ticket); audit(store, user, workspaceId, 'ticket.created', 'ticket', ticket.id, { title }); notifyWorkspace(store, user, workspaceId, 'ticket.created', 'New task created', title, ticket.id); });
      return json(res, 201, { ticket });
    }
    if (ticketId && ['PATCH','DELETE'].includes(req.method)) {
      const action = req.method === 'DELETE' ? 'delete' : 'update';
      if (!allowed(res, member, action)) return;
      if (process.env.DATABASE_URL && process.env.PERSISTENCE_MODE === 'normalized') {
        const pool = await getPostgresPool(); const client = await pool.connect();
        try {
          await client.query('BEGIN');
          if (req.method === 'DELETE') {
            const attachmentFiles = await client.query('SELECT storage_name FROM ticket_attachments WHERE workspace_id=$1 AND ticket_id=$2', [workspaceId,ticketId]);
            const deleted = await deleteNormalizedTicket(client, workspaceId, ticketId);
            if (!deleted) { await client.query('ROLLBACK'); return json(res, 404, { error: 'Ticket not found' }); }
            await client.query('DELETE FROM ticket_comments WHERE workspace_id=$1 AND ticket_id=$2', [workspaceId, ticketId]);
            await client.query('DELETE FROM ticket_attachments WHERE workspace_id=$1 AND ticket_id=$2', [workspaceId, ticketId]);
            await client.query('INSERT INTO workspace_audit_logs(id,workspace_id,actor_id,action,entity_type,entity_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now())', [randomUUID(), workspaceId, user.id, 'ticket.deleted', 'ticket', ticketId, '{}']);
            await client.query('COMMIT');
            await invalidateWorkspaceTicketCache(workspaceId);
            for (const file of attachmentFiles.rows) await unlink(join(resolve(process.env.UPLOAD_DIR || './data/uploads'),file.storage_name)).catch(() => {});
            publish(workspaceId, { type: 'ticket.deleted', entityId: ticketId, at: new Date().toISOString() });
            res.writeHead(204); return res.end();
          }
          const input = await body(req);
          if (input.title !== undefined) { const title = String(input.title).trim(); if (!title || title.length > 200) throw Object.assign(new Error('Invalid title'), { status: 400 }); input.title = title; }
          if (input.description !== undefined) input.description = String(input.description).slice(0, 10000);
          if (input.status !== undefined && !['backlog','todo','in-progress','qa','done'].includes(input.status)) return json(res, 400, { error: 'Invalid status' });
          if (input.priority !== undefined && !['High','Medium','Low'].includes(input.priority)) return json(res, 400, { error: 'Invalid priority' });
          const updated = await updateNormalizedTicket(client, workspaceId, ticketId, input);
          if (!updated) { await client.query('ROLLBACK'); return json(res, 404, { error: 'Ticket not found' }); }
          await client.query('INSERT INTO workspace_audit_logs(id,workspace_id,actor_id,action,entity_type,entity_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now())', [randomUUID(), workspaceId, user.id, 'ticket.updated', 'ticket', ticketId, JSON.stringify({ fields: Object.keys(input) })]);
          await notifyNormalizedWorkspace(client,{workspaceId,actorId:user.id,type:'ticket.updated',title:'Task updated',message:updated.title,entityId:ticketId,createdAt:updated.updatedAt});
          await client.query('COMMIT');
          await invalidateWorkspaceTicketCache(workspaceId);
          publish(workspaceId, { type: 'ticket.updated', entityId: ticketId, at: updated.updatedAt });
          return json(res, 200, { ticket: updated });
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
      }
      let updated;
      await legacyUpdateStore(async (store) => {
        const ticket = store.tickets.find((t) => t.id === ticketId && t.workspaceId === workspaceId);
        if (!ticket) return;
        if (req.method === 'DELETE') {
          const files = (store.attachments || []).filter((item) => item.ticketId === ticketId && item.workspaceId === workspaceId);
          const dir = resolve(process.env.UPLOAD_DIR || './data/uploads');
          for (const file of files) await unlink(join(dir, file.storageName)).catch(() => {});
          store.attachments = (store.attachments || []).filter((item) => item.ticketId !== ticketId);
          store.tickets = store.tickets.filter((t) => t.id !== ticketId); store.comments = store.comments.filter((comment) => comment.ticketId !== ticketId);
          audit(store, user, workspaceId, 'ticket.deleted', 'ticket', ticketId); publish(workspaceId, { type: 'ticket.deleted', entityId: ticketId }); return;
        }
        const input = await body(req);
        if (input.title !== undefined) { const title = String(input.title).trim(); if (!title || title.length > 200) throw Object.assign(new Error('Invalid title'), { status: 400 }); ticket.title = title; }
        if (input.description !== undefined) ticket.description = String(input.description).slice(0,10000);
        if (input.status !== undefined && ['backlog','todo','in-progress','qa','done'].includes(input.status)) ticket.status = input.status;
        if (input.priority !== undefined && ['High','Medium','Low'].includes(input.priority)) ticket.priority = input.priority;
        for (const key of ['type','dueDate','assigneeId','projectId','tests','tags','comments','estimateHours','timeSpentHours','dependsOn','recurrence']) if (input[key] !== undefined) ticket[key] = input[key];
        ticket.updatedAt = new Date().toISOString(); updated = ticket; audit(store, user, workspaceId, 'ticket.updated', 'ticket', ticketId, { fields: Object.keys(input) }); notifyWorkspace(store, user, workspaceId, 'ticket.updated', 'Task updated', ticket.title, ticket.id);
      });
      if (req.method === 'DELETE') { if (!updated) return json(res,404,{error:'Ticket not found'}); res.writeHead(204); return res.end(); }
      return updated ? json(res, 200, { ticket: updated }) : json(res, 404, { error: 'Ticket not found' });
    }
   }
   const workspaceExportRoute = path.match(/^\/api\/workspaces\/([^/]+)\/export$/);
   if (workspaceExportRoute && req.method === 'GET') {
    const [, workspaceId] = workspaceExportRoute;
    if (normalizedPersistence()) {
      const pool = await getPostgresPool(); const client = await pool.connect();
      try {
        const member = await findNormalizedMembership(client, user.id, workspaceId);
        if (!allowed(res, member, 'read')) return;
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const snapshot = await exportNormalizedWorkspace(client, workspaceId);
          await client.query('COMMIT');
          if (!snapshot) return json(res, 404, { error: 'Workspace not found' });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename=ashkan-workspace-${workspaceId}.json`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          return res.end(JSON.stringify(snapshot, null, 2));
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      } finally { client.release(); }
    }
    const snapshot = await legacyReadStore();
    const member = membership(snapshot, user.id, workspaceId);
    if (!allowed(res, member, 'read')) return;
    const workspace = snapshot.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) return json(res, 404, { error: 'Workspace not found' });
    const usersById = new Map(snapshot.users.map((entry) => [entry.id, entry]));
    const safeMembers = snapshot.memberships.filter((entry) => entry.workspaceId === workspaceId).map((entry) => ({ user: cleanUser(usersById.get(entry.userId)), role: entry.role, joinedAt: entry.joinedAt || null }));
    const exported = {
      format: 'ashkanboard-workspace-export', version: 1, exportedAt: new Date().toISOString(),
      workspace, members: safeMembers,
      tickets: snapshot.tickets.filter((entry) => entry.workspaceId === workspaceId),
      comments: snapshot.comments.filter((entry) => entry.workspaceId === workspaceId),
      notifications: snapshot.notifications.filter((entry) => entry.workspaceId === workspaceId),
      auditEvents: snapshot.auditLogs.filter((entry) => entry.workspaceId === workspaceId),
      importBatches: snapshot.importBatches.filter((entry) => entry.workspaceId === workspaceId),
      attachments: snapshot.attachments.filter((entry) => entry.workspaceId === workspaceId).map(({ storageName, ...entry }) => entry),
      exclusions: ['password hashes', 'refresh tokens', 'password reset tokens', 'invitation token hashes', 'attachment storage names and file bytes', 'online presence'],
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename=ashkan-workspace-${workspaceId}.json`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(JSON.stringify(exported, null, 2));
   }
   return json(res, 404, { error: 'Route not found' });
  } catch (error) {
    logEvent('error', 'http.unhandled_error', { requestId, errorName: error.name || 'Error', errorCode: error.code || 'UNEXPECTED', status: error.status || 500 });
    if (res.headersSent) { res.destroy(error); return; }
    return json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error', requestId });
  }
 });
}
async function processDueWebhookCircuitRecovery() {
  if (!normalizedPersistence() || process.env.WEBHOOK_CIRCUIT_RECOVERY_WORKER_ENABLED === 'false') return;
  const pool = await getPostgresPool();
  const client = await pool.connect();
  try {
    const recovered = await recoverDueNormalizedWebhookCircuits(client, { limit: Number(process.env.WEBHOOK_CIRCUIT_RECOVERY_BATCH_SIZE || 25) });
    for (const webhook of recovered) logEvent('info','webhook.circuit.auto_recovered',{webhookId:webhook.id,workspaceId:webhook.workspaceId,recoveryCount:webhook.circuitRecoveryCount});
  } finally { client.release(); }
}

async function processWebhookDeliveryRetention() {
  if (!normalizedPersistence() || process.env.WEBHOOK_RETENTION_WORKER_ENABLED === 'false') return;
  const pool = await getPostgresPool();
  const client = await pool.connect();
  try {
    const deleted = await purgeExpiredNormalizedWebhookDeliveries(client, { limit: Number(process.env.WEBHOOK_RETENTION_BATCH_SIZE || 500) });
    if (deleted.length) logEvent('info','webhook.delivery.retention_purged',{count:deleted.length});
  } finally { client.release(); }
}

async function processDueWebhookRetries() {
  if (!normalizedPersistence() || process.env.WEBHOOK_RETRY_WORKER_ENABLED === 'false') return;
  const pool = await getPostgresPool();
  const claimClient = await pool.connect();
  let claimed = [];
  try { claimed = await claimNormalizedWebhookRetries(claimClient, { batchSize: Number(process.env.WEBHOOK_RETRY_BATCH_SIZE || 10), staleAfterSeconds: Number(process.env.WEBHOOK_RETRY_LOCK_STALE_SECONDS || 300) }); }
  finally { claimClient.release(); }
  for (const delivery of claimed) {
    const client = await pool.connect();
    try {
      const rows = await client.query('SELECT id,workspace_id AS "workspaceId",endpoint_url AS "endpointUrl",max_attempts AS "maxAttempts",retry_delay_seconds AS "retryDelaySeconds",secret_enc AS "secretEnc",enabled FROM workspace_webhooks WHERE id=$1',[delivery.webhookId]);
      const webhook = rows.rows[0];
      if (!webhook || !webhook.enabled || !delivery.payload) { await clearNormalizedWebhookRetryLock(client, delivery.id); continue; }
      const secret = decryptSecret(webhook.secretEnc);
      const timestamp = Math.floor(Date.now()/1000);
      const payloadText = JSON.stringify(delivery.payload);
      const signature = createHash('sha256').update(`${timestamp}.${secret}.${payloadText}`).digest('hex');
      const attempt = Number(delivery.attempt) + 1;
      let delivered = false, status = null, errorMessage = null;
      try {
        const response = await fetch(webhook.endpointUrl,{method:'POST',headers:{'content-type':'application/json','user-agent':'AshkanBoard-Webhooks/1.0','x-ashkan-event':delivery.eventType,'x-ashkan-retry':'true','x-ashkan-signature-version':'1','x-ashkan-signature':`t=${timestamp},v1=${signature}`},body:payloadText,signal:AbortSignal.timeout(5000)});
        status=response.status; delivered=response.ok;
      } catch (error) { errorMessage=error.message; }
      const deadLettered = !delivered && attempt >= Number(webhook.maxAttempts);
      const nextRetryAt = !delivered && !deadLettered ? new Date(Date.now()+Number(webhook.retryDelaySeconds)*1000) : null;
      await recordNormalizedWebhookDelivery(client, webhook.id, { status, delivered });
      await recordNormalizedWebhookDeliveryAttempt(client,{webhookId:webhook.id,eventType:delivery.eventType,status,delivered,attempt,errorMessage,payload:delivery.payload,deadLettered,nextRetryAt});
      await clearNormalizedWebhookRetryLock(client, delivery.id);
      logEvent('info','webhook.retry.completed',{webhookId:webhook.id,deliveryId:delivery.id,attempt,delivered,status,deadLettered});
    } catch (error) {
      try { await clearNormalizedWebhookRetryLock(client, delivery.id); } catch {}
      logEvent('error','webhook.retry.failed',{deliveryId:delivery.id,message:error.message});
    } finally { client.release(); }
  }
}

const entryFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryFile && fileURLToPath(import.meta.url) === entryFile) {
  const server = createAppServer();
  server.once('error', (error) => {
    logEvent('error', 'server.listen_failed', { errorCode: error.code || 'LISTEN_FAILED', message: error.message });
    process.exitCode = 1;
  });
  server.listen(PORT, () => logEvent('info', 'server.started', { port: PORT, nodeEnv: process.env.NODE_ENV || 'development', persistence: process.env.DATABASE_URL ? (process.env.PERSISTENCE_MODE === 'normalized' ? 'postgres-normalized-runtime' : 'postgres-jsonb-compatibility') : 'json-file', metricsEnabled: process.env.METRICS_ENABLED === 'true' }));
  const retryIntervalMs = Math.max(Number(process.env.WEBHOOK_RETRY_INTERVAL_MS || 10_000), 1_000);
  const circuitRecoveryIntervalMs = Math.max(Number(process.env.WEBHOOK_CIRCUIT_RECOVERY_INTERVAL_MS || retryIntervalMs), 1_000);
  const retryWorker = setInterval(() => { processDueWebhookRetries().catch((error) => logEvent('error','webhook.retry.worker_failed',{message:error.message})); }, retryIntervalMs);
  const retentionIntervalMs = Math.max(Number(process.env.WEBHOOK_RETENTION_INTERVAL_MS || 3_600_000), 60_000);
  const retentionWorker = setInterval(() => { processWebhookDeliveryRetention().catch((error) => logEvent('error','webhook.retention.worker_failed',{message:error.message})); }, retentionIntervalMs);
  const circuitRecoveryWorker = setInterval(() => { processDueWebhookCircuitRecovery().catch((error) => logEvent('error','webhook.circuit.recovery_worker_failed',{message:error.message})); }, circuitRecoveryIntervalMs);
  retryWorker.unref?.();
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(retryWorker);
    clearInterval(circuitRecoveryWorker);
    clearInterval(retentionWorker);
    logEvent('info', 'server.shutdown', { signal });
    const forceExit = setTimeout(() => { logEvent('error', 'server.shutdown_timeout', { signal }); process.exit(1); }, Number(process.env.SHUTDOWN_TIMEOUT_MS || 10_000));
    forceExit.unref();
    server.close(async (error) => {
      try { await closePostgresPool(); } catch (poolError) { logEvent('error', 'database.pool_close_failed', { errorCode: poolError.code || 'POOL_CLOSE_FAILED' }); }
      clearTimeout(forceExit);
      if (error) { logEvent('error', 'server.close_failed', { errorCode: error.code || 'SERVER_CLOSE_FAILED' }); process.exitCode = 1; }
      else logEvent('info', 'server.shutdown_complete', { signal });
    });
    server.closeIdleConnections?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
