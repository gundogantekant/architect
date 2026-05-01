export const version = 18;
export const name = '018-gate-tracking-columns';
export const noTransaction = false;

export async function up(client) {
  await client.query(`
    ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS plan_gate_passed BOOLEAN DEFAULT NULL;
    ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS plan_gate_passed_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS code_gate_passed BOOLEAN DEFAULT NULL;
    ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS code_gate_passed_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS contract_satisfied BOOLEAN DEFAULT NULL;
    ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS contract_satisfied_at TIMESTAMPTZ DEFAULT NULL;
  `);
}
