/** Length of a trusted-reader grant. "forever" stores no end time. */
export const TRUST_TERMS = ["week", "month", "quarter", "year", "forever"] as const;
export type TrustTerm = (typeof TRUST_TERMS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export function isTrustTerm(value: unknown): value is TrustTerm {
  return typeof value === "string" && (TRUST_TERMS as readonly string[]).includes(value);
}

/**
 * When this grant ends, or null when it does not end.
 * A week is 7 days. A month, quarter, and year step the calendar in UTC.
 */
export function trustedUntil(term: TrustTerm, now: number): number | null {
  if (term === "forever") return null;
  if (term === "week") return now + 7 * DAY_MS;
  const date = new Date(now);
  const months = term === "month" ? 1 : term === "quarter" ? 3 : 12;
  const day = date.getUTCDate();
  // Step to the 1st, add the months, then take the same day or the last day of that month:
  // Jan 31 + 1 month is Feb 28 (or 29), not Mar 3; Feb 29 + 1 year is Feb 28.
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime();
}

/** Distinct new novels a plain reader may open in one week. */
export const GLOSSARY_WEEK_BOOKS = 7;
/** Distinct new speeches, counted apart from novels. */
export const GLOSSARY_WEEK_SPEECHES = 7;
export const GLOSSARY_WEEK_MS = 7 * DAY_MS;

/** China is UTC+8 all year (no daylight saving). */
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * The Monday 00:00 (China time) that starts the week containing `now`, in epoch ms.
 * A fixed week is easier to explain than a rolling one: both counts reset together.
 */
export function glossaryWeekStart(now: number): number {
  const local = now + CHINA_OFFSET_MS;
  const day = Math.floor(local / DAY_MS);
  // 1970-01-01 was a Thursday. Monday is three days earlier, so Monday's day number is 4 mod 7.
  const sinceMonday = (day + 3) % 7;
  return (day - sinceMonday) * DAY_MS - CHINA_OFFSET_MS;
}

/** When this week's places come back: next Monday 00:00 China time, in epoch ms. */
export function glossaryWeekReset(now: number): number {
  return glossaryWeekStart(now) + GLOSSARY_WEEK_MS;
}

type CountDb = {
  prepare(sql: string): {
    bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> };
  };
};

/** Places used this week, and the next weekly reset (0 when none is used). */
export type WeekCount = { used: number; resetAt: number };
export type GlossaryWeek = { novels: WeekCount; speeches: WeekCount };

/** How many distinct novels and speeches this reader opened in the current week. */
export async function glossaryWeekUsed(
  db: CountDb,
  userId: string,
  now: number,
  speeches: ReadonlySet<string>,
): Promise<GlossaryWeek> {
  const start = glossaryWeekStart(now);
  const recent = await db
    .prepare(
      "SELECT book_id FROM glossary_reads WHERE user_id = ? AND created_at >= ? GROUP BY book_id",
    )
    .bind(userId, start)
    .all<{ book_id: string }>();
  const week: GlossaryWeek = { novels: { used: 0, resetAt: 0 }, speeches: { used: 0, resetAt: 0 } };
  for (const row of recent.results ?? []) {
    if (speeches.has(row.book_id)) week.speeches.used += 1;
    else week.novels.used += 1;
  }
  // Both counts reset at the same time. A row with created_at 0 is a shelf grant and never counts.
  const resetAt = glossaryWeekReset(now);
  if (week.novels.used > 0) week.novels.resetAt = resetAt;
  if (week.speeches.used > 0) week.speeches.resetAt = resetAt;
  return week;
}
