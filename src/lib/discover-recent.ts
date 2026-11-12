/**
 * Which Discover cards belong in the "new books" row: the books that came to the
 * catalog most recently (`added`). A new word list for an older book does not
 * move it here. The main list stays in its own order. A day-only catalog value is
 * that calendar day in the reader's time zone. An instant uses its real time.
 */

/** How many local calendar days, including today, count as recent. */
export const RECENT_UPDATE_DAYS = 3;

/**
 * Covers in the wide row once the page is at its full width (the `xl` breakpoint).
 * Ten fill the same edges from `lg` until then. A phone keeps the short recent window.
 */
export const RECENT_ROW_WIDE = 12;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function realDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const stamp = new Date(year, month - 1, day);
  return stamp.getFullYear() === year && stamp.getMonth() === month - 1 && stamp.getDate() === day;
}

/** Start of the local calendar day `days - 1` before `now`, so the window is `days` days long. */
export function recentWindowStart(now: Date, days = RECENT_UPDATE_DAYS): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

/**
 * When this catalog time happened, for sorting. A bare day is local midnight.
 * An unreadable value is null and stays out of the row.
 */
export function updateInstant(updated: string): number | null {
  const day = DAY.exec(updated);
  if (day) {
    const year = Number(day[1]);
    const month = Number(day[2]);
    const date = Number(day[3]);
    if (!realDay(year, month, date)) return null;
    return new Date(year, month - 1, date).getTime();
  }
  if (!INSTANT.test(updated)) return null;
  const when = new Date(updated);
  if (Number.isNaN(when.getTime())) return null;
  return when.getTime();
}

/** True when the update falls inside the recent window and is not after `now`. */
export function isRecentUpdate(updated: string, now: Date, days = RECENT_UPDATE_DAYS): boolean {
  const at = updateInstant(updated);
  if (at == null) return false;
  return at >= recentWindowStart(now, days) && at <= now.getTime();
}

/** Newest first. Same time keeps title order. Books with no usable `added` time are left out. */
export function recentUpdates<T extends { added: string; title: string }>(
  rows: readonly T[],
  now: Date,
  days = RECENT_UPDATE_DAYS,
): T[] {
  const min = recentWindowStart(now, days);
  const max = now.getTime();
  const stamped: Array<{ row: T; at: number }> = [];
  for (const row of rows) {
    const at = updateInstant(row.added);
    if (at != null && at >= min && at <= max) stamped.push({ row, at });
  }
  stamped.sort((a, b) => (b.at - a.at) || a.row.title.localeCompare(b.row.title));
  return stamped.map((item) => item.row);
}

/**
 * Newest books for the wide Discover row, capped at `limit`.
 * A future time and a blank time stay out. This is not limited to the short recent window,
 * so a wide screen can fill the page width when only a few books changed in that window.
 */
export function newestUpdates<T extends { added: string; title: string }>(
  rows: readonly T[],
  now: Date,
  limit = RECENT_ROW_WIDE,
): T[] {
  if (limit <= 0) return [];
  const max = now.getTime();
  const stamped: Array<{ row: T; at: number }> = [];
  for (const row of rows) {
    const at = updateInstant(row.added);
    if (at != null && at <= max) stamped.push({ row, at });
  }
  stamped.sort((a, b) => (b.at - a.at) || a.row.title.localeCompare(b.row.title));
  return stamped.slice(0, limit).map((item) => item.row);
}
