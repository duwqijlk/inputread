/**
 * Addresses of the app. Every top-menu page has its own path, so back/forward, refresh and
 * a link to a page all work:
 *
 *   /shelf/           Bookshelf        /discover/        Discover
 *   /discover/novels/, /discover/speeches/   Discover on one tab
 *   /book/<id>/       Discover with that catalog book's detail open. A static page per book answers
 *                     this address (scripts/seo-pages.mjs) so a shared link shows the book's preview.
 *   /dashboard/       Overview: how many books, marked words, and notes, plus the thank-you list
 *   /admin/           Sponsorship requests. Not a menu item. Only the admin account can use it.
 *   /words/           Word book (all books)
 *   /words/<bookId>   Word book of one book
 *   /review/[<id>]    Review           /read/<bookId>    the reader
 *
 * A page with no id is written with a trailing slash; both forms are read.
 *
 * `/` and unknown paths go to /shelf. `/add` (the old add-book page) reads as Discover, the only
 * place that adds books. `/guide` and `/about` (the Guide, removed) go to /shelf. `/thanks` (the old
 * thank-you page) reads as the overview, where that list now sits. A small hand-made
 * router: the app has no server and a handful of addresses, so a library would add more code
 * than it saves.
 */
import { useSyncExternalStore } from "react";
import { discoverSearch, readDiscoverView, type DiscoverView } from "./discover-route.ts";

export type Route =
  | { kind: "shelf" }
  | { kind: "discover"; category?: "novel" | "speech"; browse?: DiscoverView }
  | { kind: "book"; bookId: string }
  | { kind: "dashboard" }
  | { kind: "admin" }
  | { kind: "words"; bookId: string | null }
  | { kind: "review"; bookId: string | null }
  | { kind: "read"; bookId: string };

export const DEFAULT_ROUTE: Route = { kind: "shelf" };

/** Book ids are UUIDs or pack ids. Anything else in a path is refused. */
const ID = /^[A-Za-z0-9_-]{1,80}$/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

/** The route of a path, or null when the path is not an address of the app. */
export function parsePath(pathname: string): Route | null {
  const parts = pathname.split("/").filter(Boolean);
  const [head, rest, extra] = parts;
  if (extra !== undefined) return null;
  const decoded = rest === undefined ? "" : safeDecode(rest);
  const id = rest !== undefined && ID.test(decoded) ? decoded : null;
  if (rest !== undefined && id === null) return null;
  switch (head) {
    case "shelf":
      return rest === undefined ? { kind: "shelf" } : null;
    case "add":
      // The old add-book page: books are added on Discover now.
      return rest === undefined ? { kind: "discover" } : null;
    case "discover":
      if (rest === undefined) return { kind: "discover" };
      if (decoded === "novels") return { kind: "discover", category: "novel" };
      if (decoded === "speeches") return { kind: "discover", category: "speech" };
      return null;
    case "book":
      return id === null ? null : { kind: "book", bookId: id };
    case "dashboard":
      return rest === undefined ? { kind: "dashboard" } : null;
    case "admin":
      return rest === undefined ? { kind: "admin" } : null;
    case "thanks":
      // The old thank-you page. The list is a section of the overview now.
      return rest === undefined ? { kind: "dashboard" } : null;
    case "words":
      return { kind: "words", bookId: id };
    case "review":
      return { kind: "review", bookId: id };
    case "read":
      return id === null ? null : { kind: "read", bookId: id };
    default:
      return null;
  }
}

/**
 * The address of a page. A page with no id ends in a slash (`/shelf/`), the address the host serves:
 * public/_redirects sends `/shelf` to `/shelf/` (a rewrite of `/shelf` to index.html made Pages answer
 * with a 308 to the site root). Writing the same address here keeps one address per page, so a
 * refresh does not take an extra redirect. Pages with an id (`/read/<id>`) have no slash.
 */
export function pathFor(route: Route): string {
  switch (route.kind) {
    case "words":
      return route.bookId ? `/words/${encodeURIComponent(route.bookId)}` : "/words/";
    case "review":
      return route.bookId ? `/review/${encodeURIComponent(route.bookId)}` : "/review/";
    case "read":
      return `/read/${encodeURIComponent(route.bookId)}`;
    case "book":
      return `/book/${encodeURIComponent(route.bookId)}/`;
    case "discover":
      return route.category ? `/discover/${route.category === "speech" ? "speeches" : "novels"}/` : "/discover/";
    default:
      return `/${route.kind}/`;
  }
}

/** Which top-menu page a route belongs to. */
export function menuOf(route: Route): "shelf" | "discover" | "dashboard" | "words" | "admin" {
  switch (route.kind) {
    case "discover":
    case "book":
      return "discover";
    case "dashboard":
      return "dashboard";
    case "admin":
      return "admin";
    case "words":
    case "review":
      return "words";
    default:
      return "shelf";
  }
}

const CHANGED = "cibian-route";

function currentPath(): string {
  return typeof window === "undefined" ? "/shelf/" : window.location.pathname;
}

function currentAddress(): string {
  return currentPath() + (typeof window === "undefined" ? "" : window.location.search);
}

export function routeAddress(route: Route): string {
  return pathFor(route) + (route.kind === "discover" ? discoverSearch(route.browse) : "");
}

export function parseAddress(address: string): Route | null {
  const [path, search = ""] = address.split("?", 2);
  const route = parsePath(path);
  if (route?.kind !== "discover" || !search) return route;
  const browse = readDiscoverView(search);
  if (route.category === "speech") delete browse.genre;
  return { ...route, browse };
}

type DiscoverPosition = { address: string; y: number; limit: number };
let liveDiscoverPosition: DiscoverPosition | null = null;
let discoverFlushTimer = 0;

function writeDiscoverHistory(position: DiscoverPosition): void {
  const state = window.history.state;
  const prev = (state && typeof state === "object" ? (state as { discoverPosition?: DiscoverPosition }).discoverPosition : undefined);
  if (prev && prev.address === position.address && prev.y === position.y && prev.limit === position.limit) return;
  if (!prev && position.y === 0 && position.limit <= 12) return;
  window.history.replaceState({ ...(state && typeof state === "object" ? state : {}),
    discoverPosition: position,
  }, "", position.address + window.location.hash);
}

function flushDiscoverPosition(): void {
  if (!discoverFlushTimer) return;
  window.clearTimeout(discoverFlushTimer);
  discoverFlushTimer = 0;
  if (liveDiscoverPosition && liveDiscoverPosition.address === currentAddress()) {
    writeDiscoverHistory(liveDiscoverPosition);
  }
}

export function discoverPosition(): DiscoverPosition | null {
  const addr = currentAddress();
  if (liveDiscoverPosition?.address === addr && Number.isFinite(liveDiscoverPosition.y) && Number.isFinite(liveDiscoverPosition.limit)) {
    return liveDiscoverPosition;
  }
  const value = window.history.state?.discoverPosition as DiscoverPosition | undefined;
  return value?.address === addr && Number.isFinite(value.y) && Number.isFinite(value.limit) ? value : null;
}

export function rememberDiscoverPosition(limit: number): void {
  if (discoverFlushTimer) {
    window.clearTimeout(discoverFlushTimer);
    discoverFlushTimer = 0;
  }
  const next: DiscoverPosition = { address: currentAddress(), y: window.scrollY, limit };
  liveDiscoverPosition = next;
  writeDiscoverHistory(next);
}

/** Zero-IPC scroll tracking: updates memory immediately and flushes history.replaceState once scrolling settles. */
export function trackDiscoverScroll(limit: number): void {
  liveDiscoverPosition = { address: currentAddress(), y: window.scrollY, limit };
  if (discoverFlushTimer) window.clearTimeout(discoverFlushTimer);
  discoverFlushTimer = window.setTimeout(() => {
    discoverFlushTimer = 0;
    if (liveDiscoverPosition && liveDiscoverPosition.address === currentAddress()) {
      writeDiscoverHistory(liveDiscoverPosition);
    }
  }, 180);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

/**
 * Go to a page. `replace` swaps the current history entry (used for redirects).
 * `state` stays on that entry. Starting a review stores `{ review: "due", mode }` so a refresh
 * of that visit opens the cards again. Every other visit clears the state.
 */
export function navigate(route: Route, options: { replace?: boolean; state?: unknown } = {}): void {
  flushDiscoverPosition();
  const path = routeAddress(route);
  const state = options.state === undefined ? null : options.state;
  if (currentAddress() !== path) {
    liveDiscoverPosition = null;
    if (options.replace) window.history.replaceState(state, "", path);
    else window.history.pushState(state, "", path);
  } else if (options.state !== undefined) {
    window.history.replaceState(state, "", path);
  }
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * What this review visit was opened for (design system ReviewLauncher): a round of the due words,
 * of the words still being learnt or of all of them, in the way the reader chose; or the review
 * data page ("overview"). A bare /review visit has none and goes back to the notebook.
 */
export type ReviewIntent =
  | { pool: "due" | "learning" | "all"; mode: "cards" | "cloze" | "spell" }
  | { pool: "overview" };

export function reviewIntent(): ReviewIntent | null {
  const state = window.history.state as { review?: unknown; mode?: unknown } | null;
  if (!state || typeof state !== "object") return null;
  const mode = state.mode === "cloze" || state.mode === "spell" ? state.mode : "cards";
  if (state.review === "due" || state.review === "learning" || state.review === "all") return { pool: state.review, mode };
  if (state.review === "overview") return { pool: "overview" };
  return null;
}

/** Which half of the notebook this visit shows: the words, or the quotes (kept in the history entry). */
export function notebookTab(): "words" | "quotes" {
  const state = window.history.state as { tab?: unknown } | null;
  return state && typeof state === "object" && state.tab === "quotes" ? "quotes" : "words";
}

/** Remember the notebook half on this history entry, so Back and a refresh come back to it. */
export function rememberNotebookTab(tab: "words" | "quotes"): void {
  const state = window.history.state as Record<string, unknown> | null;
  const next = { ...(state && typeof state === "object" ? state : {}), tab };
  window.history.replaceState(next, "", window.location.pathname + window.location.search + window.location.hash);
}

let cachedRouteAddress = "";
let cachedRouteValue: Route | null = null;

/** The route of the address bar. An address that is not a page of the app reads as the shelf. */
export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, currentAddress, () => "/shelf/");
  if (cachedRouteValue && cachedRouteAddress === path) return cachedRouteValue;
  const next = parseAddress(path) ?? DEFAULT_ROUTE;
  cachedRouteAddress = path;
  cachedRouteValue = next;
  return next;
}

/** True when the address bar is not a page of the app ("/" or a typo): the caller redirects. */
export function pathNeedsRedirect(): boolean {
  return parsePath(currentPath()) === null;
}

/**
 * The address of the page on screen, written the way `pathFor` writes it. `/shelf` and `/shelf/` are
 * the same page; the caller replaces the address so there is one address per page.
 */
export function canonicalPath(): string | null {
  const route = parsePath(currentPath());
  if (!route) return null;
  const path = pathFor(route);
  return path === currentPath() ? null : path;
}
