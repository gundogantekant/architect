import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, PORTFOLIO, WORK, ARCHITECT_KEY, port } from './constants.mjs';
import * as db from './db.mjs';
import { readJson } from './utils.mjs';

export async function resolveProjectPath(projectKey) {
  if (projectKey === ARCHITECT_KEY) return ROOT;
  const registry = await readJson(join(PORTFOLIO, 'registry.json'));
  for (const [path, entry] of Object.entries(registry.entries)) {
    const key = `${entry.org}/${entry.project}/${entry.component}`;
    if (key === projectKey) return path;
  }
  return null;
}

export async function resolveOrgPath(orgKey) {
  const orgData = await readJson(join(PORTFOLIO, orgKey, 'organization.json')).catch(() => null);
  return orgData?.path_root || null;
}

export async function loadOrgContext(orgKey) {
  const orgData = await readJson(join(PORTFOLIO, orgKey, 'organization.json')).catch(() => null);
  if (!orgData) return null;

  // Read all project directories under this org
  const projectMap = [];
  try {
    const entries = await readdir(join(PORTFOLIO, orgKey), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectName = entry.name;
      // Try to read main.json (default component)
      const componentData = await readJson(join(PORTFOLIO, orgKey, projectName, 'main.json')).catch(() => null);
      if (!componentData) continue;
      projectMap.push({
        key: `${orgKey}/${projectName}/main`,
        name: componentData.name || projectName,
        role: componentData.role || 'unknown',
        purpose: componentData.brief?.purpose || '',
        stack: componentData.guidance?.stack_summary || '',
        path: componentData.path || '',
      });
    }
  } catch { /* org dir listing failed */ }

  return { org: orgData, projectMap };
}

// Context tier mapping: agent name → tier
// See domain/rules.md → Role-Scoped Context Injection
const AGENT_CONTEXT_TIERS = {
  'git-ops': 'none',
  classifier: 'minimal', scout: 'minimal', tracker: 'minimal',
  'dependency-manager': 'minimal', browser: 'minimal',
  coder: 'standard', 'coder-frontend': 'standard', 'coder-backend': 'standard',
  'coder-mobile': 'standard', 'coder-infra': 'standard', coordinator: 'standard',
  planner: 'standard', debugger: 'standard', documenter: 'standard',
  'api-designer': 'standard', refactorer: 'standard', strategist: 'standard',
  profiler: 'standard',
  tester: 'full', reviewer: 'full', 'security-auditor': 'full',
  'ci-cd': 'full', performance: 'full',
};

export function getContextTier(agentName) {
  return AGENT_CONTEXT_TIERS[agentName] || 'standard';
}

export function filterByTier(entry, tier) {
  if (!entry || tier === 'none') return null;
  if (tier === 'full') return entry;

  const filtered = {};
  // Minimal: stack_summary, scout_report.language, scout_report.framework
  if (entry.guidance?.stack_summary) {
    filtered.guidance = { stack_summary: entry.guidance.stack_summary };
  }
  if (entry.scout_report) {
    filtered.scout_report = {
      language: entry.scout_report.language,
      framework: entry.scout_report.framework,
    };
  }
  if (tier === 'minimal') return filtered;

  // Standard: minimal + structure, conventions, custom_rules, dispatch_notes, brief subset, doc_paths, portfolio_guides
  if (entry.guidance) {
    filtered.guidance = {
      ...(filtered.guidance || {}),
      structure: entry.guidance.structure,
      conventions: entry.guidance.conventions,
    };
  }
  if (entry.custom_rules) filtered.custom_rules = entry.custom_rules;
  if (entry.agents?.dispatch_notes) {
    filtered.agents = { dispatch_notes: entry.agents.dispatch_notes };
  }
  if (entry.brief) {
    filtered.brief = {
      purpose: entry.brief.purpose,
      domain: entry.brief.domain,
      users: entry.brief.users,
    };
  }
  if (entry.doc_paths) filtered.doc_paths = entry.doc_paths;
  if (entry.portfolio_guides) filtered.portfolio_guides = entry.portfolio_guides;
  if (entry.interfaces) filtered.interfaces = entry.interfaces;
  return filtered;
}

export async function loadPortfolioContext(projectKey, tier = 'full') {
  if (tier === 'none') return null;
  const [org, project, component] = projectKey.split('/');
  if (!org || !project || !component) return null;
  const [rawEntry, orgData] = await Promise.all([
    readJson(join(PORTFOLIO, org, project, component + '.json')).catch(() => null),
    readJson(join(PORTFOLIO, org, 'organization.json')).catch(() => null),
  ]);
  if (!rawEntry && !orgData) return null;

  const entry = filterByTier(rawEntry, tier);

  let guides = null;
  if (tier !== 'minimal' && rawEntry?.portfolio_guides?.length) {
    const guideDir = join(PORTFOLIO, org, project);
    guides = (await Promise.all(
      rawEntry.portfolio_guides.map(async filename => {
        try {
          const content = await readFile(join(guideDir, filename), 'utf8');
          return { filename, content };
        } catch { return null; }
      })
    )).filter(Boolean);
    if (!guides.length) guides = null;
  }

  let syncContext = null;
  if (tier === 'standard' || tier === 'full') {
    syncContext = await loadSyncContext(projectKey, rawEntry, org, project);
  }

  return { entry, org: orgData, guides, syncContext };
}

async function loadSyncContext(projectKey, rawEntry, org, project) {
  const adrIds = rawEntry?.adrs || [];
  const adrDir = join(PORTFOLIO, org, project, 'adrs');

  const [adrs, recentChanges, lastSyncedAt] = await Promise.all([
    Promise.all(
      adrIds.map(id => readJson(join(adrDir, `${id}.json`)).catch(() => null))
    ).then(results => results.filter(a => a && a.status === 'accepted')),
    fetch(`http://127.0.0.1:${port}/api/sync/significant?project_key=${encodeURIComponent(projectKey)}`)
      .then(r => r.ok ? r.json() : [])
      .then(entries => entries.filter(e => e.project_key === projectKey))
      .catch(() => []),
    fetch(`http://127.0.0.1:${port}/api/sync/${encodeURIComponent(projectKey)}/history`)
      .then(r => r.ok ? r.json() : [])
      .then(rows => rows[0]?.synced_at || null)
      .catch(() => null),
  ]);

  return { adrs, recentChanges, lastSyncedAt };
}

export function loadWorkItem(workItemId) {
  return db.getWorkItemFull(workItemId);
}

export async function loadResumeContext({ work_item_id, project_key }) {
  const [workItem, portfolio] = await Promise.all([
    work_item_id ? loadWorkItem(work_item_id) : null,
    project_key ? loadPortfolioContext(project_key) : null,
  ]);
  return { workItem, portfolio };
}

export function buildResumePrompt({ workItem, contract, additionalInstructions }) {
  const lines = ['# Resumed Session', '', 'This is a continuation of your previous session (not a fresh start).', ''];

  if (workItem) {
    lines.push(`**Work item**: ${workItem.id} — ${workItem.title || ''}`, `**Status**: ${workItem.status || 'unknown'}`, '');
    const log = workItem.session_log || [];
    const entries = log.slice(-5);
    lines.push('**Session log (last 5 entries)**:');
    if (entries.length) {
      for (const e of entries) {
        const ts = e.timestamp ? `[${e.timestamp.slice(0, 16)}] ` : '';
        lines.push(`- ${ts}${e.summary || ''}`);
      }
    } else {
      lines.push('- None');
    }
    lines.push('');
  }

  if (contract) {
    const hasScope = contract.scope_boundary && contract.scope_boundary.length;
    const hasStop = contract.stop_conditions && contract.stop_conditions.length;
    if (hasScope || hasStop) {
      lines.push('**Contract reminders**:');
      if (hasScope) lines.push(`- Scope boundary: ${Array.isArray(contract.scope_boundary) ? contract.scope_boundary.join(', ') : contract.scope_boundary}`);
      if (hasStop) lines.push(`- Stop conditions: ${Array.isArray(contract.stop_conditions) ? contract.stop_conditions.join('; ') : contract.stop_conditions}`);
      lines.push('');
    }
  }

  lines.push('**Instructions**:');
  lines.push(additionalInstructions || 'Continue where you left off.');

  return lines.join('\n');
}

export function topoSort(items) {
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const itemMap = new Map(items.map(i => [i.id, i]));
  const inDegree = new Map(items.map(i => [i.id, 0]));
  for (const item of items) {
    for (const dep of (item.depends_on || [])) {
      if (itemMap.has(dep)) {
        inDegree.set(item.id, (inDegree.get(item.id) || 0) + 1);
      }
    }
  }
  const queue = items.filter(i => inDegree.get(i.id) === 0)
    .sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2) || a.id.localeCompare(b.id));
  const sorted = [];
  const processed = new Set();
  while (queue.length) {
    const item = queue.shift();
    sorted.push(item);
    processed.add(item.id);
    const next = items.filter(i => !processed.has(i.id) && (i.depends_on || []).every(d => !itemMap.has(d) || processed.has(d)))
      .sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2) || a.id.localeCompare(b.id));
    for (const n of next) {
      if (!processed.has(n.id) && !queue.includes(n)) queue.push(n);
    }
  }
  const remaining = items.filter(i => !processed.has(i.id));
  return [...sorted, ...remaining];
}


export async function loadEpicPlanSnippet(epicId) {
  try {
    const content = await readFile(join(WORK, 'epics', epicId, 'plan.md'), 'utf8');
    return content.slice(0, 500);
  } catch {
    return '';
  }
}

export async function selectAgentsForDispatch({ workItem, portfolio }) {
  const always = ['classifier', 'coordinator', 'scout', 'planner', 'coder', 'tester', 'reviewer', 'git-ops'];
  const conditional = {
    'coder-frontend': /front.?end|ui|css|react|vue|angular|svelte|html|component|layout|responsive|tailwind/i,
    'coder-backend': /back.?end|api|server|endpoint|database|graphql|rest|middleware|auth/i,
    'coder-infra': /infra|docker|k8s|kubernetes|terraform|ci.?cd|deploy|devops|aws|gcp|azure|pipeline/i,
    'coder-mobile': /mobile|ios|android|flutter|react.native|swift|kotlin/i,
    'security-auditor': /secur|auth|token|secret|credential|permission|access.?control|encrypt|vulnerab/i,
    'refactorer': /refactor|restructur|reorganiz|clean.?up|technical.?debt|migration/i,
    'debugger': /bug|debug|fix|crash|error|broken|regression|investig|diagnos/i,
    'documenter': /document|readme|changelog|api.?doc|jsdoc|typedoc/i,
    'ci-cd': /ci.?cd|pipeline|github.?action|deploy|release|build.?system/i,
  };

  // Build search text from work item + stack
  const textParts = [];
  if (workItem) {
    textParts.push(workItem.title || '', workItem.description || '', (workItem.tags || []).join(' '));
  }
  if (portfolio?.entry?.guidance?.stack_summary) textParts.push(portfolio.entry.guidance.stack_summary);
  const searchText = textParts.join(' ');

  const selected = [...always];
  for (const [agent, pattern] of Object.entries(conditional)) {
    if (pattern.test(searchText)) selected.push(agent);
  }

  // Cap at 10
  const capped = selected.slice(0, 10);

  // Read agent .md files, strip frontmatter, build --agents JSON
  const agents = [];
  for (const name of capped) {
    try {
      let content = await readFile(join(ROOT, '.claude', 'agents', `${name}.md`), 'utf8');
      // Strip YAML frontmatter
      if (content.startsWith('---')) {
        const endIdx = content.indexOf('---', 3);
        if (endIdx !== -1) content = content.slice(endIdx + 3).trim();
      }
      agents.push({ name, prompt: content });
    } catch {
      // Agent file not found, skip
    }
  }
  return agents;
}

/**
 * Extract contract fields from structured work item description.
 * Recognized headers: **Goal**:, **Constraints**:, **Expected Output**:,
 * **Failure Conditions**:, **Scope Boundary**:, **Stop Conditions**:
 * Returns null if no recognized headers found.
 */
function deriveContractFromDescription(description) {
  if (!description || typeof description !== 'string') return null;

  const fieldMap = {
    'Goal': 'goal',
    'Constraints': 'constraints',
    'Expected Output': 'expected_output',
    'Failure Conditions': 'failure_conditions',
    'Scope Boundary': 'scope_boundary',
  };

  const contract = {};
  let foundAny = false;

  for (const [header, key] of Object.entries(fieldMap)) {
    const pattern = new RegExp(`\\*\\*${header}\\*\\*:\\s*(.+)`, 'i');
    const match = description.match(pattern);
    if (match) {
      contract[key] = match[1].trim();
      foundAny = true;
    }
  }

  // Stop Conditions: multi-line — header line followed by newline-separated items
  const scPattern = /\*\*Stop Conditions\*\*:\s*\n([\s\S]*?)(?=\n\*\*[A-Z]|\n##|\s*$)/i;
  const scMatch = description.match(scPattern);
  if (scMatch) {
    const items = scMatch[1].split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
    if (items.length) {
      contract.stop_conditions = items;
      foundAny = true;
    }
  }

  return foundAny ? contract : null;
}

function buildAdrSection(syncContext) {
  if (!syncContext) return null;
  const { adrs = [], recentChanges = [], lastSyncedAt } = syncContext;
  if (!adrs.length && !recentChanges.length) return null;

  const lines = ['# Architectural Decisions', ''];

  if (adrs.length) {
    lines.push('Active decisions governing this project. Follow these when planning or implementing.', '');
    for (const adr of adrs) {
      lines.push(`## ${adr.id}: ${adr.title}`);
      lines.push(`- Status: ${adr.status} (${adr.date})`);
      lines.push(`- Decision: ${adr.decision}`);
      lines.push(`- Consequences: ${adr.consequences}`, '');
    }
  }

  if (recentChanges.length) {
    lines.push('## Recent External Changes (since last sync)', '');
    let charCount = 0;
    const MAX_CHARS = 3000;
    for (const c of recentChanges.slice(0, 10)) {
      const summary = c.ai_summary || c.commit_message.slice(0, 80);
      const files = (c.affected_files || []).slice(0, 3).join(', ');
      const shortSha = c.commit_hash.slice(0, 8);
      const date = c.committed_at.slice(0, 10);
      const line = `- ${shortSha} [${c.classification}] (${date}): ${summary}${files ? `\n  Files: ${files}` : ''}`;
      if (charCount + line.length > MAX_CHARS) break;
      lines.push(line);
      charCount += line.length;
    }
    lines.push('');
  }

  const syncAge = lastSyncedAt
    ? `last synced ${Math.round((Date.now() - new Date(lastSyncedAt).getTime()) / 3600000)}h ago`
    : 'never synced';
  lines.push(`*Knowledge base: ${syncAge}*`);

  return lines.join('\n');
}

export function buildDispatchPrompt({ workItem, projectKey, projectPath, additionalInstructions, portfolio, epicContext, relatedProjects, orgContext, worktreeContext, contract }) {
  const sections = [];

  // --- Identity ---
  sections.push([
    '# Identity',
    '',
    'You are an **architect SDLC agent** — a full software development lifecycle orchestrator, not a simple task worker.',
    '',
    '**Responsibilities**:',
    '- Triage the assigned work item: assess complexity, identify risks, select the right workflow',
    '- Plan before implementing — do not jump straight to code for non-trivial work',
    '- Dispatch specialized sub-agents (classifier, coordinator, planner, tester, reviewer, git-ops, etc.) as needed',
    '- Track progress via the dashboard API',
    '- Be critical — if the work item is vague or the approach seems suboptimal, document your assessment and propose alternatives before implementing',
    '',
    'You are not limited to writing code. You can perform planning, architecture review, security audit, testing strategy, documentation, and project management.',
  ].join('\n'));

  // --- SDLC Guide ---
  sections.push([
    '# SDLC Guide',
    '',
    '## Workflow Selection',
    '',
    '| Condition | Workflow |',
    '|-----------|----------|',
    '| Trivial tasks | direct — dispatch a single coder agent |',
    '| Small features | sequential — scout → planner → coder → tester → reviewer |',
    '| Full-stack work (independent FE/BE/infra) | parallel-fan-out — split then converge at tester → reviewer |',
    '| Medium/large features | plan-then-execute — planner decomposes, then dispatch coders per task |',
    '| Bugfixes | investigate-then-fix — debugger/scout → coder → tester |',
    '| Vague scope, strategic decisions | strategic-evaluation — strategist evaluates first |',
    '',
    '## Agent Inclusion Rules',
    '',
    '| Agent | Include when |',
    '|-------|-------------|',
    '| scout | No portfolio entry exists for the target project |',
    '| strategist | Large/vague/strategic requests, build-vs-buy decisions |',
    '| planner | Medium+ complexity (skip for small/trivial) |',
    '| tester | All code changes except trivial |',
    '| reviewer | All code changes except trivial |',
    '| security-auditor | Auth, secrets, input validation, or external data involved |',
    '',
    '## Coordination Rules',
    '',
    '- You act as the orchestrator. Dispatch sub-agents using the Agent tool.',
    '- Sub-agents cannot spawn their own sub-agents — only you orchestrate.',
    '- Read-only agents (reviewer, security-auditor, scout, debugger, classifier, coordinator, strategist) do not modify code.',
    '- Implementation agents (coder, coder-frontend, coder-backend, coder-infra, coder-mobile) modify code. git-ops handles git commands.',
    '- Run scout or load portfolio context before dispatching implementation agents on a new project.',
    '- Use parallel fan-out when tasks are independent; sequential pipeline when output feeds the next step.',
    '- When dispatching sub-agents, include the Coding Standards block from this prompt in the Agent tool\'s prompt parameter. Sub-agents do not inherit it automatically.',
    '',
    '## Process for Any Work Item',
    '',
    '1. Assess complexity (trivial / small / medium / large / strategic)',
    '2. Select workflow from the table above',
    '3. Plan if needed (medium+ complexity)',
    '4. Dispatch agents per the workflow',
    '5. Test (dispatch tester for all non-trivial code changes)',
    '6. Review (dispatch reviewer)',
    '7. Log results via the dashboard API',
  ].join('\n'));

  // --- Available Skills ---
  sections.push([
    '# Available Skills',
    '',
    'These workflows can be followed by reading use-case files from `$ARCHITECT_ROOT/usecases/`:',
    '',
    '| Command | Purpose |',
    '|---------|---------|',
    '| /onboard | Scan and register project in portfolio |',
    '| /portfolio | View and manage project portfolio |',
    '| /scaffold | Create new project from template |',
    '| /review | Comprehensive code review |',
    '| /test | Run and generate tests |',
    '| /deploy | Local deployment |',
    '| /pr | Create PR with review summary |',
    '| /diagnose | Debug an issue |',
    '| /secure | Security audit |',
    '| /status | Project health check |',
    '| /work | Track work items across sessions |',
    '| /migrate | Technology migration |',
    '| /explain | Codebase walkthrough |',
    '| /release | Version bump, changelog, git tag |',
    '| /refactor | Systematic refactoring |',
    '| /browse | Web automation via browser agent |',
    '| /worktree | Manage git worktrees |',
  ].join('\n'));

  // --- Scope ---
  const scopeLines = ['# Scope', ''];
  if (orgContext) {
    scopeLines.push(`- **Organization**: ${orgContext.org?.name || 'unknown'}`);
    scopeLines.push(`- **Scope**: Organization-wide (all projects)`);
  } else {
    const org = projectKey.split('/')[0];
    if (org && org !== '–') scopeLines.push(`- **Organization**: ${org}`);
    scopeLines.push(`- **Project**: ${projectKey}`);
  }
  if (workItem) scopeLines.push(`- **Work Item**: ${workItem.id}`);
  if (epicContext) scopeLines.push(`- **Epic**: ${epicContext.id}`);
  sections.push(scopeLines.join('\n'));

  // --- Architect System (awareness section) ---
  {
    const awareLines = ['# Architect System', ''];
    awareLines.push('You are managed by the **architect SDLC system**. Your project has a knowledge base in the architect portfolio.');
    awareLines.push('');
    const [pOrg, pProject, pComponent] = (projectKey || '').split('/');
    if (pOrg && pProject && pComponent) {
      awareLines.push(`- **Portfolio entry**: \`$ARCHITECT_PORTFOLIO_DIR/${pOrg}/${pProject}/${pComponent}.json\``);
      if (portfolio?.guides?.length) {
        awareLines.push(`- **Portfolio guides**: ${portfolio.guides.map(g => g.filename).join(', ')} (in \`$ARCHITECT_PORTFOLIO_DIR/${pOrg}/${pProject}/\`)`);
      }
    }
    awareLines.push(`- **Domain rules**: \`$ARCHITECT_ROOT/domain/rules.md\` — business rules and constraints`);
    awareLines.push(`- **Entity schemas**: \`$ARCHITECT_ROOT/domain/entities.md\``);
    awareLines.push(`- **Use-case workflows**: \`$ARCHITECT_ROOT/usecases/\``);
    awareLines.push('');
    awareLines.push('When you need deeper context about the project, read from the portfolio entry or guides. For cross-project context, query the dashboard API.');
    sections.push(awareLines.join('\n'));
  }

  // --- Organization Context (org-level dispatch only) ---
  if (orgContext) {
    const o = orgContext.org;
    const lines = ['# Organization Context', ''];
    if (o.name) lines.push(`**Name**: ${o.name}`);
    if (o.path_root) lines.push(`**Root Path**: ${o.path_root}`);
    if (o.conventions) {
      lines.push('', '**Conventions**:');
      for (const [k, v] of Object.entries(o.conventions)) {
        if (v) lines.push(`- ${k}: ${v}`);
      }
    }
    if (o.rules?.length) {
      lines.push('', '**Rules**:');
      for (const r of o.rules) lines.push(`- ${r}`);
    }
    if (o.cloud_environments) {
      lines.push('', '**Cloud Environments**:');
      for (const [name, env] of Object.entries(o.cloud_environments)) {
        const parts = [`${name}`];
        if (env.account_id) parts.push(`account=${env.account_id}`);
        if (env.profile) parts.push(`profile=${env.profile}`);
        if (env.region) parts.push(`region=${env.region}`);
        lines.push(`- ${parts.join(', ')}`);
      }
    }
    if (o.coding_standards) {
      if (o.coding_standards.additional_rules?.length) {
        lines.push('', '**Org Coding Standards**:');
        for (const r of o.coding_standards.additional_rules) lines.push(`- ${r}`);
      }
      if (o.coding_standards.framework_patterns) {
        for (const [fw, patterns] of Object.entries(o.coding_standards.framework_patterns)) {
          if (patterns?.length) {
            lines.push('', `**${fw} Patterns**:`);
            for (const p of patterns) lines.push(`- ${p}`);
          }
        }
      }
    }
    if (o.design_systems) {
      lines.push('', '**Design Systems**:');
      for (const [name, ds] of Object.entries(o.design_systems)) {
        lines.push(`- **${name}** (${ds.type || 'unknown'}): ${ds.description || ''}`);
        if (ds.depends_on?.length) lines.push(`  Used by: ${ds.depends_on.join(', ')}`);
      }
    }
    sections.push(lines.join('\n'));
  }

  // --- Project Map (org-level dispatch only) ---
  if (orgContext?.projectMap?.length) {
    const lines = ['# Project Map', '',
      'All projects in this organization:', '',
      '| Project | Role | Stack | Purpose |',
      '|---------|------|-------|---------|',
    ];
    for (const p of orgContext.projectMap) {
      const purpose = (p.purpose || '').slice(0, 80);
      const stack = (p.stack || '').slice(0, 60);
      lines.push(`| ${p.name} | ${p.role} | ${stack} | ${purpose} |`);
    }
    lines.push('', '**Navigation**:');
    lines.push(`- Your working directory is the organization root: \`${projectPath || orgContext.org?.path_root || '(unknown)'}\``);
    lines.push('- To work on a specific project, cd into its subdirectory');
    lines.push(`- For detailed project context, read \`$ARCHITECT_PORTFOLIO_DIR/<org>/<project>/main.json\` or query \`GET http://127.0.0.1:${port}/api/component/<org>/<project>/main\` on the dashboard API`);
    lines.push('- You have cross-project awareness — use it to answer questions about the organization as a whole');
    sections.push(lines.join('\n'));
  }

  // --- Layer 1: Project Context (first — stack, structure, conventions, org rules) ---
  if (portfolio && portfolio.entry) {
    const e = portfolio.entry;
    const lines = ['# Project Context', ''];
    if (e.guidance?.stack_summary) lines.push(`**Stack**: ${e.guidance.stack_summary}`);
    if (e.guidance?.structure && e.guidance.structure.length) {
      lines.push('', '**Structure**:');
      for (const s of e.guidance.structure) lines.push(`- ${s}`);
    }
    if (e.guidance?.conventions && e.guidance.conventions.length) {
      lines.push('', '**Conventions**:');
      for (const c of e.guidance.conventions) lines.push(`- ${c}`);
    }
    if (e.agents?.dispatch_notes && Object.keys(e.agents.dispatch_notes).length) {
      lines.push('', '**Agent Notes**:');
      for (const [agent, note] of Object.entries(e.agents.dispatch_notes)) {
        lines.push(`- ${agent}: ${note}`);
      }
    }
    if (e.brief?.purpose) lines.push(`\n**Purpose**: ${e.brief.purpose}`);
    if (e.brief?.domain) lines.push(`**Domain**: ${e.brief.domain}`);
    if (e.brief?.users) lines.push(`**Users**: ${e.brief.users}`);
    if (e.brief?.key_entities?.length) lines.push(`**Key Entities**: ${e.brief.key_entities.join(', ')}`);
    if (e.brief?.data_flow) lines.push(`**Data Flow**: ${e.brief.data_flow}`);
    if (e.brief?.architecture_rationale) lines.push(`**Architecture Rationale**: ${e.brief.architecture_rationale}`);
    if (e.brief?.constraints?.length) {
      lines.push('', '**Constraints**:');
      for (const c of e.brief.constraints) lines.push(`- ${c}`);
    }
    if (e.brief?.environments?.length) {
      lines.push('', '**Environments**:');
      for (const env of e.brief.environments) lines.push(`- ${env}`);
    }
    if (e.brief?.external_dependencies?.length) {
      lines.push('', '**External Dependencies**:');
      for (const dep of e.brief.external_dependencies) lines.push(`- ${dep}`);
    }
    if (e.guidance?.ci_cd?.length) {
      lines.push('', '**CI/CD**:');
      for (const c of e.guidance.ci_cd) lines.push(`- ${c}`);
    }
    if (e.guidance?.testing?.length) {
      lines.push('', '**Testing**:');
      for (const t of e.guidance.testing) lines.push(`- ${t}`);
    }
    if (e.custom_rules?.length) {
      lines.push('', '**Project Rules**:');
      for (const r of e.custom_rules) lines.push(`- ${r}`);
    }
    if (e.doc_paths?.length) {
      lines.push('', '**Documentation** (files in target project):');
      for (const d of e.doc_paths) lines.push(`- ${d}`);
    }
    sections.push(lines.join('\n'));
  }

  if (portfolio && portfolio.org) {
    const o = portfolio.org;
    const lines = ['# Organization Conventions', ''];
    if (o.conventions?.branch_prefix) lines.push(`- Branch prefix: ${o.conventions.branch_prefix}`);
    if (o.conventions?.pr_title_pattern) lines.push(`- PR title pattern: ${o.conventions.pr_title_pattern}`);
    if (o.rules && o.rules.length) {
      lines.push('', '**Rules**:');
      for (const r of o.rules) lines.push(`- ${r}`);
    }
    if (o.coding_standards) {
      if (o.coding_standards.additional_rules?.length) {
        lines.push('', '**Org Coding Standards**:');
        for (const r of o.coding_standards.additional_rules) lines.push(`- ${r}`);
      }
      if (o.coding_standards.framework_patterns) {
        for (const [fw, patterns] of Object.entries(o.coding_standards.framework_patterns)) {
          if (patterns?.length) {
            lines.push('', `**${fw} Patterns**:`);
            for (const p of patterns) lines.push(`- ${p}`);
          }
        }
      }
    }
    sections.push(lines.join('\n'));
  }

  // Related projects (cross-project awareness for epic dispatches)
  if (relatedProjects && relatedProjects.length) {
    const lines = ['# Related Projects', ''];
    for (const rp of relatedProjects) {
      lines.push(`## ${rp.key}`);
      if (rp.entry?.guidance?.stack_summary) lines.push(`- Stack: ${rp.entry.guidance.stack_summary}`);
      if (rp.entry?.brief?.purpose) lines.push(`- Purpose: ${rp.entry.brief.purpose}`);
      lines.push('');
    }
    sections.push(lines.join('\n'));
  }

  // --- Portfolio Guides (deep project knowledge from markdown files) ---
  if (portfolio?.guides?.length) {
    const guideLines = ['# Portfolio Guides', '',
      'Deep project knowledge from the architect portfolio. Follow these when relevant to your task.', ''];
    let totalLen = 0;
    const MAX_GUIDE_CHARS = 20000;
    const [pOrg, pProject] = (projectKey || '').split('/');
    for (const g of portfolio.guides) {
      if (totalLen + g.content.length > MAX_GUIDE_CHARS) {
        guideLines.push(`## ${g.filename}`, '',
          `(truncated — read full file at \`$ARCHITECT_PORTFOLIO_DIR/${pOrg}/${pProject}/${g.filename}\`)`, '',
          g.content.slice(0, MAX_GUIDE_CHARS - totalLen), '');
        break;
      }
      guideLines.push(`## ${g.filename}`, '', g.content, '');
      totalLen += g.content.length;
    }
    sections.push(guideLines.join('\n'));
  }

  // --- Architectural Decisions (ADRs + recent significant changes) ---
  {
    const adrSection = buildAdrSection(portfolio?.syncContext);
    if (adrSection) sections.push(adrSection);
  }

  // --- Layer 2: Task Context (second — work item details, description, session log) ---
  if (workItem) {
    sections.push(`# Task\n\nWork on backlog item ${workItem.id}: ${workItem.title}`);

    const lines = ['# Work Item', ''];
    lines.push(`- **Status**: ${workItem.status}`);
    lines.push(`- **Priority**: ${workItem.priority}`);
    if (workItem.tags && workItem.tags.length) lines.push(`- **Tags**: ${workItem.tags.join(', ')}`);
    if (workItem.depends_on && workItem.depends_on.length) lines.push(`- **Depends on**: ${workItem.depends_on.join(', ')}`);
    if (workItem.description) lines.push(`- **Description**: ${workItem.description}`);
    if (workItem.session_log && workItem.session_log.length) {
      lines.push('', '**Session Log**:');
      for (const entry of workItem.session_log) {
        lines.push(`- ${entry.date}: ${entry.summary}`);
      }
    }
    sections.push(lines.join('\n'));
  } else if (additionalInstructions) {
    sections.push(`# Task\n\n${additionalInstructions}`);
  }

  // --- Dispatch Contract (value object: goal, constraints, expected output, failure conditions, scope boundary, stop conditions) ---
  const effectiveContract = contract && typeof contract === 'object' && Object.keys(contract).length
    ? contract
    : deriveContractFromDescription(workItem?.description);

  if (effectiveContract) {
    const fields = [
      ['Goal', effectiveContract.goal],
      ['Constraints', effectiveContract.constraints],
      ['Expected Output', effectiveContract.expected_output],
      ['Failure Conditions', effectiveContract.failure_conditions],
    ].filter(([, v]) => typeof v === 'string' && v.trim());
    if (fields.length) {
      const lines = ['# Dispatch Contract', ''];
      for (const [label, value] of fields) lines.push(`**${label}**: ${value}`);
      if (typeof effectiveContract.scope_boundary === 'string' && effectiveContract.scope_boundary.trim()) {
        lines.push(`**Scope Boundary**: ${effectiveContract.scope_boundary}`);
      }
      if (Array.isArray(effectiveContract.stop_conditions) && effectiveContract.stop_conditions.length) {
        lines.push('', '**Stop Conditions** (halt and report if any occur):');
        for (const c of effectiveContract.stop_conditions) lines.push(`- ${c}`);
      }
      sections.push(lines.join('\n'));
    }
  }

  // --- Layer 3: Epic Context (third — lightweight: title, status, progress, plan snippet, AC) ---
  if (epicContext) {
    const lines = ['# Epic Context', ''];
    lines.push(`- **Epic**: ${epicContext.id} — ${epicContext.title}`);
    lines.push(`- **Status**: ${epicContext.status}`);
    lines.push(`- **Progress**: ${epicContext.progress}`);
    if (epicContext.acceptance_criteria) lines.push(`- **Acceptance Criteria**: ${epicContext.acceptance_criteria}`);
    if (epicContext.items && epicContext.items.length) {
      lines.push('', '**Linked Items**:');
      for (const item of epicContext.items) {
        lines.push(`- ${item.id} [${item.status}] (${item.project_key}): ${item.title}`);
      }
    }
    if (epicContext.plan_snippet) {
      lines.push('', '**Plan (excerpt)**:', epicContext.plan_snippet);
    }
    sections.push(lines.join('\n'));
  }

  // --- Dispatch Instructions (supplementary guidance beyond the contract) ---
  if (workItem && additionalInstructions) {
    sections.push(`# Dispatch Instructions\n\n${additionalInstructions}`);
  }

  // --- Coding Standards (inline brief — self-contained, no file read required) ---
  sections.push([
    '# Coding Standards',
    '',
    'Read `domain/rules.md` → Coding Standards for full details. Key principles:',
    '- **Domain-First**: Before defining types, enums, or state values, check the domain layer for existing canonical definitions. Import, do not redefine.',
    '- **DRY**: Three occurrences = extract. Single source of truth for all shared definitions.',
    '- **Clean Architecture**: Dependencies point inward. Separate business logic from I/O and frameworks.',
    '- **Clean Code**: Short single-purpose functions. Self-explanatory names. No commented-out code.',
    '',
    'CODING STANDARDS — apply to all code you write:',
    '- Names reveal intent: `userCount` not `n`, `isAuthenticated` not `flag`, `fetchOrderHistory()` not `getData()`',
    '- No comments except TODO/DECISION tags — if code needs a comment, rename or restructure',
    '- No dead code: no commented-out code, no unused imports, no unreachable branches',
    '- Functions: single-purpose, ~20 lines max. If description has "and", split it',
    '- Dependencies point inward: domain ← usecases ← adapters ← infrastructure. Never import outward.',
    '- Business logic must not contain I/O (HTTP, DB, file, UI). Use dependency injection or ports/adapters.',
    '- Domain layer owns all types, enums, state values. Other layers import — never redefine.',
    '- Before creating any type/enum/constant, search the domain layer first. Import if it exists.',
    '- Three occurrences = extract to shared utility. Single source of truth — never redefine values.',
    '- No over-engineering: no abstractions without two concrete use cases.',
    '- Integrate through existing interfaces — do not bypass layers or create parallel paths.',
    '- Avoid OWASP Top 10 vulnerabilities. Consider Linux compatibility.',
    '',
    '**Sub-agent propagation**: When you dispatch sub-agents via the Agent tool, include the above coding standards block in the prompt parameter. Sub-agents do not automatically inherit these standards.',
  ].join('\n'));

  // --- Context Tiers (guide for sub-agent dispatches) ---
  sections.push([
    '# Context Tiers',
    '',
    'When dispatching sub-agents, apply role-scoped context injection per `domain/rules.md` → Role-Scoped Context Injection:',
    '- **none**: git-ops (branch + path only)',
    '- **minimal**: classifier, scout, tracker, dependency-manager, browser (stack_summary, language, framework)',
    '- **standard**: coders, planner, coordinator, debugger, documenter, api-designer, refactorer, strategist, profiler (+ structure, conventions, brief subset, guides)',
    '- **full**: tester, reviewer, security-auditor, ci-cd, performance (complete context)',
    '',
    'Organization conventions are always included. Use `domain/rules.md` → Model Selection Rules for dynamic model selection per dispatch.',
  ].join('\n'));

  // --- Environment (always included) ---
  {
    const envLines = ['# Environment', ''];
    envLines.push(`You are running in the target project directory: ${projectPath || '(unknown)'}`);
    envLines.push(`The architect project (portfolio, backlog, domain rules) is at: ${ROOT}`);
    envLines.push(`- Backlog: PostgreSQL via dashboard API at http://127.0.0.1:${port}`);
    envLines.push(`- Dashboard API: http://127.0.0.1:${port}`);
    envLines.push('');
    envLines.push('Use the architect project to look up cross-project context, related tasks, domain rules, or use-case workflows when needed. Your primary work should happen in the current directory (the target project).');
    sections.push(envLines.join('\n'));
  }

  // --- Worktree Context (when dispatch created a worktree) ---
  if (worktreeContext) {
    const wtLines = ['# Worktree Context', ''];
    wtLines.push('You are running in a dedicated worktree — all file changes are isolated from the main branch.');
    wtLines.push('');
    wtLines.push(`- **Worktree path**: ${worktreeContext.worktreePath}`);
    wtLines.push(`- **Source path**: ${projectPath}`);
    wtLines.push(`- **Branch**: ${worktreeContext.branchName}`);
    wtLines.push(`- **Originating branch**: ${worktreeContext.sourceBranch}`);
    wtLines.push('');
    wtLines.push('**Important**: Do NOT create a new worktree. You are already in one. Step 8 of implement-work-item (worktree creation) is already done.');
    wtLines.push('- Commit your changes on this branch');
    wtLines.push('- The worktree was provisioned with all required config files and post-setup commands');
    sections.push(wtLines.join('\n'));
  }

  // --- Tracking (only when workItem is present) ---
  if (workItem) {
    const trackLines = ['# Tracking', ''];
    const epicLine = epicContext ? ` (part of ${epicContext.id}: ${epicContext.title})` : '';
    trackLines.push(`You were dispatched for ${workItem.id}: ${workItem.title}${epicLine}.`);
    trackLines.push('');
    trackLines.push(`- Reference this work item in commit messages (e.g. "[${workItem.id}] ...")`);
    trackLines.push(`- When your work is complete, add a session log entry:`);
    trackLines.push(`  curl -s -X POST http://127.0.0.1:${port}/api/work-items/${workItem.id}/log \\`);
    trackLines.push(`    -H 'Content-Type: application/json' -d '{"summary": "..."}'`);
    trackLines.push(`- If you complete the task fully, update its status:`);
    trackLines.push(`  curl -s -X PATCH http://127.0.0.1:${port}/api/work-items/${workItem.id} \\`);
    trackLines.push(`    -H 'Content-Type: application/json' -d '{"status": "done"}'`);
    trackLines.push('- Focus primarily on this work item\'s goals. If you discover adjacent work, log it as a new backlog item via the dashboard API rather than expanding scope silently.');
    trackLines.push('- Be critical about the approach — if the work item description is vague or the approach seems suboptimal, document your assessment and propose alternatives before implementing.');
    trackLines.push(`- To create a new work item for adjacent work discovered:`);
    trackLines.push(`  curl -s -X POST http://127.0.0.1:${port}/api/work-items \\`);
    trackLines.push(`    -H 'Content-Type: application/json' -d '{"project_key": "${projectKey}", "title": "...", "description": "...", "priority": "medium", "tags": []}'`);
    sections.push(trackLines.join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * Build the `# Auto-Implement Mode` section injected into the autonomous dispatch prompt.
 * References the workflow path rather than embedding its content.
 */
function buildAutoImplementSection(workItem) {
  const id = workItem?.id || 'W-???';
  return `# Auto-Implement Mode

You are running in autonomous self-organizing mode for work item ${id}.

Follow the workflow at \`$ARCHITECT_ROOT/usecases/implement-work-item.md\` exactly, executing all 15 steps without waiting for user confirmation at intermediate steps.

**EXCEPTION**: If the Technical Review Board blocks after 2 revision cycles at any gate, do NOT proceed. Log the block reason to the work item session log and halt — the dispatch will be marked as failed.

Your session depth is 1. You MUST NOT trigger further dashboard dispatches (POST /api/dispatch or /api/dispatch/auto-implement). All sub-agent work runs in-process via the Agent tool.

When making any API call to the dashboard (curl http://127.0.0.1:${port}/...), include the header:
\`--header "X-Architect-Session-Depth: 1"\`

## Completion Signal

After step 12 (commit) succeeds in Auto-Implement Mode, retrieve the commit SHA and signal completion to the dashboard before halting:

  COMMIT_SHA=$(git rev-parse HEAD)
  curl -s -X POST http://127.0.0.1:${port}/api/dispatch/\${DISPATCH_ID}/complete \\
    -H 'Content-Type: application/json' \\
    -H 'X-Architect-Session-Depth: 1' \\
    -d "{\\"sha\\": \\"\${COMMIT_SHA}\\", \\"summary\\": \\"<one-line summary of what was implemented>\\"}"

The DISPATCH_ID is found in the \`# Tracking\` section of your prompt (the work item dispatch ID, starts with D-).
After calling this endpoint, halt. Do not proceed to steps 13–16 — the dashboard handles merge-back automatically.`;
}

/**
 * Build an autonomous auto-implement dispatch prompt.
 * Delegates to buildDispatchPrompt for all standard sections, then replaces
 * the Dispatch Instructions section with the Auto-Implement Mode section.
 */
export function buildAutoImplementPrompt(args) {
  const base = buildDispatchPrompt(args);
  const autoSection = buildAutoImplementSection(args.workItem);
  if (base.includes('# Dispatch Instructions')) {
    return base.replace(/# Dispatch Instructions[\s\S]*?(?=\n# [A-Z]|$)/, autoSection);
  }
  return base + '\n\n' + autoSection;
}
