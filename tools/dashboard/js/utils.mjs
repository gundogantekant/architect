export const $ = s => document.querySelector(s);

export function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Attribute-safe escape: escapes quotes in addition to < > &, so values are safe
// inside double/single-quoted HTML attributes (esc() does NOT escape quotes).
export function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

export function stripAnsiForDisplay(s) {
  if (!s) return s;
  return s
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[\x20-\x7e]/g, '')
    .replace(/\x1b/g, '')
    .replace(/[\x07\x08]/g, '');
}

export const ACTIVE_DOT_CLASSES = ['running', 'generating', 'tool-running', 'needs-input'];

export function clearActiveDotClasses(dot) { dot.classList.remove(...ACTIVE_DOT_CLASSES); }

export function fmtDate(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString(); } catch { return s; }
}

export function fmtTimestampParts(s) {
  const d = new Date(s);
  const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return { date, time };
}

export function fmtTimestamp(s) {
  if (!s) return '—';
  try {
    const { date, time } = fmtTimestampParts(s);
    return `<span style="display:block;white-space:nowrap">${esc(date)}</span><span style="display:block;white-space:nowrap">${esc(time)}</span>`;
  } catch { return s; }
}

export function getRouteTitle() {
  const hash = location.hash.slice(1);
  if (!hash) return null;
  const parts = hash.split('/');
  if (parts[0] === 'epics') return 'Epics';
  if (parts[0] === 'agents' || hash.startsWith('agents?')) return 'Agents';
  if (parts[0] === 'settings') return 'Settings';
  if (parts[0] === 'time-report') return 'Time Report';
  if (parts[0] === 'epic' && parts[1]) return `E-${parts[1]}`;
  if (parts[0] === 'org' && parts[1]) return parts[1];
  if (parts[0] === 'component' && parts.length >= 4) return `${parts[2]}/${parts[3]}`;
  return null;
}

export function updateTitle(subtitle) {
  document.title = subtitle ? `Architect — ${subtitle}` : 'Architect';
}

export function topoSort(items) {
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const cmp = (a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2) || a.id.localeCompare(b.id);
  const itemMap = new Map(items.map(i => [i.id, i]));
  const inDeg = new Map(items.map(i => [i.id, 0]));
  for (const item of items) {
    for (const dep of (item.depends_on || [])) {
      if (itemMap.has(dep)) inDeg.set(item.id, (inDeg.get(item.id) || 0) + 1);
    }
  }
  const queue = items.filter(i => inDeg.get(i.id) === 0).sort(cmp);
  const sorted = [], done = new Set();
  while (queue.length) {
    const item = queue.shift();
    sorted.push(item);
    done.add(item.id);
    const ready = items.filter(i => !done.has(i.id) && !queue.some(q => q.id === i.id) &&
      (i.depends_on || []).every(d => !itemMap.has(d) || done.has(d)));
    queue.push(...ready.sort(cmp));
  }
  return [...sorted, ...items.filter(i => !done.has(i.id))];
}

export function isBlockedByDeps(item, allItems) {
  if (!item.depends_on || !item.depends_on.length) return { blocked: false, pending: [] };
  const itemMap = new Map(allItems.map(i => [i.id, i]));
  const pending = item.depends_on.filter(depId => {
    const dep = itemMap.get(depId);
    return dep && dep.status !== 'done';
  });
  return { blocked: pending.length > 0, pending };
}

export function epicSignalColor(epic, progress) {
  if (epic.status === 'draft') return 'grey';
  if (epic.status === 'done') return 'green';
  if (epic.status === 'cancelled') return 'grey';
  if (epic.status === 'archived') return 'grey';
  const items = progress || { done: 0, total: 0 };
  if (items.total === 0) return 'grey';
  if (items.done === items.total) return 'green';
  if (epic.priority === 'critical' || epic.priority === 'high') return 'red';
  return 'yellow';
}
