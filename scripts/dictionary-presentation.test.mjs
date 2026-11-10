import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const card = readFileSync(new URL('../src/components/word-card.tsx', import.meta.url), 'utf8');
const float = readFileSync(new URL('../src/components/floating-card.tsx', import.meta.url), 'utf8');
const feedback = readFileSync(new URL('../src/components/word-feedback.tsx', import.meta.url), 'utf8');
function luminance(hex) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return channels.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}
test('four dictionary POS labels have distinct legible theme ink, with black e-ink fallback', () => {
  const colors = [];
  for (const pos of ['noun', 'verb', 'adjective', 'adverb']) {
    const light = css.match(new RegExp(`\\.dictionary-pos\\[data-pos~="${pos}"\\] \\{ color: (#[a-f0-9]{6}); \\}`))[1];
    const dark = css.match(new RegExp(`\\[data-theme="dark"\\] \\.dictionary-pos\\[data-pos~="${pos}"\\] \\{ color: (#[a-f0-9]{6}); \\}`))[1];
    colors.push(light);
    for (const background of ['#ffffff', '#fdfaf3']) assert.ok(contrast(light, background) >= 4.5, pos);
    assert.ok(contrast(dark, '#242a27') >= 4.5, pos);
  }
  assert.equal(new Set(colors).size, 4);
  assert.match(css, /\[data-theme="eink"\] \.dictionary-pos\[data-pos\] \{ color: #000; \}/);
  assert.match(feedback, /className="dictionary-pos[^\"]+" lang="en" data-pos=\{pos.toLowerCase\(\)\}/);
});
test('word cards gain desktop width and reading height without widening tablets or phones', () => {
  assert.match(card, /desktopWidth=\{32 \* 16\}/);
  assert.match(float, /vw < 1024 \? 384 : desktopWidth/);
  assert.match(css, /@media \(min-width: 1024px\) \{\s*\[data-word-card\] \[data-word-body\] \{\s*max-height: min\(70vh, 34rem\)/);
});
