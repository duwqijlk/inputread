import type { Env } from "../../lib/db.ts";
import type { HandlerOptions } from "../../lib/handlers.ts";
import { errorResponse, HttpError, json } from "../../lib/http.ts";
import { assertUserRateLimit } from "../../lib/rate-limit.ts";
import { requireUser } from "../../lib/session.ts";
import {
  checkChoiceMembership, choicePosition, choiceResult, existingChoice,
  parseChoiceRequest, readChoiceRequest, sameChoice, saveChoice,
} from "../../lib/dictionary-choice.ts";

// Pages uses the generic handler so unsupported methods cannot fall through to static HTML.
export const onRequest = (context: { request: Request; env: Env }) => handleDictionaryChoices(context.request, context.env);

export async function handleDictionaryChoices(request: Request, env: Env, options?: HandlerOptions): Promise<Response> {
  try {
    if (request.method !== "POST") throw new HttpError(405, "method");
    const origin = request.headers.get("origin");
    if ((origin !== null && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
      throw new HttpError(403, "origin");
    }
    const now = options?.now ?? Date.now();
    const user = await requireUser(env.DB, request, now);
    if (!(typeof user.email_verified_at === "number" && user.email_verified_at > 0)) throw new HttpError(403, "email-unverified");
    await assertUserRateLimit(env.DB, "choices", user.id, now);
    const input = parseChoiceRequest(await readChoiceRequest(request));
    const position = await choicePosition(input.target);
    const row = await existingChoice(env.DB, user.id, position.hash);
    if (input.action === "get") {
      // Return stored provenance even after a release change; no source fetch, creation or counts.
      return json(choiceResult(row ? { id: row.choice_id, lemma: row.choice_lemma, release: row.choice_release } : null));
    }
    if (input.choice) await checkChoiceMembership(env, input.choice);
    if (!sameChoice(row, input.choice)) await saveChoice(env.DB, user.id, position, input.choice, now);
    // Membership was checked, but the frontend-nominated lemma is NOT proved to match the surface,
    // and the docs-v4 exact source coordinate validator is absent. This remains raw review evidence.
    return json(choiceResult(input.choice));
  } catch (error) { return errorResponse(error); }
}
