import { fetchAuthSession, getCurrentUser } from 'aws-amplify/auth';

export async function getCurrentUserSub(): Promise<string | null> {
  try {
    const user = await getCurrentUser();
    return user.userId;
  } catch {
    return null;
  }
}

export async function getIdTokenString(): Promise<string | null> {
  try {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() ?? null;
  } catch {
    return null;
  }
}

export interface AuthenticatedUser {
  sub: string;
  email: string;
  givenName: string;
  familyName: string;
}

export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  try {
    const session = await fetchAuthSession();
    const idToken = session.tokens?.idToken;
    if (!idToken) return null;
    const payload = idToken.payload;
    return {
      sub: payload.sub as string,
      email: (payload.email as string) ?? '',
      givenName: (payload.given_name as string) ?? '',
      familyName: (payload.family_name as string) ?? '',
    };
  } catch {
    return null;
  }
}
