import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Usage: node scripts/build-dictionary-case-index.mjs --root RELEASE --out NEW_DIRECTORY
// Only the new output directory is written; dictionary/current.json is a publish candidate.
export const SHARDS = Object.freeze(Array.from({ length: 256 }, (_, n) => n.toString(16).padStart(2, '0')));
export const encodeJson = (value) => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// UTF-8 ordering agrees with Python's Unicode scalar ordering, unlike JS's default UTF-16 sort.
export const compareKeys = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
export const lowerKey = (key) => key.normalize('NFC').toLowerCase().normalize('NFC');

export function shardId(lower) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(lower, 'utf8')) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0').slice(0, 2);
}

export function entryPath(key) {
  const hex = Buffer.from(key, 'utf8').toString('hex');
  return `words/${hex.slice(0, 2)}/${hex}.json`;
}

function assertPlainFile(path) {
  if (!lstatSync(path).isFile()) throw new Error(`Not a regular source file: ${path}`);
}

function assertDirectory(path) {
  if (!lstatSync(path).isDirectory()) throw new Error(`Not a regular source directory: ${path}`);
}

export function groupLemmas(keys) {
  const groups = new Map();
  const seen = new Set();
  for (const original of keys) {
    if (typeof original !== 'string' || !original.length || !original.isWellFormed()) {
      throw new Error('Invalid lemma key');
    }
    const exact = original.normalize('NFC');
    if (seen.has(exact)) throw new Error(`Duplicate NFC lemma: ${exact}`);
    seen.add(exact);
    const lower = lowerKey(exact);
    if (!groups.has(lower)) groups.set(lower, []);
    groups.get(lower).push(exact);
  }
  return [...groups].sort(([a], [b]) => compareKeys(a, b)).map(([lower, candidates]) => [lower, candidates.sort(compareKeys)]);
}

// Reproduce build-oewn-r2.py: SHA256 of UTF-8 JSON [lemma, POSIX path, file SHA256]
// rows, sorted by original lemma, compact separators, ensure_ascii=False, one LF each.
export function inventorySha256(rows) {
  const hash = createHash('sha256');
  for (const row of [...rows].sort(([a], [b]) => compareKeys(a, b))) hash.update(encodeJson(row));
  return hash.digest('hex');
}

export function readRelease(rootPath) {
  const root = resolve(rootPath);
  assertDirectory(root);
  assertPlainFile(join(root, 'manifest.json'));
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 'oewn-r2-manifest-v1' ||
      typeof manifest.release !== 'string' || !/^oewn-[a-zA-Z0-9-]+$/.test(manifest.release) ||
      !Number.isSafeInteger(manifest.wordCount) || manifest.wordCount < 1 ||
      !Number.isSafeInteger(manifest.senseCount) || manifest.senseCount < 1 ||
      !/^[0-9a-f]{64}$/.test(manifest.inventorySha256)) {
    throw new Error('Invalid source manifest');
  }
  const words = join(root, 'words');
  assertDirectory(words);
  const rows = [];
  const seen = new Set();
  let senseCount = 0;
  for (const bucket of readdirSync(words).sort()) {
    if (!/^[0-9a-f]{2}$/.test(bucket)) throw new Error(`Bad source bucket path: ${bucket}`);
    const directory = join(words, bucket);
    assertDirectory(directory);
    for (const name of readdirSync(directory).sort()) {
      if (!/^(?:[0-9a-f]{2})+\.json$/.test(name)) throw new Error(`Bad source entry path: ${name}`);
      const path = join(directory, name);
      assertPlainFile(path);
      const bytes = readFileSync(path);
      const entry = JSON.parse(bytes.toString('utf8'));
      const key = entry.lookupKey;
      if (entry.schema !== 'oewn-r2-entry-v1' || entry.release !== manifest.release ||
          typeof key !== 'string' || !key.length || !key.isWellFormed() ||
          !Array.isArray(entry.senses) || entry.senses.length === 0) {
        throw new Error(`Invalid source entry identity: ${path}`);
      }
      if (key !== key.normalize('NFC')) throw new Error(`Non-NFC source lemma: ${path}`);
      if (seen.has(key)) throw new Error(`Duplicate source lemma: ${key}`);
      seen.add(key);
      const relativePath = `words/${bucket}/${name}`;
      if (relativePath !== entryPath(key)) throw new Error(`Source entry identity path mismatch: ${relativePath}`);
      senseCount += entry.senses.length;
      rows.push([key, relativePath, sha256(bytes)]);
    }
  }
  if (rows.length !== manifest.wordCount) throw new Error(`Source wordCount mismatch: ${rows.length} != ${manifest.wordCount}`);
  if (senseCount !== manifest.senseCount) throw new Error(`Source senseCount mismatch: ${senseCount} != ${manifest.senseCount}`);
  if (inventorySha256(rows) !== manifest.inventorySha256) throw new Error('Source inventory SHA256 mismatch');
  return { manifest, keys: rows.map(([key]) => key) };
}

export function createCaseIndex(release, keys) {
  const grouped = groupLemmas(keys);
  const indexVersion = `case-v1-${sha256(encodeJson({ release, entries: grouped })).slice(0, 12)}`;
  const shards = new Map(SHARDS.map((shard) => [shard, Object.create(null)]));
  for (const [lower, candidates] of grouped) shards.get(shardId(lower))[lower] = candidates;
  const files = new Map();
  const hashes = Object.create(null);
  let maxShardBytes = 0;
  for (const [shard, entries] of shards) {
    const bytes = encodeJson({ schema: 'oewn-case-index-v1', release, indexVersion, shard, entries });
    files.set(`${shard}.json`, bytes);
    hashes[`${shard}.json`] = { sha256: sha256(bytes), bytes: bytes.length };
    maxShardBytes = Math.max(maxShardBytes, bytes.length);
  }
  const manifest = {
    schema: 'oewn-case-index-manifest-v1', release, indexVersion,
    wordCount: grouped.reduce((count, [, candidates]) => count + candidates.length, 0),
    groupCount: grouped.length,
    ambiguousCount: grouped.filter(([, candidates]) => candidates.length > 1).length,
    files: hashes,
  };
  return { indexVersion, manifest, files, maxShardBytes };
}

function inside(path, parent) {
  const rel = relative(parent, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function buildDictionaryCaseIndex({ root, out }) {
  const source = resolve(root);
  const destination = resolve(out);
  // realpath also prevents an output-parent symlink from routing writes into the release.
  assertDirectory(source);
  const parent = realpathSync(dirname(destination));
  const actualDestination = join(parent, basename(destination));
  if (inside(actualDestination, realpathSync(source))) throw new Error('Output must be outside the immutable source release');
  try {
    lstatSync(destination);
    throw new Error('Output must be a new directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { manifest: sourceManifest, keys } = readRelease(source);
  const result = createCaseIndex(sourceManifest.release, keys);
  result.manifest.sourceInventorySha256 = sourceManifest.inventorySha256;
  // Exclusive mkdir is the last check: never reuse or overwrite an existing output.
  mkdirSync(destination);
  const directory = join(destination, 'dictionary', 'case-indexes', result.indexVersion);
  mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of result.files) writeFileSync(join(directory, name), bytes, { flag: 'wx' });
  writeFileSync(join(directory, 'manifest.json'), encodeJson(result.manifest), { flag: 'wx' });
  const current = { schema: 'oewn-r2-current-v1', release: sourceManifest.release, caseIndex: result.indexVersion };
  writeFileSync(join(destination, 'dictionary', 'current.json'), encodeJson(current), { flag: 'wx' });
  return { ...result.manifest, maxShardBytes: result.maxShardBytes };
}

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const key = flag === '--root' ? 'root' : flag === '--out' ? 'out' : null;
    if (!key || options[key] || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Usage: node scripts/build-dictionary-case-index.mjs --root RELEASE --out NEW_DIRECTORY');
    }
    options[key] = args[i + 1];
  }
  if (!options.root || !options.out) throw new Error('Both --root and --out are required');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(buildDictionaryCaseIndex(parseArgs(process.argv.slice(2)))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
