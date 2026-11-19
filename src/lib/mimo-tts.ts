/**
 * Xiaomi MiMo speech synthesis (MiMo-V2.5-TTS), called straight from the browser with the reader's
 * own API key. The API is OpenAI-compatible: POST /v1/chat/completions, the text to speak in an
 * `assistant` message, `audio: { voice, format }`. It answers CORS for any origin with the
 * `authorization` header allowed, so no server of ours sits in between and the key never reaches us.
 *
 * Audio comes back base64-encoded: a whole WAV file (non-streaming), or 24 kHz mono PCM16LE chunks
 * in an OpenAI-style event stream (`stream: true`, format "pcm16").
 *
 * Plain functions only (no React, no path aliases), so the node tests can import this file.
 * Docs: https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5
 */

export const MIMO_ENDPOINT = "https://api.xiaomimimo.com/v1/chat/completions";
/** One place to change when Xiaomi moves the voice model to a new version. */
export const MIMO_TTS_MODEL = "mimo-v2.5-tts";
/** Where a reader creates a key. */
export const MIMO_CONSOLE_URL = "https://platform.xiaomimimo.com/";
/** The streaming format: 24 kHz, mono, 16-bit little-endian PCM. */
export const PCM_RATE = 24000;

/** The four English preset voices of MiMo-V2.5-TTS. */
export const MIMO_VOICES = [
  { id: "Mia", gender: "female" },
  { id: "Chloe", gender: "female" },
  { id: "Milo", gender: "male" },
  { id: "Dean", gender: "male" },
] as const;
export type MimoVoice = (typeof MIMO_VOICES)[number]["id"];
export const DEFAULT_VOICE: MimoVoice = "Mia";

export function isMimoVoice(value: unknown): value is MimoVoice {
  return MIMO_VOICES.some((voice) => voice.id === value);
}

/** Longest text sent in one request; a longer paragraph is cut at a sentence end before it. */
export const MAX_SPEECH_CHARS = 2400;

/**
 * The words to speak: soft hyphens (inserted for justified text) and zero-width marks removed,
 * whitespace collapsed, and an over-long text cut at the last sentence end that fits.
 */
export function cleanSpeechText(text: string): string {
  const flat = text
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= MAX_SPEECH_CHARS) return flat;
  const head = flat.slice(0, MAX_SPEECH_CHARS);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf("\u201D "));
  return (end > MAX_SPEECH_CHARS / 2 ? head.slice(0, end + 1) : head).trim();
}

export function speechRequestBody(text: string, voice: MimoVoice, stream: boolean): string {
  return JSON.stringify({
    model: MIMO_TTS_MODEL,
    // The text to speak must be the assistant message (the API reads `user` as style instructions).
    messages: [{ role: "assistant", content: text }],
    audio: { voice, format: stream ? "pcm16" : "wav" },
    ...(stream ? { stream: true } : {}),
  });
}

export function speechRequestInit(apiKey: string, body: string, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey.trim()}`, "content-type": "application/json" },
    body,
    signal,
    // The key is the credential: no cookies, no referrer details beyond the origin.
    credentials: "omit",
    referrerPolicy: "origin",
    cache: "no-store",
  };
}

export type TtsErrorCode = "key" | "rate" | "network" | "server" | "empty" | "aborted";

export class TtsError extends Error {
  readonly code: TtsErrorCode;
  constructor(code: TtsErrorCode, detail = "") {
    super(detail || code);
    this.code = code;
    this.name = "TtsError";
  }
}

/** What an HTTP status means for the reader. */
export function ttsErrorForStatus(status: number): TtsErrorCode {
  if (status === 401 || status === 403) return "key";
  if (status === 429) return "rate";
  if (status === 402) return "rate"; // no balance / free allowance used up
  return "server";
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** A WAV file (RIFF, PCM16, mono) around raw PCM16LE samples, so streamed audio can be cached and replayed. */
export function pcm16ToWav(pcm: Uint8Array, rate = PCM_RATE): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) out[at + i] = value.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** PCM16LE bytes to samples in [-1, 1) for Web Audio. An odd trailing byte is ignored. */
export function pcm16ToFloat32(pcm: Uint8Array): Float32Array {
  const count = pcm.byteLength >> 1;
  const view = new DataView(pcm.buffer, pcm.byteOffset, count * 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** The base64 audio of a non-streaming answer (`choices[0].message.audio.data`), or "". */
export function audioOfCompletion(json: unknown): string {
  const choice = (json as { choices?: Array<{ message?: { audio?: { data?: unknown } } }> })?.choices?.[0];
  const data = choice?.message?.audio?.data;
  return typeof data === "string" ? data : "";
}

/**
 * Feed event-stream text in any slicing; get back each chunk's base64 audio
 * (`choices[0].delta.audio.data`). Returns the unfinished tail to pass in with the next text.
 */
export function readAudioEvents(buffer: string, onAudio: (base64: string) => void): string {
  const lines = buffer.split(/\r?\n/);
  const tail = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload) as { choices?: Array<{ delta?: { audio?: { data?: unknown } } }> };
      const data = json.choices?.[0]?.delta?.audio?.data;
      if (typeof data === "string" && data) onAudio(data);
    } catch {
      // A malformed event is skipped; the rest of the stream still plays.
    }
  }
  return tail;
}

async function failFor(response: Response): Promise<never> {
  let detail = "";
  try {
    detail = String(((await response.json()) as { error?: { message?: unknown } })?.error?.message ?? "");
  } catch {
    // no readable body
  }
  throw new TtsError(ttsErrorForStatus(response.status), detail);
}

async function post(apiKey: string, body: string, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(MIMO_ENDPOINT, speechRequestInit(apiKey, body, signal));
  } catch (error) {
    if (signal?.aborted) throw new TtsError("aborted");
    throw new TtsError("network", error instanceof Error ? error.message : "");
  }
  if (!response.ok) await failFor(response);
  return response;
}

/** The whole text as one WAV file. */
export async function synthesizeWav(apiKey: string, voice: MimoVoice, text: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await post(apiKey, speechRequestBody(text, voice, false), signal);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    if (signal?.aborted) throw new TtsError("aborted");
    throw new TtsError("server", "unreadable answer");
  }
  const data = audioOfCompletion(json);
  if (!data) throw new TtsError("empty");
  return base64ToBytes(data);
}

/**
 * Stream the text: `onPcm` gets each PCM16LE chunk as it arrives (to play at once). Resolves with
 * all the PCM, for the cache. Falls back to the whole-file request where streams are unavailable.
 */
export async function synthesizePcmStream(
  apiKey: string,
  voice: MimoVoice,
  text: string,
  onPcm: (pcm: Uint8Array) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await post(apiKey, speechRequestBody(text, voice, true), signal);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const take = (base64: string) => {
    const pcm = base64ToBytes(base64);
    if (pcm.byteLength === 0) return;
    chunks.push(pcm);
    total += pcm.byteLength;
    onPcm(pcm);
  };
  const reader = response.body?.getReader?.();
  try {
    if (!reader) {
      readAudioEvents(`${await response.text()}\n`, take);
    } else {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = readAudioEvents(buffer + decoder.decode(value, { stream: true }), take);
      }
      readAudioEvents(`${buffer + decoder.decode()}\n`, take);
    }
  } catch (error) {
    if (signal?.aborted) throw new TtsError("aborted");
    if (error instanceof TtsError) throw error;
    throw new TtsError("network", error instanceof Error ? error.message : "");
  }
  if (total === 0) throw new TtsError("empty");
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
}
