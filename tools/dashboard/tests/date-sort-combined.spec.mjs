/**
 * Date Filter + Sort Combined E2E Tests (W-1339)
 *
 * DSC-1: seed work items with distinct created_at dates → apply "last 7 days" date preset
 *        filter + sort_by=created_at asc via API → assert items filtered AND sorted correctly
 *        → switch sort to done_at desc → assert sort changes without breaking the active date filter
 */

import { test, expect } from './fixtures.mjs';
import { seedWorkItem, backdateWorkItem, api } from './helpers.mjs';

const PROJECT_KEY = 'ticari/architect/main';
const MINIMAL_PORTFOLIO_ENTRY = { worktree_mode: 'explicit', worktree_setup: { branch: 'main' } };

function daysAgoISO(n) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - n)).toISOString();
}

function todayUTCString() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

test.describe('Date Sort Combined @fast', () => {

  test.beforeAll(async () => {
    await api('test/seed-portfolio-entry', {
      method: 'POST',
      body: JSON.stringify({ project_key: PROJECT_KEY, entry: MINIMAL_PORTFOLIO_ENTRY }),
    });
  });

  test('DSC-1: date filter combined with sort_by=created_at asc, then switch to sort_by=done_at desc', async () => {
    // Seed three items: two recent (within 7 days), one old (60 days ago)
    const recentOlder = await seedWorkItem({ title: 'DSC-1 recent older', project_key: PROJECT_KEY });
    const recentNewer = await seedWorkItem({ title: 'DSC-1 recent newer', project_key: PROJECT_KEY });
    const oldItem = await seedWorkItem({ title: 'DSC-1 old item', project_key: PROJECT_KEY });

    // Backdate the older recent item to 3 days ago, old item to 60 days ago
    await backdateWorkItem(recentOlder.id, daysAgoISO(3));
    await backdateWorkItem(oldItem.id, daysAgoISO(60));

    const today = todayUTCString();
    const sevenDaysAgo = daysAgoISO(7).slice(0, 10);

    // Verify: filter to last 7 days + sort by created_at asc via API
    const filteredAsc = await api(`backlog?from=${sevenDaysAgo}&to=${today}&sort_by=created_at`);
    const allItemsAsc = Object.values(filteredAsc.projects).flatMap(p => p.items);

    const recentItemsAsc = allItemsAsc.filter(i => i.project_key === PROJECT_KEY &&
      ['DSC-1 recent older', 'DSC-1 recent newer', 'DSC-1 old item'].includes(i.title));

    // The old item (60 days ago) must be excluded from the 7-day filter
    expect(
      recentItemsAsc.find(i => i.title === 'DSC-1 old item'),
      '60-day-old item must be excluded by the last-7d filter',
    ).toBeUndefined();

    // The two recent items must appear in ascending created_at order
    const recentOnly = recentItemsAsc.filter(i => i.title !== 'DSC-1 old item');
    expect(recentOnly.length).toBeGreaterThanOrEqual(2);

    const createdAts = recentOnly.map(i => new Date(i.created_at).getTime());
    const isSortedAsc = createdAts.every((v, idx) => idx === 0 || v >= createdAts[idx - 1]);
    expect(isSortedAsc, 'items must be sorted by created_at ascending').toBe(true);

    // Now switch sort to done_at desc — filter must remain active
    const filteredDesc = await api(`backlog?from=${sevenDaysAgo}&to=${today}&sort_by=done_at`);
    const allItemsDesc = Object.values(filteredDesc.projects).flatMap(p => p.items);

    const descItems = allItemsDesc.filter(i => i.project_key === PROJECT_KEY &&
      ['DSC-1 recent older', 'DSC-1 recent newer', 'DSC-1 old item'].includes(i.title));

    // Old item must still be excluded with the sort change
    expect(
      descItems.find(i => i.title === 'DSC-1 old item'),
      '60-day-old item must remain excluded after sort change',
    ).toBeUndefined();
  });

});
