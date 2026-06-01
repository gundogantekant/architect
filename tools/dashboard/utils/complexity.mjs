// Derives complexity level from a work item.
// Priority: explicit complexity tag > title heuristics > default 'small'
export function getComplexityLevel(workItem) {
  if (!workItem) return 'small';

  const tags = workItem.tags ?? [];
  for (const level of ['large', 'medium', 'small', 'trivial']) {
    if (tags.includes(level)) return level;
  }

  const title = (workItem.title ?? '').toLowerCase();
  const description = (workItem.description ?? '').toLowerCase();
  const combined = title + ' ' + description;

  if (combined.includes('refactor') || combined.includes('migrate') || combined.includes('architecture')) return 'large';
  if (combined.includes('feature') || combined.includes('implement') || combined.includes('enforce') || combined.includes('add')) return 'medium';
  if (combined.includes('fix') || combined.includes('update') || combined.includes('tweak')) return 'small';

  return 'small';
}

export function isMediumOrAbove(workItem) {
  return ['medium', 'large'].includes(getComplexityLevel(workItem));
}

export function isLarge(workItem) {
  return getComplexityLevel(workItem) === 'large';
}
