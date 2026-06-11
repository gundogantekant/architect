const JUNK_TITLES = new Set([
  'test', 'testing', 'hello', 'asdf', 'foo', 'bar',
  'abc', 'qwerty', 'temp', 'tmp', 'xxx', 'aaa',
]);

const MIN_TITLE_LENGTH = 5;

const PLACEHOLDER_ERROR =
  "Title appears to be a placeholder. Use a descriptive title (e.g. 'Add user authentication').";

export function validateWorkItemTitle(title) {
  const trimmed = (title ?? '').trim();
  if (trimmed.length < MIN_TITLE_LENGTH) return { valid: false, reason: PLACEHOLDER_ERROR };
  if (!trimmed.includes(' ') && JUNK_TITLES.has(trimmed.toLowerCase())) {
    return { valid: false, reason: PLACEHOLDER_ERROR };
  }
  return { valid: true };
}
