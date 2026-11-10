import { useEffect, useRef, useState } from "react";
import { useAccount } from "@/lib/account-store";
import { accountRequest } from "@/lib/sync-engine";
import type { StandardSense, WordSensePanelProps } from "@/components/word-sense-panel";

export type ChoiceTarget = {
  bookId: string;
  catalogId?: string;
  chapter: number;
  chapters: number;
  paragraph: number;
  occurrence: number;
  word: string;
  sentence: string;
  context?: string;
  glossaryRev?: string;
};

type State = { scope: string; selectedId: string | null; acknowledged?: boolean; pending: boolean; error?: "failed" };
const acknowledged = new Map<string, string | null>();
let cacheAccount: string | null = null;

/** Opening a card sends no position data or API request. Only explicit thumbs trigger transport. */
export function useDictionaryChoices(target: ChoiceTarget | null, senses: StandardSense[]) {
  const phase = useAccount(s => s.phase);
  const emailVerified = useAccount(s => s.emailVerified);
  const account = useAccount(s => s.email);
  const [state, setState] = useState<State | null>(null);
  const targetKey = target ? JSON.stringify(target) : "";
  const scope = `${account ?? ""}/${phase}/${emailVerified}/${targetKey}`;
  const active = useRef({ scope, generation: 0 });
  if (active.current.scope !== scope) active.current = { scope, generation: active.current.generation + 1 };
  const busy = useRef<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current.generation += 1; }; }, []);
  const available = !!target && !!target.sentence.trim() && target.chapters > 0 && target.chapter >= 0 && target.chapter < target.chapters && senses.length > 0 && senses.every(s => !!s.source);
  useEffect(() => {
    const owner = phase === "in" ? account : null;
    if (cacheAccount !== owner) { acknowledged.clear(); cacheAccount = owner; }
  }, [phase, account]);
  const current = state?.scope === scope ? state : null;
  const cached = phase === "in" && cacheAccount === account && acknowledged.has(scope);
  const selectedId = current ? current.selectedId : cached ? acknowledged.get(scope)! : null;
  const eligibility: WordSensePanelProps["vote"]["eligibility"] = !available ? "unavailable" : phase === "unknown" ? "loading" : phase !== "in" ? "guest" : !emailVerified ? "unverified" : "verified";
  async function choose(id: string | null) {
    const generation = active.current.generation;
    if (eligibility !== "verified" || busy.current === generation || !target) return;
    const candidate = id === null ? null : senses.find(s => s.id === id);
    if (id !== null && !candidate?.source) return;
    busy.current = generation;
    const before = selectedId;
    setState({ scope, selectedId: before, pending: true });
    try {
      // Read only AFTER an explicit click, so revisiting a book never uploads word-opening evidence.
      const saved = await accountRequest("/api/dictionary/choices", { action: "get", target });
      if (saved.ok !== true || !(saved.selectedId === null || typeof saved.selectedId === "string")) throw new Error("invalid-choice-state");
      if (!mounted.current || active.current.generation !== generation) return;
      const nextId = candidate && saved.selectedId !== candidate.id ? candidate.id : null;
      const reply = await accountRequest("/api/dictionary/choices", {
        action: "set", target,
        choice: nextId && candidate ? { id: candidate.id, lemma: candidate.source!.lemma, release: candidate.source!.release } : null,
      });
      if (reply.ok !== true || reply.selectedId !== nextId) throw new Error("unacknowledged-choice");
      if (!mounted.current || active.current.generation !== generation) return;
      acknowledged.set(scope, nextId);
      if (acknowledged.size > 128) acknowledged.delete(acknowledged.keys().next().value!);
      setState({ scope, selectedId: nextId, pending: false, acknowledged: true });
    } catch {
      if (mounted.current && active.current.generation === generation) setState({ scope, selectedId: before, pending: false, error: "failed" });
    } finally {
      if (busy.current === generation) busy.current = null;
    }
  }
  return {
    vote: { eligibility, selectedId, pending: current?.pending ?? false, acknowledged: current?.acknowledged ?? cached, error: current?.error },
    onVote: (id: string | null) => { void choose(id); },
  };
}
