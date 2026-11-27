const API_URL = (import.meta.env.VITE_API_URL || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000')).replace(/\/$/, '');
const TOKEN_KEY = 'ashkan-board-access-token';
const REFRESH_KEY = 'ashkan-board-refresh-token';
export function getAccessToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function getRefreshToken() { try { return localStorage.getItem(REFRESH_KEY) || ''; } catch { return ''; } }
export function setAccessToken(token) { try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* Storage may be disabled. */ } }
function setSessionTokens(result) { setAccessToken(result.accessToken); try { if (result.refreshToken) localStorage.setItem(REFRESH_KEY, result.refreshToken); } catch { /* Storage may be disabled. */ } }
let refreshInFlight;
async function refreshSession() {
  if (!getRefreshToken()) return false;
  if (!refreshInFlight) refreshInFlight = fetch(`${API_URL}/api/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: getRefreshToken() }) }).then(async (response) => { const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error || 'Session expired'); setSessionTokens(payload); return true; }).catch(() => { setAccessToken(''); try { localStorage.removeItem(REFRESH_KEY); } catch { /* Storage may be disabled. */ } return false; }).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
async function request(path, options = {}, retry = true) {
  const token = getAccessToken();
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers } });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('Unable to reach the AshkanBoard API at ' + API_URL + '. Start the API with `npm run api` or use `npm run dev`.');
  }
  if (response.status === 401 && retry && !path.startsWith('/api/auth/')) { if (await refreshSession()) return request(path, options, false); }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({})); if (!response.ok) { const fallback = response.status === 502 ? 'The Vite development proxy cannot reach the AshkanBoard API at http://127.0.0.1:4000. Start the API with `npm run dev` (recommended) or `npm run api` in a second terminal, then retry.' : `API request failed (${response.status})`; const error = new Error(payload.error || fallback); Object.assign(error, payload); throw error; } return payload;
}
export const api = {
  health: () => request('/api/health'),
  oidcConfig: () => request('/api/auth/oidc/config'),
  register: async (input) => { const result = await request('/api/auth/register', { method: 'POST', body: JSON.stringify(input) }); setSessionTokens(result); return result; },
  login: async (input) => { try { const result = await request('/api/auth/login', { method: 'POST', body: JSON.stringify(input) }); setSessionTokens(result); return result; } catch (error) { if (error?.mfaRequired) return error; throw error; } },
  me: () => request('/api/auth/me'),
  updateProfile: (input) => request('/api/auth/me', { method: 'PATCH', body: JSON.stringify(input) }),
  security: () => request('/api/auth/security'),
  setup2fa: () => request('/api/auth/2fa/setup', { method: 'POST', body: '{}' }),
  verify2fa: (otp) => request('/api/auth/2fa/verify', { method: 'POST', body: JSON.stringify({ otp }) }),
  disable2fa: () => request('/api/auth/2fa', { method: 'DELETE' }),
  sessions: () => request('/api/auth/sessions'),
  revokeSession: (familyId) => request(`/api/auth/sessions/${encodeURIComponent(familyId)}/revoke`, { method: 'POST', body: '{}' }),
  revokeAllSessions: () => request('/api/auth/sessions/revoke-all', { method: 'POST', body: '{}' }),
  logout: async () => { const refreshToken = getRefreshToken(); try { if (refreshToken) await request('/api/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }, false); } finally { setAccessToken(''); try { localStorage.removeItem(REFRESH_KEY); } catch { /* Storage may be disabled. */ } } },
  forgotPassword: (email) => request('/api/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email }) }),
  resetPassword: (token, password) => request('/api/auth/password/reset', { method: 'POST', body: JSON.stringify({ token, password }) }),
  workspaces: () => request('/api/workspaces'),
  createWorkspace: (input) => request('/api/workspaces', { method: 'POST', body: JSON.stringify(input) }),
  members: (workspaceId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`),
  roles: (workspaceId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/roles`),
  createRole: (workspaceId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/roles`, { method: 'POST', body: JSON.stringify(input) }),
  updateRole: (workspaceId, roleKey, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/roles/${encodeURIComponent(roleKey)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteRole: (workspaceId, roleKey) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/roles/${encodeURIComponent(roleKey)}`, { method: 'DELETE' }),
  roleMappings: (workspaceId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/role-mappings`),
  createRoleMapping: (workspaceId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/role-mappings`, { method: 'POST', body: JSON.stringify(input) }),
  updateRoleMapping: (workspaceId, mappingId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/role-mappings/${encodeURIComponent(mappingId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteRoleMapping: (workspaceId, mappingId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/role-mappings/${encodeURIComponent(mappingId)}`, { method: 'DELETE' }),
  webhooks: (workspaceId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks`),
  createWebhook: (workspaceId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks`, { method: 'POST', body: JSON.stringify(input) }),
  updateWebhook: (workspaceId, webhookId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteWebhook: (workspaceId, webhookId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE' }),
  testWebhook: (workspaceId, webhookId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}`, { method: 'POST', body: '{}' }),
  rotateWebhookSecret: (workspaceId, webhookId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=rotate-secret`, { method: 'POST', body: '{}' }),
  webhookDeliveries: (workspaceId, webhookId, limit = 50) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?limit=${encodeURIComponent(limit)}`),
  webhookDeliverySummary: (workspaceId, webhookId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=stats`),
  webhookDeliverySearch: (workspaceId, webhookId, params = {}) => { const query = new URLSearchParams({ action: 'delivery-search' }); for (const [key, value] of Object.entries(params)) { if (value !== undefined && value !== null && value !== '') query.set(key, String(value)); } return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?${query.toString()}`); },
  webhookRetentionStats: (workspaceId, webhookId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=retention-stats`),
  webhookRetentionPreview: (workspaceId, webhookId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=retention-preview`),
  webhookRetentionPolicyPreview: (workspaceId, webhookId, days) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=retention-policy-preview&days=${encodeURIComponent(days)}`),
  purgeWebhookRetention: (workspaceId, webhookId, limit = 500) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=purge-retention&limit=${encodeURIComponent(limit)}`, { method: 'POST', body: '{}' }),
  updateWebhookRetentionPolicy: (workspaceId, webhookId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=retention-policy`, { method: 'PATCH', body: JSON.stringify(input) }),
  listWebhookDeadLetters: (workspaceId, webhookId, limit = 50) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=dead-letter&limit=${encodeURIComponent(limit)}`),
  requeueWebhookDeadLetter: (workspaceId, webhookId, deliveryId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=requeue-dead-letter&deliveryId=${encodeURIComponent(deliveryId)}`, { method: 'POST' }),
  discardWebhookDeadLetter: (workspaceId, webhookId, deliveryId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=discard-dead-letter&deliveryId=${encodeURIComponent(deliveryId)}`, { method: 'DELETE' }),
  requeueWebhookDeadLetters: (workspaceId, webhookId, limit = 100) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=requeue-dead-letters&limit=${encodeURIComponent(limit)}`, { method: 'POST' }),
  discardWebhookDeadLetters: (workspaceId, webhookId, limit = 100) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=discard-dead-letters&limit=${encodeURIComponent(limit)}`, { method: 'DELETE' }),
  updateWebhookRetryPolicy: (workspaceId, webhookId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=retry-policy`, { method: 'PATCH', body: JSON.stringify(input) }),
  updateWebhookCircuitPolicy: (workspaceId, webhookId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=circuit-policy`, { method: 'PATCH', body: JSON.stringify(input) }),
  recoverWebhookCircuit: (workspaceId, webhookId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=recover-circuit`, { method: 'POST', body: '{}' }),
  replayWebhookDelivery: (workspaceId, webhookId, deliveryId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}?action=replay&deliveryId=${encodeURIComponent(deliveryId)}`, { method: 'POST', body: '{}' }),
  addMember: (workspaceId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`, { method: 'POST', body: JSON.stringify(input) }),
  updateMemberRole: (workspaceId, userId, role) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  removeMember: (workspaceId, userId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  auditLog: (workspaceId, filters = {}) => { const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => [key, String(value)])); return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/audit${query.size ? `?${query}` : ''}`); },
  notifications: (workspaceId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/notifications`),
  notificationPreferences: (workspaceId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/notification-preferences`),
  updateNotificationPreferences: (workspaceId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/notification-preferences`, { method: 'PATCH', body: JSON.stringify(input) }),
  markNotificationRead: (workspaceId, notificationId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/notifications/${encodeURIComponent(notificationId)}`, { method: 'PATCH' }),
  markAllNotificationsRead: (workspaceId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/notifications/read-all`, { method: 'PATCH' }),
  inviteMember: (workspaceId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/invitations`, { method: 'POST', body: JSON.stringify(input) }),
  acceptInvitation: (token) => request('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ token }) }),
  importTickets: (workspaceId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/imports/tickets`, { method: 'POST', body: JSON.stringify(input) }),
  presence: (workspaceId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/presence`),
  heartbeat: (workspaceId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/presence`, { method: 'POST', body: '{}' }),
  attachments: (workspaceId, ticketId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tickets/${encodeURIComponent(ticketId)}/attachments`),
  uploadAttachment: (workspaceId, ticketId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tickets/${encodeURIComponent(ticketId)}/attachments`, { method: 'POST', body: JSON.stringify(input) }),
  deleteAttachment: (workspaceId, ticketId, attachmentId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' }),
  downloadAttachment: async (workspaceId, ticketId, attachmentId, inline = false) => { const response = await fetch(`${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}${inline ? '?inline=1' : ''}`, { headers: { authorization: `Bearer ${getAccessToken()}` } }); if (!response.ok) throw new Error('Unable to download attachment'); return response.blob(); },
  streamEvents: async (workspaceId, signal, onEvent) => { while (!signal.aborted) { try { const response = await fetch(`${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/events`, { headers: { authorization: `Bearer ${getAccessToken()}` }, signal }); if (response.status === 401 && await refreshSession()) continue; if (!response.ok || !response.body) throw new Error('Live connection unavailable'); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; while (!signal.aborted) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const messages = buffer.split('\n\n'); buffer = messages.pop() || ''; for (const message of messages) { const line = message.split('\n').find((item) => item.startsWith('data: ')); if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch { /* Ignore malformed event frames. */ } } } } } catch (error) { if (signal.aborted) return; if (error.name === 'AbortError') return; } if (!signal.aborted) await new Promise((resolve) => { const onAbort = () => { clearTimeout(timer); resolve(); }; const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 800); signal.addEventListener('abort', onAbort, { once: true }); }); } },
  comments: (workspaceId, ticketId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tickets/${encodeURIComponent(ticketId)}/comments`),
  createComment: (workspaceId, ticketId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tickets/${encodeURIComponent(ticketId)}/comments`, { method: 'POST', body: JSON.stringify(input) }),
  deleteComment: (workspaceId, ticketId, commentId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tickets/${encodeURIComponent(ticketId)}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' }),
  tickets: (workspaceId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tickets`),
  queryTickets: (workspaceId, params = {}) => { const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => [key, String(value)])); return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tickets/query${query.size ? `?${query}` : ''}`); },
  createTicket: (workspaceId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tickets`, { method: 'POST', body: JSON.stringify(input) }),
  updateTicket: (workspaceId, ticketId, input) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tickets/${encodeURIComponent(ticketId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteTicket: (workspaceId, ticketId) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tickets/${encodeURIComponent(ticketId)}`, { method: 'DELETE' }),
};
