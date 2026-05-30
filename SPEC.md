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
- **Vectors live in the DO — brute-force cosine in JS, no abstraction layer.** Embeddings stored as blobs; search is a plain cosine scan inside the DO. Keeps 100% of a user's data in one object (the self-host / data-control story) and is instant on the MVP seed. Comfortable to tens of thousands of vectors/user. If speed becomes an issue at scale we'll move to Vectorize *then*, not now — no premature interface. Keep the code clean.
- **No cron.** The two background jobs Glopus ran on a server lifecycle (resummarize, maintenance reorg) are folded into the `record_observation` tool call:
  - resummarize trigger — a no-op unless enough new observations have accumulated; cheap, so it doesn't slow the common case.
  - defrag hint — `record_observation` computes a **fragmentation metric** and, when it crosses a tunable threshold, returns a hint telling the agent to declutter (fold near-duplicate models, archive under-populated ones) using the maintenance tools, in-conversation. Candidate metric: count of near-duplicate model centroids (cosine > ~0.85) plus under-populated models (below an obs floor); threshold tuned against the seed. No autonomous cron agent.
- **Per-user BYOK.** Each user supplies their own provider API key (OpenRouter, or an OpenAI key with a GPT-mini swap) during the OAuth/onboarding flow — stored in their DO and used for that user's embeddings + synthesis, so nothing runs on the operator's key. Phase 2 can move synthesis to MCP *sampling* (use the host's own model — see Phasing).

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

Maintenance (in v1 — the agent is trusted to manage these): `archive_model`, `rename_model`, `fold` (record a synthesis observation into the parent, then archive the child). Guarded only by protecting the five seed models `self/user/system/world/memory` from archive/rename. No separate cron agent — `record_observation` returns a **defrag hint** when the fragmentation metric crosses threshold, and the agent acts on it in-conversation.

## load_memory & conversation-start loading

The agent **is** the router — it has the user message in its own context and the model index in front of it, so it calls `load_memory` with topics/questions rather than echoing the whole message (token-cheap, coarse-grained, fine over few models).

The mechanism for loading memory **at conversation start** is the MCP server `instructions` field — the static system-prompt addendum the protocol provides for exactly this. It carries the directive ("at the start of a conversation, call `load_memory` with the relevant topics; record observations as you go") plus the confidence-metadata legend. Fallbacks if a host ignores `instructions`: a start-of-chat `prompts` entry, tool-description nudging, or manual system-prompt injection. Verify what Claude and ChatGPT actually honor.

## Recording threshold

Lower the bar via instruction, personal/threshold framing (beats a mechanical quota):

> "Anything you don't record will be forgotten, so note down anything you might even remotely need to remember in a future conversation."

This stays curated because observations are **agent-authored** (voice + synthesis-in-flight), so it does not drift into the background-extraction pattern the redesign killed. Costs are low: embeddings are dirt cheap; Haiku synthesis is cheap and bounded by the BYOK provider; sampling (phase 2) offloads synthesis to the host model entirely.

## Seeding & testing (the MVP gate)

- **Seed** a test DO with Glopus's **1,742 direct observations** (skip `source='background'`) tagged to the **~16-model merged carve** from the migration recipe (5 seeds + ~11 topic/relationship — *not* the raw ~70/80 k-means clusters), then rebuild embeddings + pyramid.
- **Two recall suites**, the go/no-go gate:
  - *Integrative* — `load_memory` by topic → do model views carry the right arcs?
  - *Direct* — `recall` by specific fact → do the receipts (names, dates, numbers) come back?
- Question set spans completion-shaped, fact-shaped, and "remember-when" cases.

## Phasing

- **v1:** everything above — reactive tools, recall, per-model pyramid, load_memory, maintenance tools (archive/rename/fold) with the defrag hint, per-user BYOK + Google OAuth, seed + recall tests.
- **Phase 2:** MCP *sampling* for synthesis (use the host's chosen model instead of BYOK — try once Claude/ChatGPT hosts support model selection); a **memory viewer** Worker gated by the same OAuth.

## Stack

Cloudflare Workers + Durable Objects (SQLite), `agents` `McpAgent`, `@modelcontextprotocol/sdk`, `@cloudflare/workers-oauth-provider`, `zod`. Tests via `vitest`.
