export const version = 32;

export async function up(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ai_chat`);

  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ai_chat_app') THEN
        CREATE ROLE ai_chat_app;
      END IF;
    END $$
  `);

  await client.query(`GRANT USAGE ON SCHEMA ai_chat TO ai_chat_app`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_chat.users (
      cognito_sub  TEXT        PRIMARY KEY,
      email        TEXT        NOT NULL UNIQUE,
      given_name   TEXT        NOT NULL DEFAULT '',
      family_name  TEXT        NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_chat.conversations (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_sub    TEXT        NOT NULL REFERENCES ai_chat.users(cognito_sub),
      title       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS conversations_user_sub_created_at_idx
      ON ai_chat.conversations (user_sub, created_at DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_chat.messages (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id  UUID        NOT NULL REFERENCES ai_chat.conversations(id) ON DELETE CASCADE,
      role             TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
      content          TEXT        NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS messages_conversation_id_created_at_idx
      ON ai_chat.messages (conversation_id, created_at DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_chat.token_usage (
      id             UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id     UUID           REFERENCES ai_chat.messages(id) ON DELETE SET NULL,
      user_sub       TEXT           NOT NULL,
      usage_month    DATE           NOT NULL,
      input_tokens   INT            NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
      output_tokens  INT            NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
      model          TEXT           NOT NULL,
      cost_usd       NUMERIC(12,8)  NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS token_usage_user_sub_usage_month_idx
      ON ai_chat.token_usage (user_sub, usage_month DESC)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS token_usage_message_id_idx
      ON ai_chat.token_usage (message_id)
  `);
}

export async function down(client) {
  await client.query(`DROP SCHEMA IF EXISTS ai_chat CASCADE`);
  await client.query(`DROP ROLE IF EXISTS ai_chat_app`);
}
