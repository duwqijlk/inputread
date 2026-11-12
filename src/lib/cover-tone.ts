/**
 * A book's own colour (design system CoverTone): one colour taken from its cover, laid only on the
 * parts of the page that belong to that book (the shelf's continue card, Discover's new book, the top
 * of a book's detail). Buttons, links and progress stay brand green.
 *
 * The design mixes the shades with CSS `color-mix(in oklab, ...)`, which needs Chrome 111; the e-ink
 * readers run Chrome 69, so the same mixes are done here and handed to CSS as plain colours:
 * `--book-wash` (20% book on paper), `--book-tint` (44%), `--book-deep` (60% book on ink, small labels)
 * and `--book-shadow` (the cover's shadow). Night uses less colour and a black shadow; e-ink none.
 *
 * Picking the colour, once per cover and cached: draw the cover at 24×36, skip transparent, near-white
 * and near-black pixels, put the rest in 12 hue groups scored by count × (0.2 + saturation), take the
 * best group's average. Almost grey (OKLCH chroma < 0.04) is no colour. Lightness is clamped to
 * OKLCH L 0.35-0.65 so a very pale or very dark cover still gives a visible colour.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { usePrefs } from "@/lib/reader-prefs";
import { pickTone, toneStyle } from "@/lib/tone-math";

const CACHE_KEY = "cibian-cover-tone-v1";
const CACHE_MAX = 400;
const memory = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
let hydrated = false;

function ensureHydrated(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const all = JSON.parse(raw) as Record<string, unknown>;
    for (const [url, hex] of Object.entries(all)) {
      if (typeof hex === "string" && !memory.has(url)) memory.set(url, hex);
    }
  } catch {
    // Corrupted or blocked storage: memory cache still works for this session.
  }
}

function writeCache(url: string, hex: string): void {
  ensureHydrated();
  memory.delete(url);
  memory.set(url, hex);
  while (memory.size > CACHE_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(memory)));
  } catch {
    // Only a convenience: the colour is picked again next time.
  }
}

function loadTone(url: string): Promise<string> {
  ensureHydrated();
  const known = memory.get(url);
  if (known !== undefined) return Promise.resolve(known);
  const running = pending.get(url);
  if (running) return running;
  const job = new Promise<string>((resolve) => {
    const image = new Image();
    // Covers on the books host send CORS headers; without them the canvas cannot be read.
    if (!url.startsWith("data:") && !url.startsWith("blob:") && new URL(url, location.href).origin !== location.origin) {
      image.crossOrigin = "anonymous";
    }
    image.decoding = "async";
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 24;
        canvas.height = 36;
        const context = canvas.getContext("2d");
        if (!context) return resolve("");
        context.drawImage(image, 0, 0, 24, 36);
        resolve(pickTone(context.getImageData(0, 0, 24, 36).data));
      } catch {
        resolve("");
      }
    };
    image.onerror = () => resolve("");
    image.src = url;
  }).then((hex) => {
    writeCache(url, hex);
    pending.delete(url);
    return hex;
  });
  pending.set(url, job);
  return job;
}

/** Warm a cover's extracted tone ahead of time so carousel transitions never snap from grey. */
export function preloadBookTone(cover: string | undefined): void {
  if (cover) void loadTone(cover);
}

/**
 * The tone of one book as CSS custom properties. `fixed` is a known colour (a speech's generated
 * cover); otherwise the colour comes from `cover`. Until it is known (and for a grey cover) the
 * shades fall back to `sheet`.
 */
export function useBookTone(cover: string | undefined, fixed?: string): CSSProperties {
  const theme = usePrefs((state) => state.theme);
  ensureHydrated();
  const cached = cover ? memory.get(cover) : undefined;
  const [loaded, setLoaded] = useState<{ url: string; hex: string } | null>(() =>
    cover && cached !== undefined ? { url: cover, hex: cached } : null,
  );
  useEffect(() => {
    if (fixed || !cover) return;
    ensureHydrated();
    const hit = memory.get(cover);
    if (hit !== undefined) {
      setLoaded((prev) => (prev?.url === cover && prev.hex === hit ? prev : { url: cover, hex: hit }));
      return;
    }
    let alive = true;
    void loadTone(cover).then((hex) => {
      if (alive) setLoaded({ url: cover, hex });
    });
    return () => {
      alive = false;
    };
  }, [cover, fixed]);
  const activeHex = fixed || (cached !== undefined ? cached : cover && loaded?.url === cover ? loaded.hex : "");
  return useMemo(() => toneStyle(activeHex, theme), [activeHex, theme]);
}
