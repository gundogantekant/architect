const MAX_APPROVERS_PER_ITEM = 20;

export default function approvalRoutes(deps) {
  const { db, json, err, parseBody } = deps;

  return [
    [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/approvals$/, 'GET', async (m, _req, res) => {
      const item = db.getWorkItem(m[1]);
      if (!item) return err(res, 'work item not found', 404);
      json(res, db.getWorkItemApprovals(m[1]));
    }],

    [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/approvals$/, 'POST', async (m, req, res) => {
      const itemId = m[1];
      const item = db.getWorkItem(itemId);
      if (!item) return err(res, 'work item not found', 404);

      const existing = db.getWorkItemApprovals(itemId);
      if (existing.length >= MAX_APPROVERS_PER_ITEM) {
        return err(res, `approver cap reached (${MAX_APPROVERS_PER_ITEM})`, 400);
      }

      const body = await parseBody(req);
      const { identity, sort_order, blocking_work_item_id } = body;
      if (!identity) return err(res, 'identity is required', 400);

      if (blocking_work_item_id && !db.getWorkItem(blocking_work_item_id)) {
        return err(res, `blocking_work_item_id ${blocking_work_item_id} not found`, 400);
      }

      const approval = db.addWorkItemApproval({ workItemId: itemId, identity, sort_order, blocking_work_item_id });
      db.addWorkItemLog(itemId, `Approval requested from ${identity}`);
      json(res, approval, 201);
    }],

    [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/approvals\/(\d+)$/, 'PATCH', async (m, req, res) => {
      const itemId = m[1];
      const approvalId = Number(m[2]);
      const item = db.getWorkItem(itemId);
      if (!item) return err(res, 'work item not found', 404);

      const approval = db.getApprovalById(approvalId);
      if (!approval || approval.work_item_id !== itemId) return err(res, 'approval not found', 404);

      const body = await parseBody(req);
      const allowed = new Set(['pending', 'approved', 'rejected']);
      if (body.status !== undefined && !allowed.has(body.status)) {
        return err(res, `invalid approval status '${body.status}'`, 400);
      }

      const mode = item.approval.mode;
      if (mode === 'sequential' && body.status && body.status !== 'pending') {
        const activeId = db.getActiveApproverForSequential(itemId);
        if (activeId !== approvalId) {
          return err(res, 'sequential mode: only the lowest sort_order pending approver may decide', 400);
        }
      }

      if (approval.blocking_work_item_id && body.status === 'approved') {
        const blocker = db.getWorkItem(approval.blocking_work_item_id);
        if (blocker && blocker.status !== 'done') {
          return err(res, `cannot approve while blocker ${approval.blocking_work_item_id} is ${blocker.status}`, 400);
        }
      }

      const updated = db.updateWorkItemApproval(approvalId, { status: body.status, reason: body.reason });
      db.addWorkItemLog(itemId, `Approval ${approval.identity}: ${body.status}${body.reason ? ` (${body.reason})` : ''}`);
      json(res, updated);
    }],
  ];
}
