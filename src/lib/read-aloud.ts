import { create } from "zustand";
import {
  cleanSpeechText,
  PCM_RATE,
  pcm16ToFloat32,
  pcm16ToWav,
  synthesizePcmStream,
  synthesizeWav,
  TtsError,
  type MimoVoice,
  type TtsErrorCode,
} from "@/lib/mimo-tts";
import { useTtsSettings } from "@/lib/tts-settings";

/**
 * One read-aloud at a time, played with Web Audio. The AudioContext is created and resumed inside
 * the tap itself (the play button's click), which is what lets iPhone Safari play audio that only
 * arrives after a network request. A paragraph streams (it starts within a moment); a short text
 * asks for one WAV. Audio already made this session is replayed from memory, not asked for again;
 * nothing is written to disk.
 */

export type ReadAloudStatus = "idle" | "loading" | "playing" | "error";

type ReadAloudState = {
  /** which button owns the current audio (e.g. "para:3", "sentence:3:1"), or "" */
  owner: string;
  status: ReadAloudStatus;
  error: TtsErrorCode | "play" | null;
};

export const useReadAloud = create<ReadAloudState>(() => ({ owner: "", status: "idle", error: null }));

/** Texts at or over this length stream; shorter ones are one request for a whole WAV file. */
const STREAM_FROM = 220;
const CACHE_LIMIT = 40;
const cache = new Map<string, Uint8Array>();

let context: AudioContext | null = null;
let run = 0;
let abort: AbortController | null = null;
let sources: AudioBufferSourceNode[] = [];

function audioContext(): AudioContext | null {
  if (context && context.state !== "closed") return context;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext || w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

function remember(key: string, wav: Uint8Array): void {
  cache.delete(key);
  cache.set(key, wav);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

function stopSources(): void {
  for (const source of sources) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // already stopped
    }
  }
  sources = [];
}

/** Stop whatever is reading (a second tap on the same button, closing the panel, a new text). */
export function stopReadAloud(): void {
  run += 1;
  abort?.abort();
  abort = null;
  stopSources();
  useReadAloud.setState({ owner: "", status: "idle", error: null });
}

function fail(owner: string, code: TtsErrorCode | "play"): void {
  stopSources();
  useReadAloud.setState({ owner, status: "error", error: code });
}

/** Play a whole WAV file; resolves when it ends. */
async function playWav(ctx: AudioContext, wav: Uint8Array, mine: number): Promise<void> {
  const copy = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
  const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
    // The callback form also works on older Safari, where decodeAudioData returns no promise.
    const result = ctx.decodeAudioData(copy, resolve, reject);
    if (result && typeof (result as Promise<AudioBuffer>).then === "function") (result as Promise<AudioBuffer>).then(resolve, reject);
  });
  if (mine !== run) return;
  await new Promise<void>((resolve) => {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => resolve();
    sources.push(source);
    source.start();
  });
}

/**
 * Read `text` aloud for the button `owner`. Call it from the click itself (it unlocks audio).
 * A tap on the button that is already reading stops it instead.
 */
export function toggleReadAloud(owner: string, rawText: string): void {
  const current = useReadAloud.getState();
  if (current.owner === owner && (current.status === "loading" || current.status === "playing")) {
    stopReadAloud();
    return;
  }
  stopReadAloud();
  const text = cleanSpeechText(rawText);
  const { apiKey, voice } = useTtsSettings.getState();
  if (!text || !apiKey) return;
  // Chapter reading (chapter-aloud.ts) stops while a single text is read.
  window.dispatchEvent(new Event("inputread-read-aloud-single"));
  const ctx = audioContext();
  if (!ctx) {
    fail(owner, "play");
    return;
  }
  // Inside the tap: resume now so later, network-delayed playback is allowed.
  void ctx.resume?.();
  const mine = run;
  void readAloud(ctx, owner, text, apiKey, voice, mine);
}

async function readAloud(ctx: AudioContext, owner: string, text: string, apiKey: string, voice: MimoVoice, mine: number): Promise<void> {
  const key = `${voice}\n${text}`;
  const controller = new AbortController();
  abort = controller;
  try {
    const hit = cache.get(key);
    if (hit) {
      useReadAloud.setState({ owner, status: "playing", error: null });
      await playWav(ctx, hit, mine);
    } else if (text.length < STREAM_FROM) {
      useReadAloud.setState({ owner, status: "loading", error: null });
      const wav = await synthesizeWav(apiKey, voice, text, controller.signal);
      if (mine !== run) return;
      remember(key, wav);
      useReadAloud.setState({ owner, status: "playing", error: null });
      await playWav(ctx, wav, mine);
    } else {
      useReadAloud.setState({ owner, status: "loading", error: null });
      // Schedule each chunk right after the one before, from the first chunk's arrival.
      let at = 0;
      let last: AudioBufferSourceNode | null = null;
      const pcm = await synthesizePcmStream(
        apiKey,
        voice,
        text,
        (chunk) => {
          if (mine !== run) return;
          const samples = pcm16ToFloat32(chunk);
          if (samples.length === 0) return;
          const buffer = ctx.createBuffer(1, samples.length, PCM_RATE);
          buffer.getChannelData(0).set(samples);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          at = Math.max(at, ctx.currentTime + 0.05);
          source.start(at);
          at += buffer.duration;
          sources.push(source);
          last = source;
          if (useReadAloud.getState().status !== "playing") useReadAloud.setState({ owner, status: "playing", error: null });
        },
        controller.signal,
      );
      if (mine !== run) return;
      remember(key, pcm16ToWav(pcm));
      const tail = last as AudioBufferSourceNode | null;
      if (tail) await new Promise<void>((resolve) => { tail.onended = () => resolve(); });
    }
    if (mine === run) {
      sources = [];
      useReadAloud.setState({ owner: "", status: "idle", error: null });
    }
  } catch (error) {
    if (mine !== run) return;
    const code = error instanceof TtsError ? error.code : "play";
    if (code === "aborted") return;
    fail(owner, code);
  } finally {
    if (abort === controller) abort = null;
  }
}

// Chapter reading starting stops a single text that is reading.
if (typeof window !== "undefined") {
  window.addEventListener("inputread-read-aloud-chapter", () => {
    if (useReadAloud.getState().status !== "idle") stopReadAloud();
  });
}

/** Check a key with a one-word request (Account > Read aloud > Test); plays it when it works. */
export async function testReadAloudKey(apiKey: string, voice: MimoVoice): Promise<TtsErrorCode | "play" | null> {
  stopReadAloud();
  const ctx = audioContext();
  void ctx?.resume?.();
  try {
    const wav = await synthesizeWav(apiKey, voice, "Hello! This is how I sound.");
    if (ctx) {
      const mine = run;
      useReadAloud.setState({ owner: "test", status: "playing", error: null });
      await playWav(ctx, wav, mine).catch(() => undefined);
      if (mine === run) useReadAloud.setState({ owner: "", status: "idle", error: null });
    }
    return null;
  } catch (error) {
    return error instanceof TtsError ? error.code : "play";
  }
}
