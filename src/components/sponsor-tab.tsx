import { Coffee } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useT } from "@/lib/i18n";

const SponsorDialog = lazy(() =>
  import("@/components/sponsor-dialog").then((m) => ({ default: m.SponsorDialog })),
);

/** A desktop-only sponsor shortcut in the margin; never over the reading page. */
export function SponsorTab() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  if (open && !mounted) setMounted(true);
  return (
    <>
      <button
        type="button"
        className="fixed top-[58%] right-0 z-40 hidden size-12 -translate-y-1/2 items-center justify-center rounded-l-xl border border-r-0 border-float-edge bg-float text-accent shadow-hero hover:bg-sheet min-[1185px]:inline-flex"
        aria-label={t("dashboard.sponsorProject")}
        title={t("dashboard.sponsorProject")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        onPointerEnter={() => void import("@/components/sponsor-dialog").catch(() => undefined)}
        onFocus={() => void import("@/components/sponsor-dialog").catch(() => undefined)}
        data-sponsor-tab
      >
        <Coffee className="size-6" strokeWidth={1.5} aria-hidden />
      </button>
      {mounted ? (
        <Suspense fallback={null}>
          <SponsorDialog open={open} onOpenChange={setOpen} onSubmitted={() => undefined} />
        </Suspense>
      ) : null}
    </>
  );
}
