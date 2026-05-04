// Classification values must match the DB CHECK constraint on change_log_entries.classification
// architectural | dependency | feature | fix | docs | test | chore

const DEPENDENCY_MANIFESTS = [
  'package.json',
  'pubspec.yaml',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'requirements.txt',
  'Pipfile',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
];

const ARCHITECTURE_LAYER_PATHS = [
  'domain/',
  'migrations/',
  'lib/core/',
  'lib/domain/',
  'src/core/',
  'app/domain/',
];

const ARCHITECTURE_FILE_PATTERNS = [
  'schema',
  '.proto',
  'openapi',
  'swagger',
  'api/routes',
  'src/routes',
];

function isRootLevelManifest(filePath) {
  const base = filePath.split('/').pop();
  if (filePath.includes('/')) return false;
  return (
    DEPENDENCY_MANIFESTS.includes(base) ||
    base.endsWith('.podspec')
  );
}

function isDependencyFile(filePath) {
  const base = filePath.split('/').pop();
  const isManifest =
    DEPENDENCY_MANIFESTS.includes(base) ||
    base.endsWith('.podspec');
  return isManifest && !filePath.startsWith('node_modules/');
}

function isArchitectureLayerPath(filePath) {
  return (
    ARCHITECTURE_LAYER_PATHS.some((p) => filePath.includes(p)) ||
    ARCHITECTURE_FILE_PATTERNS.some((p) => filePath.includes(p))
  );
}

function classifyByFilePaths(affectedFiles) {
  if (affectedFiles.some(isDependencyFile)) return 'dependency';
  if (affectedFiles.some(isArchitectureLayerPath)) return 'architectural';
  return null;
}

function classifyByConventionalPrefix(subject) {
  if (/^(feat|feature)(\(.+\))?!?:/.test(subject)) return 'feature';
  if (/^fix(\(.+\))?!?:/.test(subject)) return 'fix';
  if (/^docs?(\(.+\))?!?:/.test(subject)) return 'docs';
  if (/^tests?(\(.+\))?!?:/.test(subject)) return 'test';
  if (/^(chore|build|ci|style|refactor|perf|revert)(\(.+\))?!?:/.test(subject)) return '__chore_prefix';
  return null;
}

function isAllTestFiles(affectedFiles) {
  if (affectedFiles.length === 0) return false;
  return affectedFiles.every(
    (f) =>
      f.startsWith('test/') ||
      f.startsWith('tests/') ||
      f.startsWith('spec/') ||
      f.startsWith('__tests__/') ||
      f.includes('.test.') ||
      f.includes('.spec.')
  );
}

function classifyByKeywords(subject, affectedFiles) {
  const s = subject.toLowerCase();

  if (/migrate|migration|redesign|restructur|refactor.*architecture|replace.*with|switch.*from|deprecat|adopt/.test(s)) {
    return 'architectural';
  }
  if (/add|implement|introduce|enable|support|create|scaffold|wire|instrument/.test(s)) {
    return 'feature';
  }
  if (/fix|patch|hotfix|revert|regression|error|crash|bug|broken/.test(s)) {
    return 'fix';
  }
  if (/doc|readme|changelog|license|comment/.test(s)) {
    return 'docs';
  }
  if (isAllTestFiles(affectedFiles)) {
    return 'test';
  }

  return null;
}

export function classifyCommit(subject, affectedFiles = []) {
  const byPath = classifyByFilePaths(affectedFiles);
  if (byPath) return byPath;

  const byPrefix = classifyByConventionalPrefix(subject);
  if (byPrefix && byPrefix !== '__chore_prefix') return byPrefix;

  const byKeyword = classifyByKeywords(subject, affectedFiles);
  if (byKeyword) return byKeyword;

  return 'chore';
}

export function isAdrCandidate(subject, affectedFiles = []) {
  const s = subject.toLowerCase();

  const hasDecisionLanguage =
    /migrate|migrat|introduce|replace|switch.*from|deprecat|adopt|move.*to|refactor.*to|redesign/.test(s);

  if (!hasDecisionLanguage) return { candidate: false, reason: null };

  const hasArchitecturePath = affectedFiles.some(
    (f) => isArchitectureLayerPath(f) || isRootLevelManifest(f)
  );

  if (!hasArchitecturePath) return { candidate: false, reason: null };

  const matchedPath = affectedFiles.find(
    (f) => isArchitectureLayerPath(f) || isRootLevelManifest(f)
  );

  return {
    candidate: true,
    reason: `Subject contains architectural decision language and touches architecture-layer path: ${matchedPath}`,
  };
}

export function parseSyncLogOutput(rawOutput) {
  if (!rawOutput || !rawOutput.trim()) return [];

  const blocks = rawOutput.split(/^(?=COMMIT )/m).filter(Boolean);

  return blocks.map((block) => {
    const lines = block.split('\n');
    const header = lines[0];

    const match = header.match(/^COMMIT (\S+) (\S+) (.+)$/);
    if (!match) return null;

    const [, hash, timestamp, subject] = match;
    const files = lines
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean);

    return { hash, timestamp, subject, files };
  }).filter(Boolean);
}
