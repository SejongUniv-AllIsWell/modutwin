'use client';

import { usePathname } from 'next/navigation';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const hasOwnHeader = pathname === '/' || pathname === '/about';
  return <main className={hasOwnHeader ? '' : 'pt-14'}>{children}</main>;
}
