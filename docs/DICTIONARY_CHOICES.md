# Explicit dictionary choices

## What is collected

Passive word-opening collection is retired. The reader has no tap buffer/timer/flush calls;
`POST /api/analytics/word-taps` is a no-op for old queued clients and does not read the body
or write D1. Historical tap rows remain for historical administration; they are not votes.

Only an explicit thumbs-up initiates `POST /api/dictionary/choices`. It requires a live session
and verified email. A card opening makes no choice API request. The client keeps the last
acknowledged choice in a bounded per-account, in-memory cache, cleared on account changes.
On an explicit click it reads that account's authoritative selection, then saves or withdraws.
After a full page restart a previous selection is not shown until the reader explicitly interacts;
this avoids transmitting a book sentence just to restore an icon. Repeating the same choice
withdraws it, choosing another switches it, and pending actions cannot duplicate requests.
There are no public counts, popularity sorting, or save/notebook dependencies.

## Review evidence, not canonical votes

The schema is deliberately `dictionary_choices`, not a public votes/mapping table. A row contains
one reader's current full source sense ID, source lemma/release, device book identity, optional
catalog identity, chapter/count, paragraph, occurrence, exact surface, sentence/context and
word-list revision. SHA-256 of that fixed-order evidence isolates distinct reported positions.
It does NOT prove a canonical source position. Different devices/editions do not share these rows.

The server verifies that the nominated full ID belongs to the exact immutable source lemma in
the current released dictionary (bounded manifest and entry reads through BOOKS). It does NOT
claim the nominated lemma has been proved to match the surface, or the source text/coordinates
have been validated. Every response/export says `status: pending-review, positionValidated: false`.
A client cannot publish mappings, create sense IDs, edit definitions, or turn these records into
valid public vote totals. Roadmap source-coordinate proof and any mapping publication must be
proved before treating these as valid position votes. The separately authorized 02:00 review
procedure in GLOSSARY_PATROL.md section 10 must verify original chapter/paragraph text and coordinates,
publish an exact-position mapping, read it back, then record acceptance and durable credit.

A cancellation removes that reader's current evidence. There is no review-queue/tombstone policy
or consensus threshold. Maintenance can read pending evidence via authorized D1 tools, but must
verify the original text, edition, location and candidate binding before taking any action.

## Safety and lifecycle

- POST only; reject foreign Origin and cross-site Fetch Metadata; streamed payload cap 8192 bytes.
- Strict per-account 120-request / 15-minute limit; both personal-state read and set are limited.
- Global daily fuse: 5000 actual evidence mutations. Repeated identical sets/cancels do not spend
  mutation budget. The fuse and mutation execute in one D1 transaction.
- Exact source IDs are opaque; no parsing a lemma from an ID. R2 source entry cap 32 KiB.
- One row per user + target evidence. Account deletion cascades; account export includes rows.
- Server errors cannot appear as successful choices; selection waits for an acknowledged response.
- Membership JSON/SHA/SQL are bounded, but production Free-plan CPU timing has NOT been measured.
  Do not claim the 10 ms budget is proven by a payload cap or local unit tests.

Apply additive migrations `0026_dictionary_choices.sql` and `0027_dictionary_choice_review.sql`
before deploying code using the choice/review/credit tables, including account export and contributor totals. Follow MAINTENANCE.md: inspect actual pending migrations, preserve a
backup/recovery point and never replay old migrations. No existing tap or feedback history is deleted.

## Community writing

When standard candidates exist without a community explanation, the card ends with one quiet
`Write my own` action. No green missing-meaning warning or automatic textarea competes with the
standard definitions. A click expands the actual community input; cancel collapses it. Failed
submissions preserve text and show an error, never a success acknowledgement. Existing community
meaning feedback remains separate from dictionary choices.
