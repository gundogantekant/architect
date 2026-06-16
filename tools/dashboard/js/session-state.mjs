export function sessionNeedsInput(s) {
  if (!s || s.type === 'terminal' || s.type === 'cli') return false;
  return s.status === 'execute_pending'
    || s.work_item_input_needed === true
    || (s.agent_phase === 'waiting_for_input' && s.status === 'running');
}

export function newlyNeedingInput(prevIdSet, sessions) {
  const ids = [];
  for (const s of sessions) {
    if (sessionNeedsInput(s) && !prevIdSet.has(s.id)) ids.push(s.id);
  }
  return ids;
}

export function notificationDecision(prefs, notificationPermission) {
  const osPrefOn = (prefs?.notify_input_os) !== 'false';
  const soundPrefOn = (prefs?.notify_input_sound) !== 'false';
  return {
    os: osPrefOn && notificationPermission === 'granted',
    sound: soundPrefOn,
  };
}
