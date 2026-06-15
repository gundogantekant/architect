/**
 * Pure formatting and routing helpers for the Telegram terminal bridge.
 *
 * Every export is side-effect free: no I/O, no Date, no console. The functions
 * shape notification text, resolve inbound Telegram updates to a terminal target,
 * and build the small set of status/error reply strings used by the bridge.
 */

const COMMAND_PATTERN = /^\/(sessions|status|start)\b/;
const PREFIX_PATTERN = /^(T-[\w-]+):\s*([\s\S]+)$/;

function notificationHeader(terminal) {
  const project = terminal.project_key ?? 'unknown';
  const workItem = terminal.work_item_id ? ` · ${terminal.work_item_id}` : '';
  return `🔔 ${terminal.id} · ${project}${workItem}`;
}

export function buildNotification(terminal, kind, bodyText) {
  const body = kind === 'lifecycle' ? `Terminal exited: ${bodyText}` : bodyText;
  return `${notificationHeader(terminal)}\n\n${body}`;
}

function resolveReply(update, bindings, terminalsById) {
  const repliedTo = update.message?.reply_to_message?.message_id;
  if (repliedTo === undefined || !bindings.has(repliedTo)) {
    return null;
  }
  const binding = bindings.get(repliedTo);
  const terminal = terminalsById.get(binding.terminal_id);
  if (terminal && terminal.status === 'running') {
    return { kind: 'reply', terminalId: terminal.id, text: update.message.text };
  }
  return { kind: 'target_gone', terminalId: binding.terminal_id };
}

function resolveCommand(text) {
  const match = text.match(COMMAND_PATTERN);
  if (!match) {
    return null;
  }
  const args = text.slice(match[0].length).trim();
  return { kind: 'command', command: match[1], args };
}

function resolvePrefix(text, terminalsById) {
  const match = text.match(PREFIX_PATTERN);
  if (!match) {
    return null;
  }
  const terminalId = match[1];
  const terminal = terminalsById.get(terminalId);
  if (terminal && terminal.status === 'running') {
    return { kind: 'prefix', terminalId, text: match[2] };
  }
  return { kind: 'target_gone', terminalId };
}

function resolveSingleWaiting(update, terminalsById) {
  const waiting = [];
  for (const terminal of terminalsById.values()) {
    if (terminal.isWaiting === true && terminal.status === 'running') {
      waiting.push(terminal);
    }
  }
  if (waiting.length === 1) {
    return { kind: 'single', terminalId: waiting[0].id, text: update.message.text };
  }
  return null;
}

export function resolveTarget(update, bindings, terminalsById) {
  const reply = resolveReply(update, bindings, terminalsById);
  if (reply) {
    return reply;
  }
  const text = update.message?.text ?? '';
  return (
    resolveCommand(text) ??
    resolvePrefix(text, terminalsById) ??
    resolveSingleWaiting(update, terminalsById) ?? { kind: 'unresolved' }
  );
}

export function deliveredMsg(id, { fallback = false } = {}) {
  const suffix = fallback ? ' (only waiting session)' : '';
  return `✅ delivered → ${id}${suffix}`;
}

export function busyMsg(id) {
  return `⚠️ ${id} already has a pending reply — try again shortly`;
}

export function exitedMsg(id) {
  return `⚠️ ${id} has exited — reply not delivered`;
}

function waitingLine(terminal) {
  const project = terminal.project_key ?? 'unknown';
  const workItem = terminal.work_item_id ? ` · ${terminal.work_item_id}` : '';
  return `${terminal.id} · ${project}${workItem} — ${terminal.questionText}`;
}

export function unresolvedMsg(waitingList) {
  if (waitingList.length === 0) {
    return 'no sessions waiting';
  }
  return waitingList.map(waitingLine).join('\n');
}

export function sessionsListMsg(waitingList) {
  return `Waiting sessions:\n${waitingList.map(waitingLine).join('\n')}`;
}

export function failureMsg(reason) {
  return `⚠️ injection failed: ${reason}`;
}

function numberedOptions(options, explained) {
  const blurbs = explained?.options ?? [];
  return options
    .map(({ n, label }, i) => {
      const blurb = blurbs[i]?.blurb;
      return blurb ? `${n}. ${label} — ${blurb}` : `${n}. ${label}`;
    })
    .join('\n');
}

export function buildQuestionNotification(terminal, explained, options, rawText) {
  const body = explained ? explained.summary : rawText;
  const header = notificationHeader(terminal);
  if (options.length === 0) {
    return `${header}\n\n${body}`;
  }
  return `${header}\n\n${body}\n\n${numberedOptions(options, explained)}`;
}

export function confirmMsg(terminal, index, label) {
  const header = notificationHeader(terminal);
  const choice = index === null ? `→ "${label}"` : `→ ${index}. ${label}`;
  return `${header}\n${choice}\nSend \`ok\` to confirm, \`cancel\` to abort, or rephrase.`;
}

export function cancelledMsg(id) {
  return `${id}: cancelled — reply again to answer`;
}

export function expiredMsg(terminal, options) {
  const header = notificationHeader(terminal);
  return `${header}\nthat question expired — here are the options again:\n${numberedOptions(options, null)}`;
}

export function selectedMsg(id, index, label) {
  if (index === null) {
    return `✅ sent: "${label}" (verify in dashboard if it didn't take)`;
  }
  return `✅ selected → ${index}. ${label} (verify in dashboard if it didn't take)`;
}

export function staleScreenMsg(id) {
  return `⚠️ ${id} — session moved on; re-check in dashboard`;
}
