import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrgName } from '../lib/portfolio-validation.mjs';

describe('OG-1: blocked org name "test" returns ok: false', () => {
  it('validateOrgName("test") returns { ok: false }', () => {
    const result = validateOrgName('test');
    assert.equal(result.ok, false);
    assert.ok(result.reason && result.reason.length > 0, 'reason must be non-empty');
  });
});

describe('OG-2: valid org name "neuronic" returns ok: true', () => {
  it('validateOrgName("neuronic") returns { ok: true }', () => {
    const result = validateOrgName('neuronic');
    assert.equal(result.ok, true);
  });
});

describe('OG-3: org name starting with digit returns ok: false', () => {
  it('validateOrgName("123") returns { ok: false }', () => {
    const result = validateOrgName('123');
    assert.equal(result.ok, false);
  });
});

describe('OG-4: org name starting with / returns ok: false', () => {
  it('validateOrgName("/tmp") returns { ok: false }', () => {
    const result = validateOrgName('/tmp');
    assert.equal(result.ok, false);
  });
});

describe('OG-5: blocked org name "testorg" returns ok: false', () => {
  it('validateOrgName("testorg") returns { ok: false }', () => {
    const result = validateOrgName('testorg');
    assert.equal(result.ok, false);
  });
});

describe('OG-6: org name with hyphens returns ok: true', () => {
  it('validateOrgName("my-org") returns { ok: true }', () => {
    const result = validateOrgName('my-org');
    assert.equal(result.ok, true);
  });
});

describe('OG-7: empty string returns ok: false', () => {
  it('validateOrgName("") returns { ok: false }', () => {
    const result = validateOrgName('');
    assert.equal(result.ok, false);
  });
});

describe('OG-8: when ok is false, reason is a non-empty string', () => {
  it('all failing cases include a reason', () => {
    for (const name of ['test', '123', '/tmp', 'testorg', '']) {
      const result = validateOrgName(name);
      assert.equal(result.ok, false, `expected ok: false for '${name}'`);
      assert.ok(typeof result.reason === 'string' && result.reason.length > 0,
        `expected non-empty reason for '${name}', got: ${JSON.stringify(result.reason)}`);
    }
  });
});
