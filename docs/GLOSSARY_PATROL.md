# Daily word-list patrol (for an AI agent)

Read this whole page before you start. It is the job description for the external agent that runs
once a day at **02:00 Asia/Shanghai**, using a Cloudflare API token for remote data access.
The existing community-review procedure needs no site login, build or deploy. Standard-position
adoption in section 10 additionally needs the actual reader parsing/coordinate helpers, or an
independently verified equivalent; if unavailable, leave those choices needs-context, not guessed.
Use only Cloudflare HTTPS API calls for remote storage access. Running local source validation is
not permission to deploy code or change schemas. This task stays hosted at [patrol.md](https://inputread.site/kit/patrol.md).
The [maintenance map](https://inputread.site/kit/maintenance.md) owns shared storage, count/version,
publishing and recovery rules; the actionable API/D1 steps for this patrol are below.

## Before each run: reread the sources

Every round, reread this **whole patrol playbook**, the
[maintenance map](https://inputread.site/kit/maintenance.md), and the glossary format/specification
sections used below before reviewing reports or writing. Do not operate from a previous run's
summary, an old copied page or the authoring ZIP. Do not guess a local checkout or specification
path. If a required source is unreadable, stay read-only and report it.

The hosted patrol and maintenance originals read for this run are the operational authority.
Record their URLs and retrieval times, plus SHA-256 of their **original bytes** when available.
If a tool returns only converted text, mark the original-byte hash **unverified**; never hash
that text and call it the source hash. This does not waive the file-byte/credit checks before
publishing: if the runtime cannot perform those checks, stay read-only.
Read the required format/specification links afresh and record their actual sources too. A local
checkout is optional: record its resolved path, commit and dirty state if used, but an old checkout
need not match the hosted playbook. Do not mix its older procedures into this run. No local/hosted
hash-equality ceremony, extra version table or authoring ZIP is required.
Before using the resolution SQL, confirm migration `0025_feedback_resolution.sql` is present
in D1's migration history. Standard-choice processing and the extended contribution projection
also require `0026_dictionary_choices.sql` and `0027_dictionary_choice_review.sql`. Do not run
new table queries against an older schema. If missing, use only the supported community review
path, report the blocked choice/credit work and ask the operator; never migrate from patrol.
See [documentation authority](https://inputread.site/kit/maintenance.md#ownership).

## Standard choices and daily schedule

The external patrol agent runs this SAME playbook daily at **02:00 Asia/Shanghai**. It handles
community suggestions, word/passage reports and standard dictionary choices. This repository
creates no scheduled task or Cron Trigger; the user's separate agent owns scheduling.

Passive word taps are retired. `book_word_taps` is historical evidence only and the old ingest
endpoint writes nothing. `dictionary_choices` holds raw pending-review evidence after migration
0026. Source-ID membership is not proof of a book coordinate. Apply the complete workflow in
[section 10](#10-standard-meaning-choices) before accepting a choice or awarding a point.
Community `From` and standard `Matched by` credits are independent; one does not replace the other.
Do not auto-select the most popular sense, and never edit the independently maintained standard
word definitions or create sense IDs. The implementation contract is documented in
[DICTIONARY_CHOICES.md](https://github.com/duwqijlk/inputread/blob/main/docs/DICTIONARY_CHOICES.md),
but this hosted patrol page remains the single operational entry.

## 1. The job

Readers of inputread.site read English books with a word list (glossary) that explains hard
words. The following evidence tells you a list or standard position mapping needs work:

- **Historical taps** (`book_word_taps`): older missing-word evidence only; no new automatic collection.
- **Standard meaning choices** (`dictionary_choices`): explicit choices, reviewed using section 10;
  source/position validation and post-publication contribution receipts are mandatory.
- **Reports** (table `word_feedback`), sent with the card's feedback button:
  - `missing_meaning`: the word has no meaning here.
  - `suggested`: the reader wrote their own meaning without saying what was wrong with the one
    shown. Treat it as "this place may need a better or different meaning" and judge it the same
    way as a `wrong_meaning` that carries a suggestion.
  - `too_hard`: the meaning uses words that are too hard for a learner.
  - `wrong_meaning`: the meaning, or a phrase match, does not fit this place in the book.
  - Any report may carry `suggestion`: the reader's own meaning for this place (plain text, at most
    200 characters, English or Chinese). Readers often look the word up while reading, so this is
    usually the quickest way to the right sense. Review it; never paste it in unchecked.
- **Passage reports** (table `passage_feedback`): a reader selected a few words, a sentence or a
  short part of one paragraph and asked for help with it. `selected` is the exact text (at most
  600 characters, never across paragraphs); `before` / `after` are a few words around it;
  `chapter` and `paragraph` are the reader's own numbers in their copy of the book (see
  "Chapter numbers" below); `sel_start` / `sel_end` are its character offsets in that paragraph;
  `span` is `sentence` when it holds a whole sentence (its final full stop need not be selected),
  else `words`: part of one sentence, of any length. `words` is not "a phrase": decide by the text
  (the table below). Older rows labelled a whole sentence without its stop as `words`. Reports that
  overlap on one paragraph share a
  `topic` (see "Passage topics" below). `reason`:
  - `hard`: "I don't understand this part".
  - `phrase`: "these words go together" (often a phrasal verb or an idiom the list does not have).
  - `wrong`: the help shown at this place is wrong.
  - `suggested`: only the reader's explanation, in `suggestion` (plain text, at most 600
    characters: room to say what a sentence means and why).

Once a day review reader reports first; use taps as a bounded signal list, not a backlog to clear.
Fix and publish only when needed. A reviewed report may be closed without publishing when the
verified current list already answers it or no change is warranted; record the outcome in §7.
You may **add** entries and **fix** existing ones: rewrite a meaning that is too hard, correct one
that is wrong, add or move an anchor, add a sense, and remove a wrong phrase match. Example: in
The Wonderful Wizard of Oz the phrase "even to" was matched in "want to kill anybody, even to see
Aunt Em", where the words are not that phrase. The fix was to remove that phrase match.

## 2. Access

- `Authorization: Bearer <token>` on every call. The token needs, on this account, **D1 Edit**
  and **Workers R2 Storage Edit**. Never print the token, put it in a file, or send it anywhere
  but `api.cloudflare.com`.
- `API = https://api.cloudflare.com/client/v4/accounts/6ece9f6dbbc73db1be2810fb39f277c3`
- D1 database `margin-words`, id `c286e644-2ead-438c-bb65-70ee028d957a`.
- R2 buckets:
  - `margin-words-books`: what readers download. You read and write here.
  - `margin-words-private`: copyrighted EPUBs. **Read only**, to check anchors.

The three calls you use:

```
D1 query   POST {API}/d1/database/c286e644-2ead-438c-bb65-70ee028d957a/query
           body {"sql": "...", "params": [...]}      rows in result[0].results
R2 read    GET  {API}/r2/buckets/<bucket>/objects/<key, URL-encoded>
R2 write   PUT  {API}/r2/buckets/<bucket>/objects/<key, URL-encoded>
           body = the exact file bytes, header Content-Type: application/json
```

Always use `params` for values in SQL. Never build SQL by pasting text into it.

**Before any R2 write**, coordinate an exclusive window with **all writers**, including admin
publishers, other patrols and CLI/API agents. Direct Cloudflare R2 calls bypass the admin routes'
cooperative D1 catalog lock; this task does **not** grant SQL lock acquisition or lock-table edits.
Snapshot exact bytes and metadata of each affected object (including absence), reread immediately
before publishing, and abort/rebase if anything changed. Keep the window through write verification.
If you cannot coordinate it, remain read-only and report. Details:
[publishing](https://inputread.site/kit/maintenance.md#publishing) and
[recovery](https://inputread.site/kit/maintenance.md#recovery).

## 3. Find the work (read only)

**Taps: rank first, then read only the words worth a run.** Many taps are one reader opening a
word once; they arrive by the hundred each day, far more than a run can answer. First rank the
open words per book by how many readers tapped them. `book_id` is one reader's device, so
`COUNT(DISTINCT book_id)` is the number of devices:

```sql
SELECT CASE WHEN catalog_id != '' THEN catalog_id ELSE 'title:' || book_title END AS book,
       word, COUNT(DISTINCT book_id) AS readers, SUM(tap_count) AS taps, MAX(last_tapped_at) AS last
  FROM book_word_taps WHERE in_glossary = 0 AND status != 'resolved'
 GROUP BY book, word
HAVING readers >= 2 OR taps >= 2 OR last > ?1
 ORDER BY readers DESC, taps DESC, last DESC LIMIT 200;
```

`?1` = now minus 14 days, in milliseconds. A word on this list is worth checking: several
readers, several taps, or a recent single tap. A word tapped once by one reader more than 14
days ago is not on it. Leave those rows **pending**: do not resolve them to clear the queue, and do
not delete them (§8). They cost nothing while they wait, and a later tap from another reader lifts
the word back onto the list. A `book` of the form `title:<title>` is an older row without
`catalog_id`; match it to a catalog book by title only when the title names exactly one book.

Then read the locations of each word you chose (`?1` = its `book` value from the list above,
`?2` = the word). The `book` expression is the same, so a `title:` book works too:

```sql
SELECT book_id, word, chapter, occurrence, catalog_id, book_title, form, chapters, context, sentence,
       glossary_rev, last_tapped_at, tap_count
  FROM book_word_taps WHERE in_glossary = 0 AND status != 'resolved'
   AND (CASE WHEN catalog_id != '' THEN catalog_id ELSE 'title:' || book_title END) = ?1 AND word = ?2
  ORDER BY tap_count DESC, last_tapped_at DESC LIMIT 50;
```

**Index note.** The `missing` index on `book_word_taps` is partial: it covers only
`in_glossary = 0 AND status != 'resolved'`, ordered by `book_id`, `tap_count` and
`last_tapped_at`. The `lookup` and `status` indexes no longer include `tap_count`, so their
small filtered result is sorted at read time. Do not add `tap_count` or `last_tapped_at` back
to those indexes without measuring the write cost: every tap updates both columns and rewrites
the index. The patrol queries are small; measure their actual time before changing indexes.

Open reports:

```sql

SELECT f.id, f.catalog_id, f.book_title, f.word, f.form, f.reason, f.chapter, f.chapters, f.occurrence,
       f.context, f.sentence, f.sense_index, f.sense_meaning, f.suggestion, f.glossary_rev, f.status,
       u.public_id AS suggested_by
  FROM word_feedback f LEFT JOIN users u ON u.id = f.user_id
 WHERE f.status != 'resolved'
 ORDER BY (f.suggestion != '') DESC, f.created_at DESC LIMIT 500;
```

Open passage reports:

```sql
SELECT p.id, p.topic, p.book_id, p.catalog_id, p.book_title, p.chapter, p.chapters, p.paragraph, p.sel_start, p.sel_end, p.span,
       p.selected, p.before, p.after, p.reason, p.suggestion, p.glossary_rev, p.status, p.created_at,
       u.public_id AS suggested_by
  FROM passage_feedback p LEFT JOIN users u ON u.id = p.user_id
 WHERE p.status != 'resolved'
 ORDER BY p.topic, p.created_at LIMIT 300;
```

`suggested_by` is set only on a report that carries a suggestion: the public id of the reader who
wrote it (12 letters and digits; never an email). Use it for `credit` below.

**Statuses differ by source.** Word feedback can be `pending`, `reopened` or `resolved`;
`reopened` is fresh work after a previous resolution, so prioritize it. Revision strings are not
ordered versions: do not infer "newer" by comparing their hashes. Passage inserts are always
`pending`, not `reopened`; a closed topic means all its reports are `resolved`, not a stored
`closed` status. Later unsuppressed passage reports search for an open overlap or start a new topic.
Missing-word taps do **not** automatically reopen after resolution (see §7). These three lifecycles
must not be treated as one state machine.

**Bounded topic discovery: do not let a deferred first topic starve later work.** The initial
300-report query is only a triage sample, not the work queue or a cursor source. Discover distinct
open topics independently of their report counts:

```sql
-- Passage topic discovery: ?1 = saved discovery_topic_cursor (initially 0).
SELECT DISTINCT topic FROM passage_feedback
 WHERE status != 'resolved' AND topic > ?1
 ORDER BY topic ASC LIMIT 20;
```

Use at most **3 topic-discovery pages per run** (20 topics per page). Walk the returned topics in
order, either reviewing through their cutoff below or explicitly recording why each is deferred.
Advance and persist `discovery_topic_cursor` to the **last considered topic**, even if that topic
was deferred; do not reset it just because no fixes were published. If the 10-book budget or other
run limit stops you partway through a page, save only the last considered topic, not the page's
last returned topic, so unconsidered topics reappear next run. Record pages used, cursor start/end
and deferred topic ids/reasons in the run report; use that record to continue next run. If the
saved record is unavailable, say so and restart at 0 rather than inventing a cursor. An empty page
ends this discovery sweep: save cursor 0 for the **next run**, without wrapping again in this run.
This eventually revisits old deferred topics and any newly open lower-numbered topics, while the
finite page budget prevents endless discovery/polling. Topic discovery never authorizes closure.

**Zero-topic anomaly lane: independent of the topic cursor.** Migration `0024` assigns a new
report's own id inside its INSERT and repairs legacy `topic = 0` rows. A zero topic after that
is an invariant violation, not a normal topic: report it to the operator. Do not run migrations
or repair topic values from this patrol. Until the operator repairs it, do not silently skip it.

```sql
-- Zero-topic sweep: save anomaly_cutoff_id and open count when starting a new sweep.
SELECT MAX(id) AS anomaly_cutoff_id, COUNT(*) AS anomaly_count FROM passage_feedback
 WHERE status != 'resolved' AND topic = 0;

-- Zero-topic page: ?1 = anomaly_id_cursor (initially 0), ?2 = saved anomaly_cutoff_id.
SELECT p.id, p.topic, p.book_id, p.catalog_id, p.book_title, p.chapter, p.chapters, p.paragraph,
       p.sel_start, p.sel_end, p.span, p.selected, p.before, p.after, p.reason, p.suggestion,
       p.glossary_rev, p.status, p.created_at, u.public_id AS suggested_by
  FROM passage_feedback p LEFT JOIN users u ON u.id = p.user_id
 WHERE p.status != 'resolved' AND p.topic = 0 AND p.id > ?1 AND p.id <= ?2
 ORDER BY p.id ASC LIMIT 20;
```

Use at most **1 zero-topic page per run**, independently of the 3 normal discovery pages.
Review each zero-topic row **individually** by its own id, catalog and text: unrelated reports
must never be grouped as "topic 0". The selected row is the complete individual work item.
Advance `anomaly_id_cursor` to the last considered id even when deferred; persist it together
with the fixed cutoff until an empty page ends the sweep. Then reset the cursor/cutoff for the
next run, without wrapping in this run. If the saved state is unavailable, start a new sweep
with cursor 0 and a fresh cutoff. New ids beyond the cutoff wait for the next sweep. The
10-book limit still applies; record deferred ids and stop before exceeding it.
For an individually reviewed, answered row, the existing §7 resolution guard uses its
**original topic 0**, its id and the saved anomaly cutoff. If an operator meanwhile repairs its topic,
zero changed rows means reread/re-evaluate; never broaden the guard. Acceptance still requires
verified publication and credit. An anomaly scan is not authorization to resolve unreviewed rows.

**LIMIT 300 is never a complete topic.** The initial report sample may cut one topic in half or
omit others; the distinct-topic pages above avoid that starvation. For each discovered topic you will handle, record a fixed upper id
before editing, then read **all** its reports up to that cutoff with keyset pagination (including
already resolved rows for context):

```sql
-- Passage topic cutoff: ?1 = the discovered topic id. Save cutoff_id for this topic/run.
SELECT MAX(id) AS cutoff_id FROM passage_feedback WHERE topic = ?1;

-- Passage topic page: ?1 = topic, ?2 = last id read (initially 0), ?3 = saved cutoff_id.
SELECT p.id, p.topic, p.book_id, p.catalog_id, p.book_title, p.chapter, p.chapters, p.paragraph,
       p.sel_start, p.sel_end, p.span, p.selected, p.before, p.after, p.reason, p.suggestion,
       p.glossary_rev, p.status, p.created_at, u.public_id AS suggested_by
  FROM passage_feedback p LEFT JOIN users u ON u.id = p.user_id
 WHERE p.topic = ?1 AND p.id > ?2 AND p.id <= ?3
 ORDER BY p.id ASC LIMIT 300;
```

Use the last returned `id` for the next page; continue until an empty page (not just until you
have 300 rows). Save the complete reviewed id list and each row's original association/revision.
If there is no cutoff or any page cannot be read/reviewed, defer the topic. Never widen or refresh
the cutoff during this review to pull in unseen reports. Reports inserted after the cutoff,
including reports joining this same still-open topic, belong to later work; never resolve them
as a side effect of this run. Bounded pagination is required, not unbounded polling.

`book_id` in these rows is the reader's device id and means nothing across devices. Find the book by
**`catalog_id`**, `<catalog>:<id>`: `word-lists:<id>` is the row with that `id` in
`word-lists/catalog.json`, `public-books:<id>` the row in `public-books/catalog.json`. Only when it is
`''` (an older page, a list the reader added by hand, a book installed before this was recorded)
consider a **title fallback only if normalization matches exactly one row across both live
catalogs**, using `normalizeTitle` in `src/lib/book-title.ts` (at most two edition-label passes,
real subtitles retained). Zero matches or ambiguity: leave it pending and report it. A malformed
or unknown **nonempty** reference must never fall back to title; leave it pending too. An empty
reference may also be a custom list: title uniqueness alone does not prove the report concerns the
published list; check context and edition before acting. See
[identity and naming](https://inputread.site/kit/book-upload.md#identity-and-naming).
Two same-title books are told apart by `catalog_id`, not device id. The
catalogs (R2 read, bucket `margin-words-books`):

- `word-lists/catalog.json`: `{ "lists": [ { "id", "title", "words", "phrases", "paragraphs",
  "sentences", "updated", "glossary": { "url", "bytes", "sha256" }, ... } ] }`
- `public-books/catalog.json`: `{ "packs": [ { "id", "title", "rev", ..., "glossary": { "url",
  "bytes", "sha256", "rev" } } ] }`

The book's list is `word-lists/<id>/glossary.json` or `public-books/<id>/glossary.json`. Its
**revision** is the first 12 hex digits of `glossary.sha256`. A row whose `glossary_rev` is not the
current revision was made on an older list: check whether the current list already fixed it.

**Chapter numbers.** Readers import their own copy of the book, so a reported `chapter` is an index
in **that** edition, not in the list's edition. Each row also carries `chapters`: how many chapters
the reporting reader's copy has (`0` from an older page that did not send it). Compare it with the
list's own `chapters`:

- Same number (or `0`): the chapter number is normally the same as the list's, and
  `chapter` + `occurrence` / `paragraph` locate the place.
- Different number: the editions are split differently, often because of front matter, so the
  chapter number may be off by a fixed amount. Do **not** trust it. Locate the place by the row's
  `context` (and, for a passage, `paragraph` and `before` + `selected` + `after`) in the book, and
  write the chapter that actually contains that text. A paragraph note's `paragraph` is also the
  reader's edition's id: the `context` decides, the id only breaks ties.

## 4. Fix the list

Download the live `glossary.json` and the book (`margin-words-private`, key `<id>/book.epub`; for
a public-domain book, `margin-words-books`, key `public-books/<id>/book.epub`). Retain the glossary
and catalog's original exact bytes and metadata as the base snapshots **before editing** (§2).
Use the book only to read the place the reader saw.

The [glossary format](https://github.com/duwqijlk/inputread/blob/main/docs/GLOSSARY_FORMAT.md)
is the entry schema. The parts you need:

```
"glossary": {
  "huge": {
    "pos": "adjective",
    "meaning": "Very, very big.",
    "senses": [
      { "meaning": "Very, very big.",
        "anchors": [ { "chapter": 4, "occurrence": 1, "form": "huge", "context": "they came to a huge oak." } ] }
    ]
  }
}
```

- The key is the lemma in lower case. A shape the book uses (`peeked`) can be its own key or go
  in `forms`. A key is a real word, never a spelling cut short by the plural rule (`perhap`,
  `themselve`, `sery`, `freez`). When you touch an entry with such a key, rename it to the real
  word and put the book's shape in `forms` when it differs (GLOSSARY_FORMAT.md, after the field table).
- An anchor is a place: `chapter` (0-based), `occurrence` (1-based count of that word form in the
  chapter), `form`, and `context` (6 to 12 words copied exactly from the book). `occurrence` and
  `context` come from the row; the chapter is the one in the **list's** edition that holds that
  text (see "Chapter numbers"). When the row's `chapters` differs from the list's, count the
  occurrence in the list's chapter, not in the reader's.
- `senseOnly: true` word entries apply only at their anchors. Phrases live in `"phrases"`, keyed by
  the phrase, with `forms`; phrase entries do not support per-place anchors or multiple senses.

Keep the sources' lifecycles separate:

| Source | Review action | When no edit is needed |
| --- | --- | --- |
| Tap signal | Inspect high-ranked locations; add a genuinely missing meaning if verified | Common words and names remain signals, not unfinished reports. Do not resolve just to reduce counts. |
| `missing_meaning` reader report | Add the entry or the missing sense anchor | Verified existing coverage: `already_covered`; an ordinary word/name needing no help: `no_change`. |
| `too_hard` reader report | Make the same meaning easier | Already sufficiently simple: `no_change`. |
| `wrong_meaning` / `suggested` reader report | Correct the sense or phrase match; consider a genuinely better suggestion | Existing correct coverage: `already_covered`; same-sense suggestion not better or unsuitable: `no_change`. |

For reports, these are individual review outcomes (§7), not automatic filters based on word length
or a name list. Unknown identity, missing text or a meaning that would require guessing stays open;
report the missing evidence to the operator. Items not reached within this run's budget stay open too.

What to do with a passage report. Find the place by its text: one paragraph of the book must
contain `before` + `selected` + `after` (spaces may differ). `chapter` and `paragraph` narrow the
search only while the row's `chapters` matches the list's (see "Chapter numbers"); the text decides.
Then write the smallest note that helps:

| The selection is | Write | Notes |
| --- | --- | --- |
| 2 to 5 words that belong together (`phrase`, or a hard group) | a `phrases` entry (GLOSSARY_FORMAT.md 7.3), key = base form | Only when it is really a fixed phrase (7.3's rule), judged by the words themselves, never by `span`. A single hard word inside it is a word entry instead. A longer group, or words that only make sense with the rest of their sentence, is a sentence note. |
| One sentence, or most of one | a `sentences` note (7.2): `context` copied from that sentence and `simple`; add the one-line `grammar` only when the grammar is the hard part (it is optional) | A figure of speech: say plainly what it means here. |
| Several sentences of one paragraph | a `paragraphs` note (7.1) on that paragraph: `mainIdea` and `simple` | When the reader asked about the whole paragraph (or most of it), or no sentence note would do. |
| `wrong` | fix the phrase, sentence or paragraph note shown there, or remove a wrong phrase match | |

A verified easy word or name that needs no note is `no_change`; verified existing help is
`already_covered`. Text you cannot locate, or a book you cannot identify safely, stays open with
the missing evidence in the run report. Do not force a decision after a number of runs.
Never copy more of the book than a note's `context` needs.

**Where readers see each note.** A paragraph note and a sentence note open from the same place:
a ✦ after the paragraph's last word. The paragraph panel shows the paragraph note and, on a second tab,
every sentence note whose `context` is inside that paragraph. In the word card
a sentence note is only a small "Explain this sentence" link that opens that panel. While the panel
is open, the sentence each note explains is marked in the page like a highlighter: the sentence that
holds the note's `context`. Copy the
`context` exactly from ONE sentence: the ✦ needs it inside one paragraph, and the word-card link
needs it inside the tapped sentence. A `context` that is not in the book, or runs across two
paragraphs, gets no ✦ and shows nowhere.

**Passage topics: device-local open overlap, not global book identity.**
`functions/api/feedback/passage.ts` searches unresolved reports with the same device `book_id`,
`chapter` and `paragraph`, then joins an overlapping selection's topic. Offsets use half-open
character overlap; without offsets, one selected text must contain the other. This is not a global
cross-device group, not guaranteed to collect every overlapping report, and the lookup currently
does **not** separate `catalog_id`. Do not infer same book, edition or contributor from `topic`.
A device association can change; verify **each report's** catalog reference, edition and context
independently under §3, even inside one topic. Do not apply a report from another catalog to this
book, or let one ambiguous/unmatched row silently inherit another row's identity. Other devices'
reports may be useful separate evidence only after their own identity/context checks.

Read every page through the saved cutoff (§3) before writing. Where those individually verified
reports truly concern the same place (a short selection inside a longer one, or shared words),
review them together:

1. **Find what is really hard.** When most reports point at the same few words (B's "as if the" sits
   inside A's sentence, and C also marked "as if"), the hard part is those words. Several readers
   marking the same small part is a strong signal; one reader marking a big part is a weak one
   for WHERE the difficulty is. It is still a real question about that big part: a whole paragraph
   asked about with an explanation gets its paragraph note (see step 2).
2. **Write the smallest set of notes that answers every report**, never one note per report:
   - The short part is a phrase or an idiom: a `phrases` entry for it. If the longer selection is
     still hard once that phrase is explained, also a `sentences` note for the whole sentence. Its
     `simple` uses the phrase's plain meaning, so the two say the same thing.
   - The short part is only hard because of the sentence around it: one `sentences` note for the
     sentence. It answers B too; do not add a phrase entry that is not a real phrase.
   - Two reports that only share a few words and point at different hard parts: answer each part
     on its own.
   - **A whole-paragraph report together with reports on sentences inside it** (reader A selected
     the paragraph, readers B and C one sentence each): write **both** a `paragraphs` note for the
     paragraph and a `sentences` note for each of those sentences, each credited to its own reader.
     They answer different questions. The paragraph note says what the paragraph is about as a
     whole; a sentence note explains only its sentence. Keep them consistent: the panel shows the
     paragraph note first and the sentence notes under it. "Only when no sentence note would do"
     does not apply when a reader asked about the whole paragraph and gave an explanation.
3. **Explanations:** compare them with each other and with the sentence. Use the sense the best one
   gives, write it in your own words (writing rules below), and credit that reader. The table for
   "a new suggestion when a meaning already exists" below applies here too: a different sense of a
   different part is its own note and its own credit; the same sense said better replaces the text
   and moves the credit.
4. **Decide per reviewed report id, never close by topic.** Use §7's `fixed`, `already_covered`
   or `no_change` outcome for each individually verified report read through the cutoff. Only
   `fixed` requires a new verified publication; only explanations actually adopted with credit
   can be accepted. Unreviewed, unidentified, unlocated and post-cutoff reports stay open. A
   topic is a review aid, not authorization for a bulk UPDATE.

A topic is closed only when all its reports are resolved. A later report that survives duplicate
suppression starts a new `pending` topic if no overlapping unresolved report is found; otherwise
it can join an existing open topic. It never acquires word feedback's `reopened` status. A failed
fix therefore comes back as fresh work, not necessarily the same topic id.

Reviewing a reader's `suggestion`:

- **Accept the sense, rewrite the words.** If the suggestion names the sense that fits the
  sentence, write the entry in your own simple English (rules below). Do not copy it word for
  word: it may be copied from a dictionary, and it may be Chinese, which a word list must not hold.
- **Reject** it when it does not fit the sentence, guesses at the plot, is a joke, spam, a link,
  or anything other than a meaning. Review the underlying question separately; an unsuitable
  suggestion does not require leaving a verified no-change report open.
- Several readers suggesting the same sense for one place is a strong signal. One reader alone
  is a hint, not proof: check it against the sentence.
- Never put a reader's text, name, or anything personal into the word list or your report beyond
  "accepted" / "rejected" and why.
- **You fill in the rest.** A reader sends only a meaning. Every entry and new sense you write must
  also have `pos` (part of speech) for the word **as it appears in this sentence** (`drifted` ->
  `past-tense verb`, `lanterns` -> `plural noun`). Use the labels the app knows, listed in
  [book-pack specification §4.1](https://github.com/duwqijlk/inputread/blob/main/docs/book-pack-spec.md).
  Also add the anchor
  from the report, and `whyHard` when a short reason helps. Never ask the reader for these.
- **Credit an accepted suggestion.** On the sense (or entry) whose meaning came from it, add
  `"credit": "<suggested_by>"`. The card then shows "From <their nickname>" with their picture. Use
  only `suggested_by`; never write a name or email. One credit per sense.

When a place already has a meaning, possibly one credited to an earlier reader (A), and a new
suggestion arrives from reader B, compare B's with the meaning shown **at this place** and choose one:

| B's suggestion | What to do | Credit | Mark B's report |
| --- | --- | --- | --- |
| A **different sense** that fits this sentence (A's fits other places) | Add an anchored word sense; preserve A's sense | New sense: B | `fixed` + accepted |
| The **same sense, said clearly better** (simpler, closer to this sentence, or A's was wrong) | Rewrite that sense's `meaning` | Switch the sense's `credit` to B | `fixed` + accepted |
| The same sense, **not better** | Change nothing | Keep A | `no_change`, not accepted |
| Does not fit the sentence | Change nothing after verifying the selected place | Keep A | `no_change`, not accepted |

- A's past help still counts: the rank counts accepted reports, not the credits shown now, so A
  keeps their place after B improves the sense.
- Several suggestions for one place in the same run: read them together, write one meaning, and
  credit the earliest reader whose sense you essentially used. Mark the others resolved; mark one
  accepted only when you really took their sense.
- Repeated `wrong_meaning` or `too_hard` reports on a credited sense (status `reopened`) mean the
  sense still does not work: fix it first, by the same table.

Writing rules (GLOSSARY_FORMAT.md 7.6): English only, the 2,000 most common words, short, one
idea; restate, never add facts or guess the plot; keep names. Change **only** what an item asks
for. Do not reformat the file, reorder keys, or touch unrelated entries, and keep `version`,
`title`, `chapters`, `sha256`, `spine` and `segmentation` as they are.

Copyright: only a short `context` may come from the book. Never put more of the book anywhere,
never upload the EPUB anywhere, never include book text in your report beyond a context.

## 5. Check before you publish

The file must parse as JSON, and every anchor you added or changed must point at a real place:
in that chapter (split as GLOSSARY_FORMAT.md section 3 describes), the `occurrence`-th time the
`form` appears must be inside the `context` text. If you cannot confirm a place, leave it out.
Compare with the live snapshot: every change must be one you meant to make for an item. Confirm
these checks from the downloaded bytes; this API-token-only task does not require Node or a
repository checkout. If you cannot verify an anchor, leave that item open.

A malformed entry no longer hides the rest of the list: the reader drops that one entry or note and
shows the others, and a list with no readable word entry still fails to load. So a bad note does
not lock readers out, but it also fails silently — the note you wrote simply never appears. Keep
the shape exact: a sentence note needs `context` and `simple` (`grammar` is optional, ONE line), a
paragraph note needs `context`, `mainIdea` and `simple`, and an entry's fields are the ones
GLOSSARY_FORMAT.md lists.

**Every suggestion you will mark accepted must have its credit in the file.** Before you publish,
go through each report you plan to mark `accepted` in step 7 and find, in the new file, the entry or
sense that now holds that meaning. It must carry `"credit": "<suggested_by>"` of that report:

- An entry with no `senses`: `credit` sits on the entry itself, next to its `meaning`.
- An entry with `senses`: `credit` sits on the sense whose anchor is this report's place
  (same `chapter`, `occurrence` and `form`), not on the entry.
- A phrase: `credit` sits on the phrase entry.
- A passage report answered by a sentence note or a paragraph note: `credit` sits on that note
  (`sentences[i].credit`, `paragraphs[i].credit`). The help panel shows "From <nickname>" there.
- `credit` is a **field** inside that entry or sense. It is never a key of `glossary` or `phrases`:
  a top-level `"credit": { ... }` is a word entry for the word "credit", not a credit. If you find one
  you did not mean to add as a word, remove it.

A reader sees "From <their nickname>" on the card only from this field. Recording `accepted_at` in D1
alone counts them in the rank but shows nothing on the card. If you cannot place a credit, do not mark
that report accepted. List in your report each accepted id with the word and where its credit is.

## 6. Publish (two R2 writes, in this order)

Keep §2's coordinated exclusive window. Follow the
[shared count/version rules](https://inputread.site/kit/maintenance.md#versions):

1. Retain §4's pre-edit snapshots of the glossary and catalog's exact bytes and metadata.
   Immediately before the first write, reread both via the R2 API and compare with those snapshots.
   If either changed, **abort and rebase** the edits on fresh snapshots, repeating §5. Compute
   SHA-256 of the exact new glossary bytes.
2. Write those `glossary.json` bytes to its key. Then reread the catalog, confirming it still matches
   the snapshot. If it changed, stop for recovery below; do not overwrite it with the old candidate.
   Otherwise change **only this book's row** and write it back:
   - `words` = `Number(file.count) || Object.keys(file.glossary).length`, matching the admin
     publisher. Check it is correct for the edited list; update a stale explicit `count` if your
     edits change the word total. `phrases` = keys in its object, `paragraphs` / `sentences` = array
     lengths (0 when absent); `glossary.bytes` and `glossary.sha256` come from the exact written bytes.
   - Set `previousUpdated` to the old `updated` only when an existing glossary hash changes;
     otherwise preserve it. Set row `updated` and top-level `updated` to now (ISO time).
   - Public book: also set `rev` and `glossary.rev` to the first 12 hex digits of the new SHA-256.
   Keep every other row, field and order exactly, including this row's `genres`, `series`,
   `seriesNumber`, category and editorial metadata. Patrol does not classify books or clear
   classification when publishing a glossary. Use one-space JSON indent and a final newline.
3. **Verify before §7:** GET the glossary and catalog back through the authenticated R2 API.
   Compare exact bytes and metadata with the intended writes, recompute the glossary byte length
   and SHA-256, check counts/revisions and all preserved rows/fields, and confirm each intended fix
   and accepted suggestion's credit is present. A PUT success is not enough.

If a write or verification fails, **do not mark anything accepted or resolved**. Stop and report,
using [recovery](https://inputread.site/kit/maintenance.md#recovery) under the exclusive window.
Replacing `glossary.json` before the catalog can leave a hash mismatch if the catalog write fails;
readers may be unable to download or update. This is not a transaction or automatic rollback.
After verified publication and catalog refresh, readers can request **Update**; their device copy
is not silently replaced.

## 7. Mark items done

For reader reports, `resolved` means **review completed**, not necessarily a repaired word list.
Use exactly one `resolution`:

- `fixed`: this run changed content, and §6's R2 readback verified the fix and any adopted credit.
- `already_covered`: verified current content already answers the report; do not republish identical bytes.
- `no_change`: verified the book/place and deliberately found no worthwhile edit (name, ordinary word,
  sufficiently simple meaning, or a suggestion that is not better or does not fit).

All three use the **verified current live revision** as `resolved_rev`, even without a new publish.
Do not invent a revision or leave it empty because no file changed. If identity, content or revision
cannot be verified, leave the report open. Historical blank `resolution` means unknown, not `fixed`.
No bulk cleanup is authorized: only individually reviewed ids may be closed. A duplicate is not by
itself proof that both reports were answered.

Taps have no resolution column. Resolve a tap only when a verified live fix covers its exact place,
using its full primary key and read-time snapshots below, never to clear common-word/name signals.
The old admin grouped resolve action leaves resolution blank and is not the patrol's per-id review
tool; do not use it to assign outcomes to unseen reports.

```sql
UPDATE book_word_taps SET status = 'resolved', resolved_at = ?1, resolved_rev = ?2
 WHERE book_id = ?3 AND word = ?4 AND chapter = ?5 AND occurrence = ?6
   AND catalog_id = ?7 AND glossary_rev = ?8 AND last_tapped_at = ?9
   AND in_glossary = 0 AND status != 'resolved';

UPDATE word_feedback SET status = 'resolved', resolved_at = ?1, resolved_rev = ?2, resolution = ?4
 WHERE id = ?3 AND status != 'resolved' AND length(trim(?2)) > 0
   AND ?4 IN ('fixed', 'already_covered', 'no_change');

UPDATE passage_feedback SET status = 'resolved', resolved_at = ?1, resolved_rev = ?2, resolution = ?6
 WHERE id = ?3 AND topic = ?4 AND id <= ?5 AND status != 'resolved' AND length(trim(?2)) > 0
   AND ?6 IN ('fixed', 'already_covered', 'no_change');
```

`?1` = now in milliseconds, `?2` = verified live revision. For **taps**, bind `?3`–`?6` to the
selected row's full primary key (`book_id`, `word`, `chapter`, `occurrence`), `?7` to its **original**
`catalog_id` (keep `''` for a verified legacy fallback), `?8` to its selected `glossary_rev`, and
`?9` to its selected `last_tapped_at`. Save these snapshots when reading §3; do not substitute
the current live revision for `?8`. Execute once per verified location, never a `book_title + word`
batch. Zero changed rows means the row changed or is already resolved: reread and re-evaluate,
not a reason to broaden the WHERE. These guards avoid resolving a new tap or a changed catalog/list
on that device while you worked. Word feedback `?3` is its individually reviewed `id`.
Word feedback adds `?4` = its explicit resolution; passage feedback adds `?6` = its explicit
resolution. Existing id/topic/cutoff positions are unchanged.
For passage feedback, execute **once per reviewed, answered id**: `?3` = that id, `?4` = its
original topic, `?5` = the saved topic cutoff from §3. Do not use `WHERE topic = ...` as an
alternative UPDATE, even when you believe you answered a whole topic: unseen/new rows can arrive
while you work. Do not construct the id list from a fresh broad query after publishing. Zero changed
rows requires a reread/re-evaluation, not a broader WHERE. Acceptance below also uses only these
individually reviewed ids, after their resolution and credit have been verified.
New word feedback carrying an explanation always remains reviewable (`pending` or `reopened`),
even from an old revision; only suggestion-free old-client reports can be automatically suppressed.
Word feedback may return as `reopened`; passage feedback instead inserts `pending` and joins an
open overlap or starts a new topic. **Missing-word taps do not currently reopen automatically**:
the tap upsert keeps a resolved status even when its revision/time changes. Do not treat absence from the open-taps query
as proof that a previously resolved word is now covered; investigate repeat reports separately.

For each actually adopted suggestion whose `fixed` resolution and credit were verified, record
acceptance (this is what the rank counts). `already_covered` and `no_change` never gain acceptance.
Existing historical accepted rows keep their credit/counts; do not infer a missing old resolution:

```sql
UPDATE word_feedback SET accepted_at = ?1, accepted_rev = ?2
 WHERE id = ?3 AND suggestion != '' AND status = 'resolved' AND resolution = 'fixed'
   AND resolved_rev = ?2 AND accepted_at = 0;

UPDATE passage_feedback SET accepted_at = ?1, accepted_rev = ?2
 WHERE id = ?3 AND suggestion != '' AND status = 'resolved' AND resolution = 'fixed'
   AND resolved_rev = ?2 AND accepted_at = 0;
```

An accepted passage suggestion is credited like a word one: `"credit": "<suggested_by>"` on the phrase
entry, sentence note or paragraph note whose text came from it (GLOSSARY_FORMAT.md 7.1-7.3).

The authority for contributor rebuilding is `functions/lib/contributors.ts` and
`functions/lib/book-maintainers.ts`. The token-only SQL procedure below is a temporary compatible
copy: keep it aligned with those implementations and test it when aggregation changes. It remains
necessary until a controlled runner can reuse the implementation; the admin rebuild endpoint needs
a site-admin session, which a Cloudflare API token does not supply. Do not add a privileged endpoint
or put EPUB/large-file validation into a Pages Free request to replace this procedure.

Then, once per run after the last accepted suggestion, refresh the public credit file. Read the
rows with this query and write them as `contributors.json` to bucket `margin-words-books`
(R2 write, `Content-Type: application/json`, `Cache-Control: public, max-age=300`; set and
verify both metadata fields on every refresh):

```sql
WITH accepted AS (
  SELECT user_id, 'w:' || book_id || ':' || word || ':' || chapter || ':' || occurrence AS place, accepted_at
    FROM word_feedback WHERE accepted_at > 0 AND user_id IS NOT NULL
  UNION ALL
  SELECT user_id, 'p:' || book_id || ':' || chapter || ':' || paragraph || ':' || selected AS place, accepted_at
    FROM passage_feedback WHERE accepted_at > 0 AND user_id IS NOT NULL
  UNION ALL
  SELECT user_id, 'd:' || position_key AS place, accepted_at FROM dictionary_choice_credits
)
SELECT u.public_id AS id, COALESCE(u.nickname, '') AS name, u.avatar_rev AS avatar,
       COUNT(DISTINCT a.place) AS helped
  FROM accepted a JOIN users u ON u.id = a.user_id
 WHERE u.public_id IS NOT NULL
 GROUP BY u.id ORDER BY helped DESC, MIN(a.accepted_at) ASC LIMIT 500;
```

(This is the same query the site uses in `functions/lib/contributors.ts`.)

```
{ "format": 1, "updated": "<now, ISO>", "people": [ { "id": "...", "name": "...", "helped": 3, "avatar": 1792900000 } ],
  "books": { "word-lists:wonder": { "count": 12, "top": ["<id>", "<id>", "<id>"] } } }
```

Leave out `avatar` when it is 0. Write nothing else into the file: no email, no internal id.

**`books` is required.** Discover covers and book details show each book's maintainers from it: a
file written without it removes them from every cover. Build it from this query (the same rule as
`functions/lib/book-maintainers.ts`):

```sql
WITH accepted AS (
  SELECT user_id, catalog_id, book_title,
         'w:' || book_id || ':' || word || ':' || chapter || ':' || occurrence AS place, accepted_at
    FROM word_feedback WHERE accepted_at > 0 AND user_id IS NOT NULL
  UNION ALL
  SELECT user_id, catalog_id, book_title,
         'p:' || book_id || ':' || chapter || ':' || paragraph || ':' || selected AS place, accepted_at
    FROM passage_feedback WHERE accepted_at > 0 AND user_id IS NOT NULL
  UNION ALL
  SELECT user_id, catalog_id, '' AS book_title, 'd:' || position_key AS place, accepted_at
    FROM dictionary_choice_credits
)
SELECT u.public_id AS id, COALESCE(u.nickname, '') AS name, u.avatar_rev AS avatar,
       a.catalog_id AS ref, a.book_title AS title,
       a.place AS place, MIN(a.accepted_at) AS first
  FROM accepted a JOIN users u ON u.id = a.user_id
 WHERE u.public_id IS NOT NULL
 GROUP BY u.id, a.catalog_id, a.book_title, a.place;
```

- The book of a row is its `ref` (`word-lists:<id>` / `public-books:<id>`). A row with `ref` `''` is an
  older report: find its `title` in the two live catalogs (case, spaces and punctuation ignored).
  Normalize using `normalizeTitle` in `src/lib/book-title.ts` (including its edition-label rule).
  Use it only when the title names exactly **one** catalog book; otherwise leave that row out. If
  either catalog cannot be read or parsed, abort the refresh rather than guess or lose credits.
  Ignore malformed nonempty references; do not fall back to title for those.
- Per book, count each reader's distinct non-NULL `place` after resolving the book, even when
  multiple titles or references name it. `count` is how many readers the book
  has; `top` is the public ids of the three with the most help (ties: the earlier `first`, then the
  public id in alphabetical order, so the same data always gives the same faces).
- Every id in a `top` must also be in `people`. When the 500-row `people` query left one out, add
  that reader there with their `name`, `avatar` and total `helped`: the count of distinct
  non-NULL `place` across all their rows, including rows that cannot be matched to a book.
  After merging, keep `people` sorted by total `helped` descending, not by book reference.
  Added readers with equal help are ordered by their earliest acceptance across all rows, then
  public id; preserve the original 500-row query order ahead of added readers with equal help.
  Keep those original 500 rows unchanged. For each added reader, also write `rank`: their global
  position after the original 500, counting **all** remaining readers in that order, including
  readers not selected for any `top`. Its position in the filtered `people` array is not its rank.
For this file too, keep the coordinated window, snapshot bytes/metadata, reread before overwriting
and verify the R2 readback against the query result. If it changed, abort/rebase instead of dropping
another writer's changes. Report a failed credit-file refresh; do not claim the public rank is updated.

## 8. Limits

- At most 10 books per run; reopened word feedback and reported items first (word and passage
  reports), then the words at the top of the ranked tap list in §3 (most readers first). Fully read a passage topic through its saved cutoff before
  deciding; resolve only its individually verified ids with a §7 outcome. Defer it if review is incomplete.
- D1 is on the Free plan (100,000 row writes a day for the whole site). The queries above read a
  few thousand rows; each resolve writes a few. Use only the bounded topic discovery, the independent
  zero-topic anomaly lane and finite topic/cutoff pagination in §3; do not poll, rerun discovery
  indefinitely or broaden writes to save queries. Topic repair and schema migrations are operator work.
- No other SQL that writes. No `DELETE`, `DROP` or `ALTER`. No R2 writes except a glossary, its
  catalog, and `contributors.json`. Never write to `margin-words-private`, and never touch
  `avatars/`.
- Unreviewed or evidence-blocked reader reports stay open; state which they are. Individually
  verified no-change reports may be closed under §7. Low-priority taps remain signals, not debt.
- Do not run schema migrations, backfill old resolution reasons, or bulk-close the historical queue.

## 9. Report

End each run with a short report per book: what you added, what you changed and why (the
item that asked for it), which reader suggestions you accepted or rejected and why (for each accepted
one: report id, word or passage, and the entry, sense or note that holds its `credit`), each passage
topic you answered (its id, the reports in it, and the notes you wrote for it), what you
skipped and why, the verified revision, the R2 verification/credit-file refresh result, and any error
or unresolved recovery. Include discovery pages used, start/end topic cursor and deferred topics
for next-run continuation. Also report the zero-topic anomaly count at sweep start, pages used,
fixed cutoff, start/end anomaly id cursor, reviewed/deferred ids and any operator repair needed.
Include each topic's saved cutoff, reviewed ids, resolved/accepted ids and
unreviewed/deferred rows; do not claim the topic is closed from a partial query. Record the
instruction source URLs/retrieval times and original-byte hashes (or **unverified**), plus optional
checkout commit/dirty state. Local/hosted equality is not a patrol prerequisite.
Finish with separate counts: reader reports reviewed by `fixed` / `already_covered` / `no_change`,
reports not reached, reports blocked by missing evidence, and tap signals selected/examined/fixed.
Do not label the total tap row count as an unresolved-report backlog. Say so if no reports were open.

## 10. Standard meaning choices

This is part of the original daily patrol, not a separate manual or scheduler. It supplements
existing community review with exact-position mappings to existing standard sense IDs. Read all
sections before writes. Standard dictionary files remain read-only. If the runtime cannot prove
the exact source/coordinates, leave that choice needs-context rather than approximating them.

### Readiness and schedule

- Run daily at 02:00 local China time (Asia/Shanghai, UTC+08:00).
- First check D1 migration history for 0026 and 0027. If absent, do not issue choice/credit SQL.
  Continue only already-supported legacy community review and report which feature is blocked.
- Confirm the reader deployment supports exact-position mapping consumption before publishing one.
- Scheduling and execution are owned by the user's separate patrol agent, not this repository or
  this desktop session. This change creates no scheduled task, Cron Trigger or autonomous loop.
  The external agent runs this procedure at 02:00 and preserves last-run/cutoff receipts.
- No passive tap collection. Historical tap rows are legacy evidence, not dictionary votes.

### Worklist: bounded, deterministic and no blind repeat scans

Capture a run cutoff timestamp before reading. In pages of at most 100, use a keyset cursor
(updated_at,user_id,target_hash), not OFFSET. Start from changed/unreviewed rows:

```sql
SELECT c.*
  FROM dictionary_choices c
  LEFT JOIN dictionary_choice_reviews r
    ON r.user_id = c.user_id AND r.target_hash = c.target_hash
 WHERE c.updated_at <= ?1
   AND (r.user_id IS NULL OR r.reviewed_updated_at != c.updated_at
        OR r.reviewed_choice_id != c.choice_id OR r.reviewed_choice_lemma != c.choice_lemma
        OR r.reviewed_choice_release != c.choice_release)
   AND (c.updated_at > ?2 OR (c.updated_at = ?2 AND c.user_id > ?3)
        OR (c.updated_at = ?2 AND c.user_id = ?3 AND c.target_hash > ?4))
 ORDER BY c.updated_at,c.user_id,c.target_hash LIMIT 100;
```

Bind ?1=cutoff, ?2..4=last cursor (initial 0,'',''). Snapshot full target_json, timestamps and choice
provenance. Work only that snapshot. A needs-context row does not retry every night unchanged;
retry only on a new reader choice or an explicit targeted operator re-review. A cancelled mutable
row is no longer pending work; do not resurrect it from an earlier task snapshot.

Group only **after proving exact source positions**. Client device bookId, title, sentence or counts
are not canonical public identities. No popularity threshold, highest-vote auto-selection, or
cross-book reuse. Review one source context once for all captured choices proven to name it.

### Exact position and source proof

1. Resolve catalogId against both live catalogs; reject ambiguity, custom/no catalog and wrong book.
   Read the authorized original EPUB (private bucket is read-only) and record original-byte SHA-256.
2. Use the current reader parser, segmentation, spine-merge settings and reading-block extraction.
   Reproduce the exact rendered chapter paragraph array P using the actual app's EPUB/flow helpers.
   Do not approximate by stripping XML, lowercasing, whitespace normalizing or title matching.
   If the runner cannot execute or verify that parser route, record needs-context, no mapping/point.
3. New target evidence includes paragraphText and position. Require paragraphText identical to P[i],
   and independently recompute the following (UTF-8 SHA-256, code-point offset, no normalization):
   chapterSha256 = SHA256(JSON.stringify(P)); paragraphSha256 = SHA256(P[i]);
   surface = code-point slice of P[i] at offset with the selected surface length. Repeated identical
   chapters/source matches are ambiguous and require proof of uniqueness; do not pick the first.
4. Match original case-sensitive surface exactly. NFC is only for the lexical lookup key; don't
   silently change source text. Validate chapter index/count/occurrence/context against the original.
   Legacy evidence lacking full chapter/paragraph proof stays needs-context, never gets inferred IDs.
5. Validate chosen full ID and lemma in the current immutable dictionary, including surface case/
   inflection legality and POS. Read original sentence and bounded surrounding paragraphs, choose
   the meaning actually fitting that occurrence. The independent dictionary remains read-only.
6. If the reader picked the wrong ID but another published ID is correct, a mapping may use that ID
   after full proof, but **do not credit the wrong choice**. No source sense fits => no mapping/credit.

Canonical position object (fixed field order):

```json
{"chapterSha256":"<64hex>","paragraphIndex":0,"paragraphSha256":"<64hex>","offset":0,"surface":"<verbatim>"}
```

positionKey = SHA256(JSON.stringify([catalogId,chapterSha256,paragraphIndex,paragraphSha256,offset,surface])).
text_sha256 in the acceptance ledger is chapterSha256. The chapter fingerprint and paragraph index
isolate repeated paragraphs and incompatible editions without trusting old PackRecord EPUB hashes.

### Publish a static direct mapping, not a live vote query

Key: `dictionary/positions/<catalog>/<id>/mappings.json` in the public books bucket.

```json
{"schema":"oewn-position-mappings-v1","catalogId":"word-lists:book-id","entries":[{"positionKey":"<64hex>","chapterSha256":"<64hex>","paragraphIndex":0,"paragraphSha256":"<64hex>","offset":0,"surface":"corner","senseId":"<existing opaque ID>","lemma":"corner","release":"<dictionary release>","reviewedAt":1,"matchedBy":["0123456789ab"]}]}
```

Preserve every unrelated verified row. One row per canonical positionKey; content max 192 KiB for
this format. If a book exceeds this bound, stop new mapping publication and request a versioned
shard extension, never silently truncate old mappings. Confirm all referenced IDs remain available.
Use JSON content type and `Cache-Control: public, max-age=300`. This adds no votes or private users
to the public file. The reader shares one static download per book/page, regardless of total votes,
then verifies exact chapter/paragraph/offset/surface locally. A mismatch falls back to candidates.
A confirmed position displays a single source meaning, with no additional vote requests.

Community authorship and standard context matching are independent contributions. The same reader
may earn one adopted-community contribution and one adopted-standard-match contribution at the
same position; different readers may provide these separately. Never deduplicate across contribution
types or replace an earlier community author when accepting a standard match. A position may
show `From Alex` below Alex's community explanation and `Matched by Sam` below the standard
meaning matched by Sam. Never copy the community credit onto the standard sense or replace one
with the other. Public mapping rows may include `matchedBy: ["<public_id>"]` (at most three unique
12-character lowercase-hex public IDs, ordered by first verified acceptance then ID). Never include
email, internal user IDs, raw vote totals or submitted text in these credit fields. More accepted
readers may all receive points even when only the first three are shown; contributor projection
must include every displayed ID. No point for a selected ID the reviewer did not adopt.

Before writes follow maintenance's exclusive writer window, exact-byte/metadata snapshot and
immediate baseline reread rules. If coordination is unavailable, remain read-only. Do not overwrite
an object changed since the run snapshot. Publish the mapping, read back storage bytes and metadata,
verify SHA-256, then verify its public URL. A PUT response alone is not successful publication.
Never write standard dictionary current/release/case/form-index objects during this patrol.

### Review outcomes and contribution points

- accepted: selected ID is exactly the independently verified and published ID; source location
  and readback receipt complete. Award **one contribution point per user per canonical position**.
- rejected: selected ID is not applicable; no point, including if the agent publishes a different ID.
- needs-context: original text/edition/coordinate/candidate proof missing or ambiguous; no point.
- A repeat vote, device duplicate, retry, switch or later cancellation never creates extra points.
  Earned credits remain durable separately from mutable choice rows and account deletion cascades.
- Several different readers whose exact selections are adopted each get one point for that position.
  Keep standard mapping points separate from existing accepted community-text points; each is an
  independently adopted contribution. Do not count clicks or failed/unverified submissions.

Only after source proof + mapping readback, issue the following in **one atomic D1 batch**. Values
are bound parameters, never interpolated. Guard against source updates/cancellation and newer
reviews. Save receipts of affected rows. This is not an unbounded UPDATE by word/book/sentence.

```sql
INSERT INTO dictionary_choice_reviews
 (user_id,target_hash,reviewed_updated_at,reviewed_choice_id,reviewed_choice_lemma,
  reviewed_choice_release,outcome,reason,catalog_id,text_sha256,canonical_position,
  verified_sense_id,evidence_sha256,mapping_key,accepted_at,reviewed_at)
SELECT c.user_id,c.target_hash,c.updated_at,c.choice_id,c.choice_lemma,c.choice_release,
 ?8,?9,?10,?11,?12,?13,?14,?15,?16,?17
 FROM dictionary_choices c
 WHERE c.user_id=?1 AND c.target_hash=?2 AND c.updated_at=?3
   AND c.choice_id=?4 AND c.choice_lemma=?5 AND c.choice_release=?6 AND c.target_json=?7
ON CONFLICT(user_id,target_hash) DO UPDATE SET
 reviewed_updated_at=excluded.reviewed_updated_at,reviewed_choice_id=excluded.reviewed_choice_id,
 reviewed_choice_lemma=excluded.reviewed_choice_lemma,reviewed_choice_release=excluded.reviewed_choice_release,
 outcome=excluded.outcome,reason=excluded.reason,catalog_id=excluded.catalog_id,
 text_sha256=excluded.text_sha256,canonical_position=excluded.canonical_position,
 verified_sense_id=excluded.verified_sense_id,evidence_sha256=excluded.evidence_sha256,
 mapping_key=excluded.mapping_key,accepted_at=excluded.accepted_at,reviewed_at=excluded.reviewed_at
WHERE dictionary_choice_reviews.reviewed_updated_at <= excluded.reviewed_updated_at;

INSERT INTO dictionary_choice_credits
 (user_id,position_key,catalog_id,text_sha256,position_json,sense_id,accepted_at,mapping_key,mapping_sha256)
SELECT r.user_id,?18,r.catalog_id,r.text_sha256,r.canonical_position,r.verified_sense_id,
 r.accepted_at,r.mapping_key,r.evidence_sha256
 FROM dictionary_choice_reviews r JOIN dictionary_choices c
 ON c.user_id=r.user_id AND c.target_hash=r.target_hash
 WHERE r.user_id=?1 AND r.target_hash=?2 AND r.reviewed_updated_at=?3
   AND r.reviewed_choice_id=?4 AND r.reviewed_choice_lemma=?5 AND r.reviewed_choice_release=?6
   AND c.target_json=?7 AND c.updated_at=?3 AND c.choice_id=?4 AND c.choice_lemma=?5 AND c.choice_release=?6
   AND r.outcome='accepted' AND r.verified_sense_id=?4 AND r.reviewed_at=?17
   AND r.catalog_id=?10 AND r.text_sha256=?11 AND r.canonical_position=?12
   AND r.verified_sense_id=?13 AND r.evidence_sha256=?14 AND r.mapping_key=?15
ON CONFLICT DO NOTHING;
```

?1..7 are the captured source snapshot. ?8=outcome, ?9=specific reason,
?10=verified catalogId, ?11=chapter SHA256, ?12=canonical JSON above,
?13=verified published sense ID, ?14=readback complete mapping SHA256,
?15=mapping key, ?16=accepted timestamp (0 for other outcomes), ?17=review timestamp,
?18=canonical positionKey. For rejected/needs-context omit unknown evidence as empty strings,
accepted_at=0 and never insert credit. Never fake hashes/receipts to satisfy schema constraints.
Zero reviewed rows means race/cancellation: reread, do not broaden guards or mark success.
The migration/SQL constraints are evidence checks, not semantic proof of a correct acceptance.

After final accepted choice/community suggestion, rebuild **one** contributors.json projection,
including dictionary_choice_credits in global helped totals, isContributor and per-book maintainers.
No per-like projection rebuilds and no browser requests per voter. Match SQL against current
functions/lib/contributors.ts and book-maintainers.ts; verify file original bytes and both people/books.
Report accepted/rejected/needs-context counts, points newly awarded vs duplicates, mapping keys and
readback hashes, actual migrations/deploy readiness, failures and work left. Never call a schedule
or a local patch an executed nightly review.
