/**
 * Load the QQ groups for the overview popup.
 * A missing file uses the built-in number. A saved list, even an empty one, is what we show.
 *
 * The overview reads this on every visit, but the groups change only when an admin saves them.
 * Keep a short page-lifetime cache; the public endpoint also sends a one-minute cache header.
 */
import { DEFAULT_QQ_GROUPS, normalizeQqGroups } from "@/lib/qq-groups";

export type QqGroupsState = { saved: boolean; groups: string[] };

const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; promise: Promise<QqGroupsState> } | null = null;

export function loadQqGroups(): Promise<QqGroupsState> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.promise;
  let promise: Promise<QqGroupsState>;
  promise = (async () => {
    const response = await fetch("/api/qq-groups");
    if (!response.ok) throw new Error("qq-groups");
    const body = (await response.json()) as { saved?: unknown; groups?: unknown };
    if (body.saved !== true) return { saved: false, groups: [...DEFAULT_QQ_GROUPS] };
    const parsed = normalizeQqGroups(body);
    return parsed.ok ? { saved: true, groups: parsed.groups } : { saved: false, groups: [...DEFAULT_QQ_GROUPS] };
  })().catch(() => {
    if (cache?.promise === promise) cache = null;
    return { saved: false, groups: [...DEFAULT_QQ_GROUPS] };
  });
  cache = { at: Date.now(), promise };
  return promise;
}

/** Tests and an admin page may drop the page-lifetime copy. */
export function forgetQqGroupsCache(): void {
  cache = null;
}
