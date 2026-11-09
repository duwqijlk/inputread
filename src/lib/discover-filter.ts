import type { BookGenre } from "./book-genres.ts";
import { compareSeriesPlace } from "./discover-rails.ts";
import { compareLexile, difficultyBand } from "./lexile.ts";

type FilterBook = { key: string; title: string; author: string; lexile: string; series: string; seriesNumber: number; genres?: BookGenre[] };
export type DiscoverConditions = { genre?: BookGenre; query: string; band: string; author: string; series: string; sort: string; interleave?: boolean };

/** Stable rounds: each named series contributes one volume; ungrouped books remain individual. */
export function interleaveDiscoverSeries<T extends FilterBook>(rows: readonly T[]): T[] {
  const buckets: T[][] = [];
  const series = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.series) { buckets.push([row]); continue; }
    let bucket = series.get(row.series);
    if (!bucket) { bucket = []; series.set(row.series, bucket); buckets.push(bucket); }
    bucket.push(row);
  }
  for (const bucket of series.values()) bucket.sort(compareSeriesPlace);
  const out: T[] = [];
  for (let round = 0; out.length < rows.length; round++) {
    for (const bucket of buckets) if (bucket[round]) out.push(bucket[round]);
  }
  return out;
}

/** Search the full combined catalog; browsing filters and category never restrict a query. */
export function searchDiscover<T extends FilterBook>(rows: readonly T[], query: string): T[] {
  return filterDiscover(rows, { query, band: "all", author: "all", series: "all", sort: "listed" });
}

/** A book stays one row even when it belongs to several genres. */
export function filterDiscover<T extends FilterBook>(rows: readonly T[], conditions: DiscoverConditions): T[] {
  const { genre, query, band, author, series, sort } = conditions;
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const list = rows.filter((row) => {
    if (seen.has(row.key)) return false;
    seen.add(row.key);
    return (!genre || row.genres?.includes(genre)) && (band === "all" || difficultyBand(row.lexile) === band) &&
      (!q || `${row.title} ${row.author}`.toLowerCase().includes(q)) && (author === "all" || row.author === author) &&
      (series === "all" || series === "grouped" || (series === "none" ? !row.series : row.series === series));
  });
  if (sort === "listed" || series === "grouped") {
    if (series !== "all" && series !== "none" && series !== "grouped") return list.sort(compareSeriesPlace);
    return conditions.interleave && !q && series === "all" ? interleaveDiscoverSeries(list) : list;
  }
  if (sort === "title") return list.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === "easy" || sort === "hard") return list.sort((a, b) => compareLexile(a.lexile, b.lexile, sort) || a.title.localeCompare(b.title));
  return list;
}
