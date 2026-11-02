// Design system visual tidy-up and feel (ColorRoles, ScrollChrome, SpringSheet, ContinueReading,
// BookDetail, LoadingStates, ReviewSession, PressFeedback).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const css = read("src/styles.css");

test("the continue card stops at the book: no last-read quote, no icon in Keep reading", () => {
  const shelf = read("src/components/shelf.tsx");
  assert.doesNotMatch(shelf, /data-continue-last|lastReadLine|shelf\.lastRead/);
  assert.doesNotMatch(shelf, /<BookOpen\b/);
  assert.doesNotMatch(css, /\.continue-last\b/);
});

test("quotes are not read aloud yet: no speaker on a quote card (design system QuoteBook)", () => {
  const book = read("src/components/quote-book.tsx");
  assert.doesNotMatch(book, /speakEnglish|QuoteSpeak|Volume2/);
});

test("a review round runs in focus mode: no site chrome, Esc ends it, the answer bar sits at the bottom", () => {
  const review = read("src/components/review.tsx");
  assert.match(review, /useEffect\(\(\) => holdFocusMode\(\), \[\]\);/);
  assert.match(review, /event\.key !== "Escape"/);
  assert.match(review, /max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0/);
  const app = read("src/components/margin-app.tsx");
  assert.match(app, /const focus = useFocusMode\(\(state\) => state\.on\) && screen\.kind === "review";/);
  assert.match(app, /\{bare \? null : \(\s*<header/);
});

test("offline: a warn notice says what still works and goes away by itself", () => {
  const app = read("src/components/margin-app.tsx");
  assert.match(app, /<Banner tone="warn" data-offline-notice>/);
  assert.match(app, /window\.addEventListener\("online", change\);/);
});

test("press feedback: covers shrink to 98% through the scale property; icons draw at 1.75", () => {
  assert.match(css, /button:active > \.cover-frame,[^{]*\{\s*scale: 0\.98;/);
  assert.match(css, /svg\.lucide\[stroke-width="2"\] \{\s*stroke-width: 1\.75;/);
});

test("book detail: four numbers at 24px (20px on a phone), labels 13px", () => {
  const discover = read("src/components/discover-browse.tsx");
  assert.match(discover, /lexile \? "grid-cols-4" : "grid-cols-3"/);
  assert.match(discover, /text-\[20px\] leading-none sm:text-2xl font-display/);
});

test("sheets follow the finger on a phone: the book detail and the tutorial list", () => {
  assert.match(read("src/components/floating-card.tsx"), /export function useSheetDrag\(/);
  assert.match(read("src/components/discover-browse.tsx"), /useSheetDrag\(sheet, onClose, "\(max-width: 639px\)", open\)/);
  assert.match(read("src/components/tutorial-tab.tsx"), /useSheetDrag\(box, hide, PHONE, from === "center" && phone\)/);
});
