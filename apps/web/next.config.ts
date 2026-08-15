import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { NextConfig } from 'next';

/* Env lives at the repo root so the runner and the web app share one file.
 *
 * Next only looks for `.env.local` beside this config, so a monorepo keeps its
 * keys somewhere Next never reads — which is why Supabase credentials that were
 * plainly present still produced "Supabase isn't configured" on the sign-up
 * page, and every account quietly fell back to the browser-only stub. */
for (const file of ['.env.local', '.env']) {
  const candidate = path.resolve(process.cwd(), '../..', file);
  if (existsSync(candidate)) loadEnv({ path: candidate });
}

const nextConfig: NextConfig = {
  /* Where the build lands.
   *
   * Normally `.next` beside this config. A Vercel project whose Root Directory
   * points at another workspace needs the output to appear inside that
   * directory instead — Vercel collects the build from within its root and
   * will not reach outside it. Set NEXT_DIST_DIR in that case. */
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  // These workspace packages ship TypeScript source, not a build.
  transpilePackages: ['@mimic/schema', '@mimic/core', '@mimic/runner'],
  /* Left for Node to require at runtime rather than bundled.
   *
   * Playwright resolves driver scripts and a browser binary by path at run
   * time, and @sparticuz/chromium carries a compressed Chromium as a file. A
   * bundler that inlines either produces a module that looks fine and cannot
   * find its own browser. */
  serverExternalPackages: ['playwright', 'playwright-core', '@sparticuz/chromium'],
  images: {
    // Scraped results link out to arbitrary sites, so remote images are
    // proxied rather than optimised against a fixed allowlist.
    unoptimized: true,
  },
};

export default nextConfig;
