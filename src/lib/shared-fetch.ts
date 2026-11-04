/**
 * One download of a catalog shared by everyone who asks for it within a minute.
 *
 * A page load asked for the same catalog two or three times (the covers, the shelf's update
 * check, the catalog index, Discover): each one a request to the books host, which reads R2 every
 * time because JSON is not kept at the edge. Now the first caller fetches it (`cache: "no-cache"`,
 * so an unchanged file is a small 304) and every caller within SHARED_TEXT_MS gets that same text.
 * Each caller parses its own copy, so no one can change what another one reads. A failed download
 * is not kept: the next caller tries again.
 */
export const SHARED_TEXT_MS = 60_000;

const recent = new Map<string, { at: number; text: Promise<string> }>();
let generation = 0;
export const sharedFetchGeneration = () => generation;

/** A successful display snapshot for a remounted screen, not a replacement for revalidation. */
export function sessionSnapshot<T>() {
  let saved: { generation: number; value: T } | undefined;
  let sequence = 0;
  return {
    read(): T | undefined {
      return saved?.generation === generation ? saved.value : undefined;
    },
    begin() {
      return { generation, sequence: ++sequence };
    },
    publish(ticket: { generation: number; sequence: number }, value: T): boolean {
      if (ticket.generation !== generation || ticket.sequence !== sequence) return false;
      saved = { generation, value };
      return true;
    },
  };
}

export function sharedText(url: string, now = Date.now()): Promise<string> {
  const hit = recent.get(url);
  if (hit && now - hit.at < SHARED_TEXT_MS) return hit.text;
  const text = fetch(url, { cache: "no-cache" }).then((response) => {
    if (!response.ok) throw new Error(`status ${response.status}`);
    return response.text();
  });
  recent.set(url, { at: now, text });
  text.catch(() => {
    if (recent.get(url)?.text === text) recent.delete(url);
  });
  return text;
}

/** Parsed JSON from sharedText: a fresh object for every caller. */
export async function sharedJson(url: string): Promise<unknown> {
  return JSON.parse(await sharedText(url)) as unknown;
}

/** Forget every shared download (tests, and an admin who just published a catalog). */
export function forgetSharedFetches(): void {
  generation += 1;
  recent.clear();
}
