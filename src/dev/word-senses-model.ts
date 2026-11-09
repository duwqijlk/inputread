import type { StandardSense, SenseResolution } from "@/components/word-sense-panel";

/** In-memory preview fixtures, never dictionary IDs or book-coordinate data. */
export const DEMO_SENSES: StandardSense[] = [
  {
    id: "demo-only-bank-money",
    pos: "noun",
    meaning: "A business that keeps money safe and lends money.",
    votes: 3,
  },
  {
    id: "demo-only-bank-river",
    pos: "noun",
    meaning: "The land along the side of a river.",
    votes: 8,
  },
  {
    id: "demo-only-bank-store",
    pos: "noun",
    meaning: "A store of something kept for future use.",
    votes: 1,
  },
  {
    id: "demo-only-bank-turn",
    pos: "verb",
    meaning: "To turn by leaning to one side, as a plane does.",
    votes: 0,
  },
];
export const DEMO_LONG_SENSES: StandardSense[] = [
  ...DEMO_SENSES,
  ...DEMO_SENSES.map((sense) => ({
    ...sense,
    id: `${sense.id}-extended`,
    meaning: `${sense.meaning} This longer example checks wrapping in the word card without changing its reading layout.`,
  })),
];
export type DemoPosition = "river" | "money";
export type DemoScenario =
  "unmapped" | "candidatesOnly" | "mapped" | "standardOnly" | "communityOnly" | "readerCommunity" | "missing" | "loading" | "error" | "long";
export type DemoOutcome = "success" | "failed" | "fixed";
export type DemoPlace = {
  selected: string | null;
  acknowledged: boolean;
  counts: Record<string, number>;
  fixed: boolean;
  revision: number;
};
export type DemoState = {
  places: Record<DemoPosition, DemoPlace>;
  pending: { position: DemoPosition; id: string | null; revision: number; ticket: number } | null;
  error: "failed" | "fixed" | undefined;
  ticket: number;
};
const place = (): DemoPlace => ({
  selected: null,
  acknowledged: false,
  counts: Object.fromEntries(DEMO_LONG_SENSES.map((sense) => [sense.id, sense.votes ?? 0])),
  fixed: false,
  revision: 0,
});
export const initialDemoState = (): DemoState => ({
  places: { river: place(), money: place() },
  pending: null,
  error: undefined,
  ticket: 0,
});
export const fixedDemoSense = (position: DemoPosition) => DEMO_SENSES[position === "river" ? 1 : 0];
export function beginDemoVote(
  state: DemoState,
  position: DemoPosition,
  id: string | null,
): DemoState {
  if (
    state.pending ||
    state.places[position].fixed ||
    (id !== null && !DEMO_LONG_SENSES.some((sense) => sense.id === id))
  )
    return state;
  return {
    ...state,
    error: undefined,
    ticket: state.ticket + 1,
    pending: { position, id, revision: state.places[position].revision, ticket: state.ticket + 1 },
  };
}
export function cancelDemoRequest(state: DemoState): DemoState {
  return { ...state, pending: null, error: undefined, ticket: state.ticket + 1 };
}
export function completeDemoVote(
  state: DemoState,
  ticket: number,
  outcome: DemoOutcome,
): DemoState {
  const pending = state.pending;
  if (
    !pending ||
    pending.ticket !== ticket ||
    state.places[pending.position].revision !== pending.revision
  )
    return state;
  if (outcome === "failed") return { ...state, pending: null, error: "failed" };
  const old = state.places[pending.position];
  if (outcome === "fixed")
    return {
      ...state,
      pending: null,
      error: "fixed",
      places: {
        ...state.places,
        [pending.position]: { ...old, fixed: true, revision: old.revision + 1 },
      },
    };
  const counts = { ...old.counts };
  if (old.selected) counts[old.selected] = Math.max(0, counts[old.selected] - 1);
  if (pending.id) counts[pending.id] = (counts[pending.id] ?? 0) + 1;
  return {
    ...state,
    pending: null,
    error: undefined,
    places: { ...state.places, [pending.position]: { ...old, selected: pending.id, acknowledged: true, counts } },
  };
}
export function demoResolution(
  scenario: DemoScenario,
  position: DemoPosition,
  state: DemoState,
): SenseResolution {
  if (state.places[position].fixed || scenario === "mapped" || scenario === "standardOnly")
    return { kind: "mapped", sense: fixedDemoSense(position) };
  if (scenario === "loading" || scenario === "error" || scenario === "missing")
    return { kind: scenario };
  const senses = (scenario === "long" ? DEMO_LONG_SENSES : DEMO_SENSES).map((sense) => ({
    ...sense,
    votes: state.places[position].counts[sense.id],
  }));
  return { kind: "unmapped", senses };
}
