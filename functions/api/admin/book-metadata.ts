import { requireAdmin } from "../../lib/admin.ts";
import type { Env, R2ObjectLike } from "../../lib/db.ts";
import type { HandlerOptions } from "../../lib/handlers.ts";
import { errorResponse, HttpError, json } from "../../lib/http.ts";
import { publishObject, withCatalogLock } from "../../lib/catalog-lock.ts";
import { applyMetadata, metadataRow, type MetadataSource } from "../../lib/book-metadata.ts";
import { BOOK_METADATA_BYTES, readBookMetadataRequest } from "../../../src/lib/book-metadata.ts";
import { CATALOG_ID, type CatalogName } from "../../../src/lib/catalog-id.ts";

export const onRequestGet = (context: { request: Request; env: Env }) => handleGet(context.request, context.env);
export const onRequestPatch = (context: { request: Request; env: Env }) => handlePatch(context.request, context.env);

type CatalogObject = R2ObjectLike & {
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
};

async function load(bucket: NonNullable<Env["BOOKS"]>, catalog: CatalogName) {
  const object = await bucket.get(`${catalog}/catalog.json`) as CatalogObject | null;
  if (!object) throw new HttpError(500, "no-catalog");
  const live = JSON.parse(await new Response(object.body).text()) as Record<string, unknown>;
  const rows = live[catalog === "word-lists" ? "lists" : "packs"];
  if (!Array.isArray(rows)) throw new HttpError(500, "bad-catalog");
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || !CATALOG_ID.test(row.id) || seen.has(row.id)) throw new HttpError(500, "bad-catalog");
    seen.add(row.id);
  }
  return { object, live, rows: rows as MetadataSource[] };
}

/** Bound the actual stream, not just an optional or untrusted Content-Length header. */
async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new HttpError(400, "bad-metadata");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > BOOK_METADATA_BYTES) {
        await reader.cancel();
        throw new HttpError(400, "bad-metadata");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new HttpError(400, "bad-metadata"); }
  } finally { reader.releaseLock(); }
}

export async function handleGet(request: Request, env: Env, options?: HandlerOptions): Promise<Response> {
  try {
    await requireAdmin(env.DB, request, options);
    if (!env.BOOKS) throw new HttpError(500, "no-books-bucket");
    const books = await Promise.all((["word-lists", "public-books"] as const).map(async (catalog) => {
      const { rows } = await load(env.BOOKS!, catalog);
      return rows.map((row) => metadataRow(catalog, row));
    }));
    return json({ books: books.flat() });
  } catch (error) { return errorResponse(error); }
}

export async function handlePatch(request: Request, env: Env, options?: HandlerOptions): Promise<Response> {
  try {
    const actor = await requireAdmin(env.DB, request, options);
    const bucket = env.BOOKS;
    if (!bucket) throw new HttpError(500, "no-books-bucket");
    const input = readBookMetadataRequest(await readBody(request));
    if (!input) throw new HttpError(400, "bad-metadata");
    const key = `${input.catalog}/catalog.json` as const;
    return await withCatalogLock(env.DB, key, async () => {
      const { object, live, rows } = await load(bucket, input.catalog);
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (input.changes.some((change) => !byId.has(change.id))) throw new HttpError(404, "unknown-id");
      const current = input.changes.map((change) => metadataRow(input.catalog, byId.get(change.id)!));
      const ids = input.changes.filter((change, index) => change.baseline !== current[index]!.baseline).map((change) => change.id);
      if (ids.length) return json({ error: "metadata-conflict", ids }, 409);
      // Validation and changes are local until the entire batch succeeds. No content objects are written.
      let changed = false;
      for (const [index, change] of input.changes.entries()) {
        if (applyMetadata(byId.get(change.id)!, current[index]!, change)) changed = true;
      }
      const books = input.changes.map((change) => metadataRow(input.catalog, byId.get(change.id)!));
      if (changed) {
        await publishObject(bucket, key, new TextEncoder().encode(`${JSON.stringify(live, null, 1)}\n`), object,
          { db: env.DB, actorId: actor.id, operation: "book-metadata" });
      }
      return json({ books });
    });
  } catch (error) { return errorResponse(error); }
}
