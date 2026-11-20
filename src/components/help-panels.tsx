import { ChevronDown, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getParagraphNoteFlags, paragraphBlocks } from "@/lib/help-lookup";
import { useT } from "@/lib/i18n";
import type { ParagraphHelpView, SentenceInParagraph } from "@/lib/help-flow";
import { FloatingAside } from "@/components/floating-card";
import { cn, panel, subTabs, TabInk } from "@/components/ui";
import { ReadAloudButton } from "@/components/read-aloud-button";
import { CreditLine } from "@/components/credit-line";
import { flowText } from "@/lib/flow-text";
import { parseGrammarMirror, splitPatternSlots } from "@/lib/grammar-mirror";
import { noteSentenceRange } from "@/lib/note-sentence";
import { SIDE_PANEL } from "@/components/side-panel";

/*
 * Help for paragraphs and sentences. The panels are overlays (position: fixed), so the text never
 * moves when help opens. The only thing put into the page is the ✦ mark after a paragraph that has
 * help, once per chapter (ParagraphMarks below).
 */

/* ------------------------------------------------------------------ ✦ marks at the end of the paragraphs */

/**
 * A ✦ after the last word of each paragraph that has help (a paragraph note, or a sentence note
 * inside it). It is part of the text flow, so the browser places it with the line: nothing is
 * measured on scroll, resize or turn, which is what made the old fixed lightbulbs stutter on phones.
 *
 * The mark is an EMPTY span; the glyph is drawn by CSS (`[data-para-marker]::before` in styles.css).
 * With no text node of its own it never reaches flowText, sentence ranges, reading anchors, word
 * counts or a selection's text, so every index computed from the page stays what it was.
 *
 * The marks are put in once per chapter text and word list (after the notes answer). Opening or
 * closing help only flips `data-active` on the mark and `data-para-active` on its paragraph; both
 * change colour and a box-shadow, never a size, so the page does not move.
 */

export function ParagraphMarks({
  articleRef,
  version,
  bookId,
  chapter,
  notesVersion,
  activeIndex,
  onOpen,
}: {
  articleRef: React.RefObject<HTMLElement | null>;
  /** changes when the chapter text changes */
  version: unknown;
  bookId: string;
  /** 0-based chapter on screen, or an extra id such as "x2" */
  chapter: number | string;
  /** changes when the book's word list (and so its paragraph notes) changes */
  notesVersion: unknown;
  activeIndex: number | null;
  onOpen: (index: number) => void;
}) {
  const { t } = useT();
  const label = t("hp.simplifyAria");
  const open = useRef(onOpen);
  open.current = onOpen;
  const active = useRef(activeIndex);
  active.current = activeIndex;
  const blocks = useRef<Element[]>([]);
  const [placed, setPlaced] = useState(0);

  // The paragraph list: numbered with the shared rule (the same as the word lists use). A mark
  // belongs only to a paragraph that has real help in the word list. Until the list has answered,
  // no paragraph has one.
  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    const list = paragraphBlocks(root);
    blocks.current = list;
    let alive = true;
    const added: Element[] = [];
    void getParagraphNoteFlags(
      bookId,
      chapter,
      list.map((el) => flowText(el)),
    ).then((flags) => {
      if (!alive) return;
      list.forEach((el, index) => {
        if (flags[index] !== true || !el.isConnected) return;
        const mark = el.ownerDocument.createElement("span");
        mark.setAttribute("data-para-ui", "");
        mark.setAttribute("data-para-marker", String(index));
        mark.setAttribute("role", "button");
        mark.setAttribute("tabindex", "0");
        mark.setAttribute("aria-label", label);
        mark.setAttribute("title", label);
        placeMark(el, mark);
        added.push(mark);
      });
      setPlaced((n) => n + 1);
    });
    return () => {
      alive = false;
      for (const mark of added) mark.remove();
      root.querySelector("[data-para-active]")?.removeAttribute("data-para-active");
    };
  }, [articleRef, version, bookId, chapter, notesVersion, label]);

  // One listener for every mark. Capture, so it runs before the reader's own tap handling (which
  // ignores [data-para-ui]) and before a link the mark may sit next to.
  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    const markOf = (event: Event) =>
      (event.target as Element | null)?.closest?.("[data-para-marker]") ?? null;
    const fire = (mark: Element, event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const index = Number(mark.getAttribute("data-para-marker"));
      if (Number.isInteger(index) && index >= 0) open.current(index);
    };
    const onClick = (event: MouseEvent) => {
      const mark = markOf(event);
      if (mark) fire(mark, event);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const mark = markOf(event);
      // Space would also turn the page: the mark keeps it.
      if (mark) fire(mark, event);
    };
    root.addEventListener("click", onClick, true);
    root.addEventListener("keydown", onKey, true);
    return () => {
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("keydown", onKey, true);
    };
  }, [articleRef, version]);

  // Which paragraph the open help is about: colour only.
  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    for (const mark of Array.from(root.querySelectorAll("[data-para-marker]"))) {
      if (Number(mark.getAttribute("data-para-marker")) === activeIndex) mark.setAttribute("data-active", "");
      else mark.removeAttribute("data-active");
    }
    const block = activeIndex === null ? null : blocks.current[activeIndex];
    root.querySelector("[data-para-active]")?.removeAttribute("data-para-active");
    block?.setAttribute("data-para-active", "");
  }, [articleRef, activeIndex, placed]);

  return null;
}

/** Tags that start their own line: the mark never leaves the paragraph through one of these. */
const BLOCK_TAGS = /^(P|DIV|LI|UL|OL|BLOCKQUOTE|H[1-6]|FIGURE|SECTION|ARTICLE|TABLE|PRE)$/;

/**
 * Put `mark` right after the last visible character of `block`. It steps out of a word button and
 * of inline wrappers (em, a, span) that end the paragraph, so the mark is neither italic nor a
 * link, but it never steps out of a nested block: a blockquote whose last child is a <p> gets the
 * mark at the end of that <p>, not on a line of its own.
 */
function placeMark(block: Element, mark: Element): void {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let last: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue && /\S/.test(node.nodeValue) && !node.parentElement?.closest("[data-para-ui]")) last = node;
  }
  if (!last) {
    block.appendChild(mark);
    return;
  }
  let at: Node = last;
  for (;;) {
    const parent: Element | null = at.parentElement;
    if (!parent || parent === block || BLOCK_TAGS.test(parent.tagName)) break;
    // Only climb when nothing visible follows inside the wrapper.
    let rest = at.nextSibling;
    while (rest && rest.nodeType === 3 && !/\S/.test(rest.nodeValue ?? "")) rest = rest.nextSibling;
    if (rest) break;
    at = parent;
  }
  at.parentNode?.insertBefore(mark, at.nextSibling);
}

/* ------------------------------------------------------------------ paragraph panel */

export type ParagraphPanelState =
  { status: "loading" } | { status: "none" } | { status: "ready"; view: ParagraphHelpView };

type HelpTabId = "paragraph" | "grammar" | "sentences";

export function ParagraphPanel({
  state,
  anchor,
  paragraphEl,
  onRevealSentence,
  onClose,
}: {
  state: ParagraphPanelState;
  /** the paragraph the card should sit next to on a wide screen */
  anchor: HTMLElement | null;
  /** the paragraph on the page, so the sentences the notes explain can be marked in it */
  paragraphEl?: Element | null;
  /** Keep a marked sentence in view: called with its top and bottom on screen. */
  onRevealSentence?: (top: number, bottom: number) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(true);
  const paragraph = state.status === "ready" ? state.view.paragraph : null;
  const paragraphText = useMemo(() => {
    if (!paragraphEl) return "";
    const copy = paragraphEl.cloneNode(true) as Element;
    copy.querySelectorAll("[data-para-ui]").forEach((node) => node.remove());
    return copy.textContent ?? "";
  }, [paragraphEl]);
  const grammar = state.status === "ready" ? state.view.grammar : [];
  const sentences = state.status === "ready" ? state.view.sentences : [];
  const [chosen, setChosen] = useState<number | null>(null);
  const [grammarAt, setGrammarAt] = useState(0);
  const safeGrammarAt = grammarAt < grammar.length ? grammarAt : 0;

  const availableTabs: Array<{ id: HelpTabId; label: string }> = [];
  if (paragraph) availableTabs.push({ id: "paragraph", label: t("hp.tabParagraph") });
  if (grammar.length > 0) {
    availableTabs.push({
      id: "grammar",
      label: grammar.length > 1 ? `${t("hp.tabGrammar")} · ${grammar.length}` : t("hp.tabGrammar"),
    });
  }
  if (sentences.length > 0) {
    availableTabs.push({ id: "sentences", label: `${t("hp.tabSentences")} · ${sentences.length}` });
  }

  const [tab, setTab] = useState<HelpTabId>("paragraph");
  const activeTab: HelpTabId = availableTabs.some((item) => item.id === tab)
    ? tab
    : (availableTabs[0]?.id ?? "paragraph");
  const hasTabs = availableTabs.length > 1;
  const showParagraph = Boolean(paragraph) && activeTab === "paragraph";
  const showGrammar = grammar.length > 0 && activeTab === "grammar";
  const showSentences = sentences.length > 0 && activeTab === "sentences";
  const activeMarkContexts = showGrammar
    ? grammar.map((note) => note.context)
    : showSentences
      ? sentences.map((note) => note.context)
      : [];

  // With no sentence marked, keep the paragraph itself in view above a phone sheet.
  const ready = state.status !== "loading";
  useEffect(() => {
    if (!ready || activeMarkContexts.length > 0 || !paragraphEl || !onRevealSentence) return;
    const frame = requestAnimationFrame(() => {
      const box = paragraphEl.getBoundingClientRect();
      onRevealSentence(box.top, box.bottom);
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, activeMarkContexts.length, paragraphEl, onRevealSentence]);

  return (
    <FloatingAside
      anchor={anchor}
      onClose={onClose}
      label={t("hp.panelAria")}
      kind="para"
      desktopWidth={27 * 16}
      className={cn(
        // A column: drag bar, header (never scrolls), and the body, the only part that scrolls.
        "panel-sheet fixed z-40 flex flex-col overflow-hidden border-float-edge bg-float text-ink shadow-pop",
        "inset-x-0 bottom-0 max-h-[52dvh] rounded-t-3xl border-t",
        SIDE_PANEL,
        "md:bottom-auto md:max-h-[calc(100dvh-6.5rem)] md:!pt-0",
      )}
    >
      <div className="mx-auto mt-2.5 mb-0 h-1 w-10 shrink-0 rounded-full bg-line md:hidden" aria-hidden />
      {paragraphEl ? <KeepClear el={paragraphEl} /> : null}
      {paragraphEl && activeMarkContexts.length > 0 ? (
        <SentenceMarks
          paragraphEl={paragraphEl}
          contexts={activeMarkContexts}
          chosen={chosen}
          onChoose={(index) => {
            setChosen(index);
            if (showGrammar) setGrammarAt(index);
          }}
          onReveal={onRevealSentence}
        />
      ) : null}
      {/* The header stays put; a hairline shows under it once the body scrolls (styles.css .panel-head). */}
      <div className="panel-head relative z-10 flex shrink-0 items-center justify-between gap-3 px-5 pt-3 pb-2.5 md:pt-5">
          <h2 className="flex min-w-0 items-center gap-2 font-bold tracking-[-0.02em] text-lg leading-tight">
            <span className="text-accent" aria-hidden>
              ✦
            </span>
            <span data-part="help-title">{t("hp.title")}</span>
          </h2>
          <div className="flex shrink-0 items-center gap-2.5">
            {/* Read the original paragraph aloud (only with the reader's own MiMo key; see tts-settings). */}
            <ReadAloudButton owner="para" text={paragraphText} label={t("tts.readParagraph")} />
            <button
              type="button"
              className={panel.close}
              onClick={onClose}
              aria-label={t("hp.close")}
              data-panel-close
            >
              <X className={panel.closeIcon} strokeWidth={2.5} aria-hidden />
            </button>
          </div>
      </div>
      <div
        className="panel-body min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none] px-5 pt-1 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:pb-5"
        data-sheet-body
      >
      <div className="grid min-w-0 gap-4" data-sheet-content>
        {state.status === "loading" ? (
          <div className="grid gap-2" aria-busy="true" aria-label={t("hp.lookingAria")}>
            <div className="h-4 w-full animate-pulse rounded bg-line" />
            <div className="h-4 w-4/5 animate-pulse rounded bg-line" />
            <p className="text-sm text-muted">{t("hp.looking")}</p>
          </div>
        ) : state.status === "none" ? (
          <p
            className="rounded-lg bg-accent-soft px-3 py-2.5 text-[0.95rem] leading-snug"
            role="status"
          >
            {t("hp.noPara")}
          </p>
        ) : (
          <>
            {hasTabs ? (
              <div
                role="tablist"
                aria-label={t("hp.panelAria")}
                className="no-scrollbar relative flex gap-4 overflow-x-auto border-b border-line sm:gap-6"
                data-part="help-tabs"
              >
                {availableTabs.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === item.id}
                    data-tab={item.id}
                    onClick={(event) => {
                      setChosen(null);
                      setTab(item.id);
                      // A new tab starts at its top; the browser's scroll anchoring would keep the old offset.
                      event.currentTarget.closest("aside")?.scrollTo?.(0, 0);
                    }}
                    className={cn(
                      subTabs.tab,
                      "whitespace-nowrap text-sm",
                      activeTab === item.id ? subTabs.on : subTabs.off,
                    )}
                  >
                    {item.label}
                  </button>
                ))}
                <TabInk selected={activeTab} />
              </div>
            ) : null}

            {showParagraph && paragraph ? (
              <section
                className="grid min-w-0 gap-4"
                aria-label={t("hp.paragraphSection")}
                data-part="paragraph-help"
              >
                {hasTabs ? null : <h3 className="sr-only">{t("hp.paragraphSection")}</h3>}
                <section className="grid gap-1" aria-label={t("hp.mainIdea")}>
                  <h4 className="text-xs font-semibold tracking-wide text-accent">{t("hp.mainIdea")}</h4>
                  <p
                    className="break-words font-display text-[1.05rem] leading-relaxed text-ink"
                    lang="en"
                    data-part="main-idea"
                  >
                    {paragraph.mainIdea}
                  </p>
                </section>

                <section className="grid gap-1" aria-label={t("hp.simple")}>
                  <h4>
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setOpen((value) => !value)}
                      className="-mx-1 flex min-h-9 w-[calc(100%+0.5rem)] items-center justify-between gap-2 rounded-lg px-1 text-left text-xs font-semibold tracking-wide text-accent hover:bg-accent-soft/60"
                    >
                      <span>{t("hp.simple")}</span>
                      <span className="flex shrink-0 items-center gap-1 font-normal text-muted">
                        {open ? t("common.hide") : t("common.show")}
                        <ChevronDown
                          className={cn("size-4 transition-transform", open && "rotate-180")}
                          aria-hidden
                        />
                      </span>
                    </button>
                  </h4>
                  {open ? (
                    <p
                      className="break-words text-[0.96rem] leading-relaxed text-muted"
                      lang="en"
                      data-part="simple"
                    >
                      {paragraph.simple}
                    </p>
                  ) : null}
                </section>

                <HelpSource credit={paragraph.credit} />
              </section>
            ) : null}

            {showGrammar ? (
              <section
                className="grid min-w-0 gap-3"
                aria-label={t("hp.grammarSection")}
                data-part="grammar-help"
              >
                {hasTabs ? null : <h3 className="sr-only">{t("hp.grammarSection")}</h3>}
                {grammar.length > 1 ? (
                  <div
                    className="flex flex-wrap items-center gap-1.5"
                    role="tablist"
                    aria-label={t("hp.grammarSection")}
                    data-part="grammar-switcher"
                  >
                    {grammar.map((item, at) => {
                      const active = safeGrammarAt === at;
                      return (
                        <button
                          key={`${at}:${item.context}`}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={(event) => {
                            setGrammarAt(at);
                            setChosen(at);
                            event.currentTarget.closest("aside")?.scrollTo?.(0, 0);
                          }}
                          className={cn(
                            "min-h-8 rounded-lg px-3 text-xs font-semibold transition-colors",
                            active
                              ? "bg-accent text-accent-ink shadow-xs"
                              : "bg-sheet text-muted hover:text-ink",
                          )}
                        >
                          {t("hp.sentenceItem", { n: at + 1 })}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {grammar[safeGrammarAt] ? (
                  <GrammarNote
                    key={`${safeGrammarAt}:${grammar[safeGrammarAt].context}`}
                    note={grammar[safeGrammarAt]}
                    chosen={chosen === safeGrammarAt}
                    onChoose={() =>
                      setChosen((now) => (now === safeGrammarAt ? null : safeGrammarAt))
                    }
                  />
                ) : null}
              </section>
            ) : null}

            {showSentences ? (
              <section
                className="grid min-w-0"
                aria-label={t("hp.sentenceSection")}
                data-part="sentences"
              >
                {hasTabs ? null : <h3 className="sr-only">{t("hp.sentenceSection")}</h3>}
                {sentences.map((note, at) => (
                  <SentenceNote
                    key={`${at}:${note.context}`}
                    note={note}
                    chosen={chosen === at}
                    onChoose={() => setChosen((now) => (now === at ? null : at))}
                  />
                ))}
              </section>
            ) : null}
          </>
        )}

        <p
          className="border-t border-line pt-3 text-xs leading-snug text-muted"
          data-part="help-footer"
        >
          {showGrammar ? t("hp.footerGrammar") : t("hp.footer")}
        </p>
      </div>
      </div>
    </FloatingAside>
  );
}

/**
 * While help is open, the floating card keeps clear of the paragraph it explains (anchorBox in
 * floating-panel.ts reads `data-help-keep`). A layout effect in a child of the card, so the mark is
 * there before the card places itself on its first frame.
 */
function KeepClear({ el }: { el: Element }) {
  useLayoutEffect(() => {
    el.setAttribute("data-help-keep", "");
    return () => el.removeAttribute("data-help-keep");
  }, [el]);
  return null;
}

/**
 * Who wrote this explanation, as one quiet line under it. Only a reader's accepted contribution
 * is credited by name; an explanation that came with the word list needs no label on every block.
 */
function HelpSource({ credit }: { credit?: string }) {
  if (!credit) return null;
  return (
    <div className="min-w-0 max-w-full" data-help-source="reader">
      <CreditLine id={credit} />
    </div>
  );
}

function splitChunk(raw: string): { quote: string; note: string } {
  const match = /\s*(?:->|\u2192)\s*/.exec(raw);
  if (!match || match.index <= 0) return { quote: "", note: raw.trim() };
  const quote = raw
    .slice(0, match.index)
    .trim()
    .replace(/^['"“”‘’]+|['"“”‘’]+$/g, "")
    .trim();
  const note = raw.slice(match.index + match[0].length).trim();
  return quote && note ? { quote, note } : { quote: "", note: raw.trim() };
}

function renderPatternSlots(pattern: string) {
  return splitPatternSlots(pattern).map((part, idx) => {
    if (part.slot) {
      return (
        <span
          key={idx}
          className="mx-0.5 inline-block rounded border border-accent/25 bg-float px-1.5 py-0.5 font-sans text-[0.73rem] font-semibold leading-tight text-accent"
        >
          {part.text}
        </span>
      );
    }
    return <span key={idx}>{part.text}</span>;
  });
}

function TargetSentenceButton({
  sentence,
  chosen,
  onChoose,
  folded = false,
}: {
  sentence: string;
  chosen: boolean;
  onChoose: () => void;
  folded?: boolean;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onChoose}
      aria-pressed={chosen}
      aria-label={`${t("hp.original")}: ${sentence}`}
      className={cn(
        "min-h-9 min-w-0 max-w-full w-full overflow-hidden break-words rounded-r-lg py-1.5 pr-2.5 pl-3 text-left font-display text-[0.88rem] leading-snug italic transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        chosen
          ? "border-l-[3px] border-accent bg-mark text-ink"
          : "border-l-[3px] border-line bg-sheet/75 text-muted hover:text-ink",
      )}
      lang="en"
      data-part="sentence-context"
    >
      <span className={cn("block min-w-0 max-w-full", folded && "truncate")}>{sentence}</span>
    </button>
  );
}

/**
 * Syntactic / grammatical breakdown for one sentence inside the paragraph (Grammar tab).
 * Always displays the complete resolved sentence (`note.sentence`), its concrete plain-English
 * sentence meaning (`note.simple`), and the step-by-step clause breakdown (`note.chunks`).
 */
function GrammarNote({
  note,
  chosen,
  onChoose,
}: {
  note: SentenceInParagraph;
  chosen: boolean;
  onChoose: () => void;
}) {
  const { t } = useT();
  const [fullOriginal, setFullOriginal] = useState(false);
  const canFoldOriginal = note.sentence.length > 68;
  const hasChunks = Boolean(note.chunks && note.chunks.length > 0);
  const mirror = note.grammar ? parseGrammarMirror(note.grammar) : null;

  return (
    <div
      className="grid min-w-0 gap-3"
      data-grammar-note
      data-sentence-note
      data-chosen={chosen ? "" : undefined}
    >
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1">
            <span className="text-xs font-semibold tracking-wide text-accent">{t("hp.original")}</span>
            <ReadAloudButton owner={`sentence:${note.sentence.slice(0, 64)}`} text={note.sentence} label={t("tts.readSentence")} size="sm" />
          </span>
          {canFoldOriginal ? (
            <button
              type="button"
              onClick={() => setFullOriginal((value) => !value)}
              className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-muted hover:bg-sheet hover:text-ink"
            >
              <span>{fullOriginal ? t("hp.hideFullSentence") : t("hp.showFullSentence")}</span>
              <ChevronDown
                className={cn("size-3.5 transition-transform", fullOriginal && "rotate-180")}
                aria-hidden
              />
            </button>
          ) : null}
        </div>
        <TargetSentenceButton sentence={note.sentence} chosen={chosen} onChoose={onChoose} folded={canFoldOriginal && !fullOriginal} />
      </div>

      {mirror ? (
        mirror.isMirror ? (
          <div
            className="grid min-w-0 gap-1.5 rounded-xl border border-accent/25 bg-accent-soft/60 px-3.5 py-2.5"
            data-part="grammar"
          >
            <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-accent">
              <span aria-hidden>✦</span>
              <span>{t("hp.dailyMirror")}</span>
            </div>
            <p className="break-words font-display text-[0.94rem] leading-relaxed text-ink" lang="en">
              {mirror.scene}
            </p>
            {mirror.tip ? (
              <p
                className="break-words border-t border-accent/15 pt-1.5 text-xs leading-relaxed text-muted"
                lang="en"
              >
                {mirror.tip}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="grid min-w-0 gap-1 rounded-xl bg-sheet px-3 py-2.5" data-part="grammar">
            <span className="text-xs font-semibold tracking-wide text-accent">{t("hp.grammar")}</span>
            <p className="break-words text-sm leading-relaxed text-muted" lang="en">
              {mirror.scene}
            </p>
          </div>
        )
      ) : null}

      {note.simple ? (
        <div className="grid min-w-0 gap-1">
          <span className="text-xs font-semibold tracking-wide text-accent">{t("hp.easier")}</span>
          <p className="break-words font-display text-[0.95rem] leading-relaxed text-ink" lang="en" data-part="easier">
            {note.simple}
          </p>
        </div>
      ) : null}

      {hasChunks ? (
        <div className="grid min-w-0 gap-2">
          <span className="text-xs font-semibold tracking-wide text-accent">{t("hp.chunks")}</span>
          <ul
            className="grid gap-2"
            aria-label={t("hp.chunks")}
            data-part="sentence-chunks"
          >
            {note.chunks?.map((chunk, index) => {
              const parsed = splitChunk(chunk);
              return (
                <li
                  key={`${index}:${chunk.slice(0, 24)}`}
                  className="grid grid-cols-[1.35rem_minmax(0,1fr)] items-start gap-2.5 rounded-xl bg-sheet/80 px-3 py-2.5"
                  lang="en"
                >
                  <span
                    className="mt-0.5 flex size-5 items-center justify-center rounded-full bg-accent-soft text-[0.7rem] font-bold text-accent"
                    aria-hidden
                  >
                    {index + 1}
                  </span>
                  {parsed.quote ? (
                    <div className="grid min-w-0 gap-0.5">
                      <span className="break-words font-display text-[0.9rem] font-semibold leading-snug text-ink">
                        {parsed.quote}
                      </span>
                      <span className="break-words text-[0.84rem] leading-relaxed text-muted">
                        {parsed.note}
                      </span>
                    </div>
                  ) : (
                    <span className="break-words text-[0.85rem] leading-relaxed text-muted">{parsed.note}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {note.pattern ? (
        <div
          className="grid min-w-0 gap-1 rounded-xl border border-line/80 bg-sheet/65 px-3 py-2.5"
          data-part="sentence-pattern"
        >
          <span className="text-xs font-semibold tracking-wide text-accent">{t("hp.pattern")}</span>
          <p className="break-words text-[0.83rem] leading-relaxed text-muted" lang="en">
            {renderPatternSlots(note.pattern)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Reader-submitted or plain single-sentence help (Sentence help tab).
 */
function SentenceNote({
  note,
  chosen,
  onChoose,
}: {
  note: SentenceInParagraph;
  chosen: boolean;
  onChoose: () => void;
}) {
  const { t } = useT();
  return (
    <div
      className="grid min-w-0 gap-2.5 border-t border-line/70 py-3.5 first:border-t-0 first:pt-0 last:pb-0"
      data-sentence-note
      data-chosen={chosen ? "" : undefined}
    >
      <div className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1">
          <TargetSentenceButton sentence={note.sentence} chosen={chosen} onChoose={onChoose} />
        </div>
        <ReadAloudButton owner={`sentence:${note.sentence.slice(0, 64)}`} text={note.sentence} label={t("tts.readSentence")} size="sm" className="mt-1" />
      </div>
      <p className="break-words font-display text-[1.02rem] leading-relaxed text-ink" lang="en" data-part="easier">
        {note.simple}
      </p>
      <HelpSource credit={note.credit} />
    </div>
  );
}

type MarkBox = { note: number; top: number; left: number; width: number; height: number };

/**
 * While the panel is open, every sentence of the paragraph that has a note is marked in the page,
 * like a highlighter, and the chosen one more strongly. The marks are position: fixed boxes drawn
 * from the sentence's line boxes, under the text (pointer-events off), so nothing in the page moves
 * and a word under a mark still opens its card. A tap on a marked sentence, off a word, chooses its note.
 */
function SentenceMarks({
  paragraphEl,
  contexts,
  chosen,
  onChoose,
  onReveal,
}: {
  paragraphEl: Element;
  contexts: readonly string[];
  chosen: number | null;
  onChoose: (index: number) => void;
  /** Asked once the marks are drawn: the top of the chosen (or first) marked sentence on screen. */
  onReveal?: (top: number, bottom: number) => void;
}) {
  const [boxes, setBoxes] = useState<MarkBox[]>([]);
  const key = contexts.join("\u0001");
  const revealed = useRef("");
  useEffect(() => {
    if (!onReveal || boxes.length === 0) return;
    const note = chosen ?? boxes[0]?.note ?? 0;
    const tag = `${key}|${note}`;
    if (revealed.current === tag) return;
    revealed.current = tag;
    const mine = boxes.filter((box) => box.note === note);
    if (mine.length === 0) return;
    onReveal(Math.min(...mine.map((b) => b.top)), Math.max(...mine.map((b) => b.top + b.height)));
  }, [boxes, chosen, key, onReveal]);

  useEffect(() => {
    let frame = 0;
    const ranges = contexts.map((context) => noteSentenceRange(paragraphEl, context));
    const measure = () => {
      frame = 0;
      const next: MarkBox[] = [];
      ranges.forEach((range, note) => {
        if (!range) return;
        // A range reports one box per word button and text piece; they overlap and would stack
        // the colour. Join them into one box per line.
        const lines: MarkBox[] = [];
        for (const r of Array.from(range.getClientRects())) {
          if (r.width < 1 || r.height < 1) continue;
          const mid = r.top + r.height / 2;
          const line = lines.find((box) => mid > box.top && mid < box.top + box.height);
          if (line) {
            const right = Math.max(line.left + line.width, r.right);
            line.left = Math.min(line.left, r.left);
            line.width = right - line.left;
            const bottom = Math.max(line.top + line.height, r.bottom);
            line.top = Math.min(line.top, r.top);
            line.height = bottom - line.top;
          } else {
            lines.push({ note, top: r.top, left: r.left, width: r.width, height: r.height });
          }
        }
        for (const box of lines)
          next.push({
            note,
            top: Math.round(box.top),
            left: Math.round(box.left),
            width: Math.round(box.width),
            height: Math.round(box.height),
          });
      });
      setBoxes((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(paragraphEl);
    return () => {
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
    // `key` stands for `contexts`: a new array holding the same notes must not re-measure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paragraphEl, key]);

  // A tap in the page on a marked sentence picks its note. Capture, so it runs before the reader's
  // own tap handling closes the panel. A word under the mark still opens its card.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || !paragraphEl.contains(target) || target.closest?.("[data-word]")) return;
      const hit = boxes.find(
        (box) =>
          event.clientX >= box.left &&
          event.clientX <= box.left + box.width &&
          event.clientY >= box.top &&
          event.clientY <= box.top + box.height,
      );
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      onChoose(hit.note);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [boxes, onChoose, paragraphEl]);

  // A portal into the body: the panel is a transformed sheet, and position: fixed inside a
  // transformed parent is placed against that parent, which drew the marks over the panel.
  return createPortal(
    <>
      {boxes.map((box, at) => (
        <div
          key={at}
          aria-hidden
          data-para-ui
          data-sentence-mark={box.note}
          data-chosen={chosen === box.note ? "" : undefined}
          className={cn(
            "pointer-events-none fixed z-[1] rounded-[3px]",
            chosen === box.note ? "bg-mark-active" : "bg-mark",
          )}
          style={{ top: box.top, left: box.left - 1, width: box.width + 2, height: box.height }}
        />
      ))}
    </>,
    document.body,
  );
}
