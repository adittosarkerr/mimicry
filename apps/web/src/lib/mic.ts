/**
 * Microphone capture that produces WAV, not WebM.
 *
 * MediaRecorder gives you Opus-in-WebM, which nothing can read without a media
 * decoder. Capturing raw samples through an AudioContext and writing a WAV
 * header ourselves means the transcriber gets PCM it can use directly — no
 * ffmpeg on the server, no codec negotiation, no surprises.
 *
 * Also exposes a live input level so the UI can show that it is actually
 * hearing something, which is the difference between "is this on?" and
 * confidence.
 */

const TARGET_RATE = 16_000; // what speech models expect

export interface MicSession {
  /** 0–1, updated continuously while recording. */
  level: () => number;
  /**
   * Loudest sample seen across the whole recording. Near zero means the
   * capture was silent — a muted or wrong input device — which is worth saying
   * plainly instead of shipping silence off to a transcriber.
   */
  peak: () => number;
  /** Seconds captured so far. */
  duration: () => number;
  stop: () => Promise<Blob>;
  cancel: () => void;
}

export async function startMic(): Promise<MicSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const AudioCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioCtor();

  // Autoplay policy starts a context suspended unless it was created inside a
  // user gesture — and a suspended context never runs its processor, so every
  // recording comes back as pure silence. Resuming is not optional.
  if (context.state === 'suspended') {
    await context.resume().catch(() => {});
  }

  const source = context.createMediaStreamSource(stream);

  // ScriptProcessor is deprecated but universally available and perfectly
  // adequate for a few seconds of speech; an AudioWorklet would need a separate
  // module file for no practical gain here.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let peak = 0;
  let peakEver = 0;
  let samples = 0;
  let stopped = false;

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    samples += input.length;

    let max = 0;
    // Sampling every 16th frame is plenty for a level meter.
    for (let i = 0; i < input.length; i += 16) {
      const v = Math.abs(input[i]);
      if (v > max) max = v;
    }
    // Decay slowly so the meter doesn't flicker between syllables.
    peak = Math.max(max, peak * 0.86);
    if (max > peakEver) peakEver = max;
  };

  source.connect(processor);
  // Chromium won't run a ScriptProcessor that isn't connected to a destination.
  // Route it through a muted gain node so nothing is played back.
  const silence = context.createGain();
  silence.gain.value = 0;
  processor.connect(silence);
  silence.connect(context.destination);

  const teardown = () => {
    stopped = true;
    processor.disconnect();
    source.disconnect();
    silence.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void context.close().catch(() => {});
  };

  return {
    level: () => Math.min(1, peak * 2.2),
    peak: () => peakEver,
    duration: () => samples / context.sampleRate,
    cancel: teardown,
    stop: async () => {
      const rate = context.sampleRate;
      teardown();

      const merged = merge(chunks, samples);
      const resampled = rate === TARGET_RATE ? merged : resample(merged, rate, TARGET_RATE);
      return encodeWav(resampled, TARGET_RATE);
    },
  };
}

function merge(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Linear resample. Speech at 16 kHz doesn't need anything fancier. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    out[i] = a + (b - a) * fraction;
  }
  return out;
}

/** 16-bit PCM mono WAV. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
