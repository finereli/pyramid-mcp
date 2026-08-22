# Pyramid MCP — design spec

A portable, agent-authored memory system exposed as a remote MCP server on Cloudflare. It packages the memory architecture proven inside Glopus (a private, heavily used agent harness where this design first ran; referenced throughout as the source of ported and rejected mechanisms) - agent-authored multi-tag observations, a per-model summary pyramid, and receipt-recovery recall - so any MCP-capable agent backend can plug into it.

This is the canonical spec and describes the system as it stands (August 2026). Roads not taken and the reasons are in the footnotes at the end; they are part of the record, not decoration.

## Philosophy

Everything below follows from a few commitments. Several were learned the hard way; those carry footnotes into the record.

1. **The model is smart; the memory is stupid — by design.** Memory's job is to give the reading agent enough to *infer* the right answers, not to contain them. The agent does the routing, the relevance judgment, the integration, and the digging; the memory does bounded storage, bounded compression, and honest retrieval. Corollary: resist adding intelligence to the memory system, and resist making its output legible for a human reader — the audience is the agent.[^readerside]
2. **The store is append-only and sacred.** Nothing is discarded, truncated, or rewritten. Views shape what is seen; the store keeps what happened. Every question of "too much" is answered at render time, never at storage time.
3. **Everything stored traces to sources.** The only synthesis allowed into the record is compression over material the synthesizer just read, with provenance attached. Ungrounded inference — reflection, introspection, conclusions that can't be checked against reality — must not enter the record.[^reflection]
4. **Reality is the only writeback.** Memory changes when the agent records a new observation, ideally confirmed by the user or an external source — never by the system rewriting itself on recall.[^reconsolidation]
5. **Human memory is the model, not the blueprint.** Take the shape — clear recent events, older events abstracted into a story, specifics retrievable when the present makes them relevant, re-encoding through use. Skip the mechanisms that need substrates an agent doesn't have, or that amplify model weaknesses rather than compensating for them.[^importance][^semantic]
6. **Text is cheap; spend it on fidelity.** Context is the cheap resource; confabulation is the expensive one.[^symbolic]

## 1. What it is

> You tell the agent things. It decides what's worth remembering and which mental model(s) it belongs to. For each model it keeps recent notes verbatim and older notes summarized in layers. When you ask it something, it grabs the relevant models and looks at its notes - and digs into the raw record when it needs a specific fact.

The model for this is human memory. Recent events are clear and detailed. Older events are abstracted into a story. Specific old details that turn out to matter can still be retrieved, and when they are retrieved and used they are re-encoded fresh.

The same primitives as Glopus memory, minus the parts that required owning the conversation harness.[^stream]

## 2. Architecture

- **One Durable Object per authenticated principal** (`MemoryDO`), keyed by Google OAuth `sub`. A SQLite-backed DO is a full private *database*, so it holds *everything* for that user - models, observations, tags, summaries, provenance, embedding blobs, config. One DO = one person's memory; DOs serialize access, so there are no cross-conversation locking concerns. The cost is that a DO's SQLite has no external console; every question about the data is an endpoint (`/admin/stats`, `/admin/model`).[^do]
- **The MCP endpoint is hosted inside that same DO.** The Worker routes `POST /mcp` to the user's DO by principal; the DO answers MCP JSON-RPC directly. Stateless: each call routes by token; memory is global per user, so there is no session state.
- **Vectors live in the DO** - brute-force cosine in JS over pre-normalized blobs, for observations and summaries alike. Instant at the current scale (thousands of vectors per user), keeps 100% of a user's data in one object.[^vectorize]
- **Workers AI for embeddings and synthesis.** `bge-m3` (1024-dim) for vectors, Llama 3.3 70B (fp8-fast) for summaries, via the `env.AI` binding. No per-user keys; billed to the account.[^byok] The `synthesize()` signature is provider-agnostic so MCP sampling can replace it.
- **No cron.** Background work (pyramid growth, the defrag hint) is folded into the tool calls with bounded work per call, plus admin endpoints for bulk catch-up.[^cron]

## 3. Tenancy & auth

- Google OAuth via `@cloudflare/workers-oauth-provider`. Authenticated `sub` → DO name.
- No conversation tracking. Memory is global across conversations per principal.
- A new user signing in creates a fresh DO seeded with the five base models. One user's data is physically isolated from another's.

## 4. Data model

```
models            id, name, description, is_seed, archived, created_at, last_summarized_count (unused, kept)
observations      id, text, timestamp, source, embedding
observation_tags  observation_id, model_id
summaries         id, model_id, tier, text, start_timestamp, end_timestamp, source_count, obs_count, source_chars, is_dirty (unused), embedding
summary_sources   summary_id, source_type ('observation' | 'summary'), source_id
config            key, value
```

- An **observation** is a short agent-authored note, tagged to one or more models. Observations are never edited or deleted by the system.[^dirty]
- A **model** is a mental model - a person, project, topic, or facet. Five seed models (`self`, `user`, `system`, `world`, `memory`) are protected from archive and rename.
- A **summary** is one node of a model's pyramid. `tier` is **depth**: 0 = built from observations, 1 = built from tier-0 summaries, and so on.[^tiername] `summary_sources` records exactly which observations (tier 0) or summaries (tier N+1) it was built from. A summary without sources is invalid and is deleted on DO start.[^legacy] `obs_count`/`source_chars` are the **transitive** provenance stats — how many raw observations stand behind the summary through all tiers below, and their total characters — computed once at insert (summaries are immutable) and backfilled on DO start for rows predating the columns.

Derived sets, all per model and all by provenance:

- **unsummarized observations** - tagged to the model, not a `source_id` of any tier-0 summary of that model. The verbatim tail.
- **unrolled summaries at tier N** - the model's tier-N summaries not a `source_id` of any summary. Rollup candidates.
- **cover** - the model's summaries (any tier) not a `source_id` of any summary. Cover + tail partition the model's history exactly.[^coverts]

## 5. The pyramid

### 5.1 Invariants

1. **Every observation is summarized exactly once at tier 0** per model it is tagged to, through that model's lens, and that membership is recorded in `summary_sources`.
2. **Tier N+1 is built only from tier N.** A rollup never sees raw observations.
3. **Summaries are immutable.** New material creates new summaries; nothing rewrites old ones.
4. **No observation is dropped, truncated, or skipped before synthesis.** Batches are sized so everything fits.[^inputcap]
5. **Length comes from the prompt.** Every prompt states a target; `max_tokens` is a safety net at ~2.5x target and should not fire on a normal run.[^maxtokens]
6. **Every summary carries a start and an end timestamp**; prompts ask for date ranges on arcs and dates on discrete events.[^recency]
7. **The tiers are the record.** What the agent sees is shaped by rendering, never by discarding data from the store.
8. **Observations and summaries are both embedded and searchable.**

### 5.2 Growth

**Tier 0.** Take the model's unsummarized observations oldest first and cut them into batches. A batch closes at **10 observations** or **8,000 characters**, whichever comes first (the char rule is checked after adding, so a batch can exceed 8,000 by its last observation); a single oversize observation closes a batch by itself. Ties on timestamp break by insertion order, so batching is deterministic. The trailing partial batch stays verbatim until it fills. No time rule.[^timebatch] Each batch becomes one tier-0 summary with a provenance row per observation, `start/end` = min/max timestamp, `source_count` = batch size.

**Tier N+1.** When a model has **5 unrolled tier-N summaries**, the oldest 5 become one tier-N+1 summary with provenance rows of type `summary`. Repeat upward until no tier has 5. Rollups are checked after every tier-0 batch, not only after the whole backlog, so the cover stays narrow while a model catches up. Input is bounded by construction. Fan-in 5 makes the pyramid wide rather than tall, which suits large context windows.[^fanin]

**Length.** Soft targets: tier 0 ~600 chars, tier 1 ~800, tier 2 ~1,000, tier 3+ ~1,200. Ceiling `max_tokens = target × 2.5 / 3.5`. Actual lengths are visible in `/admin/stats` and `memory_stats`; tuning is a process (see Roadmap).

**Trigger.** `record_observation` calls `advancePyramid` in the background for every model it tagged; `load_memory` calls it for every model it loads. Each call does up to 4 LLM calls per model, so a request never waits on a long chain; a backlog catches up over a few interactions or all at once via `/admin/advance`. One advance per model runs at a time: a second caller awaits the running one and reports `remaining: true` with no work of its own. When there is nothing to do the cost is a handful of queries (the unsummarized scan loads observation text, so it is proportional to the tail - small once caught up).

**Embedding.** Every summary is embedded on insert; a failed embed is stored anyway and backfilled by `reembedBatch`, which covers observations and summaries.

**Failure.** A failed synthesis leaves the batch unsummarized and stops that run; the next trigger retries. Degenerate output (empty, a refusal, under 40 characters) is treated as a failure, not stored - summaries are immutable, so a bad one must never get in. There is no transaction across LLM calls; every intermediate state is valid. Recording never fails because synthesis failed. The surgical undo for a bad run that did get through is `/admin/unsummarize`.

### 5.3 Prompts

Two prompts (`pyramid.ts`), both lens-aware, both stating the target length, both asking for date ranges on arcs and dates on events, both forbidding preamble and generic closers, both with factual discipline (never invent a number, name, or date).

- **Tier 0:** compress these observations through this lens; the raw observations are preserved and searchable; every word must earn its place; keep the specifics that make a memory verifiable later; trace the arc with causal connective tissue.
- **Rollup:** compress these summaries already written through this lens; merge patterns across periods, consolidate repeats, keep what is distinct and load-bearing.

### 5.4 Parameters

| name | value | where |
|---|---|---|
| `TIER0_MAX_OBS` | 10 | pyramid.ts |
| `TIER0_MAX_CHARS` | 8,000 | pyramid.ts |
| `ROLLUP_FAN_IN` | 5 | pyramid.ts |
| target chars by tier | 600 / 800 / 1,000 / 1,200+ | pyramid.ts |
| ceiling | target × 2.5 / 3.5 tokens | pyramid.ts |
| request-path advance cap | 4 LLM calls per model per trigger | memory-do.ts |
| model view render budget | 16,000 chars | mcp.ts |
| model view tail | 15 newest unsummarized observations | mcp.ts |
| `RAMP_PER_TIER` | 2 newest covered summaries per tier below the top | mcp.ts |
| `RAMP_VERBATIM` | 5 newest observations always verbatim | mcp.ts |
| minimum accepted summary | 40 chars | memory-do.ts |
| recent notes cap | 6,000 chars | format.ts |
| recall limit | 15 | mcp.ts |

## 6. Reading

### 6.1 load_memory

The agent **is** the router: it has the user message in its own context and the model index in front of it, so it calls `load_memory` with short topics rather than the whole message. The response:

1. **Model index** - every active model with its description.
2. **Recent notes** - the newest observations across all models, verbatim, newest first, capped by characters, whether or not a pyramid has covered them. The cross-conversation continuity substitute.[^stream][^recent]
3. **Loaded models** - for each topic matching a model name: header and confidence meta (`[name · N obs · spans · latest]`), then the summaries oldest first, each labeled `[tier T · N obs · sourceK→summaryK chars · start–end]` — the transitive observation count and compression ratio behind the text, the confidence signal the instructions explain (deep compression → verify specifics with `recall`) — then recent observations verbatim oldest first. Observation lines and summary end-recency render as relative times for the recent past, ISO dates beyond ~two weeks; dates inside summary prose stay absolute (baked at synthesis, immutable). `load_memory` accepts the user's IANA `timezone` (persisted in config once seen — the host agent knows it, the server doesn't): with it, the last two *local* calendar days render as "today 14:30" / "yesterday 23:05" and all dates are local days; without it, the last 48h are timezone-free durations ("26h ago") — never a computed "yesterday", which server time can get wrong by a day. What is shown is the **cover plus a resolution ramp**: the cover (summaries nothing has rolled up) partitions the history exactly, and on top of it the view adds the newest `RAMP_PER_TIER` (2) summaries at every tier below the top even though a higher tile already covers them, and always the newest `RAMP_VERBATIM` (5) observations raw even when a tier-0 covers them. Ramp rows are labeled ("finer view of a period summarized above", "also summarized above") so the overlap is explicit. Reading this oldest-first gives old arcs at high tiers and progressively finer recent material - a resolution gradient that does not depend on where the observation count happens to fall.[^ramp] A generous per-model render budget (16K chars) guards against a pathological model with fill-down priority: top tier always, then newest lower summaries, then newest observations; whatever it cuts is still in the store.
4. **Relevant receipts** - for topics that match no model, observation + summary RAG.

No portrait.[^portrait] Sizing: at 500 observations a model's cover is ~2 tier-2 + ≤4 tier-1 + ≤4 tier-0 + the tail, roughly 15K chars / 4K tokens; a five-model load is ~20K tokens. Fine for a 1M-token model.

Conversation start is driven by the MCP server `instructions` field (call `load_memory` first; record as you go; the confidence-metadata legend). A Claude Code `SessionStart` hook makes it guaranteed (README).

### 6.2 recall

Brute-force cosine over observations and summaries, blended with a 30-day-half-life recency penalty (summaries use their end timestamp). Results labeled: observations `[relative time or date]`, summaries `[start–end · summary tier T · N obs]` — the transitive observation count says how much record stands behind the arc. Observations are receipts, summaries are arcs. The agent synthesizes; recall returns raw. The tool description nudges: a fact that took real effort to find (missing, several queries, supplied by the user) gets recorded as a fresh observation once confirmed — retrieval failures become the signal that fixes them, in line with reality-as-writeback.

The recency term is load-bearing beyond tie-breaking: when the append-only record holds several versions of a fact, all versions match a query about equally on similarity, and the recency term ranks the newest first — this is how a record of changes renders to current state, the way git renders diffs. The cost is that an old fact stated once and never repeated can lose to a mediocre recent match. Tune `timeWeight` only against the recall eval (which queries flip with and without the term), never by feel.

### 6.3 Retrospective significance

A bottom-up pyramid cannot know at tier-0 time which detail will matter later. Handled without machinery: the raw observation stays in the store and embedded; `recall` finds it (and the summary that abstracted it) when the present makes it relevant; and rehearsal closes the loop - when the agent reconstructs an old fact that turned out to matter, it records a fresh observation restating it, re-encoding it at the top of the pyramid. The instructions nudge this. Tier prompts carry forward load-bearing specifics rather than only the arc.

## 7. Tool surface (MCP)

- `record_observation(text, models[])` - multi-tag, agent-authored, prefix-dedup within 24h. Rejects unknown model names. Triggers background pyramid growth; returns a **defrag hint** when the model index fragments (too many sparse models).
- `create_model(name, description)` - upsert by name. `update_model_description`, `rename_model`, `archive_model` - maintenance; seeds protected. `fold(source, into, synthesis)` - record a synthesis observation into the target, archive the source.
- `recall(query)` - §6.2.
- `load_memory(topics[], timezone?)` - §6.1; also triggers background growth for loaded models, and persists the user's timezone for label rendering.
- `memory_stats()` - counts, size distributions (chars and ~tokens), per-model rows including the unsummarized tail, top tier, and LOAD: what `load_memory` would render for the model (cover + ramp + tail), measured on the real view.

Recording threshold, by instruction rather than quota: *"Anything you don't record will be forgotten, so note down anything you might even remotely need to remember."* Observations are agent-authored, so this stays curated.

## 8. Operations

Token-gated admin endpoints (`x-admin-token`), all taking `userId` (the Google `sub`; discoverable from the `grant:` keys in the OAuth KV):

- `/admin/stats` - the `memory_stats` data as JSON.
- `/admin/model {model}` - full export: model row, every summary with its sources, every observation, unsummarized ids. The verification tool.
- `/admin/advance {model?, maxCalls?}` - run `advancePyramid` for one or all models (archived included), bounded; returns counts, `remaining`, and per-model results including any synthesis error (the sweep continues past a failing model). Loop until `remaining` is false. Idempotent and resumable.
- `/admin/unsummarize {model, confirm}` - delete one model's summaries and provenance so its pyramid regrows from the observations (untouched). The undo for a bad synthesis run.
- `/admin/recall {query}`, `/admin/reembed {limit}`, `/admin/seed`, `/admin/reset {confirm}`.

`scripts/advance-prod.ts` drives `/admin/advance` to completion and then verifies exact-once provenance via `/admin/model`. `scripts/logs.sh` queries Workers observability.

### Migration from the time-window pyramid (Aug 2026)

Schema changes and cleanup run in the DO constructor on first touch after deploy: create `summary_sources`, add `summaries.embedding`, delete provenance-less summaries. The pyramid regrows from observations - incrementally through tool calls, or at once through `/admin/advance`. For the operator's DO (2,094 observations, 28 models): deploy, run `advance-prod.ts`, check `verify: OK`. Other users need nothing run.[^legacy]

## 9. Evaluation

- Unit (`test/pyramid.test.ts`): batch rules, rollup at 5, prompt contents and provenance ids, target/ceiling relations, stub synthesis, render budget priority.
- DO (`test/memory-do.test.ts`): exact-once provenance on 23/55/100-observation models, rollup builds only from summaries, tier 2 from tier 1 across separate runs (260 observations), rollups interleaved mid-backlog, immutability across repeated advances, `maxCalls` + `remaining` resume, once-per-model for multi-tagged observations, provenance mandatory, failed synthesis inserts nothing and resumes, degenerate output refused, in-flight guard under real overlap, `advanceAll` budget / archived models / per-model errors, `unsummarizeModel`, tail and recent-notes coverage by provenance, recall returns labeled summaries.
- MCP (`test/mcp.test.ts`): tools/list, record/recall/load_memory shapes, `record_observation` → background advance → `load_memory` renders cover label + tail and recent notes exclude covered observations, `memory_stats`.
- Arc-coverage (manual): for a model, sample facts from old observations; each must be in the cover or retrievable by `recall`. Run before and after prompt changes.
- Recall eval (`scripts/eval-recall.ts`): seed a DO with the Glopus carve, advance, run the integrative and direct suites.

## 10. Roadmap

Survivors of the Aug 22, 2026 design review (what remained after the roads not taken below were re-litigated and re-rejected). Three were built the same day — relative time at render, transitive confidence labels, the recall-struggle nudge (§6.1, §6.2) — leaving:

- **Drill-down** — expose summary ids in views and recall labels, plus an `expand(summary_id)` tool returning a summary's sources (child summaries or raw observations). Recollection as descent: slower than RAG, but it finds needles similarity misses, and it reaches details a tier-0 dropped — without any agentic-summarization machinery, because the descent lives in the reader.
- **Verbatim pins** — a deliberate "must survive verbatim" flag: pinned observations flow through batching and summarization normally (no holes in the narrative, provenance untouched) but are always rendered raw in the model view, under a hard per-model character cap. Pinning past the cap requires unpinning something — curation stays agent-authored, and staleness stays visible because the pin block is reread on every load. Pinned and unpinned by the main agent (there is no other author); unpinning may record an observation, keeping the diff record. For durable identifiers: URLs, amounts, exact phrasings — what compression mangles and similarity search retrieves poorly.
- **Refresh + extend eval-recall** — the script still speaks BYOK (reads `OPENAI_API_KEY`, sends `x-openai-key`) and predates the Workers AI cutover; refresh it, then extend: a time-weight counterfactual (rank the direct suite with and without the recency term, see which facts flip), lineage-slot occupancy (how many of the 15 recall slots are an observation plus its own covering summaries — deliberate gist+specifics behavior, but measure whether it crowds), and the fact-supersession tripwire from [^semantic].
- **Hygiene (Aug 22 code review)** — an unarchive path (and `create_model` unarchives on upsert — today a re-created archived model silently accepts observations while invisible to `load_memory`); dedup merges new tags into the existing observation instead of dropping them; dedup check before the embed call; fragmentation nudge exempts models younger than ~2 weeks; render budget drops ramp (covered) rows before cover rows; `advanceAll` backs off a model that fails synthesis repeatedly instead of keeping the admin loop hot forever.

Earlier items:

- **Length monitoring as a process** - a periodic check (cron-like or every N `record_observation` calls) that flags tiers drifting past target. Measurement exists; the loop does not.
- **Portrait as a pure view** over the cover, if main-model token cost ever bites.[^portrait]
- **Synthesized `recent` model** (Glopus-style 14-day cross-model window).[^recent]
- **`recall` nudge** in the instructions, if frontier models turn out not to fill gaps unprompted.
- **MCP sampling for synthesis** once clients support it - the host's own model writes its own memory.
- **Dirty-flag repair** if observation edit/delete arrives.[^dirty]
- **Multi-agent memory under one account** - several agents (a coding agent, a companion, ...) sharing all of the account's mental models but each keeping its own `self` model. Needs a design discussion first: mental models can have agent affinity (a model that is mostly one agent's lens, or one agent's private working notes), and the rules for who reads, who writes, and how the shared `user` model stays coherent across agents are not obvious. Logged 2026-08-22.
- **Memory viewer** Worker gated by the same OAuth.
- **Make pyramid-mcp the canonical implementation.** `~/source/pyramid` is the older (~6 months) implementation of the same idea; pyramid-mcp has overtaken it (provenance pyramid, Workers AI, MCP surface, admin tooling). Decide what, if anything, from the old repo is worth carrying over, then retire it. Logged 2026-08-22, not scheduled.

## 11. Stack

Cloudflare Workers + Durable Objects (SQLite) + Workers AI. MCP JSON-RPC (Streamable HTTP, stateless) hosted in the per-user DO. `@cloudflare/workers-oauth-provider` for Google OAuth. Tests via `vitest` on the workerd runtime (`@cloudflare/vitest-pool-workers`); synthesis is stubbed in tests (`enableStubSynthesis`).

---

## Footnotes: roads not taken

[^stream]: **The message stream.** A pull-based MCP server can't own the conversation, so Glopus's verbatim short-term/cross-conversation pyramid (`short-term-pyramid.ts`) is out. Intra-conversation continuity is free (the live context window); cold start is covered by recent notes. The trade: continuity is coarser and curated. Accepted at the outset.

[^do]: **Durable Objects vs. D1/Postgres.** Per-user isolation without `user_id` columns, compute co-located with the vectors (recall does the dot products in-process), single-writer serialization for free, zero ops. The cost is no SQL console - hence the admin endpoints. For a per-user memory store this is the right trade.

[^vectorize]: **Vectorize for recall - not now.** Brute-force cosine over a few thousand blobs is instant and keeps everything in one object. Revisit only if it gets slow.

[^byok]: **Per-user BYOK - dropped (June 2026).** The original design had each user supply an OpenRouter/OpenAI key. Replaced by Workers AI (bge-m3 + Llama 3.3 70B) so recall and synthesis work the moment a user signs in, with no onboarding step. An A/B (`scripts/synth-ab.ts`) found the 70B model retained more verified factual detail than gpt-4o-mini, which is what a memory substrate needs. The embedding space changed from 1536-dim to 1024-dim, which forced a re-embed migration (`/admin/reembed`).

[^cron]: **Cron / background pipeline (Glopus) - not ported.** The MCP server has no process lifecycle to hang a cron on. Growth is folded into tool calls with bounded work per call and an in-process guard; admin endpoints exist for bulk catch-up.

[^dirty]: **Dirty-flag repair (Glopus) - not ported.** Glopus regenerates a summary in place when its sources change and propagates the flag upward. pyramid-mcp has no observation edit/delete path, so there is nothing to repair. `is_dirty` stays in the schema unused. Port the mechanism if edits arrive.

[^tiername]: **Renaming `tier` to `depth` - not done.** Semantics changed from age to depth; the name was kept to avoid touching the view format and every test for no behavioral gain. "Tier" reads fine as depth.

[^legacy]: **Legacy-summary handling - built, then removed (Aug 22, 2026).** A first cut kept pre-migration summaries (rows without `summary_sources`) visible per model until that model's first provenance-backed summary, then deleted them - about 40 lines of fallbacks in the cover, the tail, the advance loop, and stats. Removed: the only thing it bought was a few minutes of slightly thinner views between deploy and the operator's migration run, and for the one other user the affected models were mostly under 10 observations and correctly have no summaries at all under the new design. A provenance-less summary is simply invalid now and is deleted on DO start.

[^coverts]: **Hierarchical cover by timestamp (Glopus `getNonOverlappingSummaries`) - replaced by provenance.** Glopus computes the cover as "top tier in full, then lower tiers with end_timestamp beyond what's covered". With `summary_sources` the cover is exact - summaries that are not a source of any summary - with no timestamp arithmetic and no boundary edge cases. The same goes for the tail and for recent-notes coverage, which used `end_timestamp >= observation.timestamp` before.

[^inputcap]: **Time-window tiers with an input cap (the June 2026 design) - dropped.** Tiers were age bands (0-30d, 30-90d, 90-365d, 365d+), one summary per band, rebuilt from raw observations whenever a model gained 8. The view was always a few blocks with hard caps - but the synthesizer's input was capped at 14K chars newest-first, and on the live data 83% of observations (3,052 of 3,676 model-tagged slots) were never read by the LLM; since every rebuild started from raw observations, anything that aged past the cap was gone from the pyramid permanently. Also: full rebuild every 8 observations meant the agent saw a different past each time and three LLM calls were spent where one would do; tier boundaries were frozen at rebuild time. The instinct to bound the view was right; the bound belonged at render time, not at synthesis input. Replaced by depth tiers with provenance.

[^maxtokens]: **Hard `max_tokens` as the length mechanism - dropped.** Added because the 70B model ignored the soft target; but a tight cap truncates mid-sentence, which is worse than being long. Length now comes from the prompt; `max_tokens` is a safety net at 2.5x; measured lengths feed prompt tuning.

[^timebatch]: **Time-based tiers or batch closing - dropped.** Time-window tiers created high tiers for sparse models for no reason; a "close a tier-0 batch after 45 days" rule proposed during review has the same disease in miniature (tiny summaries for sparse models). Tiers compress data, not time; timestamps in the text carry the sense of time.

[^fanin]: **Larger fan-in or a depth cap - not now.** Fan-in 5 gives tier 1 at 50 observations, tier 2 at 250, tier 3 at 1,250 - wide, not tall, which suits large context windows. A depth cap (stop rolling up past tier 3) would keep the oldest material from over-compressing; not needed at current scale.

[^recency]: **Recency labels.** Glopus's portrait prompt files each summary at its `endTimestamp`, so a February-May tier-2 reads as "May". Real gap in both implementations; here every summary carries start and end, prompts ask for ranges on arcs and dates on events, and the view labels each summary with its range.

[^portrait]: **A portrait per model (Glopus) - dropped, roadmap.** Glopus synthesizes one narrative per model from the cover so the main model reads one block. The argument for it: only something that knows the focal point (the present reinterprets the past) can compress aggressively, and the tiers don't know it. True - but the main model reading the cover *is* that something, and it reasons about relevance better than the synthesis model and can call `recall` for gaps, which frontier models do unprompted. With 1M-token contexts the token saving doesn't pay for the indirection, and a portrait that included the tail would need regeneration on every observation. Reversed during review of the plan; a retrieval-augmented portrait went with it.

[^ramp]: **The cliff, and the ramp (from Angel).** Batches are anchored at each model's first observation and rollups fire at a fixed fan-in, so the non-overlapping cover collapses at a clean boundary: a model at 249 observations shows 4 tier-1 + 4 tier-0 + 9 raw, at 250 it shows one tier-2 summary and nothing else, at 251 that apex plus one note. The view oscillated with count, not importance - visible in the first post-migration stats, where `bizdev` loaded in 1.1K tokens and `yael` in 2.5K purely by phase. Angel's stream pyramid hit the same geometry and settled on render-time duplication: keep storage exact and immutable, and have the view top each tier up to its newest few tiles even when a coarser tile covers them. Adopted here with RAMP_PER_TIER = 2 (Angel uses a full complement of W; a full complement is the ceiling we'd see at the worst phase anyway) and RAMP_VERBATIM = 5. The alternative - lagging rollups so the cover itself keeps recent tiles - was rejected: it changes growth, leaves the apex cliff, and makes the store bend for the view. Recent notes had the same phase dependence (it showed only uncovered observations) and now simply shows the newest.

[^recent]: **Synthesized `recent` model (Glopus) - roadmap.** Glopus keeps a 14-day cross-model window with its own pyramid and a recency-gradient prompt. pyramid-mcp's verbatim uncovered tail does the same job with no synthesis; revisit once the per-model pyramid has lived a while.

[^readerside]: **Reader-side intelligence over memory-side intelligence.** Several attractive features are really the same feature — moving interpretation into the memory system — and are resisted as a class: apex-as-context for rollup prompts (the reading agent already has the apex in view and reasons about relevance better than the synthesis model), portraits ([^portrait]), agentic summarization that pulls recall while building higher tiers (the agent already has recall at read time; drill-down covers the rest). Same instinct throughout: rely on the agent.

[^reflection]: **A reflection/introspection step — tried, rejected (early 2026, in Glopus).** A periodic "what higher-level insights follow from recent observations?" pass adds a layer of hallucination that isn't present without it: even a smart model confabulates conclusions that can't be checked against reality, and once recorded they become memory and cause drift. The pyramid keeps only bounded reflection — the summarizer synthesizes over exactly the material in front of it, provenance attached (roughly log-of-entries worth of "reflection" comes free from the tier structure). Deeper introspection is left to the reading agent, in-context, where it stays checkable and unrecorded.

[^reconsolidation]: **Rewrite-on-recall / mechanistic retrieval strength — rejected.** Human memory strengthens and rewrites what it retrieves; recall-driven rewriting is exactly where human false memories come from, and models amplify the effect rather than dampening it. There is also no honest signal to strengthen on: a pull-based server never sees which retrieved detail the agent actually used. Re-encoding therefore happens only through the agent recording a fresh observation once reality (the user, an external source) confirms the reconstruction (§6.3); the instructions nudge it, and the recall-struggle nudge (roadmap) extends it to facts that were hard to find.

[^importance]: **Importance scoring at encoding — tried, rejected (early 2026).** Without an emotional/physical substrate generating the response, importance can't be meaningfully tagged at write time. The human version of the substrate creates strong imprints and occasionally trauma — which breaks effective memory rather than serving it; not a path to follow. Progressive summarization keeps the load-bearing details instead. The bounded exception is the deliberate verbatim pin (roadmap): a binary "must survive verbatim" under a hard cap, chosen by the agent, not a salience scale.

[^semantic]: **A mutable semantic/state layer (current-facts store, temporal knowledge graph) — not built.** The tiered narrative plus time-decayed recall already render "record of changes → current state": when the record holds several versions of a fact, all match a query about equally on similarity, and the recency term ranks the newest first (§6.2) — git rendering diffs, done semantically. The residual risk is confident staleness that triggers no doubt (and therefore no recall); the observed failure modes to date — date/time confusion in recent events, facts never recorded at all — do not include it, so the layer would solve a problem the data doesn't show. Tripwire, not machinery: a fact-supersession eval (plant fact-changes in seed history, ask current-state questions); build the layer only if it starts failing.

[^symbolic]: **Symbolic/logical compression of stored text — experimented (early 2026), dropped.** Math and logic notation (which models read natively) compressed logical material up to ~10x but did almost nothing for human/psychological material — most of what this system stores. Context is cheap and getting cheaper; the complexity wasn't worth it. (Per the stats, the verbatim tail dominates view size anyway, and it must stay verbatim.)

**Glopus, for the record** (measured on a May 2026 snapshot: 5,569 observations, 587 tier-0, 85 tier-1, 4 tier-2, 80 portraits). Its pyramid is structurally right - exact-once provenance, immutable summaries, dirty repair - but has no length target at any tier, so it compresses only ~2x per level (tier-0 avg 1,564 chars, tier-1 2,841, tier-2 7,279 with a 14K max, larger than its portraits at 3.6K avg); count-only batching lets ten long observations make a 40K-char prompt; and the portrait prompt buckets by end timestamp. Suggestions passed along, not acted on here: soft length targets with a safety ceiling per tier; close tier-0 batches on chars as well as count; present items by full range.
