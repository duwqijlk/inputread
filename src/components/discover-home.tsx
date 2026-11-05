import { useState, type ReactNode } from "react";
import { BookCover } from "@/components/book-cover";
import { BookRail, type DiscoverRow } from "@/components/discover-browse";
import { btn } from "@/components/ui";
import { compareSeriesPlace, type Rail, type DiscoverRailSpec } from "@/lib/discover-rails";
import { useT } from "@/lib/i18n";

export function DiscoverHome({ rows, newest, rails, specs, complete, onCollection, onBook, action }: {
  rows: DiscoverRow[];
  newest: DiscoverRow[];
  rails: Rail<DiscoverRow>[];
  specs: DiscoverRailSpec[] | null;
  complete: boolean;
  onCollection: (collection: string) => void;
  onBook: (row: DiscoverRow) => void;
  action: (row: DiscoverRow) => ReactNode;
}) {
  const { t, tn } = useT();
  const [allSeries, setAllSeries] = useState(false);
  const series = complete ? (specs ?? []).filter((spec) => spec.source === "series").flatMap((spec) => {
    const members = rows.filter((row) => row.series === spec.name).sort(compareSeriesPlace);
    return members.length ? [{ name: spec.name, rows: members }] : [];
  }) : [];
  const editorial = rails.find((rail) => rail.kind === "curated");

  return (
    <div className="grid gap-7" data-discover-home>
      {newest.length ? (
        <BookRail rail="new" title={t("discover.recent")} rows={newest.slice(0, 12)} onOpen={onBook} onSeeAll={() => onCollection("new")} action={action} />
      ) : null}
      {series.length ? (
        <section className="grid gap-3" aria-label={t("browse.series")} data-discover-series>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-bold tracking-[-0.02em]">{t("browse.series")}</h2>
            {series.length > 4 ? (
              <button type="button" className={btn.quiet} aria-expanded={allSeries} onClick={() => setAllSeries(!allSeries)}>{t(allSeries ? "browse.fewerSeries" : "browse.allSeries")}</button>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 lg:grid-cols-4">
            {(allSeries ? series : series.slice(0, 4)).map((group) => (
              <button key={group.name} type="button" className="flex min-w-0 items-center gap-3 rounded-xl border border-line p-3 text-left hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={() => onCollection(`series:${group.name}`)} data-series-entry={group.name}>
                <div className="w-12 shrink-0" aria-hidden="true"><BookCover title={group.rows[0].title} author={group.rows[0].author} cover={group.rows[0].coverUrl} whenVisible /></div>
                <span className="grid min-w-0 gap-1">
                  <span className="break-words font-display text-sm font-bold">{group.name}</span>
                  <span className="text-xs text-muted">{tn("browse.listedBooks", group.rows.length)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {editorial ? (
        <BookRail rail={editorial.id} title={editorial.name} rows={editorial.rows.slice(0, 12)} onOpen={onBook} onSeeAll={() => onCollection(editorial.id)} action={action} />
      ) : null}
    </div>
  );
}
