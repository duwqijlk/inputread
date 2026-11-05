import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Save,
  Search,
  Tags,
  X,
} from "lucide-react";
import { useT, type Key } from "@/lib/i18n";
import { forgetSharedFetches } from "@/lib/shared-fetch";
import { BOOK_GENRES, type BookGenre } from "@/lib/book-genres";
import type { CatalogName } from "@/lib/catalog-id";
import type { BookMetadataRow } from "@/lib/book-metadata";
import {
  MAX_GENRES,
  MAX_SELECTION,
  applyGenresToDrafts,
  applySeriesToDrafts,
  buildChunks,
  draftCount,
  draftGenres,
  draftIssue,
  draftSeries,
  draftSeriesNumber,
  mergeSaved,
  pendingIssues,
  previewDrafts,
  readMetadataBooks,
  resetRowDraft,
  rowKey,
  setRowGenres,
  setRowSeries,
  setRowSeriesNumber,
  type DraftMap,
  type GenreAction,
} from "@/lib/book-metadata-draft";
import { btn, cn, ConfirmDialog, field, selectCls } from "@/components/ui";

const API = "/api/admin/book-metadata";
const CATALOGS: readonly CatalogName[] = ["word-lists", "public-books"];

type CatalogFilter = "all" | CatalogName;
type GenreFilter = "all" | BookGenre;
type SeriesFilter = "all" | "none" | string;

function errorKey(code: string): string {
  if (code === "metadata-conflict") return "admin.metadata.conflict";
  if (code === "catalog-busy") return "admin.metadata.catalogBusy";
  if (code === "bad-metadata") return "admin.metadata.badMetadata";
  if (code === "unauthorized") return "admin.metadata.unauthorized";
  return "admin.metadata.failed";
}

/**
 * Admin editor for the editorial metadata of catalog books: genres, series name and series number.
 * Only books (the `novel` category) are listed; speeches keep their own Discover tab.
 *
 * The table edits a local draft. Nothing is sent until the editor previews the exact before/after
 * values. Each request names one catalog, carries every row's read-time baseline, and is capped at
 * BOOK_METADATA_LIMIT rows; a 409 is shown as a conflict and never overwrites newer data.
 */
export function BookMetadataAdmin() {
  const { t } = useT();
  const tt = (name: string, params?: Record<string, string | number>) => t(name as Key, params);

  const [rows, setRows] = useState<BookMetadataRow[] | null>(null);
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>("all");
  const [genreFilter, setGenreFilter] = useState<GenreFilter>("all");
  const [seriesFilter, setSeriesFilter] = useState<SeriesFilter>("all");
  const [onlyUnclassified, setOnlyUnclassified] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [bulkGenres, setBulkGenres] = useState<BookGenre[]>([]);
  const [genreAction, setGenreAction] = useState<GenreAction>("add");
  const [bulkSeries, setBulkSeries] = useState("");
  const [clearGenresOpen, setClearGenresOpen] = useState(false);
  const [clearSeriesOpen, setClearSeriesOpen] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  /** A 409 or an unknown server outcome: only an explicit refresh may unlock Save again. */
  const [reconcileRequired, setReconcileRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const allRef = useRef<HTMLInputElement | null>(null);

  async function loadRows(keepDrafts: boolean) {
    setLoading(true);
    setLoadError(false);
    setError("");
    try {
      const response = await fetch(API, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("load");
      const payload = (await response.json()) as unknown;
      setRows(readMetadataBooks(payload));
      setReconcileRequired(false);
      if (!keepDrafts) {
        setDrafts({});
        setSelected(new Set());
        setEditing(null);
      }
    } catch {
      setLoadError(true);
      setError(tt("admin.metadata.loadError"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadRows(false);
    // The editor loads once; refresh is an explicit button so drafts are never replaced silently.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const novelRows = useMemo(() => (rows ?? []).filter((row) => row.category === "novel"), [rows]);
  const seriesOptions = useMemo(
    () => [...new Set(novelRows.map((row) => row.series).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [novelRows],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return novelRows.filter((row) => {
      if (catalogFilter !== "all" && row.catalog !== catalogFilter) return false;
      if (needle && !`${row.title} ${row.author}`.toLowerCase().includes(needle)) return false;
      if (onlyUnclassified && row.genres.length > 0) return false;
      if (!onlyUnclassified && genreFilter !== "all" && !row.genres.includes(genreFilter)) return false;
      if (seriesFilter === "none") {
        if (row.series) return false;
      } else if (seriesFilter !== "all" && row.series !== seriesFilter) {
        return false;
      }
      return true;
    });
  }, [novelRows, query, catalogFilter, onlyUnclassified, genreFilter, seriesFilter]);

  const visibleSelected = useMemo(
    () => filtered.filter((row) => selected.has(rowKey(row))).length,
    [filtered, selected],
  );
  useEffect(() => {
    if (allRef.current) {
      allRef.current.indeterminate = visibleSelected > 0 && visibleSelected < filtered.length;
    }
  }, [visibleSelected, filtered.length]);

  const preview = useMemo(() => previewDrafts(novelRows, drafts), [novelRows, drafts]);
  const issues = useMemo(() => pendingIssues(novelRows, drafts), [novelRows, drafts]);
  const selectedCount = selected.size;
  const draftTotal = draftCount(drafts);

  function genreLabel(genre: BookGenre): string {
    // Discover already owns the ten genre labels; the admin table reuses them.
    return t(`genre.${genre}` as Key);
  }

  function toggleRow(key: string) {
    if (!selected.has(key) && selected.size >= MAX_SELECTION) {
      setNote(tt("admin.metadata.selectLimit", { n: MAX_SELECTION }));
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAllFiltered() {
    const keys = filtered.map(rowKey);
    setSelected(new Set(keys.slice(0, MAX_SELECTION)));
    if (keys.length > MAX_SELECTION) setNote(tt("admin.metadata.selectLimit", { n: MAX_SELECTION }));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function toggleBulkGenre(genre: BookGenre) {
    setBulkGenres((current) => {
      if (current.includes(genre)) return current.filter((item) => item !== genre);
      if (current.length >= MAX_GENRES) {
        setNote(tt("admin.metadata.genreLimit", { n: MAX_GENRES }));
        return current;
      }
      return [...current, genre];
    });
  }

  function applyGenres(action: GenreAction) {
    if (selectedCount === 0) return;
    if (action !== "clear" && bulkGenres.length === 0) {
      setNote(tt("admin.metadata.pickGenre"));
      return;
    }
    const result = applyGenresToDrafts(novelRows, [...selected], drafts, action, bulkGenres);
    setDrafts(result.drafts);
    setNote(result.skipped ? tt("admin.metadata.skippedGenres", { n: result.skipped }) : "");
  }

  function applySeries() {
    if (selectedCount === 0) return;
    const name = bulkSeries.trim();
    if (!name) {
      setClearSeriesOpen(true);
      return;
    }
    setDrafts(applySeriesToDrafts(novelRows, [...selected], drafts, name));
    setNote("");
  }

  function clearSeries() {
    setDrafts(applySeriesToDrafts(novelRows, [...selected], drafts, ""));
    setClearSeriesOpen(false);
  }

  function editRowGenres(row: BookMetadataRow, genre: BookGenre) {
    const key = rowKey(row);
    const current = draftGenres(row, drafts[key]);
    if (!current.includes(genre) && current.length >= MAX_GENRES) {
      setNote(tt("admin.metadata.genreLimit", { n: MAX_GENRES }));
      return;
    }
    const next = current.includes(genre) ? current.filter((item) => item !== genre) : [...current, genre];
    setDrafts(setRowGenres(novelRows, key, drafts, next));
  }

  function confirmNumber(row: BookMetadataRow) {
    const key = rowKey(row);
    const value = draftSeriesNumber(row, drafts[key]) || null;
    setDrafts(setRowSeriesNumber(novelRows, key, drafts, value));
  }

  async function save() {
    if (busy || reconcileRequired || issues.length > 0) return;
    const chunks = buildChunks(novelRows, drafts);
    if (chunks.length === 0) return;
    setBusy(true);
    setError("");
    setNote("");
    let currentRows = rows ?? [];
    let currentDrafts = drafts;
    let saved = 0;
    let failed = 0;
    const blocked = new Set<CatalogName>();
    try {
      for (const chunk of chunks) {
        if (blocked.has(chunk.catalog)) {
          failed += chunk.changes.length;
          continue;
        }
        try {
          const response = await fetch(API, {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ catalog: chunk.catalog, changes: chunk.changes }),
          });
          const payload = (await response.json().catch(() => ({}))) as {
            books?: unknown;
            error?: unknown;
          };
          if (!response.ok) {
            const code = typeof payload.error === "string" ? payload.error : "";
            blocked.add(chunk.catalog);
            failed += chunk.changes.length;
            setError(tt(errorKey(code)));
            // A conflict or an unknown server outcome is not retryable against the old baselines:
            // keep the draft, block Save, and make the editor refresh (which discards drafts)
            // before anything else can be sent.
            if (code === "metadata-conflict" || response.status >= 500) setReconcileRequired(true);
            continue;
          }
          const savedRows = readMetadataBooks(payload, chunk.catalog);
          const expected = new Set(chunk.changes.map((change) => `${chunk.catalog}:${change.id}`));
          if (savedRows.length !== expected.size || savedRows.some((row) => !expected.has(rowKey(row)))) {
            blocked.add(chunk.catalog);
            failed += chunk.changes.length;
            setReconcileRequired(true);
            setError(tt("admin.metadata.failed"));
            continue;
          }
          const merged = mergeSaved(currentRows, savedRows, currentDrafts);
          currentRows = merged.rows;
          currentDrafts = merged.drafts;
          saved += savedRows.length;
          failed += chunk.changes.length - savedRows.length;
          setRows(currentRows);
          setDrafts(currentDrafts);
          setSelected((current) => {
            const next = new Set(current);
            for (const key of merged.savedKeys) next.delete(key);
            return next;
          });
        } catch {
          blocked.add(chunk.catalog);
          failed += chunk.changes.length;
          setReconcileRequired(true);
          setError(tt("admin.metadata.network"));
        }
      }
    } finally {
      setBusy(false);
    }
    if (saved > 0) {
      // Discover's catalog is shared for the page lifetime; a saved genre must be visible there.
      forgetSharedFetches();
      setNote(
        failed > 0
          ? tt("admin.metadata.savedPartial", { saved, failed })
          : tt("admin.metadata.saved", { n: saved }),
      );
    } else if (failed === 0) {
      setNote(tt("admin.metadata.nothing"));
    }
  }

  function refresh() {
    if (draftTotal > 0) setRefreshOpen(true);
    else void loadRows(true);
  }

  if (loading && rows === null) {
    return (
      <div className="grid gap-3" aria-busy="true" data-book-metadata-admin>
        <p className="text-sm text-muted" role="status">
          {tt("admin.metadata.loading")}
        </p>
      </div>
    );
  }

  if (loadError && rows === null) {
    return (
      <div className="grid justify-items-start gap-3" data-book-metadata-admin>
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" role="alert">
          {tt("admin.metadata.loadError")}
        </p>
        <button type="button" className={btn.quiet} onClick={() => void loadRows(false)}>
          <RefreshCw className="size-4" aria-hidden />
          {tt("admin.metadata.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-4" data-book-metadata-admin aria-busy={busy || loading}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-xl font-bold tracking-tight text-ink sm:text-2xl">
            {tt("admin.metadata.title")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">{tt("admin.metadata.hint")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted" data-metadata-draft-count>
            {tt("admin.metadata.draftCount", { n: draftTotal })}
          </span>
          <button type="button" className={btn.quiet} onClick={refresh} disabled={busy}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden />
            {tt("admin.metadata.refresh")}
          </button>
        </div>
      </div>

      <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="relative block min-w-0">
          <span className="sr-only">{tt("admin.metadata.search")}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            className={cn(field, "pl-9")}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tt("admin.metadata.search")}
            data-metadata-search
          />
        </label>
        <select
          className={cn(selectCls, "w-full")}
          aria-label={tt("admin.metadata.filterCatalog")}
          value={catalogFilter}
          onChange={(event) => setCatalogFilter(event.target.value as CatalogFilter)}
          data-metadata-catalog
        >
          <option value="all">{tt("admin.metadata.catalogAll")}</option>
          {CATALOGS.map((catalog) => (
            <option key={catalog} value={catalog}>
              {tt(`admin.metadata.catalog.${catalog === "word-lists" ? "wordLists" : "publicBooks"}`)}
            </option>
          ))}
        </select>
        <select
          className={cn(selectCls, "w-full")}
          aria-label={tt("admin.metadata.filterGenre")}
          value={genreFilter}
          onChange={(event) => setGenreFilter(event.target.value as GenreFilter)}
          disabled={onlyUnclassified}
          data-metadata-genre-filter
        >
          <option value="all">{tt("admin.metadata.filterAllGenres")}</option>
          {BOOK_GENRES.map((genre) => (
            <option key={genre} value={genre}>
              {genreLabel(genre)}
            </option>
          ))}
        </select>
        <select
          className={cn(selectCls, "w-full")}
          aria-label={tt("admin.metadata.filterSeries")}
          value={seriesFilter}
          onChange={(event) => setSeriesFilter(event.target.value)}
          data-metadata-series-filter
        >
          <option value="all">{tt("admin.metadata.filterAllSeries")}</option>
          <option value="none">{tt("admin.metadata.noSeries")}</option>
          {seriesOptions.map((series) => (
            <option key={series} value={series}>
              {series}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
            <input
              ref={allRef}
              type="checkbox"
              className="size-5"
              checked={filtered.length > 0 && visibleSelected === filtered.length}
              onChange={(event) => (event.target.checked ? selectAllFiltered() : clearSelection())}
              aria-label={tt("admin.metadata.selectAll")}
              data-metadata-select-all
            />
            {tt("admin.metadata.selectAll")}
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="size-5"
              checked={onlyUnclassified}
              onChange={(event) => setOnlyUnclassified(event.target.checked)}
              data-metadata-only-unclassified
            />
            {tt("admin.metadata.onlyUnclassified")}
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <span data-metadata-count>{tt("admin.metadata.count", { n: filtered.length })}</span>
          <span data-metadata-selected>{tt("admin.metadata.selected", { n: selectedCount })}</span>
          {selectedCount > 0 ? (
            <button type="button" className={btn.ghost} onClick={clearSelection}>
              {tt("admin.metadata.clearSelection")}
            </button>
          ) : null}
        </div>
      </div>

      {selectedCount > 0 ? (
        <section className="grid min-w-0 gap-3 rounded-xl border border-line/70 bg-line/20 p-3" data-metadata-bulk>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Tags className="size-4 text-muted" aria-hidden />
            <h3 className="text-sm font-bold text-ink">{tt("admin.metadata.bulkTitle", { n: selectedCount })}</h3>
          </div>
          <div className="grid min-w-0 gap-2">
            <p className="text-sm font-semibold text-ink">{tt("admin.metadata.bulkGenres")}</p>
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {BOOK_GENRES.map((genre) => {
                const on = bulkGenres.includes(genre);
                return (
                  <button
                    key={genre}
                    type="button"
                    className={cn(
                      "min-h-9 rounded border px-2.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                      on
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-edge bg-paper text-muted hover:text-ink",
                    )}
                    aria-pressed={on}
                    onClick={() => toggleBulkGenre(genre)}
                    data-metadata-bulk-genre={genre}
                  >
                    {genreLabel(genre)}
                  </button>
                );
              })}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <select
                className={cn(selectCls, "w-auto max-w-full")}
                aria-label={tt("admin.metadata.bulkAction")}
                value={genreAction}
                onChange={(event) => setGenreAction(event.target.value as GenreAction)}
                data-metadata-genre-action
              >
                <option value="add">{tt("admin.metadata.bulkAdd")}</option>
                <option value="remove">{tt("admin.metadata.bulkRemove")}</option>
                <option value="replace">{tt("admin.metadata.bulkReplace")}</option>
              </select>
              <button type="button" className={btn.quiet} onClick={() => applyGenres(genreAction)} data-metadata-apply-genres>
                {tt("admin.metadata.applyGenres")}
              </button>
              <button type="button" className={btn.ghost} onClick={() => setClearGenresOpen(true)} data-metadata-clear-genres>
                {tt("admin.metadata.bulkClear")}
              </button>
            </div>
          </div>
          <div className="grid min-w-0 gap-2 border-t border-line/60 pt-3">
            <p className="text-sm font-semibold text-ink">{tt("admin.metadata.bulkSeries")}</p>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <input
                className={cn(field, "min-w-0 flex-1 sm:max-w-xs")}
                value={bulkSeries}
                onChange={(event) => setBulkSeries(event.target.value)}
                placeholder={tt("admin.metadata.bulkSeriesPlaceholder")}
                maxLength={80}
                data-metadata-bulk-series
              />
              <button type="button" className={btn.quiet} onClick={applySeries} data-metadata-apply-series>
                {tt("admin.metadata.applySeries")}
              </button>
              <button type="button" className={btn.ghost} onClick={() => setClearSeriesOpen(true)}>
                {tt("admin.metadata.clearSeries")}
              </button>
            </div>
            <p className="text-xs text-muted">{tt("admin.metadata.seriesNumberHint")}</p>
          </div>
        </section>
      ) : null}

      {draftTotal > 0 ? (
        <section className="grid min-w-0 gap-3 rounded-xl border border-accent/30 bg-accent-soft/40 p-3" data-metadata-preview>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-ink">{tt("admin.metadata.previewTitle")}</h3>
            <span className="text-sm text-muted">{tt("admin.metadata.previewCount", { n: preview.length })}</span>
          </div>
          {issues.length > 0 ? (
            <p className="rounded bg-warn-soft px-2 py-1.5 text-sm text-warn" role="alert" data-metadata-number-pending>
              {tt("admin.metadata.numberPending", { n: issues.length })}
            </p>
          ) : null}
          {preview.length === 0 ? (
            <p className="text-sm text-muted">{tt("admin.metadata.previewEmpty")}</p>
          ) : (
            <ul className="grid min-w-0 gap-2">
              {preview.map(({ row, next }) => (
                <li key={rowKey(row)} className="min-w-0 rounded border border-line/60 bg-paper p-2 text-sm" data-metadata-preview-row>
                  <p className="break-words font-semibold text-ink">{row.title}</p>
                  <div className="mt-1 grid min-w-0 gap-1 text-muted">
                    <p className="break-words">
                      <span className="font-semibold text-ink">{tt("admin.metadata.previewGenres")}</span>{" "}
                      {row.genres.length ? row.genres.map(genreLabel).join(", ") : tt("admin.metadata.none")}
                      {" → "}
                      {next.genres.length ? next.genres.map(genreLabel).join(", ") : tt("admin.metadata.none")}
                    </p>
                    <p className="break-words">
                      <span className="font-semibold text-ink">{tt("admin.metadata.previewSeries")}</span>{" "}
                      {row.series || tt("admin.metadata.none")}
                      {row.seriesNumber ? ` #${row.seriesNumber}` : ""}
                      {" → "}
                      {next.series || tt("admin.metadata.none")}
                      {next.seriesNumber ? ` #${next.seriesNumber}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              className={btn.primary}
              onClick={() => setSaveOpen(true)}
              disabled={busy || reconcileRequired || preview.length === 0 || issues.length > 0}
              data-metadata-save
            >
              <Save className="size-4" aria-hidden />
              {busy ? tt("admin.metadata.saving") : tt("admin.metadata.save")}
            </button>
            <span className="text-xs text-muted">{tt("admin.metadata.saveHint")}</span>
          </div>
        </section>
      ) : null}

      {error ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" data-metadata-error>
          <p role="alert">{error}</p>
          {reconcileRequired ? (
            <button type="button" className={btn.quiet} onClick={refresh} data-metadata-reconcile>
              <RefreshCw className="size-4" aria-hidden />
              {tt("admin.metadata.refresh")}
            </button>
          ) : null}
        </div>
      ) : null}
      {note ? (
        <p className="rounded-lg bg-line/40 px-3 py-2 text-sm text-ink" role="status" data-metadata-note>
          {note}
        </p>
      ) : null}

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted" data-metadata-empty>
          {novelRows.length === 0 ? tt("admin.metadata.empty") : tt("admin.metadata.emptyFiltered")}
        </p>
      ) : (
        <ul className="grid min-w-0 gap-2" data-metadata-list>
          {filtered.map((row) => {
            const key = rowKey(row);
            const draft = drafts[key];
            const genres = draftGenres(row, draft);
            const series = draftSeries(row, draft);
            const number = draftSeriesNumber(row, draft);
            const issue = draftIssue(row, draft);
            const open = editing === key;
            return (
              <li
                key={key}
                className="min-w-0 rounded-xl border border-line/70 bg-card p-3"
                data-metadata-row={key}
              >
                <div className="flex min-w-0 items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 size-5 shrink-0"
                    checked={selected.has(key)}
                    onChange={() => toggleRow(key)}
                    aria-label={tt("admin.metadata.selectRow", { title: row.title })}
                    data-metadata-select
                  />
                  <div className="min-w-0 flex-1">
                    <p className="min-w-0 break-words font-semibold text-ink" data-metadata-title>
                      {row.title}
                    </p>
                    <p className="min-w-0 break-words text-sm text-muted">{row.author || tt("admin.metadata.noAuthor")}</p>
                    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                      {genres.length ? (
                        genres.map((genre) => (
                          <span key={genre} className="rounded bg-line/60 px-2 py-0.5 text-ink">
                            {genreLabel(genre)}
                          </span>
                        ))
                      ) : (
                        <span className="rounded bg-warn-soft px-2 py-0.5 text-warn" data-metadata-unclassified>
                          {tt("admin.metadata.unclassified")}
                        </span>
                      )}
                      {series ? (
                        <span className="rounded border border-line px-2 py-0.5 text-muted" lang="en">
                          {series}
                          {number ? ` #${number}` : ""}
                        </span>
                      ) : (
                        <span className="text-muted">{tt("admin.metadata.noSeries")}</span>
                      )}
                      <span className="text-muted">
                        {tt(`admin.metadata.catalog.${row.catalog === "word-lists" ? "wordLists" : "publicBooks"}`)}
                      </span>
                      {draft ? (
                        <span className="rounded bg-accent-soft px-2 py-0.5 font-semibold text-accent" data-metadata-draft>
                          {tt("admin.metadata.draft")}
                        </span>
                      ) : null}
                      {issue ? (
                        <span className="rounded bg-warn-soft px-2 py-0.5 text-warn" data-metadata-issue>
                          {issue === "series"
                            ? tt("admin.metadata.seriesFirst")
                            : issue === "genres"
                              ? tt("admin.metadata.genreLimit", { n: MAX_GENRES })
                              : tt("admin.metadata.needsNumber")}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={btn.ghost}
                    aria-expanded={open}
                    aria-controls={`metadata-edit-${key}`}
                    onClick={() => setEditing(open ? null : key)}
                    data-metadata-edit
                  >
                    {open ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
                    {tt("admin.metadata.edit")}
                  </button>
                </div>
                {open ? (
                  <div id={`metadata-edit-${key}`} className="mt-3 grid min-w-0 gap-3 border-t border-line/60 pt-3">
                    <div className="grid min-w-0 gap-1.5">
                      <p className="text-sm font-semibold text-ink">{tt("admin.metadata.genres")}</p>
                      <div className="flex min-w-0 flex-wrap gap-1.5">
                        {BOOK_GENRES.map((genre) => {
                          const on = genres.includes(genre);
                          return (
                            <button
                              key={genre}
                              type="button"
                              className={cn(
                                "min-h-9 rounded border px-2.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                                on
                                  ? "border-accent bg-accent-soft text-accent"
                                  : "border-edge bg-paper text-muted hover:text-ink",
                              )}
                              aria-pressed={on}
                              onClick={() => editRowGenres(row, genre)}
                            >
                              {genreLabel(genre)}
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-xs text-muted">{tt("admin.metadata.genresHint", { n: MAX_GENRES })}</p>
                    </div>
                    <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
                      <label className="grid min-w-0 gap-1 text-sm">
                        <span className="font-semibold text-ink">{tt("admin.metadata.series")}</span>
                        <input
                          className={cn(field, "min-w-0")}
                          value={draft?.series ?? row.series}
                          onChange={(event) => setDrafts(setRowSeries(novelRows, key, drafts, event.target.value))}
                          placeholder={tt("admin.metadata.seriesPlaceholder")}
                          maxLength={80}
                          lang="en"
                          data-metadata-series
                        />
                      </label>
                      <label className="grid min-w-0 gap-1 text-sm">
                        <span className="font-semibold text-ink">{tt("admin.metadata.seriesNumber")}</span>
                        <input
                          className={cn(field, "min-w-0")}
                          type="number"
                          min={0}
                          max={99}
                          value={number || ""}
                          onChange={(event) =>
                            setDrafts(
                              setRowSeriesNumber(
                                novelRows,
                                key,
                                drafts,
                                event.target.value === "" ? null : Number(event.target.value),
                              ),
                            )
                          }
                          placeholder={tt("admin.metadata.seriesNumberPlaceholder")}
                          disabled={!series}
                          data-metadata-number
                        />
                      </label>
                      <button
                        type="button"
                        className={cn(btn.quiet, "self-end")}
                        onClick={() => confirmNumber(row)}
                        disabled={!series}
                        data-metadata-confirm-number
                      >
                        <Check className="size-4" aria-hidden />
                        {tt("admin.metadata.confirmNumber")}
                      </button>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={btn.ghost}
                        onClick={() => setDrafts(setRowSeriesNumber(novelRows, key, drafts, null))}
                        disabled={!series}
                      >
                        {tt("admin.metadata.noNumber")}
                      </button>
                      <button type="button" className={btn.ghost} onClick={() => setDrafts(resetRowDraft(drafts, key))}>
                        <X className="size-4" aria-hidden />
                        {tt("admin.metadata.resetRow")}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={clearGenresOpen}
        onOpenChange={setClearGenresOpen}
        title={tt("admin.metadata.clearGenresTitle")}
        description={tt("admin.metadata.clearGenresBody", { n: selectedCount })}
        confirmLabel={tt("admin.metadata.clearGenresConfirm")}
        onConfirm={() => {
          applyGenres("clear");
          setClearGenresOpen(false);
        }}
      />
      <ConfirmDialog
        open={clearSeriesOpen}
        onOpenChange={setClearSeriesOpen}
        title={tt("admin.metadata.clearSeriesTitle")}
        description={tt("admin.metadata.clearSeriesBody", { n: selectedCount })}
        confirmLabel={tt("admin.metadata.clearSeriesConfirm")}
        onConfirm={clearSeries}
      />
      <ConfirmDialog
        open={refreshOpen}
        onOpenChange={setRefreshOpen}
        title={tt("admin.metadata.refreshTitle")}
        description={tt("admin.metadata.refreshBody", { n: draftTotal })}
        confirmLabel={tt("admin.metadata.refreshConfirm")}
        onConfirm={() => {
          setRefreshOpen(false);
          void loadRows(false);
        }}
      />
      <ConfirmDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title={tt("admin.metadata.saveTitle")}
        description={tt("admin.metadata.saveBody", { n: preview.length })}
        confirmLabel={tt("admin.metadata.saveConfirm")}
        onConfirm={() => {
          setSaveOpen(false);
          void save();
        }}
      />
    </div>
  );
}
