import { store } from '@/lib/server/backend';

/**
 * What this site can do on its own.
 *
 * Deliberately does not import the runner module: this is asked on page load,
 * and pulling in Playwright and a 50MB Chromium to answer "can you transcribe"
 * would make every visit to the voice page wait on a cold start. The two keys
 * it reports on are read straight from the environment for the same reason.
 */

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    {
      ok: true,
      ai: process.env.DEEPSEEK_API_KEY ? (process.env.DEEPSEEK_MODEL ?? 'deepseek-chat') : false,
      /* No local Whisper here. The model is hundreds of megabytes and would be
         downloaded again on every cold start into a filesystem that cannot
         keep it, so speech needs a hosted transcriber or the browser's own. */
      stt: process.env.STT_API_KEY ? (process.env.STT_MODEL ?? 'whisper-1') : false,
      browser: true,
      store: store ? 'supabase' : 'none',
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
