/**
 * Pure parsers for turning `SentenceNote.grammar` and `SentenceNote.pattern` strings into
 * structured UI blocks inside the Grammar tab (`help-panels.tsx`).
 */

export interface GrammarMirrorView {
  isMirror: boolean;
  scene: string;
  tip: string;
}

export function parseGrammarMirror(raw: string): GrammarMirrorView {
  const trimmed = raw.trim();
  const prefix = /^(?:Same shape in daily life|Everyday mirror|Real-life mirror)\s*:\s*/i.exec(
    trimmed,
  );
  if (!prefix) return { isMirror: false, scene: trimmed, tip: "" };
  const body = trimmed.slice(prefix[0].length).trim();
  const dashSplit = /\s+(?:\u2014|--)\s+/.exec(body);
  let scene = dashSplit ? body.slice(0, dashSplit.index).trim() : body;
  let tip = dashSplit ? body.slice(dashSplit.index + dashSplit[0].length).trim() : "";
  if (!tip) {
    const paren = /^(['"“‘][\s\S]+?['"”’])\s*\(([^()]+)\)\.?$/.exec(scene);
    if (paren) {
      scene = paren[1].trim();
      tip = paren[2].trim();
    }
  }
  if (
    (scene.startsWith("'") && scene.endsWith("'")) ||
    (scene.startsWith("\u2018") && scene.endsWith("\u2019"))
  ) {
    scene = scene.slice(1, -1).trim();
  }
  return { isMirror: true, scene, tip };
}

export interface PatternSegment {
  slot: boolean;
  text: string;
}

export function splitPatternSlots(pattern: string): PatternSegment[] {
  return pattern
    .split(/(\[[^\]]+\])/g)
    .filter((part) => part.length > 0)
    .map((part) => {
      if (part.startsWith("[") && part.endsWith("]") && part.length > 2) {
        return { slot: true, text: part.slice(1, -1) };
      }
      return { slot: false, text: part };
    });
}
