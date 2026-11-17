import { useEffect, useRef, useState } from "react";
import { useAccount } from "@/lib/account-store";
import { accountRequest } from "@/lib/sync-engine";
import type { StandardSense, WordSensePanelProps } from "@/components/word-sense-panel";

export type ChoiceTarget = {
  bookId: string;
  catalogId?: string;
  chapter: number;
  chapters: number;
  paragraph: number;
  occurrence: number;
  word: string;
  sentence: string;
  context?: string;
  glossaryRev?: string;
  paragraphText?: string;
  position?: {
    chapterSha256: string;
    paragraphIndex: number;
    paragraphSha256: string;
    offset: number;
    surface: string;
  };
};

type State = {
  scope: string;
  selectedId: string | null;
  acknowledged?: boolean;
  pending: boolean;
  error?: "failed" | "fixed";
};

type DesiredChoice = {
  generation: number;
  owner: string;
  hashKey: string;
  id: string | null;
  choice: { id: string; lemma: string; release: string } | null;
};

const STORAGE_KEY = "cibian-dict-choices-v1";
const MAX_STORED_CHOICES = 500;
const acknowledged = new Map<string, string | null>();
let cacheAccount: string | null = null;

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Synchronous SHA-256 so local choice state never stores plaintext book sentences or waits a frame. */
export function sha256HexSync(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(total);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(total - 4, bitLen >>> 0, false);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K256[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((n) => n.toString(16).padStart(8, "0")).join("");
}

function stablePlaceKey(target: ChoiceTarget): string {
  return JSON.stringify([
    target.bookId,
    target.catalogId ?? "",
    target.chapter,
    target.chapters,
    target.paragraph,
    target.occurrence,
    target.word,
    target.sentence,
    target.context ?? "",
  ]);
}

function readLocalMap(): Record<string, string> {
  try {
    if (typeof window === "undefined" || !window.localStorage) return {};
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (/^[0-9a-f]{64}$/.test(key) && typeof value === "string" && value.length > 0 && value.length <= 240) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeLocalChoice(hashKey: string, selectedId: string | null): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const map = readLocalMap();
    delete map[hashKey];
    if (selectedId) map[hashKey] = selectedId;
    const keys = Object.keys(map);
    while (keys.length > MAX_STORED_CHOICES) {
      const oldest = keys.shift();
      if (oldest) delete map[oldest];
    }
    if (Object.keys(map).length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* Private browsing or opaque test origin: in-memory cache still holds session state. */
  }
}

function confirmedFor(owner: string, hashKey: string): string | null | undefined {
  if (!hashKey) return undefined;
  if (cacheAccount === owner && acknowledged.has(hashKey)) return acknowledged.get(hashKey)!;
  const saved = readLocalMap()[hashKey];
  if (typeof saved === "string" && saved.length > 0) {
    if (cacheAccount === owner) {
      acknowledged.set(hashKey, saved);
      if (acknowledged.size > MAX_STORED_CHOICES) acknowledged.delete(acknowledged.keys().next().value!);
    }
    return saved;
  }
  return undefined;
}

function rememberChoice(owner: string, hashKey: string, selectedId: string | null): void {
  if (!hashKey) return;
  if (cacheAccount !== owner) {
    acknowledged.clear();
    cacheAccount = owner;
  }
  acknowledged.delete(hashKey);
  acknowledged.set(hashKey, selectedId);
  if (acknowledged.size > MAX_STORED_CHOICES) acknowledged.delete(acknowledged.keys().next().value!);
  writeLocalChoice(hashKey, selectedId);
}

/** Opening a card sends no position data or API request. Only explicit thumbs trigger transport. */
export function useDictionaryChoices(target: ChoiceTarget | null, senses: StandardSense[]) {
  const phase = useAccount((s) => s.phase);
  const emailVerified = useAccount((s) => s.emailVerified);
  const account = useAccount((s) => s.email);
  const [state, setState] = useState<State | null>(null);
  const placeKey = target ? stablePlaceKey(target) : "";
  const scope = `${account ?? ""}/${phase}/${emailVerified}/${placeKey}`;
  const hashKey =
    phase === "in" && account && placeKey
      ? sha256HexSync(`${account.trim().toLowerCase()}\0${placeKey}`)
      : "";
  const targetRef = useRef<ChoiceTarget | null>(target);
  targetRef.current = target;
  const active = useRef({ scope, generation: 0 });
  if (active.current.scope !== scope) {
    active.current = { scope, generation: active.current.generation + 1 };
  }
  const inFlight = useRef<{ generation: number; confirmedId: string | null } | null>(null);
  const desired = useRef<DesiredChoice | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current.generation += 1;
    };
  }, []);
  const available =
    !!target &&
    !!target.sentence.trim() &&
    target.chapters > 0 &&
    target.chapter >= 0 &&
    target.chapter < target.chapters &&
    senses.length > 0 &&
    senses.every((s) => !!s.source);
  const owner = phase === "in" ? account : null;
  if (cacheAccount !== owner) {
    acknowledged.clear();
    cacheAccount = owner;
  }
  const current = state?.scope === scope ? state : null;
  const stored = owner && hashKey ? confirmedFor(owner, hashKey) : undefined;
  const hasStored = stored !== undefined;
  const selectedId = current ? current.selectedId : (stored ?? null);
  const eligibility: WordSensePanelProps["vote"]["eligibility"] = !available
    ? "unavailable"
    : phase === "unknown"
      ? "loading"
      : phase !== "in"
        ? "guest"
        : !emailVerified
          ? "unverified"
          : "verified";

  async function choose(id: string | null) {
    const generation = active.current.generation;
    if (eligibility !== "verified" || current?.error === "fixed" || !targetRef.current || !account || !hashKey) {
      return;
    }
    const candidate = id === null ? null : senses.find((s) => s.id === id);
    if (id !== null && !candidate?.source) return;
    const nextId = candidate ? candidate.id : null;
    const nextChoice =
      nextId && candidate?.source
        ? { id: candidate.id, lemma: candidate.source.lemma, release: candidate.source.release }
        : null;
    const baseConfirmed =
      inFlight.current?.generation === generation
        ? inFlight.current.confirmedId
        : (stored ?? null);
    desired.current = {
      generation,
      owner: account,
      hashKey,
      id: nextId,
      choice: nextChoice,
    };
    // Optimistic 0ms thumb highlight; confirmation message still waits for server acknowledgement.
    setState({ scope, selectedId: nextId, pending: true, acknowledged: false });
    if (inFlight.current?.generation === generation) return;
    const flight = { generation, confirmedId: baseConfirmed };
    inFlight.current = flight;
    try {
      while (mounted.current && active.current.generation === generation) {
        const want = desired.current;
        if (!want || want.generation !== generation) break;
        const liveTarget = targetRef.current;
        if (!liveTarget) break;
        const reply = await accountRequest("/api/dictionary/choices", {
          action: "set",
          target: liveTarget,
          choice: want.choice,
        });
        if (reply.ok !== true || reply.selectedId !== want.id) {
          throw new Error("unacknowledged-choice");
        }
        if (!mounted.current || active.current.generation !== generation) return;
        flight.confirmedId = want.id;
        rememberChoice(want.owner, want.hashKey, want.id);
        if (!desired.current || desired.current.generation !== generation || desired.current.id === flight.confirmedId) {
          setState({ scope, selectedId: flight.confirmedId, pending: false, acknowledged: true });
          break;
        }
      }
    } catch (error) {
      if (mounted.current && active.current.generation === generation) {
        setState({
          scope,
          selectedId: flight.confirmedId,
          pending: false,
          error: error instanceof Error && error.message === "fixed" ? "fixed" : "failed",
        });
      }
    } finally {
      if (inFlight.current === flight) inFlight.current = null;
    }
  }

  return {
    vote: {
      eligibility,
      selectedId,
      pending: current?.pending ?? false,
      acknowledged: current?.acknowledged ?? hasStored,
      error: current?.error,
    },
    onVote: (id: string | null) => {
      void choose(id);
    },
  };
}
