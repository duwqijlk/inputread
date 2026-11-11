import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { HelpCircle, ThumbsUp } from "lucide-react";
import { cn, subTabs } from "@/components/ui";
import { useT } from "@/lib/i18n";

export type StandardSense = { id: string; pos: string; meaning: string; votes?: number; source?: { lemma: string; release: string } };
export type SenseResolution =
  | { kind: "unmapped"; senses: StandardSense[] }
  | { kind: "mapped"; sense: StandardSense }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "missing" };
export type CommunityExplanation = {
  kind: "community";
  meaning: string;
  pos?: string;
  author?: string;
};
export type WordSensePanelProps = {
  resolution: SenseResolution;
  community?: CommunityExplanation;
  /** Existing book-list feedback/credit renderer, when a real community explanation exists. */
  communityContent?: ReactNode;
  communityEditor?: ReactNode;
  /** Render a resolved public contributor credit, never a raw public id or email. */
  communityCredit?: ReactNode;
  /** Independent credit for the accepted context match, never the community explanation's author. */
  standardCredit?: ReactNode;
  vote: {
    eligibility: "verified" | "guest" | "unverified" | "loading" | "unavailable";
    selectedId: string | null;
    pending: boolean;
    acknowledged?: boolean;
    error?: "failed" | "fixed";
  };
  onVote: (id: string | null) => void;
  onWrite: () => void;
  onRetry?: () => void;
  onReport?: (reason: "too_hard" | "wrong_meaning") => void;
  onNoMatch?: () => void;
  onStandardWrong?: () => void;
};
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const label = "font-sans text-sm leading-5 text-muted";

/** Frontend-only presentation contract. A future resolver supplies the position data and actions. */
export function WordSensePanel({
  resolution,
  community,
  communityContent,
  communityEditor,
  communityCredit,
  standardCredit,
  vote,
  onVote,
  onWrite,
  onRetry,
  onReport,
  onNoMatch,
  onStandardWrong,
}: WordSensePanelProps) {
  const { t } = useT();
  const id = useId();
  const [selectedTab, setSelectedTab] = useState<"recommended" | "dictionary">("recommended");
  const [feedback, setFeedback] = useState(false);
  const explanation = community?.meaning.trim() ? community : undefined;
  const mapped = resolution.kind === "mapped";
  const senses = mapped
    ? [resolution.sense]
    : resolution.kind === "unmapped"
      ? resolution.senses
      : [];
  const unresolved = resolution.kind === "unmapped" && senses.length > 0;
  const hasCommunityContent = Boolean(communityContent);
  const recommended = Boolean(explanation) || hasCommunityContent || mapped;
  const tabs = (Boolean(explanation) || hasCommunityContent) && unresolved;
  const active = tabs ? selectedTab : recommended ? "recommended" : "dictionary";
  const canVote = vote.eligibility === "verified" && !vote.pending && vote.error !== "fixed";
  const compactCandidates = unresolved && !explanation;
  const reason = !unresolved
    ? undefined
    : vote.eligibility === "guest"
      ? t("card.senses.guest")
      : vote.eligibility === "unverified"
        ? t("card.senses.unverified")
        : vote.eligibility === "loading"
          ? t("card.senses.authLoading")
          : vote.eligibility === "unavailable"
            ? t("card.senses.voteUnavailable")
            : undefined;
  function choose(senseId: string) {
    if (!unresolved || !canVote || !senses.some((sense) => sense.id === senseId)) return;
    onVote(vote.selectedId === senseId ? null : senseId);
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, tab: "recommended" | "dictionary") {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "recommended"
        : event.key === "End"
          ? "dictionary"
          : tab === "recommended"
            ? "dictionary"
            : "recommended";
    setSelectedTab(next);
    document.getElementById(`${id}-${next}-tab`)?.focus();
  }
  const noMatchButton = onNoMatch ? (
    <button
      type="button"
      className={cn("min-h-11 text-left font-sans text-sm text-accent", focus)}
      onClick={onNoMatch}
      data-sense-no-match
    >
      {t("card.senses.noMatch")}
    </button>
  ) : null;
  const writeButton = (
    <button
      type="button"
      onClick={onWrite}
      className={cn("min-h-11 font-sans text-sm font-bold text-accent", focus)}
    >
      {t("card.feedbackAddMeaning")}
    </button>
  );
  return (
    <div data-word-sense-panel className="min-w-0 text-ink">
      {tabs ? (
        <div className={cn(subTabs.row, "mb-4")} role="tablist" aria-label={t("card.senses.views")}>
          {(["recommended", "dictionary"] as const).map((tab) => (
            <button
              key={tab}
              id={`${id}-${tab}-tab`}
              type="button"
              role="tab"
              aria-selected={active === tab}
              aria-controls={`${id}-${tab}-panel`}
              tabIndex={active === tab ? 0 : -1}
              className={cn(subTabs.tab, active === tab ? subTabs.on : subTabs.off)}
              onClick={() => setSelectedTab(tab)}
              onKeyDown={(event) => tabKey(event, tab)}
              data-sense-tab={tab}
            >
              {t(tab === "recommended" ? "card.senses.recommended" : "card.senses.dictionary")}
            </button>
          ))}
        </div>
      ) : null}
      {recommended ? (
        <div
          id={`${id}-recommended-panel`}
          role={tabs ? "tabpanel" : undefined}
          aria-labelledby={tabs ? `${id}-recommended-tab` : undefined}
          hidden={active !== "recommended"}
          data-recommended-meanings
        >
          {explanation || communityContent ? (
            <section data-community-explanation aria-labelledby={`${id}-community`}>
              <div id={`${id}-community`} className={label}>
                {t("card.senses.community")}
              </div>
              {explanation ? communityContent ?? (
                <>
                  {explanation.pos ? (
                    <p className="dictionary-pos mt-2 text-sm" data-pos={explanation.pos.toLowerCase()} lang="en">
                      {explanation.pos}
                    </p>
                  ) : null}
                  <p className="mt-2 break-words font-display text-xl leading-relaxed">
                    {explanation.meaning}
                    <button
                      type="button"
                      className={cn(
                        "relative ml-1 -my-1.5 inline-grid size-6 place-items-center rounded align-[-3px] text-faint after:absolute after:-inset-2 after:content-[''] hover:bg-sheet hover:text-ink",
                        focus,
                      )}
                      aria-label={t("card.feedbackPrompt")}
                      aria-expanded={feedback}
                      aria-controls={feedback ? `${id}-feedback` : undefined}
                      onClick={() => setFeedback((value) => !value)}
                      data-community-feedback
                    >
                      <HelpCircle className="size-4" aria-hidden />
                    </button>
                  </p>
                  {communityCredit ??
                    (explanation.author ? (
                      <p className={cn(label, "mt-1 break-words")}>
                        {t("card.senses.from", { name: explanation.author })}
                      </p>
                    ) : null)}
                  {feedback ? (
                    <div
                      id={`${id}-feedback`}
                      className="mt-3 rounded-xl bg-sheet p-3"
                      data-community-feedback-options
                    >
                      <p className="text-xs font-bold text-muted">{t("card.feedbackQuestion")}</p>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                        {onReport ? (
                          <>
                            <button
                              type="button"
                              className={cn("min-h-11 text-sm text-ink", focus)}
                              onClick={() => onReport("too_hard")}
                            >
                              {t("card.feedbackTooHard")}
                            </button>
                            <button
                              type="button"
                              className={cn("min-h-11 text-sm text-ink", focus)}
                              onClick={() => onReport("wrong_meaning")}
                            >
                              {t("card.feedbackWrong")}
                            </button>
                          </>
                        ) : null}
                        {writeButton}
                      </div>
                    </div>
                  ) : null}
                  {communityEditor}
                </>
              ) : communityContent}
            </section>
          ) : null}
          {mapped ? (
            <section
              className={explanation ? "mt-4 border-t border-line pt-4" : ""}
              aria-labelledby={`${id}-standard`}
              data-fixed-standard
            >
              <div id={`${id}-standard`} className={label}>
                {t("card.senses.standard")}
              </div>
              <div data-standard-senses>
                <div data-sense-id={resolution.sense.id} className="pt-2">
                  {resolution.sense.pos ? (
                    <p className="dictionary-pos mb-1 text-xs" data-pos={resolution.sense.pos.toLowerCase()}>{resolution.sense.pos}</p>
                  ) : null}
                  <p className="break-words font-display text-xl leading-relaxed">
                    {resolution.sense.meaning}
                  </p>
                </div>
              </div>
              {standardCredit ? <div className="mt-2" data-standard-match-credit>{standardCredit}</div> : null}
              {onStandardWrong ? (
                <button
                  type="button"
                  className={cn("min-h-11 text-left font-sans text-sm text-muted", focus)}
                  onClick={onStandardWrong}
                  data-standard-wrong
                >
                  {t("card.senses.standardWrong")}
                </button>
              ) : null}
              {!explanation ? (
                <section className="mt-2 border-t border-line pt-2" data-community-invitation>
                  {!communityEditor ? (
                    <>
                      <p className={label}>{t("card.senses.communityInvite")}</p>
                      <button
                        type="button"
                        onClick={onWrite}
                        className={cn(
                          "min-h-11 text-left font-sans text-sm font-bold text-accent",
                          focus,
                        )}
                        data-write-community
                      >
                        {t("card.senses.writeCommunity")}
                      </button>
                    </>
                  ) : null}
                  {communityEditor}
                </section>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
      {!mapped ? (
        <div
          id={`${id}-dictionary-panel`}
          role={tabs ? "tabpanel" : undefined}
          aria-labelledby={tabs ? `${id}-dictionary-tab` : undefined}
          hidden={active !== "dictionary"}
          data-dictionary-meanings
        >
          <div className={label}>
            {t(unresolved ? "card.senses.candidates" : "card.senses.standard")}
          </div>
          {senses.length > 0 ? (
            <ul
              data-standard-senses
              className={cn(
                "m-0 list-none divide-y divide-line p-0",
                compactCandidates && "text-[0.9375rem]",
              )}
              aria-busy={vote.pending}
            >
              {senses.map((sense) => (
                <li
                  key={sense.id}
                  data-sense-id={sense.id}
                  className={cn(
                    "flex items-start",
                    compactCandidates ? "gap-1.5 py-1" : "gap-3 py-3",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    {sense.pos ? (
                      <div
                        className={cn(
                          "dictionary-pos text-xs leading-4",
                          compactCandidates ? "mb-0" : "mb-1",
                        )}
                        data-pos={sense.pos.toLowerCase()}
                      >
                        {sense.pos}
                      </div>
                    ) : null}
                    <p
                      className={cn(
                        "break-words font-display leading-snug",
                        compactCandidates ? "text-[0.9375rem]" : "text-lg leading-relaxed",
                      )}
                    >
                      {sense.meaning}
                    </p>
                  </div>
                  <button
                    type="button"
                    data-sense-vote={sense.id}
                    aria-label={t(
                      vote.selectedId === sense.id ? "card.senses.cancelVote" : "card.senses.vote",
                      { meaning: sense.meaning },
                    )}
                    title={t(
                      vote.selectedId === sense.id
                        ? "card.senses.removeChoice"
                        : "card.senses.fitsHere",
                    )}
                    aria-pressed={vote.selectedId === sense.id}
                    aria-describedby={reason ? `${id}-eligibility` : undefined}
                    disabled={!canVote}
                    onClick={() => choose(sense.id)}
                    className={cn(
                      cn(
                        "inline-flex shrink-0 items-center justify-center rounded font-sans disabled:cursor-not-allowed",
                        compactCandidates
                          ? "min-h-11 min-w-11"
                          : "min-h-11 min-w-11 gap-1.5 px-2 text-sm",
                      ),
                      focus,
                      vote.selectedId === sense.id
                        ? "bg-accent-soft text-accent"
                        : "text-muted enabled:hover:bg-sheet enabled:hover:text-ink",
                    )}
                  >
                    <ThumbsUp aria-hidden size={18} strokeWidth={1.5} fill="none" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="py-3">
              <p role={resolution.kind === "error" ? "alert" : "status"} className={label}>
                {t(
                  resolution.kind === "loading"
                    ? "card.senses.loading"
                    : resolution.kind === "error"
                      ? "card.senses.error"
                      : resolution.kind === "missing"
                        ? "card.senses.missing"
                        : "card.senses.empty",
                )}
              </p>
              {resolution.kind === "error" && onRetry ? (
                <button
                  type="button"
                  className={cn("min-h-11 text-sm text-accent", focus)}
                  onClick={onRetry}
                >
                  {t("card.senses.retry")}
                </button>
              ) : null}
            </div>
          )}
          {reason ? (
            <p id={`${id}-eligibility`} className={cn(label, "pb-2")}>
              {reason}
            </p>
          ) : null}
          {unresolved ? (
            <div aria-live="polite" aria-atomic className={label}>
              {vote.pending ? (
                <p className="pb-2">{t("card.senses.pending")}</p>
              ) : vote.error === "failed" ? (
                <div className="pb-2 text-warn">
                  <p>{t("card.senses.voteFailed")}</p>
                  {onRetry ? <button type="button" className={cn("min-h-11 text-sm underline", focus)} onClick={onRetry}>{t("card.senses.retry")}</button> : null}
                </div>
              ) : vote.error === "fixed" ? (
                <p className="pb-2">{t("card.senses.voteFixed")}</p>
              ) : vote.eligibility === "verified" &&
                vote.acknowledged &&
                senses.some((sense) => sense.id === vote.selectedId) ? (
                <p className="pb-2" data-sense-choice-saved>
                  {t("card.senses.choiceSaved")}
                </p>
              ) : vote.eligibility === "verified" &&
                vote.acknowledged &&
                vote.selectedId === null ? (
                <p className="pb-2">{t("card.senses.choiceRemoved")}</p>
              ) : null}
            </div>
          ) : null}
          {resolution.kind === "unmapped" || resolution.kind === "missing" ? noMatchButton : null}
          {!explanation && communityEditor ? (
            <section className="mt-3 border-t border-line pt-3" data-community-content>
              {communityEditor}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
