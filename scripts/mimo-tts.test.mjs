import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  audioOfCompletion,
  base64ToBytes,
  cleanSpeechText,
  DEFAULT_VOICE,
  isMimoVoice,
  MAX_SPEECH_CHARS,
  MIMO_ENDPOINT,
  MIMO_TTS_MODEL,
  MIMO_VOICES,
  pcm16ToFloat32,
  pcm16ToWav,
  readAudioEvents,
  speechRequestBody,
  speechRequestInit,
  synthesizePcmStream,
  synthesizeWav,
  TtsError,
  ttsErrorForStatus,
} from "../src/lib/mimo-tts.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

test("the request is the MiMo-V2.5-TTS chat call with the text as the assistant message", () => {
  assert.equal(MIMO_ENDPOINT, "https://api.xiaomimimo.com/v1/chat/completions");
  assert.equal(MIMO_TTS_MODEL, "mimo-v2.5-tts");
  const whole = JSON.parse(speechRequestBody("Hello there.", "Mia", false));
  assert.deepEqual(whole, {
    model: "mimo-v2.5-tts",
    messages: [{ role: "assistant", content: "Hello there." }],
    audio: { voice: "Mia", format: "wav" },
  });
  const streamed = JSON.parse(speechRequestBody("Hello there.", "Dean", true));
  assert.equal(streamed.stream, true);
  assert.deepEqual(streamed.audio, { voice: "Dean", format: "pcm16" }, "streaming asks for raw PCM16 so chunks join");
  assert.ok(!streamed.messages.some((message) => message.role === "user"), "no style prompt in the user role");
});

test("the key is a bearer token, sent with no cookies", () => {
  const init = speechRequestInit("  sk-abc  ", "{}");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, "Bearer sk-abc");
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
});

test("English preset voices only, Mia by default", () => {
  assert.deepEqual(MIMO_VOICES.map((voice) => voice.id), ["Mia", "Chloe", "Milo", "Dean"]);
  assert.equal(DEFAULT_VOICE, "Mia");
  assert.ok(isMimoVoice("Chloe"));
  assert.ok(!isMimoVoice("mimo_default"), "the Chinese default voice is not offered for English books");
});

test("speech text drops soft hyphens and invisible marks, collapses space, and is cut at a sentence end", () => {
  const shy = String.fromCharCode(0xad);
  const zw = String.fromCharCode(0x200b);
  assert.equal(cleanSpeechText(`  Rab${shy}bit${zw} ran\n\n  away. `), "Rabbit ran away.");
  const sentence = "The White Rabbit hurried along the bank. ";
  const long = sentence.repeat(Math.ceil((MAX_SPEECH_CHARS * 1.5) / sentence.length));
  const cut = cleanSpeechText(long);
  assert.ok(cut.length <= MAX_SPEECH_CHARS);
  assert.ok(cut.endsWith("bank."), "cut after a whole sentence");
});

test("statuses map to what the reader can do", () => {
  assert.equal(ttsErrorForStatus(401), "key");
  assert.equal(ttsErrorForStatus(403), "key");
  assert.equal(ttsErrorForStatus(429), "rate");
  assert.equal(ttsErrorForStatus(402), "rate");
  assert.equal(ttsErrorForStatus(500), "server");
  assert.equal(ttsErrorForStatus(400), "server");
});

test("a whole WAV answer and streamed PCM events are both read", () => {
  assert.equal(audioOfCompletion({ choices: [{ message: { audio: { data: "QUJD" } } }] }), "QUJD");
  assert.equal(audioOfCompletion({ choices: [] }), "");
  const got = [];
  const event = (data) => `data: ${JSON.stringify({ choices: [{ delta: { audio: { data } } }] })}\n\n`;
  // Split mid-event: the tail carries over to the next read.
  const text = event("AAA=") + event("BBB=") + "data: [DONE]\n\n";
  const cut = 30;
  let tail = readAudioEvents(text.slice(0, cut), (value) => got.push(value));
  tail = readAudioEvents(tail + text.slice(cut), (value) => got.push(value));
  readAudioEvents(`${tail}\n`, (value) => got.push(value));
  assert.deepEqual(got, ["AAA=", "BBB="]);
  const skipped = [];
  readAudioEvents("data: {not json}\n: comment\nevent: ping\n", (value) => skipped.push(value));
  assert.deepEqual(skipped, [], "malformed events and comments are ignored");
});

test("PCM16 becomes a playable 24 kHz mono WAV and Web Audio samples", () => {
  const pcm = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80]);
  const wav = pcm16ToWav(pcm);
  const view = new DataView(wav.buffer);
  assert.equal(Buffer.from(wav.slice(0, 4)).toString(), "RIFF");
  assert.equal(Buffer.from(wav.slice(8, 12)).toString(), "WAVE");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), 24000, "24 kHz");
  assert.equal(view.getUint16(34, true), 16, "16-bit");
  assert.equal(view.getUint32(40, true), pcm.byteLength);
  assert.equal(wav.byteLength, 44 + pcm.byteLength);
  const samples = pcm16ToFloat32(pcm);
  assert.equal(samples.length, 3);
  assert.equal(samples[0], 0);
  assert.ok(samples[1] > 0.999);
  assert.equal(samples[2], -1);
  assert.deepEqual([...base64ToBytes(b64([1, 2, 3]))], [1, 2, 3]);
});

test("requests go to Xiaomi with the key and turn answers and failures into audio or a reason", async () => {
  const original = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { audio: { data: b64([9, 8, 7]) } } }] }), { status: 200 });
    };
    const wav = await synthesizeWav("sk-test", "Chloe", "Hi.");
    assert.deepEqual([...wav], [9, 8, 7]);
    assert.equal(calls[0].url, MIMO_ENDPOINT);
    assert.equal(calls[0].init.headers.authorization, "Bearer sk-test");
    assert.equal(JSON.parse(calls[0].init.body).audio.voice, "Chloe");

    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 });
    await assert.rejects(synthesizeWav("bad", "Mia", "Hi."), (error) => error instanceof TtsError && error.code === "key");
    globalThis.fetch = async () => new Response("{}", { status: 429 });
    await assert.rejects(synthesizeWav("k", "Mia", "Hi."), (error) => error.code === "rate");
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(synthesizeWav("k", "Mia", "Hi."), (error) => error.code === "network");
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 });
    await assert.rejects(synthesizeWav("k", "Mia", "Hi."), (error) => error.code === "empty");

    // Streaming: chunks arrive one by one and are also joined for the cache.
    const events = [b64([1, 0, 2, 0]), b64([3, 0])]
      .map((data) => `data: ${JSON.stringify({ choices: [{ delta: { audio: { data } } }] })}\n\n`)
      .join("") + "data: [DONE]\n\n";
    globalThis.fetch = async () => new Response(new Blob([events]).stream(), { status: 200 });
    const parts = [];
    const all = await synthesizePcmStream("k", "Milo", "A long paragraph.", (pcm) => parts.push([...pcm]));
    assert.deepEqual(parts, [[1, 0, 2, 0], [3, 0]]);
    assert.deepEqual([...all], [1, 0, 2, 0, 3, 0]);
  } finally {
    globalThis.fetch = original;
  }
});

test("the key stays on the device: not synced, cleared with the device, never sent to our API", () => {
  const settings = read("src/lib/tts-settings.ts");
  assert.match(settings, /TTS_SETTINGS_KEY = "cibian-mimo-tts-v1"/);
  assert.match(read("src/lib/device-wipe.ts"), /"cibian-mimo-tts-v1",/, "Sign out and clear removes the key");
  for (const file of ["src/lib/sync-merge.ts", "src/lib/sync-engine.ts", "src/lib/reader-prefs.ts"]) {
    assert.doesNotMatch(read(file), /apiKey|mimo-tts|tts-settings/, `${file} never carries the key`);
  }
  const client = read("src/lib/mimo-tts.ts");
  assert.doesNotMatch(client, /\/api\//, "the client talks to Xiaomi only");
  assert.doesNotMatch(read("src/lib/read-aloud.ts"), /localStorage|indexedDB|caches\./, "generated audio is kept in memory only");
});

test("read aloud lives in Account and the paragraph help, only with a key", () => {
  const account = read("src/components/account-dialog.tsx");
  assert.match(account, /type AccountPage = "home" \| "quota" \| "general" \| "tts" \| "delete";/);
  assert.match(account, /data-account-row="tts"/);
  assert.match(account, /<TtsSettings \/>/);
  const help = read("src/components/help-panels.tsx");
  assert.match(help, /<ReadAloudButton owner="para" text=\{paragraphText\} label=\{t\("tts\.readParagraph"\)\} \/>/);
  assert.equal((help.match(/label=\{t\("tts\.readSentence"\)\}/g) ?? []).length, 2, "grammar and sentence notes");
  const button = read("src/components/read-aloud-button.tsx");
  assert.match(button, /if \(!ready \|\| !text\.trim\(\)\) return null;/, "hidden without a key or on engines that cannot play");
  for (const locale of ["en", "zh"]) {
    const dict = read(`src/lib/i18n-${locale}.ts`);
    for (const key of ["tts.title", "tts.readParagraph", "tts.readSentence", "tts.err.key", "tts.err.rate", "tts.privacy"]) {
      assert.match(dict, new RegExp(`"${key.replaceAll(".", "\\.")}":`), `${locale}: ${key}`);
    }
  }
});
