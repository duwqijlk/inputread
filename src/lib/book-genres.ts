/** Editorial book genres, independent of series, reading level and weekly allowance. */
export const BOOK_GENRES = [
  "fantasy", "adventure", "mystery", "science-fiction", "realistic",
  "historical", "romance", "animals", "horror-thriller", "nonfiction",
] as const;

export type BookGenre = (typeof BOOK_GENRES)[number];

export function isBookGenre(value: unknown): value is BookGenre {
  return typeof value === "string" && (BOOK_GENRES as readonly string[]).includes(value);
}

/** Older or partially invalid catalogs still load; an unknown genre never hides a book. */
export function readBookGenres(value: unknown): BookGenre[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isBookGenre))].slice(0, 3);
}

/** Publishing is strict even though catalog reading is tolerant. */
export function validBookGenres(value: unknown): value is BookGenre[] {
  return Array.isArray(value) && value.length <= 3 && value.every(isBookGenre) && new Set(value).size === value.length;
}
