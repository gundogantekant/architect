'use client';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { getCurrentUser } from 'aws-amplify/auth';

export default function LoginPage() {
  const router = useRouter();

  useEffect(() => {
    getCurrentUser().then(() => router.replace('/chat')).catch(() => {});
  }, [router]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-950">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold text-center mb-8 text-white">Architect Chat</h1>
        <Authenticator hideSignUp={false} />
      </div>
    </div>
  );
}
