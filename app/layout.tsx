import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import '@openmaic/renderer/fonts.css';
import 'animate.css';
import 'katex/dist/katex.min.css';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import { AuthAppShell } from '@/components/auth/AuthAppShell';
import { BRAND_ENGLISH_NAME, DEFAULT_BRAND } from '@/lib/brand/brand-config';

// The UI font is loaded from @fontsource's stylesheet rather than next/font,
// because only the stylesheet carries the per-subset `unicode-range`
// declarations. Pointing next/font at `inter-latin-wght-normal.woff2` loaded
// exactly one subset, so every character outside Latin — Cyrillic for ru-RU,
// tone-marked letters for vi-VN — fell back to an arbitrary OS font and
// rendered in a different typeface mid-word.
//
// Declaring the other subset files as sibling faces of the same family does not
// fix it either: faces with identical descriptors and no `unicode-range` do not
// fall through per glyph, so the browser simply picks one.
//
// `--font-sans` moves to globals.css since the family no longer comes from
// next/font's generated class.
import '@fontsource-variable/inter';

export const metadata: Metadata = {
  title: `${DEFAULT_BRAND.productName} · ${BRAND_ENGLISH_NAME}`,
  applicationName: DEFAULT_BRAND.productName,
  icons: {
    icon: DEFAULT_BRAND.markSrc,
    shortcut: DEFAULT_BRAND.markSrc,
    // app/apple-icon.png has an opaque background: iOS shows the mark's
    // transparent corners as black.
    apple: '/apple-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: DEFAULT_BRAND.themeColor },
    { media: '(prefers-color-scheme: dark)', color: '#121816' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        <ThemeProvider>
          <I18nProvider>
            <AuthAppShell>{children}</AuthAppShell>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
