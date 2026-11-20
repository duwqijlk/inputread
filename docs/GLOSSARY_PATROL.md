# Daily Glossary & Dictionary Patrol (V2 — Slim L1/L2/L3 Edition)

**Schedule:** Once daily at **02:00 Asia/Shanghai** (owned by the external patrol agent).  
**Authority:** The hosted patrol and maintenance originals read for this run are the operational authority ([maintenance.md](https://inputread.site/kit/maintenance.md) and `docs/GLOSSARY_FORMAT.md`). No local/hosted hash-equality ceremony is required; if a local checkout is in a dirty state or unavailable, rely on the hosted originals and live R2 original bytes.  
**Scope:** Strictly **Daily User-Feedback Patrol ONLY** (Cloudflare D1 + R2). Handle only reader feedback (`word_feedback`, `passage_feedback`, `dictionary_choices`), L3 credits, and `contributors.json`. Never deploy code, run D1 migrations, upload `.epub` files, edit standard OEWN definitions, or run whole-book upgrades during daily patrol.

> **Retired:** `book_word_taps` (passive missing-word taps) is retired legacy data — do **not** scan, rank, or update it during daily patrol.

---

## 1. Access & Three-Layer Storage Contract (L1 / L2 / L3)

- **Auth:** `Authorization: Bearer <token>` (`D1 Edit` + `R2 Storage Edit`) sent **only** to `https://api.cloudflare.com/client/v4/accounts/6ece9f6dbbc73db1be2810fb39f277c3`. Never log or store the token.
- **D1 (`margin-words`):** `c286e644-2ead-438c-bb65-70ee028d957a` (parameterized `params` only; never interpolate SQL).
- **R2 Buckets:** `margin-words-books` (read/write) and `margin-words-private` (**read-only**, solely to read original EPUB ZIP bytes to verify book text/coordinates).

Every live book consists of **three strictly separated layers**:

| Layer | R2 Key (`margin-words-books`) | Cache-Control | Hard Cap | Purpose & Patrol Rule |
|---|---|---|---:|---|
| **L1 Standard Mappings** | `dictionary/positions/<catalog>/<id>/mappings.json` | `public, max-age=300` | `192 KiB` | Static OEWN `senseId + lemma` position proofs (`oewn-position-mappings-v1`) + `matchedBy` (max 3 public IDs). Never truncate old rows. |
| **L2 Base Glossary** | `word-lists/<id>/glossary.json` *(or `public-books/<id>/glossary.json`)* | `no-store` | `16,000,000 B` | Clean community/Agent base (`glossary`, `phrases`, `paragraphs`, `sentences`). **Zero inline `credit` fields** (`countCreditsInGlossary().total === 0`). Auto-compact JSON (`separators=(',', ':')`) when pretty output `> 12 MiB`. |
| **L3 Reader Credits** | `dictionary/credits/<catalog>/<id>/credits.json` | `public, max-age=300` | — | **All adopted reader-submitted `credit` entries** (`words`, `phrases`, `sentences`, `paragraphs`). Isolates reader credits so future on-demand L2 upgrades never overwrite user contributions. |

- **Shared Catalogs:** `word-lists/catalog.json` (`lists[]`) and `public-books/catalog.json` (`packs[]`), `Cache-Control: no-store`. Update **only** the edited book's row; preserve all unrelated rows and all `PRESERVED_ROW_KEYS` (`id`, `title`, `author`, `added`, `cover`, `lexile`, `isbn`, `series`, `seriesNumber`, `category`, `genres`, `credits`).
- **Shared Contributors:** `contributors.json`, `Cache-Control: public, max-age=300`. Rebuilt **once** at end of run after all accepted items are verified.

---

## 2. Daily Limits & Pre-Flight

1. **Migration Check:** Confirm D1 migrations `0025_feedback_resolution.sql`, `0026_dictionary_choices.sql`, and `0027_dictionary_choice_review.sql` are applied. If `0025` is absent, stay read-only. If `0026`/`0027` are absent, skip Queue C and report blocked.
2. **Per-Run Budget:** Max **10 books** published per run; max **3 topic-discovery pages per run** (20 topics/page); max **1 zero-topic page per run** (20 anomaly rows); max **100 `dictionary_choices` rows/page** (keyset cursor). Unreached items stay open for next run.
3. **Verification Tooling & Token-Only Fallback:** Run local verification with Node 22+ and the Reader's own scripts (`validate-glossary.mjs`, `check-no-cjk.mjs`, `check-definition-words.mjs`, `credits-layer.mjs`, `positions-build.mjs`, `positions-verify.mjs`). A Cloudflare API token does not supply local Reader scripts by itself; if a local checkout is absent or in a dirty state, you may stage a temporary compatible copy of the Reader verification scripts from the repository, or else stay read-only and leave items unverified rather than publishing without proof.

---

## 3. Step-by-Step Execution Flow

### Step 1 — Pull Bounded Work (Read-Only, Priority Order)

1. **Queue A — Word Feedback (`word_feedback`)**: `status != 'resolved'`, prioritize `reopened` and rows carrying `suggestion != ''`. Word feedback has `pending`, `reopened`, and `resolved`; revision hashes are not ordered versions.
2. **Queue B — Passage Feedback (`passage_feedback`)**:
   - Passage inserts are always `pending`, not `reopened` (a closed topic simply means all its rows are `resolved`). Topic overlap does **not** separate `catalog_id`: verify **every row's** `catalog_id`, edition, and exact EPUB ZIP text independently.
   - Discover distinct open topics with `topic > saved_cursor` (**3 topic-discovery pages per run**, 20 topics/page; the initial 300-row query is a triage sample only, never a cursor source). Advance and persist `discovery_topic_cursor` to the **last considered topic**, even if that topic was deferred; when an empty page ends the sweep, save cursor 0 for the **next run** without wrapping in the same run.
   - For each topic reviewed, capture `MAX(id) AS cutoff_id` first, then page **all** rows up to `cutoff_id` (`LIMIT 300`, including already-resolved rows for context). Never widen `cutoff_id`.
   - **Zero-Topic Anomaly Lane:** Independently run at most **1 zero-topic page per run** (20 rows where `topic = 0`, bounded by `anomaly_cutoff_id`), reviewing each row individually (never group `topic = 0`) and resolving only with its **original topic 0** guard; report any `topic = 0` invariant violation to the operator.
3. **Queue C — Standard Meaning Choices (`dictionary_choices`)**: Capture `cutoff = now_ms` and pull unreviewed/changed rows via keyset cursor `(updated_at, user_id, target_hash)` (max 100 rows/page).

### Step 2 — Semantic Review & Editing Rules

Never blindly copy a reader's text (it may be Chinese, copied from a dictionary, spam, or plot-guessing). Accept the **sense**, rewrite in plain English, and route each verified edit to its exact layer:

| Queue / Situation | Action & Target Layer | Outcome (`resolution` / `outcome`) |
|---|---|---|
| Word/phrase missing, wrong, or too hard (no reader suggestion adopted) | Edit **L2 `glossary.json`** directly | `fixed` (no credit) |
| Reader `suggestion` gives a **new fitting sense** or a **clearly better** explanation | Rewrite in plain Basic-2000 English; write credited entry to **L3 `credits.json`** and keep **L2 `glossary.json`** credit-free | `fixed` + record `accepted_at` |
| Reader `suggestion` is the same sense (not better), wrong, or an ordinary word/name needing no note | No file edit | `no_change` (no credit) |
| The current list already answers the report accurately (live L1/L2/L3 covers it) | No file edit | `already_covered` (no credit) |
| Standard dictionary choice verified via `positions-build.mjs` / `positions-verify.mjs` | Add/preserve canonical `positionKey` row in **L1 `mappings.json`** (`matchedBy` max 3 unique 12-char public IDs) | `accepted` (1 point per user per position) — or `rejected` if wrong sense (even if another ID is mapped) |
| Blocked by missing evidence (book, edition, original bytes, or coordinates are unverified) | No file edit; do not guess | Leave open (`word`/`passage`) or `needs-context` (`dictionary_choices`) |

**Strict Content & Format Rules (Zero Regression):**
- **English only, Basic-2000:** Zero CJK anywhere. Word/phrase `meaning` (`<= 180` chars) must pass `check-definition-words.mjs`.
- **Retired fields forbidden:** NEVER add `whyHard`, `here`, `hardWords`, `clues`, or `core`.
- **Paragraph/Sentence invariant:** Every `(chapter, paragraph)` carrying a `sentences[]` note MUST also have a `paragraphs[]` entry (`mainIdea <= 180`, `simple <= 650`). Copy `context` verbatim from **one** sentence inside **one** paragraph.
- **Sentence note structure (`src/lib/grammar-mirror.ts` contract):** When adding or editing a `sentences[]` note, NEVER strip existing structure fields (`chunks`, `pattern`, `grammar`) down to a bare stub:
  - `simple` (`<= 450` chars): plain-English meaning only.
  - `chunks` (`2..6` items, `<= 240` chars): concise `"quote -> explanation"` breakdown of sentence mechanics.
  - `pattern` (`<= 160` chars): reusable sentence mold with descriptive `[Slot]` placeholders and balanced brackets.
  - `grammar` (`<= 400` chars): `"Same shape in daily life: '<plain-English mirror>' — <short tip>"` in Basic-2000 (`0` outside-basic warnings in `validate-glossary.mjs`).
- **Minimal diff:** Touch **only** entries needed by reviewed items; preserve top-level `version`, `title`, `author`, `chapters`, `sha256`, `spine`, `segmentation`. Keep `count` synced if present.

### Step 3 — Local Automated Verification (Mandatory Before Any R2 Write)

Run the Reader verification scripts against every modified book:
1. L3 credit isolation: verify L2 `countCreditsInGlossary().total === 0` and every adopted `suggested_by` credit is present in L3 `credits.json`.
2. `node --experimental-strip-types scripts/validate-glossary.mjs --json --bundled <book.epub> <glossary.json>` → `ok: true`, `0` errors, `0` `"grammar" uses words outside` warnings, `bytes <= 16_000_000`.
3. `node --experimental-strip-types scripts/check-no-cjk.mjs <glossary.json>` → exit `0`.
4. `node --experimental-strip-types scripts/check-definition-words.mjs <glossary.json>` → `0` outside.
5. `node --experimental-strip-types scripts/positions-verify.mjs --catalog-id <cat:id> --epub <book.epub> --glossary <glossary.json> --mappings <mappings.json> --dictionary-root <dict-root>` (whenever L1 or L2 changed) → `ok: true`, `mappings.json <= 192 KiB`.

### Step 4 — Atomic Publish → Readback → D1 Close → Contributors

1. **Exclusive Window & Snapshot:** Confirm D1 `catalog_locks` is clear. Snapshot exact original bytes + HTTP metadata of every target R2 object (including `catalog.json`) before editing; reread immediately before first PUT and **abort/rebase** if any baseline changed.
2. **Serialize Safely:** If L2 pretty JSON `> 12 MiB`, serialize compactly (`separators=(',', ':')` + `\n`); otherwise `indent=1` + `\n`. Compute exact byte count and SHA-256 of final uploaded bytes.
3. **Publish Order (R2):**
   - PUT modified **L1 `mappings.json`** (`Cache-Control: public, max-age=300`) and/or **L3 `credits.json`** (`Cache-Control: public, max-age=300`) → read back & verify SHA-256.
   - PUT modified **L2 `glossary.json`** (`Cache-Control: no-store`) → read back & verify SHA-256.
   - Reread `catalog.json` baseline → update **only this book's row** (`words`, `phrases`, `paragraphs`, `sentences`, `glossary.bytes`, `glossary.sha256`, `previousUpdated`, `updated`, and `rev`/`glossary.rev` on public books) → PUT `catalog.json` (`Cache-Control: no-store`) → read back via R2 API & verify SHA-256.
4. **D1 Close & Credits (ONLY After R2 Readback Passes):**
   - Execute per-ID resolution (`fixed` / `already_covered` / `no_change`) using the **verified live `glossary.sha256[:12]`** as `resolved_rev` (never bulk `UPDATE` by topic/word).
   - Record `accepted_at` / `accepted_rev` ONLY for suggestions whose L3 credit was verified on R2 readback.
   - Record `dictionary_choice_reviews` + `dictionary_choice_credits` in one atomic D1 batch ONLY after L1 mapping readback.
   - Zero affected rows means race/cancellation: reread, never broaden `WHERE`.
5. **Rebuild `contributors.json` Once (If Any New Acceptance):** Query accepted `word_feedback` + `passage_feedback` + `dictionary_choice_credits` (matching `functions/lib/contributors.ts` and `book-maintainers.ts`; Appendix D), keep `people` sorted by total `helped` descending, PUT `contributors.json` (`Content-Type: application/json`, `Cache-Control: public, max-age=300`), and verify readback.
6. **Concise Run Report:** List books touched (old → new SHA-256, bytes, L1/L2/L3 keys), counts (`fixed` / `already_covered` / `no_change` / `accepted` / `rejected` / `needs-context`), `discovery_topic_cursor`, `anomaly_id_cursor`, & `dictionary_choices` cursor start → end, and any blocked/deferred items.

---

## Appendix — Exact Parameterized D1 SQL Reference

### A. Queue Queries
```sql
-- Open word feedback (Queue A)
SELECT f.id, f.catalog_id, f.book_title, f.word, f.form, f.reason, f.chapter, f.chapters, f.occurrence,
       f.context, f.sentence, f.sense_index, f.sense_meaning, f.suggestion, f.glossary_rev, f.status,
       u.public_id AS suggested_by
  FROM word_feedback f LEFT JOIN users u ON u.id = f.user_id
 WHERE f.status != 'resolved'
 ORDER BY (f.status = 'reopened') DESC, (f.suggestion != '') DESC, f.created_at DESC LIMIT 500;

-- Open passage triage sample (Queue B triage only; never a cursor source)
SELECT p.id, p.topic, p.book_id, p.catalog_id, p.book_title, p.chapter, p.chapters, p.paragraph, p.sel_start, p.sel_end, p.span,
       p.selected, p.before, p.after, p.reason, p.suggestion, p.glossary_rev, p.status, p.created_at,
       u.public_id AS suggested_by
  FROM passage_feedback p LEFT JOIN users u ON u.id = p.user_id
 WHERE p.status != 'resolved'
 ORDER BY p.topic, p.created_at LIMIT 300;

-- Passage topic discovery (?1 = saved discovery_topic_cursor, initially 0)
SELECT DISTINCT topic FROM passage_feedback
 WHERE status != 'resolved' AND topic > ?1
 ORDER BY topic ASC LIMIT 20;

-- Zero-topic anomaly sweep (?1 = anomaly_id_cursor, ?2 = saved anomaly_cutoff_id)
SELECT MAX(id) AS anomaly_cutoff_id, COUNT(*) AS anomaly_count FROM passage_feedback
 WHERE status != 'resolved' AND topic = 0;

SELECT p.id, p.topic, p.book_id, p.catalog_id, p.book_title, p.chapter, p.chapters, p.paragraph,
       p.sel_start, p.sel_end, p.span, p.selected, p.before, p.after, p.reason, p.suggestion,
       p.glossary_rev, p.status, p.created_at, u.public_id AS suggested_by
  FROM passage_feedback p LEFT JOIN users u ON u.id = p.user_id
 WHERE p.status != 'resolved' AND p.topic = 0 AND p.id > ?1 AND p.id <= ?2
 ORDER BY p.id ASC LIMIT 20;

-- Passage topic cutoff & paged rows (?1 = topic, ?2 = last id read, ?3 = saved cutoff_id)
SELECT MAX(id) AS cutoff_id FROM passage_feedback WHERE topic = ?1;

SELECT p.id, p.topic, p.book_id, p.catalog_id, p.book_title, p.chapter, p.chapters, p.paragraph,
       p.sel_start, p.sel_end, p.span, p.selected, p.before, p.after, p.reason, p.suggestion,
       p.glossary_rev, p.status, p.created_at, u.public_id AS suggested_by
  FROM passage_feedback p LEFT JOIN users u ON u.id = p.user_id
 WHERE p.topic = ?1 AND p.id > ?2 AND p.id <= ?3
 ORDER BY p.id ASC LIMIT 300;

-- Standard meaning choices (Queue C, ?1 = cutoff_ms, ?2..4 = last cursor)
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
 ORDER BY c.updated_at, c.user_id, c.target_hash LIMIT 100;
```

### B. Resolution & Acceptance Updates (Execute Only After R2 Readback)
```sql
UPDATE word_feedback SET status = 'resolved', resolved_at = ?1, resolved_rev = ?2, resolution = ?4
 WHERE id = ?3 AND status != 'resolved' AND length(trim(?2)) > 0
   AND ?4 IN ('fixed', 'already_covered', 'no_change');

UPDATE passage_feedback SET status = 'resolved', resolved_at = ?1, resolved_rev = ?2, resolution = ?6
 WHERE id = ?3 AND topic = ?4 AND id <= ?5 AND status != 'resolved' AND length(trim(?2)) > 0
   AND ?6 IN ('fixed', 'already_covered', 'no_change');

UPDATE word_feedback SET accepted_at = ?1, accepted_rev = ?2
 WHERE id = ?3 AND suggestion != '' AND status = 'resolved' AND resolution = 'fixed'
   AND resolved_rev = ?2 AND accepted_at = 0;

UPDATE passage_feedback SET accepted_at = ?1, accepted_rev = ?2
 WHERE id = ?3 AND suggestion != '' AND status = 'resolved' AND resolution = 'fixed'
   AND resolved_rev = ?2 AND accepted_at = 0;
```

### C. Standard Choice Review & Credit Atomic Batch
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

### D. Contributors & Book Maintainers Query (`contributors.json`)

**`books` is required.** Match `functions/lib/book-maintainers.ts` exactly when rebuilding `contributors.json` (`Cache-Control: public, max-age=300`):
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
  SELECT user_id, catalog_id, '' AS book_title,
         'd:' || position_key AS place, accepted_at
    FROM dictionary_choice_credits
)
SELECT u.public_id AS id, COALESCE(u.nickname, '') AS name, u.avatar_rev AS avatar,
       a.catalog_id AS ref, a.book_title AS title,
       a.place AS place, MIN(a.accepted_at) AS first
  FROM accepted a JOIN users u ON u.id = a.user_id
 WHERE u.public_id IS NOT NULL
 GROUP BY u.id, a.catalog_id, a.book_title, a.place;
```
