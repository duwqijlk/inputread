import { validBookGenres, type BookGenre } from "./book-genres.ts";
import { CATALOG_ID, isCatalogName, type CatalogName } from "./catalog-id.ts";

export const BOOK_METADATA_LIMIT = 60;
export const BOOK_METADATA_BYTES = 32_000;

export type BookMetadataRow = {
  catalog: CatalogName;
  id: string;
  title: string;
  author: string;
  category: "novel" | "speech";
  genres: BookGenre[];
  series: string;
  seriesNumber: number;
  baseline: string;
};

export type BookMetadataChange = {
  id: string;
  baseline: string;
  genres?: BookGenre[];
  series?: string;
  seriesNumber?: number;
};

export type BookMetadataRequest = { catalog: CatalogName; changes: BookMetadataChange[] };

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** An optimistic-concurrency token, not a credential or a word-list revision. */
export function isBookMetadataBaseline(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("m1:") && value.length > 3 && value.length <= 8192;
}

/** Refuse unknown fields, duplicate targets and malformed edits before acquiring a catalog lock. */
export function readBookMetadataRequest(value: unknown): BookMetadataRequest | null {
  if (!object(value) || !keys(value, ["catalog", "changes"]) || !isCatalogName(value.catalog) ||
      !Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > BOOK_METADATA_LIMIT) return null;
  const seen = new Set<string>();
  for (const row of value.changes) {
    if (!object(row) || !keys(row, ["id", "baseline", "genres", "series", "seriesNumber"]) ||
        typeof row.id !== "string" || !CATALOG_ID.test(row.id) || row.id === "custom" || seen.has(row.id) ||
        !isBookMetadataBaseline(row.baseline)) return null;
    seen.add(row.id);
    if (!Object.hasOwn(row, "genres") && !Object.hasOwn(row, "series") && !Object.hasOwn(row, "seriesNumber")) return null;
    if (Object.hasOwn(row, "genres") && !validBookGenres(row.genres)) return null;
    if (Object.hasOwn(row, "series") && (typeof row.series !== "string" || row.series.length > 80 ||
        [...row.series].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) return null;
    if (Object.hasOwn(row, "seriesNumber") && (typeof row.seriesNumber !== "number" ||
        !Number.isInteger(row.seriesNumber) || row.seriesNumber < 0 || row.seriesNumber > 99)) return null;
  }
  return value as BookMetadataRequest;
}

/** The same normalized values shown in the confirmation preview and returned by the server. */
export function previewBookMetadata(book: BookMetadataRow, change: BookMetadataChange): BookMetadataRow {
  const next = { ...book, genres: change.genres === undefined ? [...book.genres] : [...change.genres] };
  if (change.series !== undefined) next.series = change.series.replace(/\s+/g, " ").trim();
  if (!next.series) next.seriesNumber = 0;
  else if (change.seriesNumber !== undefined) next.seriesNumber = change.seriesNumber;
  return next;
}
