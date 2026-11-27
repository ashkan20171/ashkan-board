export const STORAGE_KEY = 'ashkan-board-tickets';
export const ACTIVITY_KEY = 'ashkan-board-activity';
export const NOTIFICATIONS_KEY = 'ashkan-board-notifications';
export const WORKSPACE_KEY = 'ashkan-board-workspace';
export const ORGANIZATION_KEY = 'ashkan-board-organization';
export const defaultWorkspaces = [{ id: 'main', name: 'Ashkan Product', description: 'Main product workspace' }];
export const roleDefinitions = [
  { id: 'admin', permissions: ['view', 'create', 'edit', 'delete', 'manage'] },
  { id: 'manager', permissions: ['view', 'create', 'edit', 'manage'] },
  { id: 'member', permissions: ['view', 'create', 'edit'] },
  { id: 'viewer', permissions: ['view'] },
];
export const columns = [
  { id: 'backlog', label: 'backlog' },
  { id: 'todo', label: 'todo' },
  { id: 'in-progress', label: 'inProgress' },
  { id: 'qa', label: 'qa' },
  { id: 'done', label: 'done' },
];

export const workspaceMembers = [
  { id: 'ashkan', name: 'Ashkan', role: 'Product & Engineering', initials: 'A', tone: 'blue' },
  { id: 'niloofar', name: 'Niloofar', role: 'Frontend Engineer', initials: 'N', tone: 'violet' },
  { id: 'reza', name: 'Reza', role: 'Backend Engineer', initials: 'R', tone: 'green' },
  { id: 'sara', name: 'Sara', role: 'QA Engineer', initials: 'S', tone: 'amber' },
];

export const projects = [
  { id: 'core', name: 'AshkanBoard Core', key: 'ASH', description: 'Core product workflow and quality system.' },
  { id: 'mobile', name: 'Mobile Experience', key: 'MOB', description: 'Responsive and mobile-first improvements.' },
  { id: 'platform', name: 'Platform & API', key: 'API', description: 'Architecture, integrations and services.' },
];

const initialData = [
  { id: 'ASH-101', title: 'Architect database schema for Sprint workflow', description: 'Support multi-tenant projects and task transitions.', type: 'task', status: 'in-progress', priority: 'High', dueDate: '2026-11-20', assigneeId: 'ashkan', projectId: 'platform', tests: [{ id: 't-1', title: 'Foreign key constraints prevent orphaned cards', passed: true }, { id: 't-2', title: 'Migration script runs cleanly without rollback error', passed: false }], createdAt: '2026-10-28T09:00:00.000Z' },
  { id: 'ASH-102', title: 'JWT Token expiration silent renewal issue', description: 'Mobile clients get 401 when background app refreshes.', type: 'bug', status: 'qa', priority: 'High', dueDate: '2026-11-10', assigneeId: 'reza', projectId: 'platform', tests: [{ id: 't-3', title: 'Refresh token endpoint issues valid new bearer', passed: true }, { id: 't-4', title: 'Concurrency lock works under 10 parallel calls', passed: false }], createdAt: '2026-10-29T09:00:00.000Z' },
  { id: 'ASH-103', title: 'Dark Mode contrast adjustments for QA Column', description: 'Ensure text meets WCAG AA standards in low-light environments.', type: 'task', status: 'done', priority: 'Medium', dueDate: '2026-11-04', assigneeId: 'niloofar', projectId: 'core', tests: [{ id: 't-5', title: 'Color contrast ratio exceeds 4.5:1', passed: true }], createdAt: '2026-10-25T09:00:00.000Z' },
];

export function normalizeTicket(ticket, index = 0) {
  const tests = Array.isArray(ticket?.tests) ? ticket.tests.map((test, testIndex) => ({
    id: String(test.id ?? `test-${index}-${testIndex}`),
    title: String(test.title ?? test.label ?? '').trim(),
    passed: Boolean(test.passed),
  })).filter((test) => test.title) : [];
  return {
    id: String(ticket?.id ?? `ASH-${Date.now()}-${index}`),
    title: String(ticket?.title ?? '').trim(),
    description: String(ticket?.description ?? ''),
    type: ticket?.type === 'bug' ? 'bug' : 'task',
    status: columns.some((column) => column.id === ticket?.status) ? ticket.status : 'backlog',
    priority: ['High', 'Medium', 'Low'].includes(ticket?.priority) ? ticket.priority : 'Medium',
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(ticket?.dueDate ?? '') ? ticket.dueDate : '',
    assigneeId: workspaceMembers.some((member) => member.id === ticket?.assigneeId) ? ticket.assigneeId : 'ashkan',
    projectId: projects.some((project) => project.id === ticket?.projectId) ? ticket.projectId : 'core',
    workspaceId: String(ticket?.workspaceId ?? 'main'),
    sprintId: String(ticket?.sprintId ?? ''),
    dependsOn: String(ticket?.dependsOn ?? ''),
    recurrence: ['none', 'daily', 'weekly', 'monthly'].includes(ticket?.recurrence) ? ticket.recurrence : 'none',
    estimateHours: Math.max(0, Number(ticket?.estimateHours) || 0),
    timeSpentHours: Math.max(0, Number(ticket?.timeSpentHours) || 0),
    tests,
    tags: Array.isArray(ticket?.tags) ? [...new Set(ticket.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 12) : [],
    comments: Array.isArray(ticket?.comments) ? ticket.comments.map((comment, commentIndex) => ({
      id: String(comment.id ?? `comment-${index}-${commentIndex}`),
      authorId: workspaceMembers.some((member) => member.id === comment.authorId) ? comment.authorId : 'ashkan',
      body: String(comment.body ?? '').trim(),
      mentions: Array.isArray(comment.mentions) ? comment.mentions.filter((id) => workspaceMembers.some((member) => member.id === id)) : [],
      createdAt: comment.createdAt ?? new Date().toISOString(),
    })).filter((comment) => comment.body) : [],
    createdAt: ticket?.createdAt ?? new Date().toISOString(),
    updatedAt: ticket?.updatedAt ?? null,
  };
}

export function createTicket(status = 'backlog', type = 'task', existing = [], projectId = 'core') {
  const used = new Set(existing.map((ticket) => ticket.id));
  let sequence = Math.max(100, ...existing.map((ticket) => Number(ticket.id?.match(/(\d+)$/)?.[1] ?? 100)));
  let id;
  do { sequence += 1; id = `ASH-${sequence}`; } while (used.has(id));
  return normalizeTicket({ id, title: '', description: '', type, status, priority: 'Medium', dueDate: '', assigneeId: 'ashkan', projectId, tests: [], createdAt: new Date().toISOString() });
}

export function loadTickets() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!Array.isArray(saved)) return initialData.map(normalizeTicket);
    return saved.map(normalizeTicket);
  } catch { return initialData.map(normalizeTicket); }
}

export function canMoveToDone(task) {
  return task.tests.length > 0 && task.tests.every((test) => test.passed);
}

export function checkIsOverdue(task) {
  if (!task.dueDate || task.status === 'done') return false;
  const [year, month, day] = task.dueDate.split('-').map(Number);
  const due = new Date(year, month - 1, day);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return due < today;
}
