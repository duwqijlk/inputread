/**
 * Paragraph and sentence help. Everything is written ahead of time and comes from the book's
 * own word list (its book pack, or a list the user added). Nothing is made up while reading:
 * when the list has no note for a paragraph or sentence, the result is null and the screen
 * shows a friendly message.
 */
import { getParagraphHelp, getSentenceHelp, getSentenceNotesIn } from "@/lib/help-lookup";
import { findNoteSentence } from "@/lib/note-sentence";
import { cleanNoteText, cleanParagraphNote, type ParagraphNote } from "@/lib/paragraph-note";

export type ParagraphView = ParagraphNote;

export type SentenceView = {
  simple: string;
  grammar: string;
  core?: string;
  chunks?: string[];
  pattern?: string;
  /** Public id of the reader whose explanation this note uses. */
  credit?: string;
};

/**
 * One sentence-anchored item inside the paragraph panel:
 * - `context`: short verbatim locator snippet stored in the glossary;
 * - `sentence`: full sentence resolved from the paragraph text so the header matches the exact scope.
 */
export type SentenceInParagraph = SentenceView & {
  context: string;
  sentence: string;
};

/**
 * Three distinct reading-help boundaries opened by a paragraph's ✦ mark:
 * 1. `paragraph`: paragraph-level meaning (`mainIdea` + `simple`);
 * 2. `grammar`: editorial syntactic/grammar breakdown inside this paragraph;
 * 3. `sentences`: reader-contributed or plain single-sentence explanations.
 */
export type ParagraphHelpView = {
  paragraph: ParagraphView | null;
  grammar: SentenceInParagraph[];
  sentences: SentenceInParagraph[];
};

export function isGrammarBreakdown(view: SentenceView): boolean {
  return !view.credit && Boolean(view.chunks?.length || view.pattern || view.grammar || view.core);
}

export function resolveFullSentence(paragraphText: string, context: string): string {
  if (!paragraphText.trim()) return context;
  const span = findNoteSentence(paragraphText, context);
  if (!span) return context;
  const full = paragraphText.slice(span.start, span.end).replace(/\u00AD/g, "").replace(/\s+/g, " ").trim();
  return full || context;
}

const clean = cleanNoteText;

function asSentence(value: unknown): SentenceView | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const simple = clean(row.simple, 800);
  // The easier sentence is the note; the grammar and structure fields are extra help and may be absent.
  if (!simple) return null;
  const grammar = clean(row.grammar, 400);
  const core = clean(row.core, 240);
  const chunks = Array.isArray(row.chunks)
    ? row.chunks
        .map((item) => clean(item, 320))
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const pattern = clean(row.pattern, 280);
  const credit = typeof row.credit === "string" && /^[a-z0-9]{12}$/.test(row.credit) ? row.credit : undefined;
  return {
    simple,
    grammar,
    ...(core ? { core } : {}),
    ...(chunks.length ? { chunks } : {}),
    ...(pattern ? { pattern } : {}),
    ...(credit ? { credit } : {}),
  };
}

export async function loadParagraphView(args: {
  bookId: string;
  chapter: number | string;
  paragraph: number;
  /** the text of every paragraph of the chapter, in paragraph order */
  texts: readonly string[];
}): Promise<ParagraphView | null> {
  try {
    return cleanParagraphNote(
      await getParagraphHelp(args.bookId, args.chapter, args.paragraph, args.texts),
    );
  } catch {
    return null;
  }
}

export async function loadSentenceView(args: {
  bookId: string;
  chapter: number | string;
  text: string;
}): Promise<SentenceView | null> {
  try {
    return asSentence(await getSentenceHelp(args.bookId, args.chapter, args.text));
  } catch {
    return null;
  }
}

/** Everything the bulb of paragraph `paragraph` opens, or null when it has no help at all. */
export async function loadParagraphHelpView(args: {
  bookId: string;
  chapter: number | string;
  paragraph: number;
  texts: readonly string[];
}): Promise<ParagraphHelpView | null> {
  const paragraphText = args.texts[args.paragraph] ?? "";
  const [paragraph, notes] = await Promise.all([
    loadParagraphView(args),
    getSentenceNotesIn(args.bookId, args.chapter, paragraphText, args.paragraph, args.texts).catch(() => []),
  ]);
  const grammar: SentenceInParagraph[] = [];
  const sentences: SentenceInParagraph[] = [];
  for (const note of notes) {
    const view = asSentence(note);
    const context = clean(note.context, 300);
    if (!view || !context) continue;
    const item: SentenceInParagraph = {
      ...view,
      context,
      sentence: resolveFullSentence(paragraphText, context),
    };
    if (isGrammarBreakdown(view)) grammar.push(item);
    else sentences.push(item);
  }
  return paragraph || grammar.length || sentences.length ? { paragraph, grammar, sentences } : null;
}
