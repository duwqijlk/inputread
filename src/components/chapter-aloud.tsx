import { ChevronsDown, Loader2, Pause, Play, SkipBack, SkipForward, SlidersHorizontal, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { btn, cn, Segmented, Switch } from "@/components/ui";
import { MIMO_VOICES, type MimoVoice } from "@/lib/mimo-tts";
import { useT, type Key } from "@/lib/i18n";
import { flowText } from "@/lib/flow-text";
import { readerParagraphBlocks } from "@/lib/reader-blocks";
import {
  closeChapterAloud,
  continueChapterAloud,
  jumpChapterAloud,
  openAloudPanel,
  pauseChapterAloud,
  resumeChapterAloud,
  setChapterAloudRate,
  skipChapterAloud,
  startChapterAloud,
  stopChapterAloud,
  useChapterAloud,
  type AloudChapter,
} from "@/lib/chapter-aloud";
import { ALOUD_RATES, useReadAloudReady, useTtsSettings, type AloudRate } from "@/lib/tts-settings";

/*
 * Reading a chapter aloud from the reader itself: a play button in the top bar (from the first
 * paragraph on screen), a small speaker after every paragraph (from that paragraph on), a bar at
 * the bottom while it reads, the paragraph being read highlighted and kept in view. All of it only
 * with the reader's own MiMo key (tts-settings.ts) on a browser that can play it.
 */

const ERROR_KEYS: Record<string, Key> = {
  key: "tts.err.key",
  rate: "tts.err.rate",
  network: "tts.err.network",
  server: "tts.err.server",
  empty: "tts.err.empty",
  play: "tts.err.play",
};

export type AloudBook = { bookTitle: string; chapterTitle: string; author: string };

function chapterOf(root: HTMLElement, meta: AloudBook, onChapterEnd?: () => boolean): AloudChapter {
  return { paragraphs: readerParagraphBlocks(root).map((block) => flowText(block)), ...meta, onChapterEnd };
}

/**
 * Where to start: the first paragraph that begins on screen below the top bar. A paragraph cut by
 * the bar counts only when most of it is still in view (a long one filling the screen); its last
 * line peeking out at the top does not.
 */
function firstVisibleParagraph(root: HTMLElement, barBottom: number): number {
  const blocks = readerParagraphBlocks(root);
  for (let index = 0; index < blocks.length; index += 1) {
    const box = blocks[index].getBoundingClientRect();
    if (box.bottom <= barBottom + 8) continue;
    if (box.top >= barBottom - 4) return index;
    const shown = (box.bottom - barBottom) / Math.max(1, box.height);
    if (shown >= 0.6) return index;
  }
  return 0;
}

/**
 * The reader's side of chapter reading. `onNextChapter` opens the next chapter and returns false
 * when there is none; reading carries on there once its text is on the page (`version` changes).
 */
export function useChapterAloudBridge({
  articleRef,
  headerRef,
  chapterKey,
  meta,
  onNextChapter,
}: {
  articleRef: React.RefObject<HTMLElement | null>;
  headerRef: React.RefObject<HTMLElement | null>;
  /**
   * Which chapter is on the page (book and chapter, not its HTML: the HTML is also rebuilt inside a
   * chapter, after a word is saved for one, and that must not stop the reading).
   */
  chapterKey: string;
  meta: AloudBook;
  onNextChapter: () => boolean;
}) {
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const nextRef = useRef(onNextChapter);
  nextRef.current = onNextChapter;
  const status = useChapterAloud((state) => state.status);

  const onChapterEnd = useCallback(() => nextRef.current(), []);

  const start = useCallback(
    (from?: number) => {
      const root = articleRef.current;
      if (!root) return;
      const bar = headerRef.current?.getBoundingClientRect().bottom ?? 0;
      const at = from ?? firstVisibleParagraph(root, bar);
      startChapterAloud(chapterOf(root, metaRef.current, onChapterEnd), at);
    },
    [articleRef, headerRef, onChapterEnd],
  );

  // A new chapter on the page: carry on reading it if the last one ended into it; if the reader
  // moved to it by hand while reading, stop (the old chapter's paragraphs are gone).
  const firstVersion = useRef(true);
  useEffect(() => {
    if (firstVersion.current) {
      firstVersion.current = false;
      return;
    }
    const state = useChapterAloud.getState().status;
    if (state === "advancing") {
      const frame = requestAnimationFrame(() => {
        const root = articleRef.current;
        if (root) continueChapterAloud(chapterOf(root, metaRef.current, onChapterEnd));
      });
      return () => cancelAnimationFrame(frame);
    }
    if (state !== "off") stopChapterAloud();
  }, [chapterKey, articleRef, onChapterEnd]);

  // Leaving the book stops reading.
  useEffect(() => () => stopChapterAloud(), []);

  return { start, status };
}

/**
 * The top-bar button opens the player at the bottom (voice, speed, then Play); it does not start
 * reading by itself. While reading it shows the player's options.
 */
export function AloudHeaderButton() {
  const { t } = useT();
  const ready = useReadAloudReady();
  const panel = useChapterAloud((state) => state.panel);
  const status = useChapterAloud((state) => state.status);
  if (!ready) return null;
  const on = panel || status !== "off";
  return (
    <button
      type="button"
      className={cn(btn.icon, on && "text-accent")}
      onClick={() => {
        if (status !== "off") window.dispatchEvent(new Event(SHOW_OPTIONS));
        else if (panel) closeChapterAloud();
        else openAloudPanel();
      }}
      aria-label={t("aloud.open")}
      aria-pressed={on}
      title={t("aloud.open")}
      data-aloud-header
    >
      <Volume2 className="size-5" aria-hidden />
    </button>
  );
}

/** The top-bar button, while reading: open the player's options. */
const SHOW_OPTIONS = "inputread-aloud-options";

/**
 * A small speaker after the last word of every paragraph (after its help mark, if any). Like the
 * help mark it is an EMPTY span drawn by CSS, so it never reaches the paragraph's text, anchors or
 * selections. Tapping one reads from that paragraph on. The paragraph being read is highlighted.
 */
export function ParagraphSpeakers({
  articleRef,
  version,
  onStartAt,
}: {
  articleRef: React.RefObject<HTMLElement | null>;
  version: unknown;
  onStartAt: (index: number) => void;
}) {
  const { t } = useT();
  const ready = useReadAloudReady();
  const label = t("aloud.fromHere");
  const startAt = useRef(onStartAt);
  startAt.current = onStartAt;
  const status = useChapterAloud((state) => state.status);
  const index = useChapterAloud((state) => state.index);

  useEffect(() => {
    const root = articleRef.current;
    if (!root || !ready) return;
    const added: Element[] = [];
    readerParagraphBlocks(root).forEach((block, at) => {
      if (!/[A-Za-z]/.test(flowText(block))) return;
      const mark = block.ownerDocument.createElement("span");
      mark.setAttribute("data-para-ui", "");
      mark.setAttribute("data-aloud-from", String(at));
      mark.setAttribute("role", "button");
      mark.setAttribute("tabindex", "0");
      mark.setAttribute("aria-label", label);
      mark.setAttribute("title", label);
      block.appendChild(mark);
      added.push(mark);
    });
    const markOf = (event: Event) => (event.target as Element | null)?.closest?.("[data-aloud-from]") ?? null;
    const fire = (mark: Element, event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const at = Number(mark.getAttribute("data-aloud-from"));
      if (Number.isInteger(at) && at >= 0) startAt.current(at);
    };
    const onClick = (event: MouseEvent) => {
      const mark = markOf(event);
      if (mark) fire(mark, event);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const mark = markOf(event);
      if (mark) fire(mark, event);
    };
    root.addEventListener("click", onClick, true);
    root.addEventListener("keydown", onKey, true);
    return () => {
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("keydown", onKey, true);
      for (const mark of added) mark.remove();
    };
  }, [articleRef, version, ready, label]);

  // The paragraph being read: a soft highlight (colour only, the page does not move).
  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    root.querySelector("[data-aloud-current]")?.removeAttribute("data-aloud-current");
    if (status === "off") return;
    readerParagraphBlocks(root)[index]?.setAttribute("data-aloud-current", "");
  }, [articleRef, version, status, index]);

  return null;
}

/** Voice, speed and "carry on into the next chapter": before Play, and from the options button. */
function AloudOptions() {
  const { t } = useT();
  const voice = useTtsSettings((state) => state.voice);
  const rate = useTtsSettings((state) => state.rate);
  const autoNext = useTtsSettings((state) => state.autoNext);
  const setVoice = useTtsSettings((state) => state.setVoice);
  const setRate = useTtsSettings((state) => state.setRate);
  const setAutoNext = useTtsSettings((state) => state.setAutoNext);
  return (
    <div className="grid gap-3" data-aloud-options>
      <div className="grid gap-1.5">
        <span className="px-0.5 text-[13px] font-semibold text-faint">{t("tts.voice")}</span>
        <Segmented<MimoVoice>
          layout="wrap"
          label={t("tts.voice")}
          value={voice}
          onChange={(next) => {
            setVoice(next);
            // Reading: say the paragraph again in the new voice.
            const state = useChapterAloud.getState();
            if (state.status === "playing" || state.status === "loading") jumpChapterAloud(state.index);
          }}
          options={MIMO_VOICES.map((item) => ({
            value: item.id,
            label: `${item.id} · ${t(item.gender === "female" ? "tts.female" : "tts.male")}`,
          }))}
        />
      </div>
      <div className="grid gap-1.5">
        <span className="px-0.5 text-[13px] font-semibold text-faint">{t("aloud.speedTitle")}</span>
        <Segmented<AloudRate>
          label={t("aloud.speedTitle")}
          value={rate}
          onChange={(next) => {
            setRate(next);
            setChapterAloudRate(next);
          }}
          options={ALOUD_RATES.map((value) => ({ value, label: `${value}x` }))}
        />
      </div>
      <label className="flex min-h-11 items-center justify-between gap-3 px-0.5 text-[15px]" data-aloud-autonext>
        <span>{t("aloud.autoNext")}</span>
        <Switch checked={autoNext} onChange={setAutoNext} label={t("aloud.autoNext")} />
      </label>
    </div>
  );
}

/**
 * The player at the bottom. Opened from the top bar it shows the options and a Play button;
 * reading, it shows previous / play-pause / next, where it is, options and close.
 *
 * Following: the paragraph being read is kept in view. The reader scrolling (the wheel, a finger
 * dragging more than a few pixels, scrolling keys) stops it at once, even in the middle of our own
 * smooth scroll; a tap does not. Once the reader stops scrolling and the paragraph being read is on
 * screen again, following comes back on its own; "Back to the reading" brings it back at once.
 * The highlight stays all the while.
 */
export function AloudBar({
  articleRef,
  headerRef,
  version,
  onStart,
}: {
  articleRef: React.RefObject<HTMLElement | null>;
  headerRef: React.RefObject<HTMLElement | null>;
  version: unknown;
  /** start reading from the first paragraph on screen */
  onStart: () => void;
}) {
  const { t } = useT();
  const panel = useChapterAloud((state) => state.panel);
  const status = useChapterAloud((state) => state.status);
  const index = useChapterAloud((state) => state.index);
  const total = useChapterAloud((state) => state.total);
  const error = useChapterAloud((state) => state.error);
  const [follow, setFollow] = useState(true);
  const [inView, setInView] = useState(true);
  const [options, setOptions] = useState(false);
  const autoUntil = useRef(0);
  const baseY = useRef(0);
  /** When the reader last scrolled by hand (wheel, a drag, a scrolling key). */
  const handAt = useRef(0);
  const on = status !== "off";

  const currentBlock = useCallback(() => {
    const root = articleRef.current;
    return root ? (readerParagraphBlocks(root)[useChapterAloud.getState().index] ?? null) : null;
  }, [articleRef]);

  const visible = useCallback(() => {
    const block = currentBlock();
    if (!block) return true;
    const box = block.getBoundingClientRect();
    const top = (headerRef.current?.getBoundingClientRect().bottom ?? 0) + 8;
    return box.bottom > top && box.top < window.innerHeight - 110;
  }, [currentBlock, headerRef]);

  const reveal = useCallback(() => {
    const block = currentBlock();
    if (!block) return;
    const box = block.getBoundingClientRect();
    const top = (headerRef.current?.getBoundingClientRect().bottom ?? 0) + 16;
    const bottom = window.innerHeight - 140;
    if (box.top >= top && box.bottom <= bottom) {
      baseY.current = window.scrollY;
      return;
    }
    const target = Math.max(0, window.scrollY + box.top - top);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    autoUntil.current = Date.now() + (reduce ? 250 : 1200);
    baseY.current = target;
    window.scrollTo({ top: target, behavior: reduce ? "auto" : "smooth" });
  }, [currentBlock, headerRef]);

  // A new reading: follow again, options closed.
  useEffect(() => {
    if (status === "off") {
      setFollow(true);
      setOptions(false);
    }
  }, [status]);

  // The top-bar button while reading: show the options.
  useEffect(() => {
    const show = () => setOptions(true);
    window.addEventListener(SHOW_OPTIONS, show);
    return () => window.removeEventListener(SHOW_OPTIONS, show);
  }, []);

  // The reader's own scrolling: the wheel, a drag of the finger (a tap moves a few pixels, which
  // is not a scroll), or a key that scrolls.
  useEffect(() => {
    if (!on) return;
    let startY = 0;
    const hand = () => {
      handAt.current = Date.now();
      autoUntil.current = 0;
    };
    const onTouchStart = (event: TouchEvent) => {
      startY = event.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (Math.abs((event.touches[0]?.clientY ?? startY) - startY) > 12) hand();
    };
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) hand();
    };
    window.addEventListener("wheel", hand, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", hand);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [on]);

  // Watch the page position: the reader's own move (beyond a few pixels) stops following, also in
  // the middle of our smooth scroll; a pause in scrolling with the paragraph on screen brings it back.
  useEffect(() => {
    if (!on) return;
    baseY.current = window.scrollY;
    let idle = 0;
    const onScroll = () => {
      const now = Date.now();
      const byHand = now - handAt.current < 450;
      if (!byHand && now < autoUntil.current) {
        baseY.current = window.scrollY;
        return;
      }
      if (Math.abs(window.scrollY - baseY.current) > 48) setFollow(false);
      setInView(visible());
      window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        if (visible()) {
          baseY.current = window.scrollY;
          setFollow(true);
        }
      }, 1600);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(idle);
    };
  }, [on, visible]);

  // Each new paragraph: keep it in view while following; the highlight is set either way.
  useEffect(() => {
    if (!on) return;
    if (follow) reveal();
    setInView(visible());
  }, [on, follow, index, version, reveal, visible]);

  if (!on && !panel) return null;
  const playing = status === "playing" || status === "loading" || status === "advancing";
  const busy = status === "loading" || status === "advancing";
  const iconBtn =
    "inline-flex size-10 shrink-0 items-center justify-center rounded-full text-ink transition-colors duration-150 hover:bg-ink/[0.06] active:bg-ink/[0.1] disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  const card = "pointer-events-auto w-full max-w-[24rem] rounded-2xl border border-float-edge bg-float p-4 text-ink shadow-lift";
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 flex flex-col items-center gap-2 px-3"
      data-aloud-bar={on ? status : "ready"}
    >
      {on && !follow && !inView ? (
        <button
          type="button"
          className="pointer-events-auto inline-flex min-h-9 items-center gap-1.5 rounded-full bg-float px-3.5 text-[13px] font-semibold text-accent shadow-lift"
          onClick={() => {
            setFollow(true);
            reveal();
          }}
          data-aloud-follow
        >
          <ChevronsDown className="size-4" aria-hidden />
          {t("aloud.backToReading")}
        </button>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="pointer-events-auto m-0 max-w-[22rem] rounded-xl bg-float px-3.5 py-2 text-center text-[13px] leading-snug text-warn shadow-lift"
          data-aloud-error={error}
        >
          {t(ERROR_KEYS[error] ?? "tts.err.server")}
        </p>
      ) : null}

      {!on ? (
        <div role="dialog" aria-label={t("aloud.player")} className={card} data-aloud-ready>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="m-0 text-[15px] font-semibold">{t("aloud.readyTitle")}</p>
              <p className="m-0 text-xs text-faint">{t("aloud.fromScreen")}</p>
            </div>
            <button
              type="button"
              className="relative inline-flex size-[30px] shrink-0 items-center justify-center rounded-full bg-ink/[0.07] text-muted after:absolute after:-inset-[7px] after:content-[''] hover:bg-ink/[0.11] hover:text-ink"
              onClick={() => closeChapterAloud()}
              aria-label={t("aloud.close")}
              data-aloud-close
            >
              <X className="size-4" strokeWidth={2.5} aria-hidden />
            </button>
          </div>
          <AloudOptions />
          <button type="button" className={cn(btn.primary, "mt-4 w-full")} onClick={onStart} data-aloud-play>
            <Play className="size-4 fill-current" aria-hidden />
            {t("aloud.play")}
          </button>
        </div>
      ) : (
        <>
          {options ? (
            <div role="dialog" aria-label={t("aloud.options")} className={card} data-aloud-options-card>
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="m-0 text-[15px] font-semibold">{t("aloud.options")}</p>
                <button
                  type="button"
                  className="relative inline-flex size-[30px] shrink-0 items-center justify-center rounded-full bg-ink/[0.07] text-muted after:absolute after:-inset-[7px] after:content-[''] hover:bg-ink/[0.11] hover:text-ink"
                  onClick={() => setOptions(false)}
                  aria-label={t("common.close")}
                >
                  <X className="size-4" strokeWidth={2.5} aria-hidden />
                </button>
              </div>
              <AloudOptions />
            </div>
          ) : null}
          <div
            role="group"
            aria-label={t("aloud.player")}
            className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-float-edge bg-float py-1 pr-1.5 pl-2 text-ink shadow-lift"
          >
            <button type="button" className={iconBtn} onClick={() => skipChapterAloud(-1)} disabled={index <= 0} aria-label={t("aloud.previous")} data-aloud-prev>
              <SkipBack className="size-[18px]" aria-hidden />
            </button>
            <button
              type="button"
              className={cn(iconBtn, "size-11 bg-accent text-accent-ink hover:bg-accent/90 active:bg-accent/80")}
              onClick={() => (playing ? pauseChapterAloud() : resumeChapterAloud())}
              aria-label={playing ? t("aloud.pause") : t("aloud.resume")}
              data-aloud-toggle
            >
              {busy ? (
                <Loader2 className="size-5 animate-spin" aria-hidden />
              ) : playing ? (
                <Pause className="size-5 fill-current" aria-hidden />
              ) : (
                <Play className="size-5 translate-x-px fill-current" aria-hidden />
              )}
            </button>
            <button type="button" className={iconBtn} onClick={() => skipChapterAloud(1)} disabled={index >= total - 1} aria-label={t("aloud.next")} data-aloud-next>
              <SkipForward className="size-[18px]" aria-hidden />
            </button>
            <span className="min-w-[3.25rem] px-1 text-center text-xs text-muted [font-variant-numeric:tabular-nums]" aria-live="polite" data-aloud-position>
              {`${Math.min(index + 1, total)} / ${total}`}
            </span>
            <button
              type="button"
              className={cn(iconBtn, options && "bg-ink/[0.07]")}
              onClick={() => setOptions((value) => !value)}
              aria-pressed={options}
              aria-label={t("aloud.options")}
              title={t("aloud.options")}
              data-aloud-options-button
            >
              <SlidersHorizontal className="size-[17px]" aria-hidden />
            </button>
            <button type="button" className={cn(iconBtn, "text-muted")} onClick={() => closeChapterAloud()} aria-label={t("aloud.stop")} data-aloud-stop>
              <X className="size-[18px]" strokeWidth={2.25} aria-hidden />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** For the reader: jump straight to a paragraph while reading (a speaker tapped mid-chapter). */
export function readFromParagraph(start: (from?: number) => void, at: number): void {
  if (useChapterAloud.getState().status === "off") start(at);
  else jumpChapterAloud(at);
}
