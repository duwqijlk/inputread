/**
 * Pure helpers for reading a whole chapter aloud: cutting text into requests the voice service
 * accepts, and joining the WAV answers of one paragraph into one file. No browser APIs, no path
 * aliases, so the node tests import this file directly.
 */

/** MiMo takes at most about 1000 characters per request; keep a margin. */
export const SPEECH_BATCH_CHARS = 800;

/**
 * Split a paragraph into batches of whole sentences, each at most `max` characters. A sentence
 * longer than `max` is cut at a comma, semicolon or colon, and only as a last resort at a space.
 * Joining the batches with single spaces gives back the text (whitespace collapsed).
 */
export function splitForSpeech(text: string, max = SPEECH_BATCH_CHARS): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  if (flat.length <= max) return [flat];
  // Sentences: up to an end mark (. ! ? or an ellipsis character) plus any closing quotes or brackets.
  const ellipsis = String.fromCharCode(0x2026);
  const closers = `"')\\]${String.fromCharCode(0x201d, 0x2019)}`;
  const sentencePattern = new RegExp(`[^.!?${ellipsis}]+(?:[.!?${ellipsis}]+[${closers}]*|$)\\s*`, "g");
  const sentences = (flat.match(sentencePattern) ?? [flat]).map((part) => part.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= max) pieces.push(sentence);
    else pieces.push(...splitLong(sentence, max));
  }
  const batches: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (!current) current = piece;
    else if (current.length + 1 + piece.length <= max) current += ` ${piece}`;
    else {
      batches.push(current);
      current = piece;
    }
  }
  if (current) batches.push(current);
  return batches;
}

function splitLong(sentence: string, max: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const head = rest.slice(0, max + 1);
    let cut = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "));
    if (cut < max / 3) cut = head.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export type PcmWav = { rate: number; channels: number; pcm: Uint8Array };

/** The PCM16 samples and format of a WAV file (RIFF, format 1, 16-bit), or null for anything else. */
export function readPcmWav(wav: Uint8Array): PcmWav | null {
  if (wav.byteLength < 12) return null;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(wav[at], wav[at + 1], wav[at + 2], wav[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let at = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  while (at + 8 <= wav.byteLength) {
    const id = tag(at);
    let size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt " && body + 16 <= wav.byteLength) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      // Some encoders write 0 or 0xFFFFFFFF for a streamed length: take what is there.
      if (size === 0 || body + size > wav.byteLength) size = wav.byteLength - body;
      if ((format !== 1 && format !== 0xfffe) || bits !== 16 || !rate || !channels) return null;
      return { rate, channels, pcm: wav.subarray(body, body + size) };
    }
    at = body + size + (size % 2);
  }
  return null;
}

/** One WAV out of several PCM16 WAVs of the same format, or null when they do not match. */
export function joinWavs(files: Uint8Array[]): Uint8Array | null {
  const parts = files.map(readPcmWav);
  if (parts.length === 0 || parts.some((part) => !part)) return null;
  const first = parts[0] as PcmWav;
  if (parts.some((part) => part!.rate !== first.rate || part!.channels !== first.channels)) return null;
  const total = parts.reduce((sum, part) => sum + part!.pcm.byteLength, 0);
  const out = new Uint8Array(44 + total);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) out[at + i] = value.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + total, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, first.channels, true);
  view.setUint32(24, first.rate, true);
  view.setUint32(28, first.rate * first.channels * 2, true);
  view.setUint16(32, first.channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, total, true);
  let at = 44;
  for (const part of parts) {
    out.set(part!.pcm, at);
    at += part!.pcm.byteLength;
  }
  return out;
}

/** About how fast MiMo reads English at 1x, to guess how long a paragraph will play. */
export const SPOKEN_CHARS_PER_SECOND = 14;

/**
 * Which paragraphs to have ready, in order: the one playing, then the next ones until about
 * `seconds` of audio are covered or `maxAhead` paragraphs are queued, never past the end.
 * Counting time, not paragraphs, matters: a run of one-line dialogue plays in a second each
 * while one request takes a few, so a fixed "two ahead" fell behind and left long pauses.
 */
export function prefetchPlan(current: number, lengths: number[], seconds = 90, maxAhead = 12): number[] {
  const out: number[] = [];
  let covered = 0;
  for (let index = Math.max(0, current); index < lengths.length && out.length <= maxAhead; index += 1) {
    out.push(index);
    // The paragraph playing now does not count towards the time kept in hand.
    if (index > current) covered += lengths[index] / SPOKEN_CHARS_PER_SECOND;
    if (covered >= seconds) break;
  }
  return out;
}
