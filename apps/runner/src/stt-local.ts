import { config } from './config.js';

/**
 * Speech-to-text with no API key and no network provider.
 *
 * Runs Whisper locally through ONNX. The model is downloaded once (tens of MB)
 * and cached on disk, after which transcription is entirely offline. That
 * matters because the browser's own speech API is unavailable in Brave and in
 * any Chromium build without Google's speech backend — which is precisely where
 * a voice feature is otherwise dead.
 *
 * Audio arrives as 16 kHz mono WAV from the browser, so there is nothing to
 * decode: the samples are read straight out of the file.
 */

type Transcriber = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text?: string } | { text?: string }[]>;

let loading: Promise<Transcriber> | null = null;

/** Loads (and on first call, downloads) the model. Shared across requests. */
function getTranscriber(): Promise<Transcriber> {
  if (loading) return loading;

  loading = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');

    // Keep the model beside the rest of the runner's state.
    env.cacheDir = `${config.storageDir}/models`;
    env.allowLocalModels = true;

    const model = config.stt.localModel;
    console.log(`[stt] loading ${model} (first run downloads it, then it is cached)`);
    const pipe = await pipeline('automatic-speech-recognition', model, { dtype: 'q8' });
    console.log('[stt] model ready');

    return pipe as unknown as Transcriber;
  })().catch((err) => {
    loading = null; // let a later request try again
    throw err;
  });

  return loading;
}

/** True once the model has been loaded into memory. */
export function isLocalSttWarm(): boolean {
  return loading !== null;
}

/** Start loading in the background so the first real request isn't the slow one. */
export function warmLocalStt(): void {
  if (!config.stt.localEnabled) return;
  void getTranscriber().catch((err) => {
    console.error('[stt] could not load the local model:', err instanceof Error ? err.message : err);
  });
}

export async function transcribeLocally(wav: Buffer): Promise<string> {
  const samples = decodeWav(wav);
  if (samples.length < 1600) {
    throw new Error('That was too short to hear — hold the button while you speak.');
  }

  const transcribe = await getTranscriber();

  // English-only checkpoints (…-tiny.en, …-base.en) reject `language`/`task`
  // outright — those options are only meaningful for multilingual models.
  const multilingual = !/\.en\b/i.test(config.stt.localModel);

  const result = await transcribe(samples, {
    // Whisper is trained on 30s windows; longer clips need chunking.
    chunk_length_s: 30,
    stride_length_s: 5,
    ...(multilingual ? { language: 'english', task: 'transcribe' } : {}),
  });

  const text = Array.isArray(result) ? result.map((r) => r.text ?? '').join(' ') : (result.text ?? '');
  const cleaned = text.replace(/\s+/g, ' ').trim();

  /* Whisper hallucinates stock phrases when fed silence or noise rather than
     returning nothing. Filter those, but say what was heard — "I didn't catch
     that" with no detail is impossible to act on. */
  const isArtifact = /^(\[.*\]|\(.*\)|you|thank you\.?|thanks for watching[.!]?|bye[.!]?)$/i.test(cleaned);

  if (!cleaned) {
    throw new Error("I didn't catch anything — check the microphone input and try again.");
  }
  if (isArtifact) {
    throw new Error(
      `I only picked up “${cleaned}”, which usually means near-silence. Move closer to the mic, or check the input device.`,
    );
  }
  return cleaned;
}

/**
 * Reads 16-bit PCM out of a WAV file.
 *
 * Deliberately minimal: it walks the RIFF chunks rather than assuming a 44-byte
 * header, because browsers and audio tools pad `fmt ` and insert `LIST` chunks
 * at will, and a fixed offset silently reads noise when they do.
 */
function decodeWav(buffer: Buffer): Float32Array {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('That audio was not in a format Mimic could read.');
  }

  let offset = 12; // past "RIFF<size>WAVE"
  let channels = 1;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(offset + 10);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataStart = offset + 8;
      dataLength = Math.min(size, buffer.length - dataStart);
      break;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }

  if (dataStart < 0) throw new Error('That audio file had no sound data in it.');
  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported audio format (${bitsPerSample}-bit) — expected 16-bit PCM.`);
  }

  const frames = Math.floor(dataLength / 2 / channels);
  const out = new Float32Array(frames);

  for (let i = 0; i < frames; i += 1) {
    // Mix down to mono; the browser sends one channel, but be safe.
    let sum = 0;
    for (let c = 0; c < channels; c += 1) {
      sum += buffer.readInt16LE(dataStart + (i * channels + c) * 2);
    }
    out[i] = sum / channels / 32768;
  }

  return out;
}
