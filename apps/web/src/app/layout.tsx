import type { Metadata } from 'next';
import { Inter, Instrument_Serif } from 'next/font/google';
import './globals.css';
import { SiteHeader } from '@/components/site-header';
import { RunnerBanner } from '@/components/runner-banner';
import { SiteFooter } from '@/components/site-footer';
import { AuthProvider } from '@/lib/auth-context';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const display = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Mimic — record it once, run it forever',
    template: '%s · Mimic',
  },
  description:
    'Record any task in your browser. Mimic turns it into an editable form and replays it headlessly — flights, hotels, mail, research, anything.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable}`}>
      <body className="grain min-h-screen antialiased">
        <AuthProvider>
          <RunnerBanner />
          <SiteHeader />
          <main className="min-h-[70vh]">{children}</main>
          <SiteFooter />
        </AuthProvider>
      </body>
    </html>
  );
}
