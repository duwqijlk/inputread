import { paragraphBlocks } from "./help-match.ts";

/**
 * The reader's rendered blocks, excluding headings the reader adds only to give an old
 * paragraphs-only book a title. Those headings are visual decoration, not word-list
 * paragraphs, so they must not shift a saved paragraph index.
 */
export function readerParagraphBlocks(root: ParentNode): Element[] {
  // The stored array already defines the indexes; do not filter out short/empty strings again.
  if (root instanceof Element && root.hasAttribute("data-reader-paragraphs"))
    return Array.from(root.querySelectorAll("p"));
  return paragraphBlocks(root);
}
