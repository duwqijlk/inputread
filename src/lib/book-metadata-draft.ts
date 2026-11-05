/**
 * Local edits for the admin book-metadata table. A row is only sent after the editor has
 * previewed the exact before/after values; this module keeps that work pure so the table
 * component stays about layout and requests.
 *
 * The server contract is in src/lib/book-metadata.ts. A change always carries the row's
 * read-time `baseline`; a stale baseline is a conflict, never a silent overwrite.
 */
import { isCatalogName, type CatalogName } from "@/lib/catalog-id";
import {
  BOOK_METADATA_BYTES,
  BOOK_METADATA_LIMIT,
  isBookMetadataBaseline,
  previewBookMetadata,
  type BookMetadataChange,
  type BookMetadataRow,
} from "@/lib/book-metadata";
import { isBookGenre, readBookGenres, type BookGenre } from "@/lib/book-genres";

export const MAX_SELECTION = BOOK_METADATA_LIMIT;
export const MAX_GENRES = 3;

export type MetadataDraft = {
  /** The full genre list in display order; the first genre is the primary one. */
  genres?: BookGenre[];
  /** A changed series name. "" clears the series. */
  series?: string;
  /** A confirmed series number; 0 means the series has no number. */
  seriesNumber?: number;
  /** A bulk series change needs each row's number looked at before it can be saved. */
  numberConfirmed?: boolean;
};

export type DraftMap = Record<string, MetadataDraft>;

export type MetadataChunk = { catalog: CatalogName; changes: BookMetadataChange[] };

export type DraftIssue = "number" | "series" | "genres";

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function rowKey(row: Pick<BookMetadataRow, "catalog" | "id">): string {
  return `${row.catalog}:${row.id}`;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/**
 * Read a GET/PATCH response. A PATCH row may omit `catalog` because the request already named
 * one catalog; `fallbackCatalog` fills that in. Unknown or malformed rows are dropped, never
 * guessed.
 */
export function readMetadataBooks(value: unknown, fallbackCatalog?: CatalogName): BookMetadataRow[] {
  const list = (value as { books?: unknown } | null | undefined)?.books;
  if (!Array.isArray(list)) return [];
  const out: BookMetadataRow[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const catalog = isCatalogName(row.catalog) ? row.catalog : fallbackCatalog;
    if (!catalog || typeof row.id !== "string" || !ID.test(row.id) || row.id === "custom") continue;
    if (row.category !== "novel" && row.category !== "speech") continue;
    if (typeof row.seriesNumber !== "number" || !Number.isInteger(row.seriesNumber) || row.seriesNumber < 0 || row.seriesNumber > 99) continue;
    // The baseline is an opaque optimistic-concurrency token; its format belongs to the API.
    if (!isBookMetadataBaseline(row.baseline)) continue;
    const key = `${catalog}:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      catalog,
      id: row.id,
      title: text(row.title, 200) || row.id,
      author: text(row.author, 200),
      category: row.category,
      genres: readBookGenres(row.genres),
      series: text(row.series, 80),
      seriesNumber: row.seriesNumber,
      baseline: row.baseline,
    });
  }
  return out;
}

export function sameGenres(a: readonly BookGenre[], b: readonly BookGenre[]): boolean {
  return a.length === b.length && a.every((genre, index) => genre === b[index]);
}

export function normalizeSeries(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

export function draftGenres(row: BookMetadataRow, draft: MetadataDraft | undefined): BookGenre[] {
  return draft?.genres ?? row.genres;
}

export function draftSeries(row: BookMetadataRow, draft: MetadataDraft | undefined): string {
  return draft?.series === undefined ? row.series : normalizeSeries(draft.series);
}

export function draftSeriesNumber(row: BookMetadataRow, draft: MetadataDraft | undefined): number {
  return draft?.seriesNumber ?? row.seriesNumber;
}

/** What still blocks a row from being sent, if anything. */
export function draftIssue(row: BookMetadataRow, draft: MetadataDraft | undefined): DraftIssue | null {
  if (!draft) return null;
  const genres = draftGenres(row, draft);
  if (genres.length > MAX_GENRES) return "genres";
  const series = draftSeries(row, draft);
  const seriesChanged = series !== row.series;
  if (!series && (draft.seriesNumber ?? 0) > 0) return "series";
  // 0 is an explicit "unknown" number; a changed series still needs its number looked at.
  if (seriesChanged && series !== "" && !draft.numberConfirmed) return "number";
  return null;
}

/**
 * The PATCH change for one row, or null when there is nothing valid to send. The server preview
 * and this change use the same normalization; a row that still needs its series number confirmed
 * is deliberately not included.
 */
export function changeFor(
  row: BookMetadataRow,
  draft: MetadataDraft | undefined,
): BookMetadataChange | null {
  if (!draft || draftIssue(row, draft)) return null;
  const change: BookMetadataChange = { id: row.id, baseline: row.baseline };
  let changed = false;
  if (draft.genres && !sameGenres(draft.genres, row.genres)) {
    change.genres = [...draft.genres];
    changed = true;
  }
  const series = draftSeries(row, draft);
  const seriesChanged = series !== row.series;
  if (seriesChanged) {
    change.series = series;
    changed = true;
  }
  if (draft.numberConfirmed && draft.seriesNumber !== undefined && series !== "") {
    const number = draft.seriesNumber;
    // 0 is an explicit "unknown"; it clears an old number instead of silently keeping it.
    if (seriesChanged || number !== row.seriesNumber) {
      change.seriesNumber = number;
      changed = true;
    }
  }
  return changed ? change : null;
}

export type DraftPreview = {
  row: BookMetadataRow;
  next: BookMetadataRow;
  change: BookMetadataChange;
};

export function previewDrafts(rows: readonly BookMetadataRow[], drafts: DraftMap): DraftPreview[] {
  const out: DraftPreview[] = [];
  for (const row of rows) {
    const change = changeFor(row, drafts[rowKey(row)]);
    if (!change) continue;
    out.push({ row, next: previewBookMetadata(row, change), change });
  }
  return out;
}

export function pendingIssues(
  rows: readonly BookMetadataRow[],
  drafts: DraftMap,
): Array<{ row: BookMetadataRow; issue: DraftIssue }> {
  const out: Array<{ row: BookMetadataRow; issue: DraftIssue }> = [];
  for (const row of rows) {
    const draft = drafts[rowKey(row)];
    if (!draft) continue;
    const issue = draftIssue(row, draft);
    if (issue) out.push({ row, issue });
  }
  return out;
}

export function draftCount(drafts: DraftMap): number {
  return Object.keys(drafts).length;
}

/** Keep the draft only while it differs from the server row. */
function setDraft(
  drafts: DraftMap,
  key: string,
  row: BookMetadataRow,
  next: MetadataDraft,
): DraftMap {
  const clean: MetadataDraft = {};
  if (next.genres && !sameGenres(next.genres, row.genres)) clean.genres = [...next.genres];
  if (next.series !== undefined && next.series !== row.series) clean.series = next.series;
  if (next.numberConfirmed && next.seriesNumber !== undefined) {
    const series = next.series === undefined ? row.series : normalizeSeries(next.series);
    if (next.seriesNumber !== row.seriesNumber || series !== row.series) {
      clean.seriesNumber = next.seriesNumber;
      clean.numberConfirmed = true;
    }
  }
  const out = { ...drafts };
  if (Object.keys(clean).length) out[key] = clean;
  else delete out[key];
  return out;
}

export type GenreAction = "add" | "remove" | "replace" | "clear";

/**
 * Apply one genre action to the selected rows. "add" never exceeds three genres: a row that
 * would overflow is left as it was and counted in `skipped`, so a bulk action cannot silently
 * drop an existing genre.
 */
export function applyGenresToDrafts(
  rows: readonly BookMetadataRow[],
  keys: readonly string[],
  drafts: DraftMap,
  action: GenreAction,
  picked: readonly BookGenre[],
): { drafts: DraftMap; skipped: number } {
  const chosen = [...new Set(picked.filter(isBookGenre))];
  const byKey = new Map(rows.map((row) => [rowKey(row), row]));
  let next = { ...drafts };
  let skipped = 0;
  for (const key of keys) {
    const row = byKey.get(key);
    if (!row) continue;
    const current = draftGenres(row, next[key]);
    let genres: BookGenre[];
    if (action === "clear") {
      genres = [];
    } else if (action === "replace") {
      if (chosen.length > MAX_GENRES) {
        skipped += 1;
        continue;
      }
      genres = chosen;
    } else if (action === "remove") {
      genres = current.filter((genre) => !chosen.includes(genre));
    } else {
      genres = [...current];
      for (const genre of chosen) if (!genres.includes(genre)) genres.push(genre);
      if (genres.length > MAX_GENRES) {
        skipped += 1;
        continue;
      }
    }
    next = setDraft(next, key, row, { ...next[key], genres });
  }
  return { drafts: next, skipped };
}

/**
 * Set one series name on the selected rows. The number is not set in bulk: each changed row
 * starts from its own old number and must be confirmed on its own line. An empty name clears
 * the series and its number, which needs no number confirmation.
 */
export function applySeriesToDrafts(
  rows: readonly BookMetadataRow[],
  keys: readonly string[],
  drafts: DraftMap,
  name: string,
): DraftMap {
  const series = normalizeSeries(name);
  const byKey = new Map(rows.map((row) => [rowKey(row), row]));
  let next = { ...drafts };
  for (const key of keys) {
    const row = byKey.get(key);
    if (!row) continue;
    if (series === row.series) {
      const current = { ...next[key] };
      delete current.series;
      delete current.seriesNumber;
      delete current.numberConfirmed;
      next = setDraft(next, key, row, current);
      continue;
    }
    next = setDraft(next, key, row, {
      ...next[key],
      series,
      // A different series never inherits the old number; 0 means "unknown" until confirmed.
      seriesNumber: series === "" ? undefined : 0,
      numberConfirmed: series === "",
    });
  }
  return next;
}

/** Set one row's genres from the expanded editor. Unknown or repeated genres are dropped. */
export function setRowGenres(
  rows: readonly BookMetadataRow[],
  key: string,
  drafts: DraftMap,
  genres: readonly BookGenre[],
): DraftMap {
  const row = rows.find((item) => rowKey(item) === key);
  if (!row) return drafts;
  const valid = [...new Set(genres.filter(isBookGenre))].slice(0, MAX_GENRES);
  return setDraft(drafts, key, row, { ...drafts[key], genres: valid });
}

/** Set one row's series from the expanded editor; its number then needs its own confirmation. */
export function setRowSeries(
  rows: readonly BookMetadataRow[],
  key: string,
  drafts: DraftMap,
  value: string,
): DraftMap {
  const row = rows.find((item) => rowKey(item) === key);
  if (!row) return drafts;
  const series = normalizeSeries(value);
  return setDraft(drafts, key, row, {
    ...drafts[key],
    series: value,
    // A different series never inherits the old number; 0 means "unknown" until confirmed.
    seriesNumber: series === "" ? undefined : 0,
    numberConfirmed: series === "",
  });
}

/** A typed or explicitly confirmed number is a single-row decision, not a bulk one. */
export function setRowSeriesNumber(
  rows: readonly BookMetadataRow[],
  key: string,
  drafts: DraftMap,
  value: number | null,
): DraftMap {
  const row = rows.find((item) => rowKey(item) === key);
  if (!row) return drafts;
  const number = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(99, Math.floor(value)));
  // 0 is an explicit "unknown"; a positive number still needs a series.
  if (!draftSeries(row, drafts[key]) && number > 0) return drafts;
  return setDraft(drafts, key, row, { ...drafts[key], seriesNumber: number, numberConfirmed: true });
}

export function resetRowDraft(drafts: DraftMap, key: string): DraftMap {
  const out = { ...drafts };
  delete out[key];
  return out;
}

/** Confirm one row's series number after a bulk series change. */
export function confirmSeriesNumber(
  rows: readonly BookMetadataRow[],
  key: string,
  drafts: DraftMap,
  value: number | null,
): DraftMap {
  const row = rows.find((item) => rowKey(item) === key);
  if (!row) return drafts;
  const current = drafts[key];
  if (!current) return drafts;
  const number = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(99, Math.floor(value)));
  if (!draftSeries(row, current) && number > 0) return drafts;
  return setDraft(drafts, key, row, { ...current, seriesNumber: number, numberConfirmed: true });
}

/**
 * Changes grouped per catalog, in chunks the API accepts: at most 60 rows and under the request
 * byte limit. An opaque baseline can be long, so counting rows alone is not enough.
 */
export function buildChunks(rows: readonly BookMetadataRow[], drafts: DraftMap): MetadataChunk[] {
  const byCatalog = new Map<CatalogName, BookMetadataChange[]>();
  for (const row of rows) {
    const change = changeFor(row, drafts[rowKey(row)]);
    if (!change) continue;
    const list = byCatalog.get(row.catalog) ?? [];
    list.push(change);
    byCatalog.set(row.catalog, list);
  }
  const encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
  const bytesOf = (value: unknown) => {
    const text = JSON.stringify(value);
    return encoder ? encoder.encode(text).length : text.length;
  };
  const budget = BOOK_METADATA_BYTES - 256;
  const out: MetadataChunk[] = [];
  for (const catalog of ["word-lists", "public-books"] as const) {
    const changes = byCatalog.get(catalog) ?? [];
    let current: BookMetadataChange[] = [];
    let size = 0;
    const flush = () => {
      if (!current.length) return;
      out.push({ catalog, changes: current });
      current = [];
      size = 0;
    };
    for (const change of changes) {
      const add = bytesOf(change) + 1;
      if (current.length && (current.length >= BOOK_METADATA_LIMIT || size + add > budget)) flush();
      current.push(change);
      size += add;
      if (current.length >= BOOK_METADATA_LIMIT) flush();
    }
    flush();
  }
  return out;
}

/** Apply the rows a successful PATCH returned, and clear only those rows' drafts. */
export function mergeSaved(
  rows: readonly BookMetadataRow[],
  saved: readonly BookMetadataRow[],
  drafts: DraftMap,
): { rows: BookMetadataRow[]; drafts: DraftMap; savedKeys: string[] } {
  const byKey = new Map(saved.map((row) => [rowKey(row), row]));
  const nextRows = rows.map((row) => byKey.get(rowKey(row)) ?? row);
  const nextDrafts = { ...drafts };
  for (const key of byKey.keys()) delete nextDrafts[key];
  return { rows: nextRows, drafts: nextDrafts, savedKeys: [...byKey.keys()] };
}
