import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  SHARDS, buildDictionaryCaseIndex, compareKeys, createCaseIndex, encodeJson, entryPath,
  groupLemmas, inventorySha256, lowerKey, parseArgs, readRelease, sha256, shardId,
} from './build-dictionary-case-index.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'build-dictionary-case-index.mjs');
const release = 'oewn-2025-test12345678';

function fixture(t, keys = ['US', 'us', 'İ', 'i', 'É', 'é', '__proto__', 'a/b', '\u{10000}', '']) {
  const temp = mkdtempSync(join(tmpdir(), 'dictionary-case-index-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, release);
  mkdirSync(join(root, 'words'), { recursive: true });
  const rows = [];
  for (const [n, key] of keys.entries()) {
    const relative = entryPath(key);
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    const bytes = encodeJson({ schema: 'oewn-r2-entry-v1', release, lookupKey: key, senses: [{ id: `sense-${n}`, meaning: 'Unchanged source meaning.' }] });
    writeFileSync(path, bytes);
    rows.push([key, relative, sha256(bytes)]);
  }
  const manifest = {
    schema: 'oewn-r2-manifest-v1', release, wordCount: keys.length,
    senseCount: keys.length, inventorySha256: inventorySha256(rows),
  };
  writeFileSync(join(root, 'manifest.json'), encodeJson(manifest));
  return { temp, root, manifest, out: join(temp, 'output'), rows };
}

function mutateEntry(root, key, mutate) {
  const path = join(root, entryPath(key));
  const entry = JSON.parse(readFileSync(path, 'utf8'));
  mutate(entry);
  writeFileSync(path, encodeJson(entry));
}

function tree(path, prefix = '') {
  return readdirSync(path).sort().flatMap((name) => {
    const child = join(path, name);
    const relative = prefix + name;
    return lstatSync(child).isDirectory() ? tree(child, `${relative}/`) : [[relative, readFileSync(child).toString('hex')]];
  });
}

test('JS Unicode lowercasing is NFC before and after, not locale or Unicode case folding', () => {
  assert.equal(lowerKey('İ'), 'i̇');
  assert.notEqual(lowerKey('İ'), lowerKey('i'));
  assert.equal(lowerKey('É'), 'é');
  assert.equal(lowerKey('ẞ'), 'ß');
  assert.notEqual(lowerKey('ß'), lowerKey('SS'));
  assert.equal(lowerKey('ΟΣ'), 'ος');
  assert.equal(shardId('hello'), '4f');
  assert.equal(shardId(''), '81');
  assert.equal(shardId('i̇'), independentShard('i̇'));
  assert.deepEqual(groupLemmas(['us', 'US', 'É', '__proto__']), [
    ['__proto__', ['__proto__']], ['us', ['US', 'us']], ['é', ['É']],
  ]);
  assert.throws(() => groupLemmas(['é', 'é']), /Duplicate NFC/);
  assert.throws(() => groupLemmas(['\ud800']), /Invalid lemma/);
});

function independentShard(text) {
  let n = 0x811c9dc5n;
  for (const b of Buffer.from(text)) n = ((n ^ BigInt(b)) * 0x01000193n) & 0xffffffffn;
  return n.toString(16).padStart(8, '0').slice(0, 2);
}

test('inventory hash uses Python scalar ordering, exact paths, bytes and LF rows', () => {
  const rows = [['\u{10000}', 'words/f0/x.json', 'a'], ['', 'words/ee/x.json', 'b'], ['é', 'words/c3/x.json', 'c']];
  const expected = '["é","words/c3/x.json","c"]\n["","words/ee/x.json","b"]\n["\u{10000}","words/f0/x.json","a"]\n';
  assert.equal(inventorySha256(rows), createHash('sha256').update(expected, 'utf8').digest('hex'));
  assert.ok(compareKeys('', '\u{10000}') < 0);
});

test('all 256 shards, manifest hashes and publish candidate are deterministic; source is untouched', (t) => {
  const { root, out, temp, manifest } = fixture(t);
  const before = tree(root);
  const first = buildDictionaryCaseIndex({ root, out });
  const secondOut = join(temp, 'second');
  const second = buildDictionaryCaseIndex({ root, out: secondOut });
  assert.deepEqual(first, second);
  assert.deepEqual(tree(out), tree(secondOut));
  assert.deepEqual(tree(root), before);
  assert.equal(first.wordCount, 10);
  assert.equal(first.groupCount, 8);
  assert.equal(first.ambiguousCount, 2);
  assert.equal(first.sourceInventorySha256, manifest.inventorySha256);
  assert.match(first.indexVersion, /^case-v1-[0-9a-f]{12}$/);
  const directory = join(out, 'dictionary', 'case-indexes', first.indexVersion);
  assert.deepEqual(readdirSync(directory).sort(), [...SHARDS.map((s) => `${s}.json`), 'manifest.json'].sort());
  let maximum = 0;
  const collected = new Map();
  for (const shard of SHARDS) {
    const bytes = readFileSync(join(directory, `${shard}.json`));
    const data = JSON.parse(bytes);
    assert.deepEqual(first.files[`${shard}.json`], { sha256: sha256(bytes), bytes: bytes.length });
    assert.equal(data.schema, 'oewn-case-index-v1');
    assert.equal(data.release, release);
    assert.equal(data.indexVersion, first.indexVersion);
    assert.equal(data.shard, shard);
    for (const [lower, candidates] of Object.entries(data.entries)) {
      assert.equal(shardId(lower), shard);
      assert.ok(!collected.has(lower));
      collected.set(lower, candidates);
      assert.ok(candidates.every((key) => lowerKey(key) === lower));
    }
    maximum = Math.max(maximum, bytes.length);
  }
  assert.deepEqual(collected.get('us'), ['US', 'us']);
  assert.deepEqual(collected.get('i̇'), ['İ']);
  assert.deepEqual(collected.get('i'), ['i']);
  assert.deepEqual(collected.get('__proto__'), ['__proto__']);
  assert.equal(maximum, first.maxShardBytes);
  const saved = JSON.parse(readFileSync(join(directory, 'manifest.json')));
  const { maxShardBytes, ...onDisk } = first;
  assert.deepEqual(saved, JSON.parse(JSON.stringify(onDisk)));
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'dictionary', 'current.json'))), {
    schema: 'oewn-r2-current-v1', release, caseIndex: first.indexVersion,
  });
});

test('version covers release and all candidates, independent of input order', () => {
  const keys = ['US', 'us', 'İ', 'i', 'é'];
  const first = createCaseIndex(release, keys);
  const reordered = createCaseIndex(release, [...keys].reverse());
  assert.deepEqual([...first.files], [...reordered.files]);
  assert.equal(first.indexVersion, reordered.indexVersion);
  assert.notEqual(first.indexVersion, createCaseIndex(`${release}-other`, keys).indexVersion);
  assert.notEqual(first.indexVersion, createCaseIndex(release, keys.slice(1)).indexVersion);
  const grouped = groupLemmas(keys);
  assert.equal(first.indexVersion, `case-v1-${sha256(encodeJson({ release, entries: grouped })).slice(0, 12)}`);
});

for (const [name, mutate, pattern] of [
  ['word count', ({ root, manifest }) => writeFileSync(join(root, 'manifest.json'), encodeJson({ ...manifest, wordCount: 99 })), /wordCount mismatch/],
  ['sense count', ({ root, manifest }) => writeFileSync(join(root, 'manifest.json'), encodeJson({ ...manifest, senseCount: 99 })), /senseCount mismatch/],
  ['inventory', ({ root }) => mutateEntry(root, 'US', (entry) => { entry.senses[0].meaning = 'Tampered.'; }), /inventory SHA256 mismatch/],
  ['identity path', ({ root }) => renameSync(join(root, entryPath('US')), join(root, 'words/55/5555.json')), /identity path mismatch/],
  ['duplicate lemma', ({ root }) => writeFileSync(join(root, 'words/75/7575.json'), readFileSync(join(root, entryPath('US')))), /Duplicate source lemma/],
  ['entry release', ({ root }) => mutateEntry(root, 'US', (entry) => { entry.release = 'wrong'; }), /entry identity/],
  ['entry schema', ({ root }) => mutateEntry(root, 'US', (entry) => { entry.schema = 'wrong'; }), /entry identity/],
  ['empty senses', ({ root }) => mutateEntry(root, 'US', (entry) => { entry.senses = []; }), /entry identity/],
  ['non-NFC', ({ root }) => mutateEntry(root, 'US', (entry) => { entry.lookupKey = 'é'; }), /Non-NFC/],
  ['bad bucket', ({ root }) => mkdirSync(join(root, 'words/../words/zz')), /Bad source bucket/],
  ['bad filename', ({ root }) => writeFileSync(join(root, 'words/55/not-hex.json'), '{}'), /Bad source entry path/],
  ['nested directory', ({ root }) => mkdirSync(join(root, 'words/55/5555.json')), /Not a regular source file/],
]) {
  test(`rejects ${name} without creating output`, (t) => {
    const context = fixture(t, ['US', 'us']);
    mutate(context);
    assert.throws(() => buildDictionaryCaseIndex(context), pattern);
    assert.throws(() => lstatSync(context.out), { code: 'ENOENT' });
  });
}

test('rejects existing output, source-contained output and symlink source paths', (t) => {
  const { root, out, temp } = fixture(t, ['US']);
  mkdirSync(out);
  writeFileSync(join(out, 'keep'), 'keep');
  assert.throws(() => buildDictionaryCaseIndex({ root, out }), /new directory/);
  assert.equal(readFileSync(join(out, 'keep'), 'utf8'), 'keep');
  assert.throws(() => buildDictionaryCaseIndex({ root, out: join(root, 'output') }), /outside.*source/);
  // Directory junctions work on Windows without symlink privileges.
  symlinkSync(join(root, 'words/55'), join(root, 'words/56'), 'junction');
  assert.throws(() => readRelease(root), /Not a regular source directory/);
  symlinkSync(root, join(temp, 'source-alias'), 'junction');
  assert.throws(() => buildDictionaryCaseIndex({ root, out: join(temp, 'source-alias', 'output') }), /outside.*source/);
});

test('strict CLI arguments, successful CLI and side-effect-free import', (t) => {
  const { root, out, temp } = fixture(t, ['US', 'us']);
  assert.deepEqual(parseArgs(['--root', root, '--out', out]), { root, out });
  for (const args of [[], ['--root', root], ['--root'], ['--root', root, '--root', root], ['--wat', 'x'], ['--root', '--out']]) {
    assert.throws(() => parseArgs(args), /required|Usage/);
  }
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./build-dictionary-case-index.mjs', import.meta.url).href)})`], { cwd: temp, encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  const report = JSON.parse(execFileSync(process.execPath, [script, '--root', root, '--out', out], { encoding: 'utf8' }));
  assert.equal(report.wordCount, 2);
  assert.equal(report.ambiguousCount, 1);
  const failed = spawnSync(process.execPath, [script, '--root', root, '--out', out], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /new directory/);
});
