import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/error-boundary";
import { MarginApp } from "@/components/margin-app";
import { listBookSummaries, listPackRecords } from "@/lib/book-db";
import { finishDeviceWipe } from "@/lib/device-wipe";
import { useLocale } from "@/lib/i18n";
import { BUNDLED_CATALOG_URL, downloadPack, loadCatalog } from "@/lib/packs";
import { clearPackRemoved } from "@/lib/removed-packs";
import { registerInstalled } from "@/lib/shelf-register";
import { useFeedbackTip, useQuoteTip, useTutorial } from "@/lib/tutorial";
import { markVocabHydrated, useVocab } from "@/lib/vocab-store";

/**
 * DEV-only helper: when a developer reloads `/read/<bookId>` directly, check whether that book came
 * from a local preview pack whose `rev` has changed on disk, and refresh its IndexedDB glossary in place.
 */
export async function syncDevReadPackIfStale(bookId: string): Promise<void> {
  if (!bookId) return;
  try {
    const records = await listPackRecords();
    const existing = records.find((record) => record.bookId === bookId);
    if (!existing) return;
    try {
      localStorage.removeItem("cibian-catalog-cache-v1");
    } catch {
      // Storage may be blocked in private mode.
    }
    const { catalog } = await loadCatalog(BUNDLED_CATALOG_URL);
    const pack = catalog.packs.find((item) => item.id === existing.packId);
    if (!pack || pack.rev === existing.rev) return;
    await useVocab.persist.rehydrate();
    const summaries = await listBookSummaries();
    useVocab.getState().restoreBooks(summaries);
    markVocabHydrated();
    const result = await downloadPack(BUNDLED_CATALOG_URL, pack, () => undefined, existing.bookId);
    clearPackRemoved(pack.id);
    registerInstalled(result, {
      oldFashioned: pack.oldFashioned,
      oldFashionedReason: pack.oldFashionedReason,
    });
  } catch (error) {
    console.error("[companion-preview-sync]", error);
  }
}

/**
 * DEV-only host (`/shelf/?demo=companion`): installs or refreshes a public-domain preview pack
 * from the local dev catalog into IndexedDB and opens Chapter 1 in the real reader.
 */
export async function bootCompanionPreview(rootEl: HTMLElement): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const lang = params.get("lang");
  if (lang === "zh" || lang === "en") useLocale.getState().setLocale(lang);

  useTutorial.getState().hide();
  useFeedbackTip.getState().hide();
  useQuoteTip.getState().hide();

  await finishDeviceWipe().catch(() => false);
  try {
    localStorage.removeItem("cibian-catalog-cache-v1");
  } catch {
    // Storage may be blocked in private mode.
  }

  try {
    await useVocab.persist.rehydrate();
    const summaries = await listBookSummaries();
    useVocab.getState().restoreBooks(summaries);
    markVocabHydrated();

    const packId = params.get("book") || "alice";
    const { catalog } = await loadCatalog(BUNDLED_CATALOG_URL);
    const pack = catalog.packs.find((item) => item.id === packId) ?? catalog.packs[0];
    if (pack) {
      const records = await listPackRecords();
      const existing = records.find((record) => record.packId === pack.id);
      const onShelf = existing
        ? useVocab.getState().books.some((book) => book.id === existing.bookId)
        : false;
      let bookId = existing?.bookId ?? "";
      if (!existing || existing.rev !== pack.rev || !onShelf) {
        const result = await downloadPack(
          BUNDLED_CATALOG_URL,
          pack,
          () => undefined,
          existing?.bookId,
        );
        clearPackRemoved(pack.id);
        registerInstalled(result, {
          oldFashioned: pack.oldFashioned,
          oldFashionedReason: pack.oldFashionedReason,
        });
        bookId = result.bookId;
      }
      if (bookId) {
        window.history.replaceState(null, "", `/read/${encodeURIComponent(bookId)}`);
      }
    }
  } catch (error) {
    console.error("[companion-preview]", error);
  }

  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary>
        <MarginApp />
      </ErrorBoundary>
    </StrictMode>,
  );
}
