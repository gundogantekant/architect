import { Amplify } from 'aws-amplify';

export function configureAmplify(): void {
  const userPoolId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;

  if (!userPoolId) {
    throw new Error(
      'NEXT_PUBLIC_COGNITO_USER_POOL_ID is not set. ' +
      'Copy .env.local.example to .env.local and fill in your Cognito User Pool ID ' +
      'from: AWS Console → Cognito → User Pools → [pool] → Overview → User Pool ID'
    );
  }
  if (!clientId) {
    throw new Error(
      'NEXT_PUBLIC_COGNITO_CLIENT_ID is not set. ' +
      'Copy .env.local.example to .env.local and fill in your Cognito App Client ID ' +
      'from: AWS Console → Cognito → User Pools → [pool] → App clients → [client] → Client ID'
    );
  }

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId: clientId,
      },
    },
  });
}
