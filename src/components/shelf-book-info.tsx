import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useRef } from "react";
import { useSheetDrag } from "@/components/floating-card";
import { isbnDigits, readSeries } from "@/lib/book-meta";
import { useT } from "@/lib/i18n";
import type { Book } from "@/lib/vocab-model";
import { cn, panel, PanelHandle } from "@/components/ui";

/** Shelf facts only: opening this dialog never loads a catalog, blurb, or book body. */
export function ShelfBookInfo({
  book,
  classic,
  fileHere,
  due,
  open,
  onOpenChange,
  onReturnFocus,
}: {
  book: Book;
  classic: boolean;
  /** null while local file presence is still unknown. */
  fileHere: boolean | null;
  due: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReturnFocus: () => void;
}) {
  const { t } = useT();
  const sheet = useRef<HTMLDivElement | null>(null);
  useSheetDrag(sheet, () => onOpenChange(false), "(max-width: 639px)", open);
  const isbn = isbnDigits(book.isbn);
  const series = readSeries(book.series, book.seriesNumber);
  const lexile = book.lexile?.trim() ?? "";
  const match = typeof book.matchRate === "number" && Number.isFinite(book.matchRate)
    && book.matchRate >= 0 && book.matchRate <= 100 ? book.matchRate : null;
  const hasDue = Number.isFinite(due) && due >= 0;
  const reason = book.oldFashionedReason?.trim();
  const fileStatus = book.needsEpub ? t("shelf.needsEpub")
    : book.source === "epub" && fileHere !== null ? t(fileHere ? "shelf.infoFileHere" : "shelf.fileMissing")
    : book.source === "notes" ? t("shelf.infoNotesOnly") : "";
  const tileCount = Number(Boolean(lexile)) + Number(hasDue);
  const hasRows = Boolean(
    book.author.trim() ||
    series.series ||
    match !== null ||
    fileStatus ||
    classic ||
    isbn ||
    book.oldFashioned ||
    reason,
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/[0.32]" />
        <Dialog.Content
          ref={sheet}
          className="panel-in panel-sheet fixed z-50 flex flex-col overflow-hidden border-float-edge bg-float text-ink shadow-lift max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[88vh] max-sm:rounded-t-sheet max-sm:border-t sm:top-1/2 sm:left-1/2 sm:w-[calc(100vw-2rem)] sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border max-h-[calc(100vh-2rem)]"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onReturnFocus();
          }}
          data-shelf-book-info=""
        >
          <PanelHandle />
          <div className="panel-head relative z-10 grid shrink-0 gap-1 px-5 pt-1 pb-3 sm:pt-5">
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title className="m-0 font-bold tracking-[-0.02em] text-xl">{t("shelf.info")}</Dialog.Title>
              <Dialog.Close type="button" className={panel.close} aria-label={t("common.close")}>
                <X className={panel.closeIcon} strokeWidth={2.5} aria-hidden />
              </Dialog.Close>
            </div>
            <Dialog.Description className="m-0 text-xs leading-relaxed text-muted">
              {t("shelf.infoLocal")}
            </Dialog.Description>
          </div>
          <div className="panel-body grid min-h-0 flex-1 content-start gap-4 overflow-y-auto overscroll-contain px-5 pt-1 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:pb-5">
          {book.title.trim() ? (
            <h3 className="m-0 break-words font-display text-lg leading-snug font-semibold" lang="en">
              {book.title}
            </h3>
          ) : null}
          {tileCount > 0 ? (
            <dl className={cn("m-0 grid gap-2", tileCount > 1 ? "grid-cols-2" : "grid-cols-1")}>
              {lexile ? (
                <div className="grid content-start gap-1 rounded-2xl bg-sheet px-3.5 pt-2.5 pb-3" data-info-lexile="">
                  <dt className="text-xs text-faint">{t("lexile.name")}</dt>
                  <dd className="m-0 font-display text-xl leading-none font-bold tabular-nums" lang="en">{lexile}</dd>
                </div>
              ) : null}
              {hasDue ? (
                <div className="grid content-start gap-1 rounded-2xl bg-sheet px-3.5 pt-2.5 pb-3" data-info-due={due}>
                  <dt className="text-xs text-faint">{t("shelf.infoDue")}</dt>
                  <dd className="m-0 font-display text-xl leading-none font-bold tabular-nums">{t("shelf.due", { n: due })}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {hasRows ? (
            <dl className="m-0 grid divide-y divide-line rounded-2xl bg-sheet px-4 py-1 text-sm leading-relaxed [&_dt]:text-xs [&_dt]:font-medium [&_dt]:text-faint [&_dd]:m-0 [&_dd]:mt-0.5 [&_dd]:break-words">
              {book.author.trim() ? (
                <div className="py-2.5" data-info-author="">
                  <dt>{t("shelf.authorLabel")}</dt>
                  <dd lang="en">{book.author}</dd>
                </div>
              ) : null}
              {series.series ? (
                <div className="py-2.5" data-info-series="">
                  <dt>{t("shelf.seriesLabel")}</dt>
                  <dd>
                    <span lang="en">{series.series}</span>
                    {series.seriesNumber > 0 ? ` · ${t("shelf.infoSeriesNumber", { n: series.seriesNumber })}` : ""}
                  </dd>
                </div>
              ) : null}
              {match !== null ? (
                <div className="py-2.5" data-info-match={match}>
                  <dt>{t("shelf.infoMatch")}</dt>
                  <dd>
                    <p className={match < 80 ? "font-medium text-warn" : "font-medium"}>
                      {t("match.short", { n: Math.round(match) })}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted">{t("shelf.infoMatchNote")}</p>
                  </dd>
                </div>
              ) : null}
              {fileStatus ? (
                <div className="py-2.5" data-info-file="">
                  <dt>{t("shelf.infoFile")}</dt>
                  <dd>{fileStatus}</dd>
                </div>
              ) : null}
              {classic ? (
                <div className="py-2.5" data-info-public-domain="">
                  <dt>{t("shelf.infoAvailability")}</dt>
                  <dd>{t("shelf.classic")}</dd>
                </div>
              ) : null}
              {isbn ? (
                <div className="py-2.5" data-info-isbn="">
                  <dt>{t("isbn.name")}</dt>
                  <dd className="tabular-nums" lang="en">{isbn}</dd>
                </div>
              ) : null}
              {book.oldFashioned || reason ? (
                <div className="py-2.5" data-info-old-fashioned="">
                  <dt>{t("shelf.infoLanguage")}</dt>
                  <dd>
                    <p>{t("shelf.oldFashioned")} · {t("shelf.oldFashionedNote")}</p>
                    {reason ? <p className="mt-1 text-muted" lang="en">{reason}</p> : null}
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
