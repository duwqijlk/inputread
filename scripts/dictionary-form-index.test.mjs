import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { encodeJson, entryPath, inventorySha256, lowerKey, sha256, shardId } from './build-dictionary-case-index.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'build-dictionary-form-index.py');
const release = 'oewn-2025-fixture';
const run = (f, out = f.out) => spawnSync('python', ['-I', script, '--source', f.source, '--release', f.root, '--out', out], { encoding: 'utf8' });
const git = (source, ...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();

function fixture(t, mutate = () => {}) {
  const temp = mkdtempSync(join(tmpdir(), 'dictionary-forms-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const source = join(temp, 'source');
  const root = join(temp, 'release');
  mkdirSync(join(source, 'src/yaml'), { recursive: true });
  const entries = {
    child: { n: { form: ['children', 'CHILDREN'], sense: [{ id: 'child-n' }] }, v: { sense: [{ id: 'child-v' }] } },
    go: { v: { form: ['went'], sense: [{ id: 'go-v' }, { id: 'go-v2' }] } },
    learn: { v: { form: ['learnt'], sense: [{ id: 'learn-v' }] } },
    axe: { n: { form: ['axes'], sense: [{ id: 'axe-n' }] } },
    axis: { n: { form: ['axes'], sense: [{ id: 'axis-n' }] } },
    I: { n: { form: ['İ', 'É', 'É', '__proto__', 'ΟΣ', '𐐀'], sense: [{ id: 'I-n' }] } },
  };
  mutate(entries);
  // JSON is valid YAML; no helper import or fake source IDs are needed by the builder.
  writeFileSync(join(source, 'src/yaml/entries-test.yaml'), JSON.stringify(entries));
  writeFileSync(join(source, 'src/yaml/frames.yaml'), '{}\n');
  git(source, 'init', '-q');
  git(source, 'config', 'core.autocrlf', 'false');
  git(source, 'add', '.');
  git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const commit = git(source, 'rev-parse', 'HEAD');
  const f = { temp, source, root, entries, commit, out: join(temp, 'out') };
  saveRelease(f);
  return f;
}

function saveRelease(f, mutate = () => {}) {
  rmSync(f.root, { force: true, recursive: true });
  mkdirSync(join(f.root, 'words'), { recursive: true });
  const rows = [];
  let senseCount = 0;
  for (const [lemma, groups] of Object.entries(f.entries)) {
    const senses = Object.entries(groups).flatMap(([lexicalKey, entry]) => entry.sense.map(({ id }) => ({ id, pos: lexicalKey[0], meaning: 'Immutable definition.' })));
    const entry = { schema: 'oewn-r2-entry-v1', release, lookupKey: lemma, senses };
    mutate(entry);
    const relative = entryPath(lemma);
    const body = encodeJson(entry);
    mkdirSync(dirname(join(f.root, relative)), { recursive: true });
    writeFileSync(join(f.root, relative), body);
    rows.push([lemma, relative, sha256(body)]);
    senseCount += entry.senses.length;
  }
  f.manifest = { schema: 'oewn-r2-manifest-v1', release, learningCommit: f.commit,
    wordCount: rows.length, senseCount, inventorySha256: inventorySha256(rows) };
  writeFileSync(join(f.root, 'manifest.json'), encodeJson(f.manifest));
}

function tree(path, prefix = '') {
  return readdirSync(path).sort().flatMap((name) => {
    const child = join(path, name);
    return lstatSync(child).isDirectory() ? tree(child, `${prefix}${name}/`) : [[prefix + name, sha256(readFileSync(child))]];
  });
}

function success(f, out = f.out) {
  const result = run(f, out);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function rejected(f, pattern, out = f.out) {
  const result = run(f, out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
  assert.equal(existsSync(out), false);
}

test('explicit exception shards preserve exact lemmas/POS, ambiguity, JS Unicode, hashes and immutable inputs', (t) => {
  const f = fixture(t);
  const before = [tree(f.source), tree(f.root)];
  const report = success(f);
  const again = join(f.temp, 'again');
  assert.deepEqual(success(f, again), report);
  assert.deepEqual(tree(f.out), tree(again));
  assert.deepEqual([tree(f.source), tree(f.root)], before);
  assert.match(report.indexVersion, /^forms-v1-[0-9a-f]{12}$/);
  assert.equal(report.sourceCommit, f.commit);
  assert.equal(report.sourceInventorySha256, f.manifest.inventorySha256);
  const directory = join(f.out, 'dictionary/form-indexes', report.indexVersion);
  assert.equal(readdirSync(directory).length, 257);
  assert.equal(existsSync(join(f.out, 'dictionary/current.json')), false);
  const collected = new Map();
  let maxBytes = 0;
  for (let n = 0; n < 256; n++) {
    const shard = n.toString(16).padStart(2, '0');
    const body = readFileSync(join(directory, `${shard}.json`));
    const data = JSON.parse(body);
    assert.equal(data.schema, 'oewn-form-index-v1');
    assert.equal(data.release, release);
    assert.equal(data.indexVersion, report.indexVersion);
    assert.equal(data.shard, shard);
    assert.deepEqual(report.files[`${shard}.json`], { sha256: sha256(body), bytes: body.length });
    for (const [key, candidates] of Object.entries(data.entries)) {
      assert.equal(shardId(key), shard);
      assert.equal(lowerKey(key), key);
      assert.equal(collected.has(key), false);
      collected.set(key, candidates);
      assert.deepEqual(candidates, [...candidates].sort((a, b) => Buffer.compare(Buffer.from(a.lemma), Buffer.from(b.lemma)) || a.pos.localeCompare(b.pos)));
      for (const { lemma, pos } of candidates) {
        const entry = JSON.parse(readFileSync(join(f.root, entryPath(lemma))));
        assert.ok(entry.senses.some(s => s.pos === pos));
      }
    }
    maxBytes = Math.max(maxBytes, body.length);
  }
  assert.deepEqual(collected.get('children'), [{ lemma: 'child', pos: 'n' }]);
  assert.deepEqual(collected.get('went'), [{ lemma: 'go', pos: 'v' }]);
  assert.deepEqual(collected.get('learnt'), [{ lemma: 'learn', pos: 'v' }]);
  assert.deepEqual(collected.get('axes'), [{ lemma: 'axe', pos: 'n' }, { lemma: 'axis', pos: 'n' }]);
  for (const key of ['i̇', 'é', '__proto__', 'ος', '𐐨']) assert.deepEqual(collected.get(key), [{ lemma: 'I', pos: 'n' }]);
  for (const key of ['childs', 'goed', 'learned', 'learns', 'going', 'child']) assert.equal(collected.has(key), false);
  assert.equal(report.summary.maxShardBytes, maxBytes);
  assert.equal(report.summary.groupCount, collected.size);
  assert.equal(report.summary.ambiguousCount, 1);
  const groups = [...collected].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  assert.equal(report.indexVersion, `forms-v1-${sha256(encodeJson({ release, sourceCommit: f.commit, entries: groups })).slice(0, 12)}`);
  const saved = JSON.parse(readFileSync(join(directory, 'manifest.json')));
  const { status, ...expected } = report;
  assert.equal(status, 'built-not-uploaded');
  assert.deepEqual(saved, expected);
});

for (const [label, mutate, pattern] of [
  ['mismatched HEAD', f => { writeFileSync(join(f.root, 'manifest.json'), encodeJson({ ...f.manifest, learningCommit: '0'.repeat(40) })); }, /HEAD must match/],
  ['dirty YAML', f => writeFileSync(join(f.source, 'src/yaml/entries-test.yaml'), '{}'), /must be clean/],
  ['untracked YAML', f => writeFileSync(join(f.source, 'src/yaml/entries-other.yaml'), '{}'), /must be clean/],
  ['ignored inventory addition', f => { writeFileSync(join(f.source, '.git/info/exclude'), 'src/yaml/extra.yaml\n'); writeFileSync(join(f.source, 'src/yaml/extra.yaml'), '{}'); }, /inventory differs/],
  ['hidden modified bytes', f => { git(f.source, 'update-index', '--assume-unchanged', 'src/yaml/entries-test.yaml'); writeFileSync(join(f.source, 'src/yaml/entries-test.yaml'), '{}'); }, /bytes differ/],
  ['corrupt release bytes', f => { const path = join(f.root, entryPath('child')); writeFileSync(path, readFileSync(path, 'utf8').replace('Immutable', 'Changed')); }, /inventory SHA256/],
  ['wrong sense binding', f => saveRelease(f, entry => { if (entry.lookupKey === 'child') entry.senses[0].id = 'new-id'; }), /sense\/POS inventory mismatch/],
  ['wrong POS binding', f => saveRelease(f, entry => { if (entry.lookupKey === 'child') entry.senses[0].pos = 'a'; }), /sense\/POS inventory mismatch/],
  ['missing source lemma', f => { delete f.entries.axis; saveRelease(f); }, /sense\/POS inventory mismatch/],
  ['release count', f => writeFileSync(join(f.root, 'manifest.json'), encodeJson({ ...f.manifest, senseCount: 999 })), /senseCount mismatch/],
]) {
  test(`rejects ${label} before output creation`, (t) => {
    const f = fixture(t);
    mutate(f);
    rejected(f, pattern);
  });
}

test('rejects malformed explicit forms and duplicate YAML keys without invoking source scripts', (t) => {
  const f = fixture(t, entries => { entries.child.n.form = 'children'; });
  mkdirSync(join(f.source, 'scripts'));
  writeFileSync(join(f.source, 'scripts/learning_gloss_format.py'), 'raise Exception("must never execute")');
  rejected(f, /Invalid explicit form array/);
  writeFileSync(join(f.source, 'src/yaml/entries-test.yaml'), 'child: {}\nchild: {}\n');
  git(f.source, 'add', '.');
  git(f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'duplicate');
  f.commit = git(f.source, 'rev-parse', 'HEAD');
  saveRelease(f);
  rejected(f, /Duplicate YAML key/);
});

test('rejects reused or source-contained output and missing CLI arguments', (t) => {
  const f = fixture(t);
  mkdirSync(f.out);
  writeFileSync(join(f.out, 'keep'), 'keep');
  assert.match(run(f).stderr, /new directory outside/);
  assert.equal(readFileSync(join(f.out, 'keep'), 'utf8'), 'keep');
  rejected(f, /new directory outside/, join(f.source, 'forbidden'));
  rejected(f, /new directory outside/, join(f.root, 'forbidden'));
  const result = spawnSync('python', ['-I', script], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required/);
});
