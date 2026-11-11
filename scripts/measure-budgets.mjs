#!/usr/bin/env node
/** Local/read-only budget reports. Elapsed time is NEVER reported as platform CPU time. */
import { readFileSync, readdirSync, lstatSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

function walk(directory, files = []) {
  if (!existsSync(directory)) return files;
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name); const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error('Symlink input is not accepted');
    if (stat.isDirectory()) walk(path, files);
    else if (stat.isFile() && name === 'mappings.json') files.push(path);
  }
  return files;
}
function jsonLines(path) {
  if (lstatSync(path).size > 16 * 1024 * 1024) throw Error('Input log exceeds 16 MiB');
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
}
function summary(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { samples: sorted.length, min: sorted[0] ?? null, p50: sorted[Math.floor((sorted.length - 1) * .5)] ?? null,
    p95: sorted[Math.floor((sorted.length - 1) * .95)] ?? null, max: sorted.at(-1) ?? null };
}

export function buildBudgetReport({ mappingsRoot, requestLog, platformLog, syncPayload } = {}) {
  const report = { source: 'operator-supplied local artifacts; no remote account queries', platformCpuMs: null,
    r2AccountReadCount: null, warnings: ['Client request counts are not R2 billing counts. Wall duration is not CPU time.'] };
  if (mappingsRoot) {
    report.mappingFiles = walk(resolve(mappingsRoot)).map(path => {
      const stat = lstatSync(path);
      if (stat.size > 4 * 1024 * 1024) throw Error('Mapping inspection input exceeds 4 MiB');
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (data.schema !== 'oewn-position-mappings-v1' || !Array.isArray(data.entries)) throw Error('Invalid mapping artifact');
      return { path, bytes: stat.size, entries: data.entries.length, limitBytes: 192 * 1024,
        limitUsedPercent: +(100 * stat.size / (192 * 1024)).toFixed(2), exceedsReaderLimit: stat.size > 192 * 1024 };
    });
  }
  if (requestLog) {
    const rows = jsonLines(requestLog);
    const requests = rows.filter(row => row.event === 'request');
    for (const row of requests) {
      if (typeof row.resource !== 'string' || !['publication','word','case-index','form-index','position-mapping','api'].includes(row.resource) ||
          !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0 || !Number.isInteger(row.status) || row.status < 0 || row.status > 599) throw Error('Invalid request timing row');
    }
    const statuses = {}; const cacheStatuses = {};
    for (const row of requests) {
      statuses[row.status] = (statuses[row.status] ?? 0) + 1;
      const status = typeof row.cfCacheStatus === 'string' ? row.cfCacheStatus : 'unknown';
      cacheStatuses[status] = (cacheStatuses[status] ?? 0) + 1;
    }
    report.requests = { count: requests.length, elapsedMs: summary(requests.map(r => r.elapsedMs)), statuses, cacheStatuses,
      confirmedCacheHitCount: requests.filter(r => r.cfCacheStatus === 'HIT').length,
      lookupFirstDisplayMs: summary(rows.filter(r => r.event === 'lookup' && Number.isFinite(r.firstDisplayMs) && r.firstDisplayMs >= 0).map(r => r.firstDisplayMs)) };
  }
  if (platformLog) {
    // Intentionally require an explicit normalized platform-export provenance marker. A browser
    // timer, request timestamp difference, SQL duration or wallTimeMs cannot fill this field.
    const rows = jsonLines(platformLog);
    for (const row of rows) {
      if (row.source !== 'cloudflare-platform-export' || typeof row.route !== 'string' || !row.route.startsWith('/api/') ||
          !Number.isFinite(row.cpuTimeMs) || row.cpuTimeMs < 0) throw Error('CPU rows require explicit platform export provenance and cpuTimeMs');
    }
    report.platformCpuMs = summary(rows.map(r => r.cpuTimeMs));
    report.platformCpuByRoute = Object.fromEntries([...new Set(rows.map(r => r.route))].sort().map(route => [route, summary(rows.filter(r => r.route === route).map(r => r.cpuTimeMs))]));
    report.warnings.push('CPU data is an operator-supplied platform export, not independently authenticated by this local tool.');
  }
  if (syncPayload) {
    if (lstatSync(syncPayload).size > 16 * 1024 * 1024) throw Error('Sync input exceeds 16 MiB');
    const bytes = readFileSync(syncPayload); const payload = JSON.parse(bytes);
    if (!Array.isArray(payload.items)) throw Error('Expected sync payload items array');
    let maxItemBytes = 0;
    for (const item of payload.items) maxItemBytes = Math.max(maxItemBytes, Buffer.byteLength(JSON.stringify(item)));
    report.syncPayload = { bytes: bytes.length, items: payload.items.length, maxItemBytes };
  }
  return report;
}

/** Bounded public probe; never accepts user URLs, cookies, bodies, auth endpoints or credentials. */
export async function probePublicDictionary(fetcher = fetch) {
  const origin = 'https://books.inputread.site/';
  const paths = ['dictionary/current.json', 'dictionary/releases/oewn-2025-809369f31478/words/68/686f74656c.json'];
  const rows = [];
  for (const path of paths) {
    const started = performance.now();
    const response = await fetcher(origin + path, { cache: 'no-cache', signal: AbortSignal.timeout(20_000) });
    let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) try {
      while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength;
        if (bytes > 256 * 1024) { await reader.cancel(); throw Error('Public probe response too large'); } }
    } finally { reader.releaseLock(); }
    rows.push({ resource: path.endsWith('current.json') ? 'publication' : 'word', status: response.status,
      elapsedMs: +(performance.now() - started).toFixed(2), bytes, cfCacheStatus: response.headers.get('cf-cache-status'),
      cacheControl: response.headers.get('cache-control'), etag: response.headers.get('etag') });
  }
  return { publicProbe: rows, platformCpuMs: null, r2AccountReadCount: null,
    warning: 'Two explicit read-only requests; not an authenticated billing/CPU measurement or all-edge cache proof.' };
}

export async function main(argv) {
  const options = {}; let output; let probe = false;
  const flags = { '--mappings-root':'mappingsRoot', '--request-log':'requestLog', '--platform-log':'platformLog', '--sync-payload':'syncPayload' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--probe-public') { if (probe) throw Error('Duplicate probe'); probe = true; continue; }
    if (!(flag in flags) && flag !== '--out') throw Error('Unknown argument: ' + flag);
    const value = argv[++i]; if (!value || value.startsWith('--')) throw Error('Missing argument value');
    if (flag === '--out') { if (output) throw Error('Duplicate output'); output = resolve(value); }
    else { const key = flags[flag]; if (options[key]) throw Error('Duplicate input'); options[key] = resolve(value); }
  }
  if (!Object.keys(options).length && !probe) throw Error('Specify local report inputs or explicit --probe-public');
  if (output && existsSync(output)) throw Error('Output must be a new file');
  const report = buildBudgetReport(options);
  if (probe) Object.assign(report, await probePublicDictionary());
  const text = JSON.stringify(report, null, 2) + '\n';
  if (output) writeFileSync(output, text, { flag: 'wx' }); else process.stdout.write(text);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
