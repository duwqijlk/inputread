import { Loader2, Square, Volume2 } from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/components/ui";
import { useT, type Key } from "@/lib/i18n";
import { stopReadAloud, toggleReadAloud, useReadAloud } from "@/lib/read-aloud";
import { useReadAloudReady } from "@/lib/tts-settings";

const ERROR_KEYS: Record<string, Key> = {
  key: "tts.err.key",
  rate: "tts.err.rate",
  network: "tts.err.network",
  server: "tts.err.server",
  empty: "tts.err.empty",
  play: "tts.err.play",
};

/**
 * Read a text aloud with the reader's MiMo voice. Hidden when no key is saved or the browser cannot
 * play generated audio. A second tap stops it; the icon shows preparing (spinner) and playing (stop).
 * `owner` names this button so only it shows the state of its own audio.
 */
export function ReadAloudButton({
  owner,
  text,
  label,
  className,
  size = "md",
}: {
  owner: string;
  text: string;
  label: string;
  className?: string;
  /** md: a 30px tinted circle beside a close button; sm: an inline icon next to a label. */
  size?: "md" | "sm";
}) {
  const { t } = useT();
  const ready = useReadAloudReady();
  const mine = useReadAloud((state) => state.owner === owner);
  const status = useReadAloud((state) => (state.owner === owner ? state.status : "idle"));
  const error = useReadAloud((state) => (state.owner === owner ? state.error : null));
  // Leaving (the panel closes, the note goes away) stops this button's audio.
  useEffect(() => () => {
    if (useReadAloud.getState().owner === owner) stopReadAloud();
  }, [owner]);
  // A failure note fades after a while; the button can be tapped again at once.
  useEffect(() => {
    if (!mine || !error) return;
    const timer = window.setTimeout(() => {
      const now = useReadAloud.getState();
      if (now.owner === owner && now.error === error) useReadAloud.setState({ owner: "", status: "idle", error: null });
    }, 7000);
    return () => window.clearTimeout(timer);
  }, [mine, error, owner]);
  if (!ready || !text.trim()) return null;
  const busy = status === "loading";
  const playing = status === "playing";
  const title = busy ? t("tts.loading") : playing ? t("tts.stop") : label;
  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={() => toggleReadAloud(owner, text)}
        aria-label={title}
        aria-pressed={busy || playing}
        title={title}
        data-read-aloud={owner}
        data-read-aloud-state={status}
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center rounded-full transition-colors duration-150 after:absolute after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          size === "md"
            ? "size-[30px] bg-ink/[0.07] text-muted after:-inset-[7px] hover:bg-ink/[0.11] hover:text-ink active:bg-ink/[0.15]"
            : "size-7 text-accent after:-inset-2 hover:bg-accent-soft/70",
          (busy || playing) && "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent",
          className,
        )}
      >
        {busy ? (
          <Loader2 className={cn(size === "md" ? "size-4" : "size-3.5", "animate-spin")} aria-hidden />
        ) : playing ? (
          <Square className={cn(size === "md" ? "size-3" : "size-2.5", "fill-current")} aria-hidden />
        ) : (
          <Volume2 className={size === "md" ? "size-4" : "size-[15px]"} strokeWidth={2.1} aria-hidden />
        )}
      </button>
      {mine && error ? (
        <span
          role="alert"
          className="absolute top-full right-0 z-20 mt-1.5 w-max max-w-[15rem] rounded-xl bg-float px-3 py-2 text-xs leading-snug text-warn shadow-lift"
          data-read-aloud-error={error}
        >
          {t(ERROR_KEYS[error] ?? "tts.err.server")}
        </span>
      ) : null}
    </span>
  );
}
