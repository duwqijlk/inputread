import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { btn, cn, subTabs } from "@/components/ui";
import { BOOK_GENRES, type BookGenre } from "@/lib/book-genres";
import { useT } from "@/lib/i18n";

/** A third navigation level: always available above both home and filtered results. */
export function DiscoverGenres({ genre, onSelect }: {
  genre?: BookGenre;
  onSelect: (genre?: BookGenre) => void;
}) {
  const { t, locale } = useT();
  const strip = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });
  useEffect(() => {
    const node = strip.current;
    if (!node) return;
    const measure = () => {
      const next = {
        overflow: node.scrollWidth > node.clientWidth + 1,
        left: node.scrollLeft > 1,
        right: node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
      };
      setEdges((old) => old.overflow === next.overflow && old.left === next.left && old.right === next.right ? old : next);
    };
    const selected = node.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (selected) {
      const viewport = node.getBoundingClientRect();
      const item = selected.getBoundingClientRect();
      if (item.left < viewport.left) node.scrollLeft -= viewport.left - item.left;
      else if (item.right > viewport.right) node.scrollLeft += item.right - viewport.right;
    }
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    for (const child of node.children) observer?.observe(child);
    return () => {
      node.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [genre, locale]);

  function move(direction: number) {
    const node = strip.current;
    if (node) node.scrollLeft += direction * Math.max(120, node.clientWidth * 0.75);
  }

  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-line" role="group" aria-label={t("browse.genres")} data-discover-genres>
      {edges.overflow ? (
        <button type="button" className={cn(btn.icon, "shrink-0 disabled:opacity-30 sm:size-9")} disabled={!edges.left} aria-label={t("browse.previousGenres")} onClick={() => move(-1)} data-genres-prev>
          <ChevronLeft className="size-3.5" aria-hidden />
        </button>
      ) : null}
      <div ref={strip} className="no-scrollbar flex min-w-0 flex-1 gap-5 overflow-x-auto overflow-y-hidden" data-genre-strip>
        {[undefined, ...BOOK_GENRES].map((value) => {
          const selected = genre === value;
          return (
            <button key={value ?? "all"} type="button" aria-pressed={selected} data-genre-tab={value ?? "all"} onClick={() => onSelect(value)} className={cn(
              subTabs.tab.replace("text-[0.9375rem]", "text-[0.8125rem]"), "whitespace-nowrap sm:min-h-9",
              selected ? subTabs.on : subTabs.off,
            )}>
              {value ? t(`genre.${value}`) : t("browse.genreAll")}
            </button>
          );
        })}
      </div>
      {edges.overflow ? (
        <button type="button" className={cn(btn.icon, "shrink-0 disabled:opacity-30 sm:size-9")} disabled={!edges.right} aria-label={t("browse.nextGenres")} onClick={() => move(1)} data-genres-next>
          <ChevronRight className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
