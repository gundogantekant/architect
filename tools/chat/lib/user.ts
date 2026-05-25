import { query } from './db';
import type { AuthenticatedUser } from './auth';

export async function ensureUser(user: AuthenticatedUser): Promise<void> {
  await query(
    `INSERT INTO users (cognito_sub, email, given_name, family_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (cognito_sub) DO UPDATE SET
       email = EXCLUDED.email,
       given_name = EXCLUDED.given_name,
       family_name = EXCLUDED.family_name`,
    [user.sub, user.email, user.givenName, user.familyName]
  );
}
