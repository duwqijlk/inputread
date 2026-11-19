import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { FeaturedBook, preloadFeaturedBooks, type DiscoverRow } from "@/components/discover-browse";
import { useT } from "@/lib/i18n";
import { motionOff } from "@/lib/motion";

const INTERVAL = 6000;

/** Only the current banner mounts. Catalog identity, not its array position, owns its local state. */
export function NewBooksCarousel({ rows, detailOpen, onOpen }: {
  rows: DiscoverRow[];
  detailOpen: boolean;
  onOpen: (row: DiscoverRow) => void;
}) {
  const { t } = useT();
  const [selected, setSelected] = useState(() => rows[0]?.key ?? "");
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [off, setOff] = useState(motionOff);
  const frame = useRef<HTMLDivElement>(null);
  const previous = useRef("");
  const direction = useRef(1);
  const pointerFocus = useRef(false);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const index = Math.max(0, rows.findIndex((row) => row.key === selected));
  const active = rows[index];
  const key = active?.key ?? "";
  const keys = JSON.stringify(rows.map((row) => row.key));
  const nextKey = rows[(index + 1) % rows.length]?.key;
  const count = rows.length;
  const stopped = paused || hovered || hidden || off || detailOpen;

  useEffect(() => {
    const visibility = () => setHidden(document.hidden);
    const preference = () => setOff(motionOff());
    let media: MediaQueryList | undefined;
    try { media = window.matchMedia("(prefers-reduced-motion: reduce)"); } catch { /* Older engines may not expose matchMedia. */ }
    if (media?.addEventListener) media.addEventListener("change", preference);
    else media?.addListener(preference);
    const observer = new MutationObserver(preference);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    document.addEventListener("visibilitychange", visibility);
    preference();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      if (media?.removeEventListener) media.removeEventListener("change", preference);
      else media?.removeListener(preference);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (selected !== key) setSelected(key);
  }, [selected, key]);

  useEffect(() => {
    if (rows.length > 1) preloadFeaturedBooks?.(rows);
  }, [keys, rows]);

  useEffect(() => {
    if (count < 2 || stopped || !nextKey) return;
    const timer = window.setTimeout(() => {
      direction.current = 1;
      setSelected(nextKey);
    }, INTERVAL);
    return () => window.clearTimeout(timer);
  }, [key, keys, count, nextKey, stopped]);

  useLayoutEffect(() => {
    const changed = previous.current && previous.current !== key;
    previous.current = key;
    if (!changed || !frame.current || off || motionOff()) return;
    const animation = frame.current.animate([
      { opacity: 0.78 },
      { opacity: 1 },
    ], { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    return () => animation.cancel();
  }, [key, off]);

  const go = (next: number, toward = next >= index ? 1 : -1) => {
    setPaused(true);
    direction.current = toward;
    setSelected(rows[(next + rows.length) % rows.length]!.key);
  };

  if (!active) return null;
  return (
    <section
      aria-label={t("browse.carousel.label")}
      aria-roledescription={t("browse.carousel.role")}
      className="group/carousel relative [overflow-anchor:none]"
      data-new-books-carousel=""
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onTouchStart={(event) => {
        swiped.current = false;
        const touch = event.touches[0];
        swipeStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
      }}
      onTouchEnd={(event) => {
        const start = swipeStart.current;
        swipeStart.current = null;
        const touch = event.changedTouches[0];
        if (!start || !touch || rows.length < 2) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          swiped.current = true;
          go(index + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
        }
      }}
      onClickCapture={(event) => {
        if (!swiped.current) return;
        swiped.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDownCapture={() => { pointerFocus.current = true; }}
      onMouseDownCapture={() => { pointerFocus.current = true; }}
      onMouseUpCapture={() => { pointerFocus.current = false; }}
      onKeyDownCapture={() => { pointerFocus.current = false; }}
      onFocusCapture={(event) => {
        // A pointer click must not turn Pause into Play before its click handler runs.
        const toggleClick = pointerFocus.current && event.target instanceof Element && event.target.closest("[data-carousel-play]");
        pointerFocus.current = false;
        if (!toggleClick) setPaused(true);
      }}
    >
      <div ref={frame} data-carousel-slide={key}>
        <FeaturedBook key={key} row={active} onOpen={onOpen} animateCover={false} carouselFooter />
      </div>
      {rows.length > 1 ? (
        <>
          <button type="button" className="absolute left-2.5 top-1/2 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full bg-paper/75 text-muted opacity-0 shadow-2xs backdrop-blur-md transition-[color,background-color,opacity,transform] duration-150 hover:bg-paper hover:text-ink active:scale-95 group-hover/carousel:opacity-100 focus-visible:opacity-100 sm:flex" aria-label={t("browse.carousel.previous")} onClick={() => go(index - 1, -1)}>
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button type="button" className="absolute right-2.5 top-1/2 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full bg-paper/75 text-muted opacity-0 shadow-2xs backdrop-blur-md transition-[color,background-color,opacity,transform] duration-150 hover:bg-paper hover:text-ink active:scale-95 group-hover/carousel:opacity-100 focus-visible:opacity-100 sm:flex" aria-label={t("browse.carousel.next")} onClick={() => go(index + 1, 1)}>
            <ChevronRight className="size-4" aria-hidden />
          </button>
          <div className="absolute bottom-0 left-1/2 flex h-10 -translate-x-1/2 items-center" data-carousel-controls="" data-carousel-footer>
            {rows.map((row, at) => (
              <button key={row.key} type="button" className="flex h-10 w-5 items-center justify-center" aria-label={t("browse.carousel.position", { n: at + 1, total: rows.length })} aria-current={at === index ? "true" : undefined} onClick={() => go(at)} data-carousel-position={at}>
                <span className={`size-1.5 rounded-full transition-all duration-200 ${at === index ? "!w-4 bg-accent" : "bg-ink/20 hover:bg-ink/35"}`} aria-hidden />
              </button>
            ))}
          </div>
          <button type="button" className="absolute bottom-1 right-2.5 flex size-8 items-center justify-center rounded-full text-muted opacity-0 transition-opacity hover:text-ink group-hover/carousel:opacity-60 focus-visible:opacity-100 disabled:opacity-0" aria-label={t(paused ? "browse.carousel.play" : "browse.carousel.pause")} disabled={off} data-carousel-play="" onClick={() => setPaused((value) => !value)}>
            {paused ? <Play className="size-3" aria-hidden /> : <Pause className="size-3" aria-hidden />}
          </button>
        </>
      ) : null}
    </section>
  );
}
