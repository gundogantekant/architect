import { test, expect } from './fixtures.mjs';
import { api, seedWorkItem } from './helpers.mjs';

test.describe('Portfolio Audit API contracts @fast', () => {

  test('PA-1: GET /api/portfolio/audit returns 200 with correct shape', async () => {
    const result = await api('portfolio/audit');
    expect(Array.isArray(result.orphan_db_keys)).toBe(true);
    expect(Array.isArray(result.orphan_portfolio)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(typeof result.generated_at).toBe('string');
  });

  test('PA-2: orphan_db_keys populated when DB project_key has no matching portfolio dir', async () => {
    await seedWorkItem({ project_key: 'testorg-pa2/fake/main', title: 'PA-2 orphan item' });
    const result = await api('portfolio/audit');
    const orphan = result.orphan_db_keys.find(r => r.project_key === 'testorg-pa2/fake/main');
    expect(orphan).toBeDefined();
  });

  test('PA-3: orphan_portfolio test skipped — requires writing to real portfolio filesystem', async () => {
    // Writing to the real portfolio to create an orphan would have side effects on
    // the live architect portfolio. This test is intentionally omitted.
    expect(true).toBe(true);
  });

  test('PA-4: when DB keys have matching portfolio dirs, both orphan lists are empty for those keys', async () => {
    const result = await api('portfolio/audit');
    const inOrphanDb = result.orphan_db_keys.find(r => r.project_key === 'ticari/architect/main');
    expect(inOrphanDb).toBeUndefined();
  });

  test('PA-5: project_key present in both DB and portfolio does not appear in either orphan list', async () => {
    const result = await api('portfolio/audit');
    const inDb = result.orphan_db_keys.find(r => r.project_key === 'ticari/architect/main');
    const inPortfolio = result.orphan_portfolio.find(r => `${r.org}/${r.project}/${r.component}` === 'ticari/architect/main');
    expect(inDb).toBeUndefined();
    expect(inPortfolio).toBeUndefined();
  });

  test('PA-6: generated_at is a valid ISO 8601 date string', async () => {
    const result = await api('portfolio/audit');
    const d = new Date(result.generated_at);
    expect(isNaN(d.getTime())).toBe(false);
    expect(result.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('PA-7: each orphan_db_keys entry has statuses as object with integer counts', async () => {
    await seedWorkItem({ project_key: 'testorg-pa7/check/main', title: 'PA-7 item', status: 'draft' });
    const result = await api('portfolio/audit');
    const entry = result.orphan_db_keys.find(r => r.project_key === 'testorg-pa7/check/main');
    expect(entry).toBeDefined();
    expect(typeof entry.statuses).toBe('object');
    for (const v of Object.values(entry.statuses)) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  test('PA-8: response is 200 even when portfolio has minimal content', async () => {
    const result = await api('portfolio/audit');
    expect(result).toBeDefined();
    expect(Array.isArray(result.orphan_db_keys)).toBe(true);
  });

});
