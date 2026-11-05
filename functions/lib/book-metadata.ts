import { readBookGenres } from "../../src/lib/book-genres.ts";
import { readSeries } from "../../src/lib/book-meta.ts";
import type { CatalogName } from "../../src/lib/catalog-id.ts";
import { previewBookMetadata, type BookMetadataChange, type BookMetadataRow } from "../../src/lib/book-metadata.ts";
import { HttpError } from "./http.ts";

export type MetadataSource = Record<string, unknown> & { id: string };

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)]));
  return value;
}

/** Raw editable fields retain missing/null/empty distinctions; content updates do not cause conflicts. */
export function metadataRow(catalog: CatalogName, row: MetadataSource): BookMetadataRow {
  const baseline = `m1:${JSON.stringify([catalog, row.id,
    ...["genres", "series", "seriesNumber", "category"].map((key) => Object.hasOwn(row, key) ? [key, stable(row[key])] : [key]),
  ])}`;
  return {
    catalog, id: row.id,
    title: typeof row.title === "string" ? row.title : row.id,
    author: typeof row.author === "string" ? row.author : "",
    category: row.category === "speech" ? "speech" : "novel",
    genres: row.category === "speech" ? [] : readBookGenres(row.genres), ...readSeries(row.series, row.seriesNumber), baseline,
  };
}

/** Mutate only explicit editorial fields, after every target in the batch has been checked. */
export function applyMetadata(row: MetadataSource, current: BookMetadataRow, change: BookMetadataChange): boolean {
  const next = previewBookMetadata(current, change);
  if (change.genres?.length && current.category === "speech") throw new HttpError(400, "bad-metadata");
  if (change.seriesNumber !== undefined && change.seriesNumber > 0 && !next.series) throw new HttpError(400, "bad-metadata");
  let changed = false;
  if (change.genres !== undefined && JSON.stringify(next.genres) !== JSON.stringify(Object.hasOwn(row, "genres") ? row.genres : [])) {
    row.genres = next.genres;
    changed = true;
  }
  if (change.series !== undefined && (next.series !== current.series ||
      (!next.series && (Object.hasOwn(row, "series") || Object.hasOwn(row, "seriesNumber"))))) {
    if (next.series) {
      row.series = next.series;
      if (next.seriesNumber || change.seriesNumber === 0) row.seriesNumber = next.seriesNumber;
      else delete row.seriesNumber;
    } else {
      delete row.series;
      delete row.seriesNumber;
    }
    changed = true;
  }
  if (next.series && change.seriesNumber !== undefined && next.seriesNumber !== current.seriesNumber) {
    // Older catalogs may encode the series as {name, number}; keep the edit effective there too.
    row.series = next.series;
    row.seriesNumber = next.seriesNumber;
    changed = true;
  }
  return changed;
}
