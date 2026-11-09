import { useEffect, useRef, useState } from "react";
import { WordCard, type CardState } from "@/components/word-card";
import { WordSensePanel, type WordSensePanelProps } from "@/components/word-sense-panel";
import { btn, cn, field, selectCls } from "@/components/ui";
import { useLocale, useT } from "@/lib/i18n";
import { ZH_NAME } from "@/lib/i18n-zh";
import {
  beginDemoVote,
  cancelDemoRequest,
  completeDemoVote,
  demoResolution,
  initialDemoState,
  type DemoOutcome,
  type DemoPosition,
  type DemoScenario,
} from "./word-senses-model";

/** DEV-only host. No account, feedback, storage or vote transport is mounted. */
export function WordSensesDemo() {
  const { t, locale } = useT();
  const [scenario, setScenario] = useState<DemoScenario>("unmapped");
  const [position, setPosition] = useState<DemoPosition>("river");
  const [eligibility, setEligibility] =
    useState<WordSensePanelProps["vote"]["eligibility"]>("verified");
  const [outcome, setOutcome] = useState<DemoOutcome>("success");
  const [model, setModel] = useState(initialDemoState);
  const [open, setOpen] = useState(true);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [theme, setTheme] = useState("light");
  const [selection, setSelection] = useState(1);
  const [saveChooser, setSaveChooser] = useState(false);
  const [saved, setSaved] = useState(false);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const state = useRef(model);
  state.current = model;
  useEffect(() => {
    const old = document.documentElement.getAttribute("data-theme");
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (old) document.documentElement.setAttribute("data-theme", old);
      else document.documentElement.removeAttribute("data-theme");
    };
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  function changeScope(nextPosition: DemoPosition, nextScenario = scenario) {
    if (timer.current) clearTimeout(timer.current);
    setModel((current) => nextScenario === scenario ? cancelDemoRequest(current) : initialDemoState());
    setPosition(nextPosition);
    setScenario(nextScenario);
    setSelection((value) => value + 1);
    setSaved(false);
    setSaveChooser(false);
    setWriting(false);
    setDraft("");
    setNotice("");
  }
  const resolution = demoResolution(scenario, position, model);
  const community =
    scenario === "candidatesOnly" ||
    scenario === "standardOnly" ||
    scenario === "loading" ||
    scenario === "error" ||
    scenario === "missing"
      ? undefined
      : {
          kind: "community" as const,
          meaning:
            position === "river"
              ? "Here, bank means the ground beside the river, where someone can sit."
              : "Here, bank is the place where the person keeps their savings.",
          ...(scenario !== "communityOnly" ? { author: "Demo reader" } : {}),
        };
  const sentence =
    position === "river"
      ? "We sat on the bank and watched the river flow."
      : "She went to the bank to pay in some money.";
  const card: CardState = {
    surface: "bank",
    key: "bank",
    pos: "noun",
    meaning: scenario === "readerCommunity" ? community?.meaning ?? "" : "",
    whyHard: "",
    sentence,
    ready: true,
    status: scenario === "readerCommunity" ? "ready" : "unknown",
  };
  function vote(id: string | null) {
    if (eligibility !== "verified" || resolution.kind !== "unmapped") return;
    const next = beginDemoVote(state.current, position, id);
    if (next === state.current) return;
    state.current = next;
    setModel(next);
    const ticket = next.pending!.ticket;
    timer.current = setTimeout(
      () => setModel((current) => completeDemoVote(current, ticket, outcome)),
      650,
    );
  }
  function saveMeaning() {
    setSaved(true);
    setSaveChooser(false);
    setNotice(t("demo.wordSenses.localSaved"));
  }
  function toggleSave() {
    if (saved) {
      setSaved(false);
      setNotice("");
      return;
    }
    if (resolution.kind === "unmapped" && resolution.senses.length > 1)
      setSaveChooser((value) => !value);
    else saveMeaning();
  }
  const panel = (
    <div className="grid gap-3" data-demo-meaning-body>
      <WordSensePanel
        key={`${position}:${scenario}`}
        resolution={resolution}
        community={community}
        vote={{
          eligibility,
          selectedId: model.places[position].selected,
          pending: Boolean(model.pending),
          acknowledged: model.places[position].acknowledged,
          error: model.error,
        }}
        onVote={vote}
        onWrite={() => {
          setWriting((value) => !value);
          setSaveChooser(false);
        }}
        onRetry={() => changeScope(position, "unmapped")}
        onReport={() => setNotice(t("demo.wordSenses.reported"))}
        onNoMatch={() => {
          setWriting(false);
          setSaveChooser(false);
          setNotice(t("demo.wordSenses.noMatch"));
        }}
        onStandardWrong={() => {
          setWriting(false);
          setNotice(t("demo.wordSenses.standardWrong"));
        }}
        communityEditor={writing ? (
          <div className="mt-3 grid gap-2 border-t border-line pt-3" data-demo-write>
            <label className="grid gap-2 text-sm font-bold">
              {t("demo.wordSenses.write")}
              <textarea
                className={cn(field, "min-h-24 resize-y font-display font-normal")}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={600}
              />
            </label>
            <p className="text-xs text-muted">{t("demo.wordSenses.writeHint")}</p>
            <button
              type="button"
              className={btn.quiet}
              disabled={!draft.trim()}
              onClick={() => {
                setNotice(t("demo.wordSenses.submitNotice"));
                setDraft("");
                setWriting(false);
              }}
            >
              {t("demo.wordSenses.submit")}
            </button>
          </div>
        ) : null}
      />
      {saveChooser && resolution.kind === "unmapped" ? (
        <div className="grid gap-2 border-t border-line pt-3" data-demo-save-chooser>
          <p className="text-xs text-muted">{t("demo.wordSenses.pickSave")}</p>
          {resolution.senses.map((sense) => (
            <button
              key={sense.id}
              type="button"
              className="min-h-11 text-left font-display text-sm text-ink hover:text-accent"
              aria-label={t("demo.wordSenses.saveMeaning", { meaning: sense.meaning })}
              onClick={saveMeaning}
            >
              {sense.meaning}
            </button>
          ))}
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-muted" data-demo-notice>
          {notice}
        </p>
      ) : null}
    </div>
  );
  return (
    <main className="mx-auto min-h-dvh max-w-5xl px-4 py-6 text-ink sm:px-6" data-word-senses-demo>
      <h1 className="text-xl font-bold tracking-[-0.02em]">{t("demo.wordSenses.title")}</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted" role="note">
        {t("demo.wordSenses.notice")}
      </p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="grid gap-1 text-sm">
          {t("demo.wordSenses.scenario")}
          <select
            className={selectCls}
            value={scenario}
            onChange={(event) => changeScope(position, event.target.value as DemoScenario)}
            data-demo-scenario
          >
            {(
              [
                "unmapped",
                "candidatesOnly",
                "mapped",
                "standardOnly",
                "communityOnly",
                "readerCommunity",
                "missing",
                "loading",
                "error",
                "long",
              ] as const
            ).map((value) => (
              <option key={value} value={value}>
                {t(`demo.wordSenses.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {t("demo.wordSenses.position")}
          <select
            className={selectCls}
            value={position}
            onChange={(event) => changeScope(event.target.value as DemoPosition)}
            data-demo-position
          >
            {(["river", "money"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`demo.wordSenses.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {t("demo.wordSenses.account")}
          <select
            className={selectCls}
            value={eligibility}
            onChange={(event) => {
              setEligibility(event.target.value as typeof eligibility);
              setModel((current) => cancelDemoRequest(current));
            }}
            data-demo-auth
          >
            {(["verified", "guest", "unverified", "loading"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`demo.wordSenses.${value === "loading" ? "authLoading" : value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {t("demo.wordSenses.outcome")}
          <select
            className={selectCls}
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as DemoOutcome)}
            data-demo-outcome
          >
            {(["success", "failed", "fixed"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`demo.wordSenses.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {t("demo.wordSenses.language")}
          <select
            className={selectCls}
            value={locale}
            onChange={(event) => useLocale.setState({ locale: event.target.value as "en" | "zh" })}
            data-demo-language
          >
            <option value="en">English</option>
            <option value="zh">{ZH_NAME}</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {t("demo.wordSenses.theme")}
          <select
            className={selectCls}
            value={theme}
            onChange={(event) => setTheme(event.target.value)}
            data-demo-theme
          >
            {["light", "sepia", "dark", "eink"].map((value) => (
              <option key={value} value={value}>
                {t(`rs.theme.${value}` as Parameters<typeof t>[0])}
              </option>
            ))}
          </select>
        </label>
      </div>
      <article className="mt-10 max-w-xl rounded-xl border border-line p-5" data-demo-reading>
        <p className="font-display text-xl leading-relaxed">
          {position === "river" ? "We sat on the " : "She went to the "}
          <button
            ref={setAnchor}
            className="rounded-sm bg-mark px-0.5 font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => {
              setOpen(true);
              setSelection((value) => value + 1);
            }}
            data-demo-token
          >
            bank
          </button>
          {position === "river" ? " and watched the river flow." : " to pay in some money."}
        </p>
        <p className="mt-3 text-sm text-muted">{t("demo.wordSenses.prompt")}</p>
      </article>
      <button
        type="button"
        className={cn(btn.quiet, "mt-4")}
        onClick={() => {
          setModel(initialDemoState());
          changeScope(position, "unmapped");
          setOpen(true);
        }}
      >
        {t("demo.wordSenses.reset")}
      </button>
      {open && anchor ? (
        <WordCard
          state={card}
          saved={saved}
          canSave={
            resolution.kind === "mapped" ||
            (resolution.kind === "unmapped" && resolution.senses.length > 0) ||
            Boolean(community)
          }
          phrase={null}
          targetMode="word"
          phrasePending={false}
          onTargetChange={() => {}}
          selectionId={selection}
          bookId="demo-only-book"
          chapter={0}
          noList={false}
          anchor={anchor}
          onClose={() => {
            setOpen(false);
            anchor.focus();
          }}
          onToggle={toggleSave}
          meaningContent={scenario === "readerCommunity" ? undefined : panel}
          compactLookups
        />
      ) : null}
    </main>
  );
}
