'use client';
import type { ReactNode } from 'react';
import { configureAmplify } from '@/lib/amplify-config';
import './globals.css';

configureAmplify();

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen">{children}</body>
    </html>
  );
}
