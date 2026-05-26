'use client';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    fetchAuthSession()
      .then((session) => {
        if (!session.tokens?.idToken) router.replace('/login');
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  return <>{children}</>;
}
