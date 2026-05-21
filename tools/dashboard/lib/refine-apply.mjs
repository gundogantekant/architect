const ALLOWED_TARGET_STATUSES = new Set(['planned', 'draft', 'blocked']);

export async function applyRefinementSummary(dispatchId, summary, { db }) {
  await db.withTransaction(async (client) => {
    const idempotencyRow = await client.query(
      'SELECT completion_summary FROM dispatches WHERE id = $1',
      [dispatchId]
    );
    if (idempotencyRow.rows[0]?.completion_summary != null) return;

    for (const item of summary.items || []) {
      const { item_id, refined_description, target_status } = item;

      if (!ALLOWED_TARGET_STATUSES.has(target_status)) {
        console.warn(`[refine-apply] dispatch ${dispatchId}: skipping item ${item_id} — invalid target_status: ${target_status}`);
        continue;
      }

      const existingRow = await client.query(
        'SELECT id FROM work_items WHERE id = $1',
        [item_id]
      );
      if (!existingRow.rows.length) {
        console.warn(`[refine-apply] dispatch ${dispatchId}: skipping item ${item_id} — not found in DB`);
        continue;
      }

      await client.query(
        'UPDATE work_items SET description = $1, status = $2, updated_at = NOW() WHERE id = $3',
        [refined_description, target_status, item_id]
      );
    }

    await client.query(
      'UPDATE dispatches SET completion_summary = $1 WHERE id = $2',
      [JSON.stringify(summary), dispatchId]
    );
  });
}
