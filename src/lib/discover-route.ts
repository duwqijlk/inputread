import { isBookGenre, type BookGenre } from "./book-genres.ts";

export type DiscoverView = {
  view?: "results";
  genre?: BookGenre;
  collection?: string;
  q?: string;
  band?: "under800" | "mid" | "high" | "unrated";
  sort?: "easy" | "hard" | "title";
  author?: string;
  series?: string;
  detail?: string;
};

const text = (value: string | null, max = 160) => (value ?? "").trim().slice(0, max);

/** Public filters belong in the address; device progress and account state never do. */
export function readDiscoverView(search: string): DiscoverView {
  const params = new URLSearchParams(search);
  const out: DiscoverView = {};
  if (params.get("view") === "results") out.view = "results";
  const genre = params.get("genre");
  if (isBookGenre(genre)) out.genre = genre;
  const collection = text(params.get("collection"));
  if (collection === "new" || collection === "classic" || /^(series|curated):.+/.test(collection)) out.collection = collection;
  const q = text(params.get("q"));
  if (q) out.q = q;
  const band = params.get("band"), sort = params.get("sort");
  if (band === "under800" || band === "mid" || band === "high" || band === "unrated") out.band = band;
  if (sort === "easy" || sort === "hard" || sort === "title") out.sort = sort;
  for (const key of ["author", "series"] as const) {
    const value = text(params.get(key));
    if (value && value !== "all") out[key] = value;
  }
  if (q) {
    delete out.genre;
    delete out.collection;
    delete out.band;
    delete out.author;
    delete out.series;
    delete out.sort;
  }
  const detail = params.get("detail") ?? "";
  if (/^(list|classic):[a-z0-9][a-z0-9_-]{0,63}$/.test(detail)) out.detail = detail;
  if (out.genre || out.collection || out.q || out.band || out.sort || out.author || out.series) out.view = "results";
  return out;
}

export function discoverSearch(view: DiscoverView = {}): string {
  const params = new URLSearchParams();
  for (const key of ["view", "genre", "collection", "q", "band", "sort", "author", "series", "detail"] as const) {
    const value = view[key];
    if (value) params.set(key, value);
  }
  const normalized = readDiscoverView(params.toString());
  const clean = new URLSearchParams();
  for (const [key, value] of Object.entries(normalized)) clean.set(key, value);
  const search = clean.toString();
  return search ? `?${search}` : "";
}
