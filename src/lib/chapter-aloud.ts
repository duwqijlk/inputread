import { create } from "zustand";
import { cleanSpeechText, pcm16ToWav, synthesizeWav, TtsError, type MimoVoice, type TtsErrorCode } from "@/lib/mimo-tts";
import { joinWavs, prefetchPlan, readPcmWav, splitForSpeech } from "@/lib/speech-split";
import { useTtsSettings } from "@/lib/tts-settings";

/**
 * Reading a whole chapter aloud with the reader's own MiMo voice.
 *
 * - Each paragraph is cut into batches of whole sentences under MiMo's per-request limit
 *   (speech-split.ts); the batches' WAVs are joined into one file, so a long paragraph plays with
 *   no seam inside it.
 * - About 90 seconds of audio past the paragraph playing are prepared ahead (at most 12
 *   paragraphs), two requests at a time, the paragraph needed now always first. A request that
 *   meets a rate limit or a dropped connection is tried again before reading stops.
 * - Playback is one <audio> element (not Web Audio): it keeps playing with the screen locked, and
 *   Media Session puts the book, chapter and play/pause/previous/next on the lock screen. The
 *   element is unlocked inside the tap that starts reading (iPhone Safari needs that).
 * - The short pause between paragraphs is silence at the end of each paragraph's own audio, and the
 *   next paragraph starts from the element's "ended" event, not a timer: a locked phone throttles
 *   timers (seconds, or not at all), which made reading stutter or stop between paragraphs.
 * - With the screen locked it keeps going until the reader pauses: while the next paragraph is
 *   still being made, the element plays silence (a playing element keeps the phone's audio
 *   session; a stopped one may not be allowed to start again from the background), and a
 *   system interruption (a call) is shown as paused, to resume from the lock screen.
 * - Prepared audio stays in memory for this session only.
 */

export type AloudStatus = "off" | "loading" | "playing" | "paused" | "advancing" | "error";

type AloudState = {
  /** the player bar is open (it opens from the top-bar button, before reading starts) */
  panel: boolean;
  status: AloudStatus;
  /** paragraph playing (or about to), in the chapter's paragraph list */
  index: number;
  total: number;
  error: TtsErrorCode | "play" | null;
};

export const useChapterAloud = create<AloudState>(() => ({ panel: false, status: "off", index: 0, total: 0, error: null }));

/** Open the player (voice, speed, then Play). Nothing plays yet. */
export function openAloudPanel(): void {
  useChapterAloud.setState({ panel: true });
}

export type AloudChapter = {
  paragraphs: string[];
  /** lock-screen text */
  bookTitle: string;
  chapterTitle: string;
  author: string;
  /** the chapter has ended: open the next one and call continueChapterAloud, or return false */
  onChapterEnd?: () => boolean;
};

/** Pause between two paragraphs, as a reader takes a breath at a new paragraph (inside the audio). */
const PARAGRAPH_PAUSE_MS = 320;
const AHEAD_SECONDS = 90;
const AHEAD_MAX = 12;
const CONCURRENCY = 2;
const RETRY_DELAYS_MS = [1500, 4000];
const CACHE_LIMIT = 80;
/** Events between the two read-aloud players, so they never sound at once (no import cycle). */
export const SINGLE_STARTS = "inputread-read-aloud-single";
export const CHAPTER_STARTS = "inputread-read-aloud-chapter";

let audio: HTMLAudioElement | null = null;
let chapter: AloudChapter | null = null;
let session = 0;
let abort: AbortController | null = null;
let running = 0;
const waiting: Array<() => void> = [];
let currentUrl = "";
let silenceUrl = "";
/** Our own src switches and pauses, so the element's "pause" event is not taken for a call. */
let quietUntil = 0;
/** Keys of paragraphs whose audio is ready (their promise has resolved). */
const ready = new Set<string>();
/** True once a real paragraph (not the unlocking silence) is loaded in the element. */
let trackLoaded = false;
const prepared = new Map<string, Promise<Uint8Array[]>>();

function element(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = "auto";
    audio.setAttribute("playsinline", "");
    audio.setAttribute("data-chapter-aloud", "");
    // A pause we did not ask for (a call, another app, headphones out): show it as paused, so the
    // lock screen and the bar offer Play, and nothing restarts on its own.
    audio.addEventListener("pause", () => {
      if (Date.now() < quietUntil || audio?.ended) return;
      const state = useChapterAloud.getState();
      if (state.status === "playing" || state.status === "loading") {
        useChapterAloud.setState({ status: "paused" });
        setPlaybackState("paused");
      }
    });
  }
  return audio;
}

function quiet(ms = 400): void {
  quietUntil = Date.now() + ms;
}

/** One second of silence, looped while the next paragraph is still being made. */
function holdSilence(): void {
  const el = element();
  if (!silenceUrl) silenceUrl = URL.createObjectURL(new Blob([pcm16ToWav(new Uint8Array(24000 * 2)) as BlobPart], { type: "audio/wav" }));
  if (el.src === silenceUrl && !el.paused) return;
  quiet();
  el.loop = true;
  el.src = silenceUrl;
  trackLoaded = false;
  void el.play().catch(() => undefined);
}

function keyOf(voice: MimoVoice, text: string): string {
  return `${voice}\n${text}`;
}

function remember(key: string, value: Promise<Uint8Array[]>): void {
  prepared.delete(key);
  prepared.set(key, value);
  while (prepared.size > CACHE_LIMIT) {
    const old = prepared.keys().next().value as string;
    prepared.delete(old);
    ready.delete(old);
  }
}

/** At most CONCURRENCY requests at once; `urgent` (the paragraph needed now) jumps the queue. */
function limited<T>(task: () => Promise<T>, urgent: boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const go = () => {
      running += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          waiting.shift()?.();
        });
    };
    if (running < CONCURRENCY) go();
    else if (urgent) waiting.unshift(go);
    else waiting.push(go);
  });
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new TtsError("aborted"));
      },
      { once: true },
    );
  });
}

/** A rate limit, a dropped connection or a server hiccup is tried again; a bad key is not. */
async function withRetry(make: () => Promise<Uint8Array>, signal?: AbortSignal): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await make();
    } catch (error) {
      const code = error instanceof TtsError ? error.code : "network";
      const again = (code === "rate" || code === "network" || code === "server") && attempt < RETRY_DELAYS_MS.length;
      if (!again || signal?.aborted) throw error;
      await wait(RETRY_DELAYS_MS[attempt], signal);
    }
  }
}

/** The paragraph's own audio with the pause after it, so the next one can start at "ended". */
function withPause(wav: Uint8Array): Uint8Array {
  const info = readPcmWav(wav);
  if (!info || info.channels !== 1) return wav;
  const samples = Math.round((info.rate * PARAGRAPH_PAUSE_MS) / 1000);
  return joinWavs([wav, pcm16ToWav(new Uint8Array(samples * 2), info.rate)]) ?? wav;
}

/** The audio of one paragraph: usually one joined WAV, or its batches when they could not be joined. */
function prepare(index: number, urgent = false): Promise<Uint8Array[]> | null {
  const text = chapter ? cleanSpeechText(chapter.paragraphs[index] ?? "") : "";
  const { apiKey, voice } = useTtsSettings.getState();
  if (!text || !apiKey) return null;
  const key = keyOf(voice, text);
  const hit = prepared.get(key);
  if (hit) return hit;
  const signal = abort?.signal;
  // The batches of a long paragraph are asked for side by side (within the limit), kept in order.
  const job = Promise.all(
    splitForSpeech(text).map((batch) =>
      limited(() => withRetry(() => synthesizeWav(apiKey, voice, batch, signal), signal), urgent),
    ),
  ).then((wavs) => {
    const joined = wavs.length > 1 ? joinWavs(wavs) : wavs[0];
    if (joined) return [withPause(joined)];
    return [...wavs.slice(0, -1), withPause(wavs[wavs.length - 1])];
  });
  job.then(() => ready.add(key), () => undefined);
  // A failed paragraph is not kept: the next try asks again.
  job.catch(() => {
    if (prepared.get(key) === job) prepared.delete(key);
  });
  remember(key, job);
  return job;
}

function prefetch(from: number): void {
  if (!chapter) return;
  const lengths = chapter.paragraphs.map((text) => cleanSpeechText(text).length);
  for (const index of prefetchPlan(from, lengths, AHEAD_SECONDS, AHEAD_MAX)) {
    if (index !== from) void prepare(index)?.catch(() => undefined);
  }
}

function releaseUrl(): void {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = "";
}

function playTrack(wav: Uint8Array, mine: number): Promise<void> {
  const el = element();
  return new Promise<void>((resolve, reject) => {
    releaseUrl();
    currentUrl = URL.createObjectURL(new Blob([wav as BlobPart], { type: "audio/wav" }));
    quiet();
    el.loop = false;
    el.src = currentUrl;
    trackLoaded = true;
    el.playbackRate = useTtsSettings.getState().rate;
    el.onended = () => resolve();
    el.onerror = () => reject(new TtsError("server", "audio element error"));
    el.play().catch((error) => {
      if (mine !== session) resolve();
      else reject(error instanceof Error && error.name === "NotAllowedError" ? Object.assign(new Error("blocked"), { blocked: true }) : error);
    });
  });
}

async function playFrom(index: number, mine: number): Promise<void> {
  if (!chapter) return;
  const total = chapter.paragraphs.length;
  let at = index;
  // Skip paragraphs with nothing to say (a lone "*").
  while (at < total && !cleanSpeechText(chapter.paragraphs[at] ?? "").match(/[A-Za-z0-9]/)) at += 1;
  if (at >= total) {
    finishChapter(mine);
    return;
  }
  const key = keyOf(useTtsSettings.getState().voice, cleanSpeechText(chapter.paragraphs[at]));
  const waitingForAudio = !ready.has(key);
  useChapterAloud.setState({ index: at, total, error: null, status: waitingForAudio ? "loading" : "playing" });
  updateMediaSession();
  const job = prepare(at, true);
  prefetch(at);
  if (!job) return;
  // Not ready yet: keep the element playing (silence) so a locked phone keeps the audio going.
  if (waitingForAudio) holdSilence();
  let tracks: Uint8Array[];
  try {
    tracks = await job;
  } catch (error) {
    if (mine !== session) return;
    const code = error instanceof TtsError ? error.code : "server";
    if (code === "aborted") return;
    fail(code);
    return;
  }
  if (mine !== session) return;
  useChapterAloud.setState({ status: "playing" });
  setPlaybackState("playing");
  try {
    for (const track of tracks) {
      await playTrack(track, mine);
      if (mine !== session) return;
    }
  } catch (error) {
    if (mine !== session) return;
    fail((error as { blocked?: boolean }).blocked ? "play" : "play");
    return;
  }
  if (mine !== session || useChapterAloud.getState().status === "paused") return;
  // Straight on from "ended" (the pause is already in the audio): no timer for a locked phone to hold.
  void playFrom(at + 1, mine);
}

function finishChapter(mine: number): void {
  if (mine !== session) return;
  const next = chapter?.onChapterEnd;
  if (useTtsSettings.getState().autoNext && next && next()) {
    useChapterAloud.setState({ status: "advancing" });
    return;
  }
  stopChapterAloud();
}

function fail(code: TtsErrorCode | "play"): void {
  element().pause();
  setPlaybackState("paused");
  useChapterAloud.setState({ status: "error", error: code });
}

function setPlaybackState(state: "playing" | "paused" | "none"): void {
  try {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state;
  } catch {
    // not supported
  }
}

function updateMediaSession(): void {
  if (!chapter || !("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapter.chapterTitle || chapter.bookTitle,
      artist: chapter.author,
      album: chapter.bookTitle,
    });
    const handlers: Array<[MediaSessionAction, () => void]> = [
      ["play", resumeChapterAloud],
      ["pause", pauseChapterAloud],
      ["previoustrack", () => skipChapterAloud(-1)],
      ["nexttrack", () => skipChapterAloud(1)],
      ["stop", stopChapterAloud],
    ];
    for (const [action, handler] of handlers) navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // An engine without some actions still plays.
  }
}

function clearMediaSession(): void {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = null;
    for (const action of ["play", "pause", "previoustrack", "nexttrack", "stop"] as MediaSessionAction[]) {
      navigator.mediaSession.setActionHandler(action, null);
    }
    navigator.mediaSession.playbackState = "none";
  } catch {
    // ignore
  }
}

/**
 * A new reading position. Requests already under way are kept (moving on a paragraph usually
 * needs them); only stopping, or a new chapter, cancels them (`cancel`).
 */
function newSession(cancel = false): number {
  session += 1;
  if (cancel || !abort) {
    abort?.abort();
    abort = new AbortController();
  }
  return session;
}

/**
 * Start reading `next` from paragraph `from`. Call it from the tap (it unlocks the audio element).
 */
export function startChapterAloud(next: AloudChapter, from: number): void {
  window.dispatchEvent(new Event(CHAPTER_STARTS));
  const el = element();
  // Inside the tap: play 10 ms of silence so later, network-delayed playback is allowed.
  quiet();
  el.loop = false;
  releaseUrl();
  currentUrl = URL.createObjectURL(new Blob([pcm16ToWav(new Uint8Array(480)) as BlobPart], { type: "audio/wav" }));
  el.src = currentUrl;
  trackLoaded = false;
  el.playbackRate = 1;
  void el.play().catch(() => undefined);
  chapter = next;
  const mine = newSession(true);
  useChapterAloud.setState({ panel: true, status: "loading", index: Math.max(0, from), total: next.paragraphs.length, error: null });
  void playFrom(Math.max(0, from), mine);
}

/** After onChapterEnd opened the next chapter: keep reading it from the top (no tap needed). */
export function continueChapterAloud(next: AloudChapter): void {
  if (useChapterAloud.getState().status !== "advancing") return;
  chapter = next;
  const mine = newSession(true);
  void playFrom(0, mine);
}

export function pauseChapterAloud(): void {
  const state = useChapterAloud.getState();
  if (state.status !== "playing" && state.status !== "loading") return;
  quiet();
  element().pause();
  setPlaybackState("paused");
  useChapterAloud.setState({ status: "paused" });
}

export function resumeChapterAloud(): void {
  const state = useChapterAloud.getState();
  if (state.status === "error") {
    jumpChapterAloud(state.index);
    return;
  }
  if (state.status !== "paused") return;
  const el = element();
  // Paused mid-paragraph: carry on in it; paused in the gap: start the next paragraph.
  if (trackLoaded && !el.ended && el.currentTime > 0) {
    quiet();
    useChapterAloud.setState({ status: "playing" });
    setPlaybackState("playing");
    void el.play().catch(() => fail("play"));
  } else {
    jumpChapterAloud(el.ended ? state.index + 1 : state.index);
  }
}

export function jumpChapterAloud(index: number): void {
  if (!chapter) return;
  const el = element();
  quiet();
  el.pause();
  const mine = newSession();
  void playFrom(Math.min(Math.max(0, index), Math.max(0, chapter.paragraphs.length - 1)), mine);
}

export function skipChapterAloud(by: number): void {
  jumpChapterAloud(useChapterAloud.getState().index + by);
}

export function setChapterAloudRate(rate: number): void {
  if (audio) audio.playbackRate = rate;
}

export function stopChapterAloud(): void {
  newSession(true);
  abort?.abort();
  abort = null;
  chapter = null;
  if (audio) {
    quiet();
    audio.loop = false;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  releaseUrl();
  trackLoaded = false;
  clearMediaSession();
  useChapterAloud.setState({ status: "off", index: 0, total: 0, error: null });
}

/** Stop and close the player. */
export function closeChapterAloud(): void {
  stopChapterAloud();
  useChapterAloud.setState({ panel: false });
}

// The single-text read-aloud (paragraph help) starting stops chapter reading.
if (typeof window !== "undefined") {
  window.addEventListener(SINGLE_STARTS, () => {
    if (useChapterAloud.getState().status !== "off") stopChapterAloud();
  });
}
