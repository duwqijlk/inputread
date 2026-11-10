import type { Env } from "../../lib/db.ts";
import type { HandlerOptions } from "../../lib/handlers.ts";
import { json } from "../../lib/http.ts";

/** Retired: old clients may finish a queued flush, but opening words never writes telemetry. */
export const onRequestPost = (context: { request: Request; env: Env }) =>
  handleWordTapsPost(context.request, context.env);

export async function handleWordTapsPost(
  _request: Request,
  _env: Env,
  _options?: HandlerOptions,
): Promise<Response> {
  // Do not read a possibly large request or touch D1. Historical rows remain available to admins.
  return json({ ok: true, saved: 0, retired: true });
}
