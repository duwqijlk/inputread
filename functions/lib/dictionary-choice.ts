import type { D1Database, D1Statement, Env, R2ObjectLike } from "./db.ts";
import { HttpError } from "./http.ts";
import { sha256Hex } from "./password.ts";
import { DAILY_USER_CHOICE_BUDGET, DAILY_WRITE_BUDGET } from "./rate-limit.ts";

export const CHOICE_REQUEST_BYTES = 8192;
const ENTRY_BYTES = 32 * 1024;
const RELEASE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const encoder = new TextEncoder();

type RecordValue = Record<string, unknown>;
export type DictionaryChoice = { id: string; lemma: string; release: string };
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
  position?: { chapterSha256: string; paragraphIndex: number; paragraphSha256: string; offset: number; surface: string };
};
export type ChoiceRequest = { action: "get" | "set"; target: ChoiceTarget; choice: DictionaryChoice | null };
export type ChoiceRow = {
  target_hash: string;
  target_json: string;
  choice_id: string;
  choice_lemma: string;
  choice_release: string;
  created_at: number;
  updated_at: number;
};

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: RecordValue, allowed: string[], required = allowed): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}
function text(value: unknown, max: number, min = 1): value is string {
  // Reject controls and unpaired surrogates instead of silently changing the evidence or UTF-8 path.
  return typeof value === "string" && value.length >= min && value.length <= max && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Strict evidence, never a claim that these client-supplied coordinates name a real source position. */
export function parseChoiceRequest(value: unknown): ChoiceRequest {
  if (!record(value) || !fields(value, ["action", "target", "choice"], ["action", "target"]) ||
    (value.action !== "get" && value.action !== "set") || !record(value.target)) throw new HttpError(400, "bad-choice");
  const t = value.target;
  if (!fields(t, ["bookId", "catalogId", "chapter", "chapters", "paragraph", "occurrence", "word", "sentence", "context", "glossaryRev", "paragraphText", "position"],
    ["bookId", "chapter", "chapters", "paragraph", "occurrence", "word", "sentence"]) ||
    !text(t.bookId, 64) || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(t.bookId) ||
    (t.catalogId !== undefined && (!text(t.catalogId, 80, 0) || (t.catalogId !== "" && !/^(word-lists|public-books):[a-z0-9][a-z0-9_-]{0,63}$/.test(t.catalogId)))) ||
    !integer(t.chapters, 1, 2000) || !integer(t.chapter, 0, t.chapters - 1) ||
    !integer(t.paragraph, 0, 1_000_000) || !integer(t.occurrence, 1, 1_000_000) ||
    !text(t.word, 240) || !t.word.trim() || t.word !== t.word.normalize("NFC") ||
    !text(t.sentence, 2000) || !t.sentence.trim() ||
    (t.context !== undefined && !text(t.context, 2000, 0)) ||
    (t.glossaryRev !== undefined && !text(t.glossaryRev, 100, 0))) throw new HttpError(400, "bad-target");
  // Fixed field order, absent optional strings canonicalized to empty. No title/name is identity.
  const target: ChoiceTarget = {
    bookId: t.bookId, catalogId: t.catalogId as string | undefined ?? "",
    chapter: t.chapter, chapters: t.chapters, paragraph: t.paragraph, occurrence: t.occurrence,
    word: t.word, sentence: t.sentence, context: t.context as string | undefined ?? "",
    glossaryRev: t.glossaryRev as string | undefined ?? "",
  };
  if (t.position !== undefined || t.paragraphText !== undefined) {
    const p = t.position;
    if (!record(p) || !fields(p, ["chapterSha256", "paragraphIndex", "paragraphSha256", "offset", "surface"]) ||
      typeof p.chapterSha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.chapterSha256) ||
      typeof p.paragraphSha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.paragraphSha256) ||
      !integer(p.paragraphIndex, 0, 1_000_000) || p.paragraphIndex !== target.paragraph ||
      !integer(p.offset, 0, 100_000) || !text(p.surface, 240) || p.surface.normalize("NFC") !== target.word ||
      !text(t.paragraphText, 3000) || Array.from(t.paragraphText).slice(p.offset, p.offset + Array.from(p.surface).length).join("") !== p.surface) throw new HttpError(400, "bad-position-evidence");
    target.paragraphText = t.paragraphText;
    target.position = { chapterSha256: p.chapterSha256, paragraphIndex: p.paragraphIndex, paragraphSha256: p.paragraphSha256, offset: p.offset, surface: p.surface };
  }
  let choice: DictionaryChoice | null = null;
  if (value.action === "set" && !Object.hasOwn(value, "choice")) throw new HttpError(400, "bad-choice");
  if (value.choice !== null && value.choice !== undefined) {
    const c = value.choice;
    if (!record(c) || !fields(c, ["id", "lemma", "release"]) || !text(c.id, 240) || !c.id.trim() ||
      !text(c.lemma, 240) || !c.lemma.trim() || c.lemma !== c.lemma.normalize("NFC") || encoder.encode(c.lemma).length > 240 ||
      !text(c.release, 80) || !RELEASE.test(c.release)) throw new HttpError(400, "bad-choice");
    choice = { id: c.id, lemma: c.lemma, release: c.release };
  }
  if (value.action === "get" && choice !== null) throw new HttpError(400, "bad-choice");
  return { action: value.action, target, choice };
}

/** Bounded stream reader shared by the request and the small trusted R2 source objects. */
async function boundedJson(body: ReadableStream<Uint8Array> | null, max: number, status: number, code: string): Promise<unknown> {
  if (!body) throw new HttpError(status, code);
  const reader = body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        await reader.cancel();
        throw new HttpError(status, code);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new HttpError(status === 413 ? 400 : status, status === 413 ? "bad-json" : code); }
  } finally { reader.releaseLock(); }
}

export function readChoiceRequest(request: Request): Promise<unknown> {
  return boundedJson(request.body, CHOICE_REQUEST_BYTES, 413, "too-large");
}
async function sourceJson(object: R2ObjectLike, max: number): Promise<unknown> {
  if (object.size > max) {
    await object.body.cancel();
    throw new HttpError(503, "dictionary-unavailable");
  }
  return boundedJson(object.body, max, 503, "dictionary-unavailable");
}

/** Only small exact entry membership checks: no browser resolver, stemming, ID parsing or surface proof. */
export async function checkChoiceMembership(env: Env, choice: DictionaryChoice): Promise<void> {
  if (!env.BOOKS) throw new HttpError(503, "dictionary-unavailable");
  const current = await env.BOOKS.get("dictionary/current.json");
  if (!current) throw new HttpError(503, "dictionary-unavailable");
  const manifest = await sourceJson(current, 4096);
  if (!record(manifest) || manifest.schema !== "oewn-r2-current-v1" || typeof manifest.release !== "string" || !RELEASE.test(manifest.release) ||
    Object.hasOwn(manifest, "wordBase") ||
    (Object.hasOwn(manifest, "wordsMutable") && manifest.wordsMutable !== true)) {
    throw new HttpError(503, "dictionary-unavailable");
  }
  const mutable = manifest.wordsMutable === true;
  // In stable mode releases describe publication provenance, not unchanged sense identity.
  if (!mutable && choice.release !== manifest.release) throw new HttpError(409, "dictionary-release");
  const hex = Array.from(encoder.encode(choice.lemma), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const base = `dictionary/releases/${manifest.release}/words`;
  const object = await env.BOOKS.get(`${base}/${hex.slice(0, 2)}/${hex}.json`);
  if (!object) throw new HttpError(400, "dictionary-choice");
  const entry = await sourceJson(object, ENTRY_BYTES);
  if (!record(entry) || entry.schema !== "oewn-r2-entry-v1" || typeof entry.release !== "string" || !RELEASE.test(entry.release) ||
    (!mutable && entry.release !== choice.release) ||
    entry.lookupKey !== choice.lemma || !Array.isArray(entry.senses)) throw new HttpError(503, "dictionary-unavailable");
  const ids = new Set<string>();
  for (const sense of entry.senses) {
    if (!record(sense) || !text(sense.id, 240) || ids.has(sense.id) || typeof sense.pos !== "string" ||
      typeof sense.meaning !== "string" || !sense.meaning.trim() || typeof sense.originalMeaning !== "string" || !sense.originalMeaning.trim() ||
      (sense.learningMeaning !== undefined && typeof sense.learningMeaning !== "string")) throw new HttpError(503, "dictionary-unavailable");
    ids.add(sense.id);
  }
  if (!ids.has(choice.id)) throw new HttpError(400, "dictionary-choice");
}

/** A published, exact matching source position is read-only, never reopened by a stale thumb. */
export async function assertChoiceUnfixed(env: Env, target: ChoiceTarget): Promise<void> {
  if (!target.position || !target.catalogId || !env.BOOKS) return;
  const [catalog, id] = target.catalogId.split(":");
  const object = await env.BOOKS.get(`dictionary/positions/${catalog}/${id}/mappings.json`);
  if (!object) return;
  const raw = await sourceJson(object, 192 * 1024);
  if (!record(raw) || raw.schema !== "oewn-position-mappings-v1" || raw.catalogId !== target.catalogId || !Array.isArray(raw.entries)) throw new HttpError(503, "mapping-unavailable");
  const p = target.position;
  const key = await sha256Hex(JSON.stringify([target.catalogId, p.chapterSha256, p.paragraphIndex, p.paragraphSha256, p.offset, p.surface]));
  const match = raw.entries.find(row => record(row) && row.positionKey === key && row.chapterSha256 === p.chapterSha256 && row.paragraphIndex === p.paragraphIndex && row.paragraphSha256 === p.paragraphSha256 && row.offset === p.offset && row.surface === p.surface);
  if (match) throw new HttpError(409, "fixed");
}

export async function choicePosition(target: ChoiceTarget): Promise<{ hash: string; json: string }> {
  const json = JSON.stringify(target);
  return { hash: await sha256Hex(json), json };
}
export async function existingChoice(db: D1Database, userId: string, hash: string): Promise<ChoiceRow | null> {
  return db.prepare("SELECT target_hash, target_json, choice_id, choice_lemma, choice_release, created_at, updated_at FROM dictionary_choices WHERE user_id = ? AND target_hash = ?")
    .bind(userId, hash).first<ChoiceRow>();
}
export function sameChoice(row: ChoiceRow | null, choice: DictionaryChoice | null): boolean {
  return choice === null ? row === null : row !== null && row.choice_id === choice.id && row.choice_lemma === choice.lemma && row.choice_release === choice.release;
}
export function choiceResult(choice: DictionaryChoice | null) {
  return { ok: true, selectedId: choice?.id ?? null, selected: choice, status: "pending-review", positionValidated: false };
}

/**
 * Raw pending review evidence only. No canonical mapping, aggregate vote or review queue is written.
 * Gate the mutation on the daily fuse, then charge only an actual change in the SAME D1 transaction.
 * This also makes simultaneous identical sets/cancels no-ops without spending extra daily budget.
 */
export async function saveChoice(db: D1Database, userId: string, position: { hash: string; json: string }, choice: DictionaryChoice | null, now: number): Promise<void> {
  const day = Math.floor(now / 86_400_000) * 86_400_000;
  const bucket = `budget:choices:${day}`; // Daily prefix is excluded from short-window pruning.
  const userBucket = `budget:choice-user:${userId}:${day}`;
  const available = "COALESCE((SELECT hits FROM rate_limits WHERE bucket = ? AND window_start = ?), 0) < ? AND COALESCE((SELECT hits FROM rate_limits WHERE bucket = ? AND window_start = ?), 0) < ?";
  const budgetArgs = [bucket, day, DAILY_WRITE_BUDGET.choices, userBucket, day, DAILY_USER_CHOICE_BUDGET];
  let mutation: D1Statement;
  if (choice) {
    mutation = db.prepare(`INSERT INTO dictionary_choices (user_id, target_hash, target_json, choice_id, choice_lemma, choice_release, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${available}
      ON CONFLICT(user_id, target_hash) DO UPDATE SET choice_id = excluded.choice_id, choice_lemma = excluded.choice_lemma,
        choice_release = excluded.choice_release, updated_at = excluded.updated_at
      WHERE choice_id != excluded.choice_id OR choice_lemma != excluded.choice_lemma OR choice_release != excluded.choice_release
      RETURNING choice_id`).bind(userId, position.hash, position.json, choice.id, choice.lemma, choice.release, now, now, ...budgetArgs);
  } else {
    // Withdrawal removes the evidence; there is deliberately no invented queue/tombstone policy.
    mutation = db.prepare(`DELETE FROM dictionary_choices WHERE user_id = ? AND target_hash = ? AND ${available} RETURNING choice_id`)
      .bind(userId, position.hash, ...budgetArgs);
  }
  const results = await db.batch([
    mutation,
    // Both counters depend on the original mutation's changes(), in a single statement.
    // A third statement would accidentally charge a no-op based on the counter insert itself.
    db.prepare(`INSERT INTO rate_limits (bucket, window_start, hits)
      SELECT ?, ?, 1 WHERE changes() > 0
      UNION ALL SELECT ?, ?, 1 WHERE changes() > 0
      ON CONFLICT(bucket, window_start) DO UPDATE SET hits = hits + 1 RETURNING hits`).bind(bucket, day, userBucket, day),
  ]);
  if (!results[0]?.results || !results[1]?.results) throw new HttpError(500, "server");
  if (results[0].results.length > 0) {
    if (results[1].results.length !== 2) throw new HttpError(500, "server");
    return;
  }
  if (!sameChoice(await existingChoice(db, userId, position.hash), choice)) {
    const usage = await db.prepare("SELECT hits FROM rate_limits WHERE bucket = ? AND window_start = ?")
      .bind(userBucket, day).first<{ hits: number }>();
    throw new HttpError(429, (usage?.hits ?? 0) >= DAILY_USER_CHOICE_BUDGET ? "choices-user-budget" : "choices-budget");
  }
}
