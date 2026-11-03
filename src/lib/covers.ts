import { checkAbort, requestScope } from "@/lib/cancel-work";
/**
 * Fetching a catalog cover. The books host serves cover.jpg with a long browser cache (4 hours), so a
 * changed cover would not show up in time. The catalog gives every cover a sha256; it is added to the
 * address (`?v=<first 12 letters>`), so a new picture is a new address and is fetched fresh.
 *
 * The fetch also skips the HTTP cache. A plain cover `<img>` does not send Origin, and the books host
 * only adds Access-Control-Allow-Origin when Origin is present, so a cached image response cannot
 * be read by this fetch.
 */
import { fetchCover } from "@/lib/cover-request";

export function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => resolve("");
    reader.readAsDataURL(blob);
  });
}

/** The address to fetch for a cover with this version. Without a version the address is unchanged. */
export function coverAddress(url: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return url;
  const hash = url.indexOf("#");
  const base = hash >= 0 ? url.slice(0, hash) : url;
  return `${base}${base.includes("?") ? "&" : "?"}v=${sha256.slice(0, 12)}`;
}

/** The cover as a data URL, or "" when it cannot be fetched. Never throws. */
const dataCache = new Map<string, string>();
const DATA_CACHE_MAX = 24;

export async function fetchCoverData(url: string, sha256: string, signal?: AbortSignal): Promise<string> {
  const address = coverAddress(url, sha256);
  const cached = dataCache.get(address);
  if (cached !== undefined) {
    checkAbort(signal);
    return cached;
  }
  const scope = requestScope(signal, 10000);
  try {
    const response = await scope.run(fetchCover(address, scope.signal));
    if (!response.ok) return "";
    const data = await scope.run(response.blob().then(dataUrlOf));
    if (data) {
      dataCache.set(address, data);
      if (dataCache.size > DATA_CACHE_MAX) {
        const oldest = dataCache.keys().next().value;
        if (oldest !== undefined) dataCache.delete(oldest);
      }
    }
    return data;
  } catch {
    checkAbort(signal);
    return "";
  } finally {
    scope.dispose();
  }
}
