import { library, store } from '@/lib/server/backend';
import { repairHostnames, resolveSpelling, runnerConfig, transcribeAudio } from '@/lib/server/runner';

/**
 * Audio → text, for browsers whose own speech recognition is unavailable —
 * which is the normal case in Brave and in Chromium builds without Google's
 * speech backend.
 *
 * The runner can fall back to a local Whisper model. Nothing here can: the
 * model is hundreds of megabytes and would be downloaded again on every cold
 * start, into a filesystem that cannot keep it. So this needs a hosted
 * transcriber, and says so rather than timing out trying.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(req: Request) {
  if (!runnerConfig.stt.enabled) {
    return json(
      {
        error:
          'Speech recognition is unavailable here. This browser could not transcribe locally, and this site has no hosted transcriber configured — set STT_API_KEY (any OpenAI-compatible /audio/transcriptions endpoint) and redeploy. You can type the request instead.',
      },
      503,
    );
  }

  const audio = Buffer.from(await req.arrayBuffer());
  if (audio.length < 512) return json({ error: 'No audio received.' }, 400);

  const mimeType = req.headers.get('content-type') || 'audio/webm';
  const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';

  try {
    const heard = await transcribeAudio(audio, `speech.${extension}`, mimeType);

    /* Fix site names before anyone sees them. By the time "gozion.com" reaches
       the planner it is just a site nobody has heard of, and the user's own
       automations are the correction key. */
    const sites = store && library ? (await library.listAutomations().catch(() => [])).map((a) => a.site) : [];
    const transcript = repairHostnames(resolveSpelling(heard), sites);

    return json({ transcript, heard: transcript === heard ? undefined : heard });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}
