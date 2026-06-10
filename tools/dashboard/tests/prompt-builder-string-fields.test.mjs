/**
 * Regression test for W-1342: string portfolio fields must not iterate character-by-character.
 *
 * All fixtures use in-memory objects — no server, DB, or file system required.
 * Run: node --test tools/dashboard/tests/prompt-builder-string-fields.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildDispatchPrompt } = await import('../prompt-builder.mjs');

function baseArgs(overrides = {}) {
  return {
    workItem: null,
    projectKey: 'org/proj/main',
    projectPath: '/projects/proj',
    additionalInstructions: null,
    portfolio: null,
    epicContext: null,
    orgContext: null,
    relatedProjects: null,
    worktreeContext: null,
    contract: null,
    ...overrides,
  };
}

test('guidance.structure as string — section absent, no character bullets', async () => {
  const prompt = buildDispatchPrompt(baseArgs({
    portfolio: {
      entry: { guidance: { structure: 'monorepo' } },
      org: null,
      guides: null,
      syncContext: null,
    },
  }));
  assert.ok(!prompt.includes('- m'), 'must not contain "- m" character bullet');
  assert.ok(!prompt.includes('- o'), 'must not contain "- o" character bullet');
  assert.ok(!prompt.includes('- n'), 'must not contain "- n" character bullet');
  assert.ok(!prompt.includes('**Structure**'), 'Structure section must be absent');
});

test('brief.constraints as string — section absent, string value not rendered', async () => {
  const prompt = buildDispatchPrompt(baseArgs({
    portfolio: {
      entry: {
        guidance: {},
        brief: { constraints: 'No offline mode' },
      },
      org: null,
      guides: null,
      syncContext: null,
    },
  }));
  assert.ok(!prompt.includes('**Constraints**'), 'Constraints section must be absent');
  assert.ok(!prompt.includes('No offline mode'), 'raw string value must not appear in prompt');
});

test('custom_rules as null — no error thrown, section absent', async () => {
  assert.doesNotThrow(() => {
    buildDispatchPrompt(baseArgs({
      portfolio: {
        entry: { guidance: {}, custom_rules: null },
        org: null,
        guides: null,
        syncContext: null,
      },
    }));
  });
  const prompt = buildDispatchPrompt(baseArgs({
    portfolio: {
      entry: { guidance: {}, custom_rules: null },
      org: null,
      guides: null,
      syncContext: null,
    },
  }));
  assert.ok(!prompt.includes('**Project Rules**'), 'Project Rules section must be absent');
});

test('guidance.structure as valid array — renders normally (no regression)', async () => {
  const prompt = buildDispatchPrompt(baseArgs({
    portfolio: {
      entry: { guidance: { structure: ['src/', 'tests/'] } },
      org: null,
      guides: null,
      syncContext: null,
    },
  }));
  assert.ok(prompt.includes('- src/'), 'must render "- src/" bullet');
  assert.ok(prompt.includes('- tests/'), 'must render "- tests/" bullet');
  assert.ok(prompt.includes('**Structure**'), 'Structure section must be present');
});

test('orgContext.org.rules as string — Rules section absent, string value not rendered', async () => {
  const prompt = buildDispatchPrompt(baseArgs({
    orgContext: {
      org: {
        name: 'TestOrg',
        rules: 'No force-push',
      },
      projectMap: [],
    },
  }));
  assert.ok(!prompt.includes('**Rules**:'), 'Rules section must be absent');
  assert.ok(!prompt.includes('No force-push'), 'raw string value must not appear in prompt');
});

test('portfolio.org.coding_standards.additional_rules as string — section absent', async () => {
  const prompt = buildDispatchPrompt(baseArgs({
    portfolio: {
      entry: { guidance: {} },
      org: {
        conventions: {},
        coding_standards: {
          additional_rules: 'strict mode',
        },
      },
      guides: null,
      syncContext: null,
    },
  }));
  assert.ok(!prompt.includes('**Org Coding Standards**'), 'Org Coding Standards section must be absent');
  assert.ok(!prompt.includes('- s'), 'must not contain "- s" character bullet');
});

test('portfolio.org.coding_standards.framework_patterns value as string — section absent', async () => {
  const prompt = buildDispatchPrompt(baseArgs({
    portfolio: {
      entry: { guidance: {} },
      org: {
        conventions: {},
        coding_standards: {
          framework_patterns: { node: 'ESM only' },
        },
      },
      guides: null,
      syncContext: null,
    },
  }));
  assert.ok(!prompt.includes('**node Patterns**'), 'node Patterns section must be absent');
  assert.ok(!prompt.includes('- E'), 'must not contain "- E" character bullet');
});
