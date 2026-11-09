import * as Menu from "@radix-ui/react-dropdown-menu";
import { ArrowUpRight, Ellipsis, Image as ImageIcon } from "lucide-react";
import merriamWebsterLogo from "@/assets/merriam-webster-logo.png";
import { useT, type Key } from "@/lib/i18n";
import { LOOKUP_SITES, lookupUrl, type LookupSite } from "@/lib/lookup-links";

const labels = {
  longman: "card.look.longman",
  webster: "card.look.websterFull",
  images: "card.look.images",
} as const satisfies Record<LookupSite, Key>;

/** A non-modal overlay: opening a lookup never moves the word card or its meaning. */
export function WordLookupMenu({
  word,
  open,
  onOpenChange,
}: {
  word: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT();
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Menu.Trigger
        type="button"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded text-muted outline-none hover:bg-sheet hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent data-[state=open]:bg-sheet data-[state=open]:text-ink"
        aria-label={t("card.senses.more")}
        data-word-more
      >
        <Ellipsis className="size-5" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-[220px] max-w-[calc(100vw-16px)] rounded-2xl border border-float-edge bg-float p-1.5 font-sans text-sm text-ink shadow-lift outline-none"
          aria-label={t("card.lookAria", { word })}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onTouchMove={(event) => event.preventDefault()}
          style={{ touchAction: "none" }}
          data-word-lookup-menu
        >
          {LOOKUP_SITES.map((site) => (
            <Menu.Item key={site} asChild>
              <a
                href={lookupUrl(site, word)}
                target="_blank"
                rel="noopener noreferrer"
                className="grid min-h-11 cursor-pointer grid-cols-[20px_minmax(0,1fr)_16px] items-center gap-2 rounded-lg px-2.5 py-2 text-left leading-snug outline-none data-[highlighted]:bg-sheet data-[highlighted]:text-ink"
                aria-label={t("card.lookOne", { site: t(labels[site]), word })}
                data-lookup={site}
              >
                {site === "longman" ? (
                  <span
                    className="inline-grid size-4 place-items-center rounded-sm bg-[#314089] text-[0.62rem] font-bold leading-none text-white"
                    aria-hidden
                  >
                    L
                  </span>
                ) : site === "webster" ? (
                  <img
                    src={merriamWebsterLogo}
                    alt=""
                    className="size-4 rounded-full"
                    aria-hidden
                  />
                ) : (
                  <ImageIcon className="size-4 text-muted" aria-hidden />
                )}
                <span>{t(labels[site])}</span>
                <ArrowUpRight className="size-4 text-faint" aria-hidden />
              </a>
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
