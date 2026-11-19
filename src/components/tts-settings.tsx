import { ExternalLink, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { btn, cn, field, panel, Segmented } from "@/components/ui";
import { useT, type Key } from "@/lib/i18n";
import { MIMO_CONSOLE_URL, MIMO_VOICES, type MimoVoice } from "@/lib/mimo-tts";
import { testReadAloudKey } from "@/lib/read-aloud";
import { readAloudSupported, useTtsSettings } from "@/lib/tts-settings";

const ERROR_KEYS: Record<string, Key> = {
  key: "tts.err.key",
  rate: "tts.err.rate",
  network: "tts.err.network",
  server: "tts.err.server",
  empty: "tts.err.empty",
  play: "tts.err.play",
};

/** The short value beside the Read aloud row on the account home. */
export function TtsSummary() {
  const { t } = useT();
  const on = useTtsSettings((state) => Boolean(state.apiKey));
  return (
    <span className="text-[15px] text-muted" data-tts-summary={on ? "on" : "off"}>
      {on ? t("tts.on") : t("tts.off")}
    </span>
  );
}

/**
 * Account > Read aloud: the reader's own Xiaomi MiMo key (saved only once a test request works),
 * the voice, and what is sent where. The key never leaves the device except to Xiaomi.
 */
export function TtsSettings() {
  const { t } = useT();
  const saved = useTtsSettings((state) => state.apiKey);
  const voice = useTtsSettings((state) => state.voice);
  const setKey = useTtsSettings((state) => state.setKey);
  const setVoice = useTtsSettings((state) => state.setVoice);
  const clear = useTtsSettings((state) => state.clear);
  const [draft, setDraft] = useState(saved);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [note, setNote] = useState("");
  const supported = readAloudSupported();

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    const key = draft.trim();
    if (!key || busy) return;
    setBusy(true);
    setProblem("");
    setNote("");
    // testReadAloudKey unlocks audio synchronously, inside this submit (a tap or Enter).
    const failure = await testReadAloudKey(key, voice);
    setBusy(false);
    if (failure && failure !== "play") {
      setProblem(t(ERROR_KEYS[failure] ?? "tts.err.server"));
      return;
    }
    setKey(key);
    setNote(t("tts.ok"));
  }

  return (
    <div className="grid gap-5" data-tts-settings>
      <p className="m-0 px-4 text-sm leading-relaxed text-muted">{t("tts.intro")}</p>
      {supported ? null : (
        <p className="m-0 rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
          {t("tts.err.play")}
        </p>
      )}
      <form className="grid gap-2" onSubmit={(event) => void onSave(event)} data-tts-key-form>
        <label className="grid gap-1.5 px-1 text-sm font-semibold" htmlFor="tts-key">
          {t("tts.key")}
          <span className="relative block">
            <input
              id="tts-key"
              className={cn(field, "pr-12 font-mono text-[0.875rem]")}
              type={show ? "text" : "password"}
              value={draft}
              placeholder={t("tts.keyPlaceholder")}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.target.value);
                setProblem("");
                setNote("");
              }}
              data-tts-key
            />
            <button
              type="button"
              className="absolute top-1/2 right-1 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-faint hover:bg-ink/[0.06] hover:text-ink"
              onClick={() => setShow((value) => !value)}
              aria-label={show ? t("tts.keyHide") : t("tts.keyShow")}
              aria-pressed={show}
            >
              {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          </span>
        </label>
        <p className="m-0 px-1 text-[13px] leading-relaxed text-faint">{t("tts.keyHint")}</p>
        {problem ? (
          <p className="m-0 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn" role="alert" data-tts-error>
            {problem}
          </p>
        ) : null}
        {note ? (
          <p className="m-0 px-1 text-sm text-accent" role="status" data-tts-ok>
            {note}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button type="submit" className={btn.primary} disabled={busy || !draft.trim() || !supported} data-tts-save>
            {busy ? t("tts.testing") : t("tts.save")}
          </button>
          {saved ? (
            <button
              type="button"
              className={cn(btn.bare, "text-warn")}
              onClick={() => {
                clear();
                setDraft("");
                setProblem("");
                setNote(t("tts.removed"));
              }}
              data-tts-remove
            >
              {t("tts.remove")}
            </button>
          ) : null}
        </div>
      </form>

      <section className={panel.group} aria-label={t("tts.voice")}>
        <h3 className={panel.groupTitle}>{t("tts.voice")}</h3>
        <div className={panel.box}>
          <div className={cn(panel.row, "py-2 [&>div]:w-full")} data-tts-voice>
            <Segmented<MimoVoice>
              layout="wrap"
              label={t("tts.voice")}
              value={voice}
              onChange={(next) => setVoice(next)}
              options={MIMO_VOICES.map((item) => ({
                value: item.id,
                label: `${item.id} · ${t(item.gender === "female" ? "tts.female" : "tts.male")}`,
              }))}
            />
          </div>
        </div>
        <p className={panel.note}>{t("tts.privacy")}</p>
      </section>

      <section className={panel.group} aria-label={t("tts.getKey")}>
        <div className={panel.box}>
          <a className={panel.row} href={MIMO_CONSOLE_URL} target="_blank" rel="noopener noreferrer" data-tts-console>
            <span className={panel.rowLabel}>{t("tts.getKey")}</span>
            <ExternalLink className={panel.rowIcon} aria-hidden />
          </a>
        </div>
      </section>
    </div>
  );
}
