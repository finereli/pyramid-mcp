# Pyramid MCP — design spec

A portable, agent-authored memory system exposed as a remote MCP server on Cloudflare. It packages the memory architecture proven inside Glopus (agent-authored multi-tag observations + per-model time-tiered "pyramids" + receipt-recovery recall) so any MCP-capable agent backend can plug into it.

This spec is the canonical design. It supersedes the exploratory analysis in `glopus/docs/memory-redesign/mcp-port-analysis.md`.

## What it is

> You tell the agent things. It decides what's worth remembering and which mental model(s) it belongs to. For each model it keeps recent notes verbatim and older notes summarized. When you ask it something, it grabs the relevant models and looks at its notes.

The same primitives as Glopus memory, minus the parts that required owning the conversation harness.

## What we deliberately dropped (and why it's fine)

The one thing a pull-based MCP server can't own is the **message stream** — so the verbatim short-term/cross-conversation pyramid (Glopus's `short-term-memory.ts`) is out. The substitute:

- **Intra-conversation continuity is free** — the live conversation's own context window holds it.
- **New-conversation cold start** is covered by `load_memory` returning **recent observations, recency-first, capped by tokens**. No pyramid, no message stream needed. Glopus data says ~20–30 agent-authored observations (avg ~780 chars) is ~4–6k tokens — compact enough to use raw.
- Denser recording (see *Recording threshold*) makes this substitute carry real weight.

The trade: continuity is coarser and curated rather than verbatim and complete. Acceptable.

## Architecture

- **One Durable Object per authenticated principal** (`MemoryDO`), keyed by Google OAuth `sub`. Holds *everything* for that user in DO-SQLite — models, observations, observation_tags, summaries, and embeddings as blobs. One DO = one person's memory; DOs serialize access, so no cross-conversation locking concerns.
- **Vector storage is a swappable `VectorStore` interface — not a hard "no Vectorize".**
  - *v1 / MVP / self-host:* an **in-DO backend** — embeddings stored as int8-quantized blobs, brute-force cosine in JS. Zero infra, instant on the ~1,742-vector seed, and keeps 100% of a user's data in one object (the open-source / data-control story). Comfortable to **~40k vectors/user** (int8 under the DO's 128MB ceiling); a heavy user on dense recording reaches that in years, not months.
  - *scale / production:* a **Vectorize backend** behind the same interface — one account-level index, namespace-per-user — scaling to millions with sub-100ms queries. Easy to wire (`wrangler vectorize create`, one binding).
  - The recall-test gate is backend-agnostic, so we build the in-DO backend first and keep Vectorize a config flip away. The *only* reason in-DO is the default is data locality: Vectorize moves vectors out of the user's DO into a shared account resource, splitting the self-host story. Decision is config, not architecture.
- **No cron.** The two background jobs Glopus ran on a server lifecycle (resummarize, maintenance reorg) are folded into the `record_observation` tool call:
  - resummarize trigger — a no-op unless enough new observations have accumulated; cheap, so it doesn't slow the common case.
  - drift check — returns a nudge message to the agent when models look like they need reorg/declutter, instead of an autonomous cron agent.
- **Single BYOK.** One provider key for both embeddings and Haiku-class synthesis (OpenRouter, or an OpenAI key with a GPT-mini swap). Phase 2 can move synthesis to MCP *sampling* (use the host's own model — see Phasing).

## Tenancy & auth

- Google OAuth via `@cloudflare/workers-oauth-provider`. Authenticated `sub` → DO name.
- **No conversation tracking.** Memory is global across conversations per principal. A soft topic/thread argument may be added later if needed — not in v1.
- A new user signing in creates a fresh DO. Migration/seeding runs per-DB. One user's data is physically isolated from another's.

## Tool surface (MCP)

Reactive (in-conversation), ported from Glopus `memory-tools.ts` with descriptions preserved:

- `record_observation(text, models[])` — multi-tag, agent-authored, dedup. Rejects unknown model names. Folds in the resummarize trigger + drift-check nudge.
- `create_model(name, description)` — upsert by name.
- `update_model_description(name, description)` — metadata only.
- `recall(query)` — raw observations + summaries, similarity + recency weighted, no synthesis. The receipt path.
- `load_memory(topics_or_questions[])` — **short args, not the full user message.** Returns recency-first recent observations (token-capped) + matched model views + observation RAG. Agent-as-router: the agent picks topics from the model index.

Privileged / phase 2: `archive_model`, `rename_model`, fold (guarded; the five seed models `self/user/system/world/memory` are protected).

## load_memory & conversation-start loading

The agent **is** the router — it has the user message in its own context and the model index in front of it, so it calls `load_memory` with topics/questions rather than echoing the whole message (token-cheap, coarse-grained, fine over few models).

Open implementation question (Task #7): how to make the host load memory **at conversation start** automatically. Candidates, in order of preference:
1. MCP `prompts` protocol (a start-of-chat prompt the host runs).
2. The MCP server `instructions` field (static system-prompt addendum).
3. Tool description nudging.
4. Manual injection into the host's system prompt (fallback; always works, least portable).

Document what each major host (Claude, ChatGPT) actually honors.

## Recording threshold

Lower the bar via instruction, personal/threshold framing (beats a mechanical quota):

> "Anything you don't record will be forgotten, so note down anything you might even remotely need to remember in a future conversation."

This stays curated because observations are **agent-authored** (voice + synthesis-in-flight), so it does not drift into the background-extraction pattern the redesign killed. Costs are low: embeddings are dirt cheap; Haiku synthesis is cheap and bounded by the BYOK provider; sampling (phase 2) offloads synthesis to the host model entirely.

## Seeding & testing (the MVP gate)

- **Seed** a test DO with Glopus's **1,742 direct observations + 80 models** (skip `source='background'`), rebuild embeddings + pyramid.
- **Two recall suites**, the go/no-go gate:
  - *Integrative* — `load_memory` by topic → do model views carry the right arcs?
  - *Direct* — `recall` by specific fact → do the receipts (names, dates, numbers) come back?
- Question set spans completion-shaped, fact-shaped, and "remember-when" cases.

## Phasing

- **v1:** everything above — reactive tools, recall, per-model pyramid, load_memory, Google OAuth, seed + recall tests.
- **Phase 2:** MCP *sampling* for synthesis (use the host's chosen model instead of BYOK — try once Claude/ChatGPT hosts support model selection); maintenance/drift reorganization as a richer tool; a **memory viewer** Worker gated by the same OAuth.

## Stack

Cloudflare Workers + Durable Objects (SQLite), `agents` `McpAgent`, `@modelcontextprotocol/sdk`, `@cloudflare/workers-oauth-provider`, `zod`. Tests via `vitest`.
