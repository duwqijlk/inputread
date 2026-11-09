import { createRoot } from "react-dom/client";
import { NewBooksCarousel } from "../../src/components/new-books-carousel";
import type { DiscoverRow } from "../../src/components/discover-browse";
import { useLocale } from "../../src/lib/i18n";
import "../../src/styles.css";

useLocale.setState({ locale: "en" });
const rows = [
  { id: "preview-short", title: "The Lantern Seller", words: 2253, phrases: 827, notes: 26 },
  { id: "preview-long", title: "The Lantern Seller and the Journey Across the River", words: 12500, phrases: 2640, notes: 124 },
].map(({ id, title, words, phrases, notes }): DiscoverRow => ({
  key: `list:${id}`, id, kind: "list", title, author: "Sample Author", lexile: "", isbn: "", series: "", seriesNumber: 0,
  category: "novel", oldFashioned: false, oldFashionedReason: "", updated: "", added: "2026-11-09",
  list: { id, title, author: "Sample Author", words, phrases, paragraphs: notes, sentences: 0, category: "novel", genres: [],
    lexile: "", isbn: "", series: "", seriesNumber: 0, cover: null, glossary: { url: "", bytes: 0, sha256: "" },
    oldFashioned: false, oldFashionedReason: "", updated: "", added: "2026-11-09" },
}));
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  if (String(input).includes("/word-lists/preview-") && String(input).endsWith("/blurb.json")) {
    return Promise.resolve(new Response(JSON.stringify({ en: "The lantern seller follows a narrow path beside the river. When rain begins to fall, the journey becomes harder, and a small act of kindness changes the way home.", zh: "" }), { headers: { "content-type": "application/json" } }));
  }
  return originalFetch(input, init);
};
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-4xl px-3 py-5 text-ink">
    <p className="mb-4 text-sm text-muted">Local banner spacing preview — synthetic books, no account writes.</p>
    <NewBooksCarousel rows={rows} detailOpen={false} onOpen={() => {}} />
  </main>,
);
