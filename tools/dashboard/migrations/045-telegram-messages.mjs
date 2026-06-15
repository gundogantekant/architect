export const version = 45;
export const name = '045-telegram-messages';
export const noTransaction = false;

export async function up(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_messages (
      message_id BIGINT PRIMARY KEY,
      terminal_id TEXT,
      chat_id BIGINT,
      kind TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
}

export async function down(pool) {
  await pool.query(`DROP TABLE IF EXISTS telegram_messages`);
}
