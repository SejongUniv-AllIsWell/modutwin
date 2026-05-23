import type { Metadata } from 'next';
import { Noto_Sans_KR, Source_Serif_4, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '@/lib/auth';
import Navbar from '@/components/dashboard/Navbar';
import AppShell from '@/components/dashboard/AppShell';
import { ToastProvider } from '@/components/ui/Toast';

// splat.wiki Landing.html 와 동일한 3-channel 폰트 — 자체 호스팅 + preload + display:swap.
// globals.css 에서 각 CSS 변수로 참조.
const notoSansKR = Noto_Sans_KR({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-noto-sans-kr',
  display: 'swap',
});

const sourceSerif4 = Source_Serif_4({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-source-serif-4',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: '3DGS Digital Twin Platform',
  description: '3D Gaussian Splatting 기반 디지털 트윈 플랫폼',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/icon-192.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="ko"
      className={`${notoSansKR.variable} ${sourceSerif4.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
        <AuthProvider>
          <ToastProvider>
            <Navbar />
            <AppShell>{children}</AppShell>
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
