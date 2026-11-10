/** Legacy module path retained for the pure context helper; passive word collection is retired. */

/** Nearby verbatim context is evidence for explicit feedback, never canonical coordinate validation. */
export function extractAnchorContext(
  paragraph: string,
  surface: string,
  beforeOffset: number,
): string {
  if (!paragraph || !surface || beforeOffset < 0) return surface;
  const beforeText = paragraph.slice(0, beforeOffset);
  const afterText = paragraph.slice(beforeOffset + surface.length);
  const beforeMatch = beforeText.match(/(?:[^\s]+\s+){0,4}$/);
  const startIdx = beforeMatch ? beforeOffset - beforeMatch[0].length : 0;
  const afterMatch = afterText.match(/^(?:\s*[^\s]+){0,4}/);
  const endIdx = afterMatch ? beforeOffset + surface.length + afterMatch[0].length : beforeOffset + surface.length;
  return paragraph.slice(startIdx, endIdx).trim().slice(0, 300);
}
