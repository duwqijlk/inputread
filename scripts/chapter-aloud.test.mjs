import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { joinWavs, prefetchPlan, readPcmWav, SPEECH_BATCH_CHARS, SPOKEN_CHARS_PER_SECOND, splitForSpeech } from "../src/lib/speech-split.ts";
import { pcm16ToWav } from "../src/lib/mimo-tts.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a paragraph is cut into whole-sentence batches under MiMo's limit, and nothing is lost", () => {
  assert.ok(SPEECH_BATCH_CHARS <= 900, "a margin under the 1000-character request limit");
  assert.deepEqual(splitForSpeech("  Short   one.  "), ["Short one."]);
  assert.deepEqual(splitForSpeech(""), []);
  const sentence = "Alice was beginning to get very tired of sitting by her sister on the bank. ";
  const text = sentence.repeat(30);
  const batches = splitForSpeech(text);
  assert.ok(batches.length > 1);
  for (const batch of batches) {
    assert.ok(batch.length <= SPEECH_BATCH_CHARS, `batch of ${batch.length}`);
    assert.ok(batch.endsWith("bank."), "every batch ends at a sentence end");
  }
  assert.equal(batches.join(" "), text.trim(), "joined back, the paragraph is whole");
});

test("closing quotes stay with their sentence; an overlong sentence is cut at a comma or a space", () => {
  const close = String.fromCharCode(0x201d);
  const quoted = splitForSpeech(`"Oh dear! Oh dear! I shall be late!${close} said the Rabbit. It ran on.`, 40);
  assert.equal(quoted[0], `"Oh dear! Oh dear! I shall be late!${close}`);
  const commas = Array.from({ length: 80 }, (_, i) => `clause number ${i}`).join(", ") + ".";
  for (const batch of splitForSpeech(commas)) {
    assert.ok(batch.length <= SPEECH_BATCH_CHARS);
    assert.ok(/(,|\.)$/.test(batch), "cut after a comma");
  }
  const words = `${"word ".repeat(500)}end.`;
  const cut = splitForSpeech(words);
  assert.ok(cut.every((batch) => batch.length <= SPEECH_BATCH_CHARS && !batch.startsWith(" ")));
  assert.equal(cut.join(" "), words.trim());
});

test("the WAVs of one paragraph join into one seamless file", () => {
  const a = pcm16ToWav(new Uint8Array([1, 0, 2, 0]));
  const b = pcm16ToWav(new Uint8Array([3, 0]));
  const joined = joinWavs([a, b]);
  const info = readPcmWav(joined);
  assert.equal(info.rate, 24000);
  assert.equal(info.channels, 1);
  assert.deepEqual([...info.pcm], [1, 0, 2, 0, 3, 0], "samples back to back, no gap");
  assert.equal(new DataView(joined.buffer).getUint32(4, true), 36 + 6);
  // Different formats cannot be joined (the engine then plays them one after another).
  const other = pcm16ToWav(new Uint8Array([4, 0]), 16000);
  assert.equal(joinWavs([a, other]), null);
  assert.equal(readPcmWav(new Uint8Array([1, 2, 3])), null);
});

test("about 90 seconds of audio ahead are prepared, counted in time, not in paragraphs", () => {
  const second = SPOKEN_CHARS_PER_SECOND;
  // One-line dialogue (a second each): a fixed "two ahead" fell behind; now it reaches the cap.
  const dialogue = Array.from({ length: 40 }, () => 1 * second);
  assert.deepEqual(prefetchPlan(0, dialogue, 90, 12), Array.from({ length: 13 }, (_, i) => i), "current + 12");
  // Long paragraphs (a minute each): the next two cover 90 seconds.
  const long = Array.from({ length: 10 }, () => 60 * second);
  assert.deepEqual(prefetchPlan(3, long, 90, 12), [3, 4, 5]);
  // Never past the end, never before the start.
  assert.deepEqual(prefetchPlan(8, dialogue.slice(0, 10), 90, 12), [8, 9]);
  assert.deepEqual(prefetchPlan(0, [], 90, 12), []);
});

test("chapter reading: one audio element (lock screen), Media Session, two requests at a time well ahead", () => {
  const engine = read("src/lib/chapter-aloud.ts");
  assert.match(engine, /new Audio\(\)/, "an <audio> element, which keeps playing with the screen locked");
  assert.match(engine, /navigator\.mediaSession\.metadata = new MediaMetadata/);
  for (const action of ["play", "pause", "previoustrack", "nexttrack", "stop"]) assert.match(engine, new RegExp(`"${action}"`));
  assert.match(engine, /const AHEAD_SECONDS = 90;/);
  assert.match(engine, /const CONCURRENCY = 2;/, "two requests at a time");
  assert.match(engine, /else if \(urgent\) waiting\.unshift\(go\);/, "the paragraph needed now goes first");
  assert.match(engine, /code === "rate" \|\| code === "network" \|\| code === "server"/, "rate limits and dropped connections are retried");
  assert.match(engine, /splitForSpeech\(text\)/);
  assert.match(engine, /joinWavs\(wavs\)/);
  assert.match(engine, /const PARAGRAPH_PAUSE_MS = 3\d\d;/, "a short breath between paragraphs");
  assert.match(engine, /return \[withPause\(joined\)\];/, "the pause is silence inside the paragraph's audio");
  assert.doesNotMatch(engine, /setTimeout\([^)]*playFrom|gapTimer/, "no timer between paragraphs (a locked phone throttles timers)");
  assert.match(engine, /void el\.play\(\)\.catch/, "the element is unlocked inside the tap");
  assert.doesNotMatch(engine, /localStorage|indexedDB|caches\./, "prepared audio stays in memory");
  // Locked screen: silence keeps the audio going while the next paragraph is made; a pause we did
  // not ask for (a call) shows as paused instead of restarting by itself.
  assert.match(engine, /if \(waitingForAudio\) holdSilence\(\);/);
  assert.match(engine, /audio\.addEventListener\("pause"/);
  assert.match(engine, /export function openAloudPanel/);
  // Chapter reading and single-text reading never sound together.
  assert.match(engine, /window\.addEventListener\(SINGLE_STARTS/);
  assert.match(read("src/lib/read-aloud.ts"), /window\.addEventListener\("inputread-read-aloud-chapter"/);
});

test("the reader: top-bar button, a speaker after every paragraph, the bar, and the next chapter", () => {
  const reader = read("src/components/reader.tsx");
  assert.match(reader, /<AloudHeaderButton \/>\s*<ReaderSettings \/>/, "beside Aa, and it starts nothing by itself");
  assert.match(reader, /<ParagraphSpeakers/);
  assert.match(reader, /<AloudBar articleRef=\{articleRef\} headerRef=\{headerRef\} version=\{aloudVersion\} onStart=\{\(\) => aloud\.start\(\)\} \/>/, "Play is in the player");
  assert.match(reader, /onNextChapter: \(\) => \{[\s\S]*?goChapter\(safeIndex \+ 1\);\s*return true;/);
  const ui = read("src/components/chapter-aloud.tsx");
  assert.match(ui, /function firstVisibleParagraph/, "starts at the paragraph on screen, not the chapter top");
  assert.match(ui, /mark\.setAttribute\("data-para-ui", ""\);\s*mark\.setAttribute\("data-aloud-from"/, "an empty UI span, outside the text");
  // Paragraph speakers only in read-aloud mode (player open or reading): plain reading keeps just
  // the help mark, so a tap meant for it cannot start reading.
  assert.match(ui, /const mode = useChapterAloud\(\(state\) => state\.panel \|\| state\.status !== "off"\);/);
  assert.match(ui, /if \(!root \|\| !ready \|\| !mode\) return;/);
  assert.match(ui, /root\.setAttribute\("data-aloud-mode", ""\);/);
  // Beside a help mark the two tap areas never meet: the speaker's grows right only, the help
  // mark's stops at its edge in read-aloud mode, and a gap sits between them.
  const styles = read("src/styles.css");
  assert.match(styles, /\.book-body \[data-aloud-from\]::after \{[^}]*left: 0;/);
  assert.match(styles, /\.book-body \[data-para-marker\] \+ \[data-aloud-from\] \{\s*margin-left: 0\.6em;/);
  assert.match(styles, /\.book-body\[data-aloud-mode\] \[data-para-marker\]::after \{\s*right: 0;/);
  assert.match(ui, /if \(!ready\) return null;/, "nothing without a key");
  // The top-bar button opens the player (voice, speed, auto-next, then Play).
  const header = ui.slice(ui.indexOf("export function AloudHeaderButton"), ui.indexOf("const SHOW_OPTIONS"));
  assert.match(header, /else openAloudPanel\(\);/);
  assert.doesNotMatch(header, /startChapterAloud|onStart/, "the top button does not start reading");
  assert.match(ui, /data-aloud-ready/);
  assert.match(ui, /function AloudOptions/);
  assert.match(ui, /data-aloud-play/);
  // Following: a real move of the page we did not make stops it (a tap does not); it comes back
  // by itself once the reader stops and the paragraph is on screen; the highlight stays.
  assert.match(ui, /> 12\) hand\(\);/, "a finger must drag more than a few pixels: a tap is not a scroll");
  assert.match(ui, /const byHand = now - handAt\.current < 450;\s*if \(!byHand && now < autoUntil\.current\)/, "the reader's scroll wins over our smooth scroll");
  assert.match(ui, /window\.addEventListener\("scroll", onScroll/);
  assert.match(ui, /Math\.abs\(window\.scrollY - baseY\.current\) > 48\) setFollow\(false\)/);
  assert.match(ui, /if \(visible\(\)\) \{\s*baseY\.current = window\.scrollY;\s*setFollow\(true\);/, "following comes back on its own");
  assert.match(ui, /data-aloud-follow/);
  const css = read("src/styles.css");
  assert.match(css, /\.book-body \[data-aloud-from\] \{[\s\S]*?mask:/);
  assert.match(css, /\.book-body \[data-aloud-current\] \{/);
  for (const locale of ["en", "zh"]) {
    const dict = read(`src/lib/i18n-${locale}.ts`);
    for (const key of ["aloud.open", "aloud.play", "aloud.options", "aloud.fromHere", "aloud.autoNext", "aloud.backToReading", "aloud.speedTitle"]) {
      assert.match(dict, new RegExp(`"${key.replace(".", "\\.")}":`), `${locale}: ${key}`);
    }
  }
});
