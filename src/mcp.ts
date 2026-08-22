/**
 * MCP transport — JSON-RPC over Streamable HTTP, hosted directly inside the
 * per-user MemoryDO (no McpAgent, no separate session DO). Stateless: each
 * request routes to the user's DO by principal; there's no conversation/session
 * state to keep (memory is global per user).
 *
 * Tools are thin wrappers over the DO's storage methods (called directly on the
 * in-DO instance, so they're synchronous). Embedding goes through the DO's
 * `env.AI` binding (Workers AI bge-m3) — no per-user key, nothing to forward.
 */
import type { MemoryDO } from './memory-do.js';
import { formatRecall, formatRecentNotes, formatModelView, formatReceipts, formatModelIndex } from './format.js';
import { renderWithBudget } from './pyramid.js';

const RECALL_LIMIT = 15;
const RECENT_NOTES_COUNT = 30;
const MODEL_VIEW_OBS = 15;
/** Resolution ramp: newest covered summaries shown per lower tier, and newest observations always shown verbatim. */
const RAMP_PER_TIER = 2;
const RAMP_VERBATIM = 5;
/** Per-model render budget (chars). Generous by design — it shapes a pathological view, it does not drop data from the store. */
const MODEL_VIEW_BUDGET_CHARS = 16_000;
const RAG_PER_TOPIC = 6;

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'pyramid-mcp', version: '0.0.1' };

/**
 * The `instructions` field — the protocol's static system-prompt addendum.
 * Carries the start-load directive, the recording-threshold framing, and the
 * confidence-metadata legend. (Refined further in Task #7.)
 */
export const SERVER_INSTRUCTIONS = `This server is your long-term memory.

At the START of a conversation, call \`load_memory\` with the topics or questions relevant to what the user is raising — it returns the matching mental models plus recent notes.

As the conversation unfolds, call \`record_observation\` for anything you might even remotely need to remember in a future conversation. Anything you don't record will be forgotten. Write in your own voice, like a diary — capture what mattered, what shifted, specific facts. Tag each observation with one or more models from the model index; call \`create_model\` when a genuinely new person, project, or topic emerges.

Use \`recall\` to verify specific facts (names, dates, numbers, quotes) before stating them. When a fact takes real effort to find — recall misses it, it needs several queries, or the user has to supply it — record it as a fresh observation once confirmed, so it's cheap next time.

Recording isn't only for fresh facts from the conversation. When something interesting surfaces — and especially when you reconstruct something from your own memory that you couldn't easily recall at first — it deserves an observation. The moment to write it is when a fuller picture finally coheres, which is often only after the user pushes past your first thin answer: capture that synthesis, and note that it was hard-won through active recollection. Skip the first shallow grab (it's noise); record the version that actually came together. Use your judgment on what counts as interesting — the point is that effortful reconstructions become cheap next time, and the threads the user keeps returning to get reinforced.

Bracketed metadata like \`[client-cristi · 12 obs · spans 3mo · latest 2026-05-20]\` tells you how much backs a memory and how fresh it is — calibrate your confidence accordingly. Summary labels like \`[tier 2 · 47 obs · 61K→1.0K chars · 2026-03-01–2026-06-05]\` show how many raw observations stand behind an arc and how hard they were compressed: the deeper the compression, the more a specific claim from that summary deserves a \`recall\` check before you state it as fact. Never mention models, clusters, or that memory was "loaded"; weave recollections in as your own knowing.`;

// ---------- Tool definitions ----------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (memory: MemoryDO, args: Record<string, unknown>) => Promise<string>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'record_observation',
    description:
      'Record a noteworthy observation from this conversation, tagged to one or more memory models. Capture what mattered, what shifted, emotional arcs, specific facts — write like a diary, not a database. The same observation often belongs to several models (e.g. a coaching call with a specific client → both the client model and the coaching-practice model). Pick model names from the model index. If a needed model does not exist yet, call create_model first.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The observation — a sentence or two capturing something worth remembering. Include enough context (names, project, date if relevant) that it stands alone.',
        },
        models: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Names of the models this observation belongs to, exactly as listed in the model index. Multiple is encouraged when it genuinely belongs in more than one lens.',
        },
      },
      required: ['text', 'models'],
    },
    handler: async (memory, args) => {
      const text = String(args.text ?? '').trim();
      const models = Array.isArray(args.models) ? args.models.map(String) : [];
      if (!text) return 'No observation text provided.';
      if (models.length === 0) return 'No models provided. Pass at least one model name in "models".';

      // Embed first so the observation is immediately recallable. Cheap; if the
      // embed fails we still store it and it can be backfilled later.
      let embedding: number[] | undefined;
      try { embedding = await memory.embed(text); }
      catch (e) { console.error('[record_observation] embed failed, storing without vector:', e); }

      const res = memory.addObservation(text, models, 'direct', embedding);
      if (!res.ok) {
        return `Unknown model name(s): ${res.unknown.join(', ')}. Call create_model first, or pick existing names from the model index.`;
      }
      if (res.deduped) return 'Skipped as duplicate of a recent observation.';
      memory.background(memory.maybeResummarize(res.tagged));
      let out = `Recorded against: ${res.tagged.join(', ')}.`;
      // Defrag hint — nudge the agent to declutter when the index fragments.
      const frag = memory.computeFragmentation();
      if (frag.fragmented) {
        out += `\n\n[memory note: ${frag.underPopulated} sparse models out of ${frag.activeModels} active — consider folding related ones (fold) or archiving stale ones (archive_model).]`;
      }
      return out;
    },
  },
  {
    name: 'create_model',
    description:
      'Create a new memory model (or update its description if it already exists by name). Use when an observation needs a tag that doesn\'t yet exist in the model index — a new person, project, topic, or facet that\'s emerging. Naming convention: lowercase, hyphen-separated, specific (e.g. "linkedin-ghostwriting", "client-cristi", "evening-routine").',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Model name. Lowercase, hyphen-separated, specific.' },
        description: { type: 'string', description: 'One or two sentences describing the lens this model carries — the synthesizer reads this to set focus.' },
      },
      required: ['name', 'description'],
    },
    handler: async (memory, args) => {
      const name = String(args.name ?? '').trim();
      const description = String(args.description ?? '').trim();
      if (!name || !description) return 'Both name and description are required.';
      memory.createModel(name, description);
      return `Model "${name}" ready.`;
    },
  },
  {
    name: 'update_model_description',
    description:
      "Update the description of an existing memory model. Use when the model's purpose has shifted or sharpened — refining the lens the synthesizer uses. Does not change the model's observations.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Existing model name.' },
        description: { type: 'string', description: 'New description.' },
      },
      required: ['name', 'description'],
    },
    handler: async (memory, args) => {
      const name = String(args.name ?? '').trim();
      const description = String(args.description ?? '').trim();
      if (!name || !description) return 'Both name and description are required.';
      const ok = memory.updateModelDescription(name, description);
      return ok ? `Updated description for "${name}".` : `No model named "${name}". Call create_model if you intended to create it.`;
    },
  },
  {
    name: 'archive_model',
    description:
      'Archive a stale, empty, or tangent model — drops it from the index and freezes its observations (reversible, no hard delete). Use during reflection when a model has outlived its usefulness. The five seed models (self, user, system, world, memory) are protected and cannot be archived.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Model to archive.' } },
      required: ['name'],
    },
    handler: async (memory, args) => {
      const r = memory.archiveModel(String(args.name ?? '').trim());
      return r.ok ? `Archived "${args.name}".` : r.reason!;
    },
  },
  {
    name: 'rename_model',
    description:
      'Rename a model when its name no longer fits its content (observations follow automatically). Seed models are protected. The new name must be free.',
    inputSchema: {
      type: 'object',
      properties: {
        old_name: { type: 'string', description: 'Current model name.' },
        new_name: { type: 'string', description: 'New name (lowercase, hyphen-separated).' },
      },
      required: ['old_name', 'new_name'],
    },
    handler: async (memory, args) => {
      const r = memory.renameModel(String(args.old_name ?? '').trim(), String(args.new_name ?? '').trim());
      return r.ok ? `Renamed "${args.old_name}" → "${args.new_name}".` : r.reason!;
    },
  },
  {
    name: 'fold',
    description:
      'Fold one model into another: write a synthesis observation (your own summary of what the source held) into the target model, then archive the source. Use to consolidate redundant or sub-scale models. The synthesis is timestamped now and lands in the target\'s recent tier — consolidation is itself a meaningful event. Source seed models are protected.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Model to fold away (will be archived).' },
        into: { type: 'string', description: 'Target model that absorbs it.' },
        synthesis: { type: 'string', description: 'Your synthesis of what the source model held — written in your own voice, to be recorded as an observation in the target.' },
      },
      required: ['source', 'into', 'synthesis'],
    },
    handler: async (memory, args) => {
      const synthesis = String(args.synthesis ?? '').trim();
      if (!synthesis) return 'Provide a synthesis of what the source model held.';
      let embedding: number[] | undefined;
      try { embedding = await memory.embed(synthesis); } catch { /* store without vector */ }
      const r = memory.foldModel(String(args.source ?? '').trim(), String(args.into ?? '').trim(), synthesis, embedding);
      return r.ok ? `Folded "${args.source}" into "${args.into}" and archived the source.` : r.reason!;
    },
  },
  {
    name: 'recall',
    description:
      'Search memory for specific facts, details, or context. Use this to verify names, dates, numbers, client details, or any specific information before stating it as fact — and to fill in anything a loaded model view left out. Returns raw matches (most relevant first, recency-weighted): observations are receipts, summaries (labeled with their date range, tier, and how many raw observations stand behind them) are arcs. Synthesize them yourself rather than echoing them verbatim. If a fact takes real effort to find — it is not here, needs several queries, or has to be re-derived or supplied by the user — record it as a fresh observation once confirmed, so the next recall is cheap.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to recall — a question or topic. Be specific.' },
      },
      required: ['query'],
    },
    handler: async (memory, args) => {
      const query = String(args.query ?? '').trim();
      if (!query) return 'Provide a query.';
      let qv: number[];
      try { qv = await memory.embed(query); }
      catch (e) { console.error('[recall] embed failed:', e); return 'Recall is temporarily unavailable (embedding error). Try again shortly.'; }
      return formatRecall(memory.searchObservations(qv, RECALL_LIMIT, 0.3));
    },
  },
  {
    name: 'load_memory',
    description:
      'Load relevant memory at the start of a conversation (or whenever the topic shifts). Pass the topics, people, projects, or questions in play — short tags, not the whole user message. Returns the model index (so you can pull more), recency-first recent notes (continuity), the full view of any topic that matches a model, and specific receipts retrieved for free-text topics. Call this early.',
    inputSchema: {
      type: 'object',
      properties: {
        topics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Topics/people/projects/questions relevant now. Names matching the model index load that model\'s view; free-text topics drive receipt retrieval.',
        },
      },
      required: ['topics'],
    },
    handler: async (memory, args) => {
      const topics = Array.isArray(args.topics) ? args.topics.map(String).map(s => s.trim()).filter(Boolean) : [];
      const models = memory.listModels();
      const byName = new Map(models.map(m => [m.name, m]));

      const blocks: string[] = [formatModelIndex(models)];

      const recent = formatRecentNotes(memory.recentObservations(RECENT_NOTES_COUNT));
      if (recent) blocks.push(`# Recent notes\n_Newest first — continuity across recent conversations._\n\n${recent}`);

      const ragTopics: string[] = [];
      const views: string[] = [];
      const loadedNames: string[] = [];
      for (const t of topics) {
        const model = byName.get(t);
        if (model) {
          const conf = memory.getModelConfidence(model.id);
          // The cover (summaries not rolled into a higher one) plus the
          // unsummarized tail partition the model's history exactly; the ramp
          // adds the newest covered tiles so the recent past never goes flat
          // at a batch boundary; a generous budget guards against a pathological model.
          const raw = memory.listViewForModel(model.id, { ramp: RAMP_PER_TIER, verbatim: RAMP_VERBATIM, tailLimit: MODEL_VIEW_OBS });
          const view = renderWithBudget(raw.summaries, raw.observations, MODEL_VIEW_BUDGET_CHARS);
          views.push(formatModelView(model, conf, view.summaries, view.observations));
          loadedNames.push(model.name);
        } else {
          ragTopics.push(t);
        }
      }
      if (views.length > 0) blocks.push(`# Loaded models\n\n${views.join('\n\n')}`);
      // Loading is also a growth trigger: catch up any pending tier-0 batches
      // or rollups in the background (bounded; a no-op when nothing's pending).
      if (loadedNames.length > 0) memory.background(memory.maybeResummarize(loadedNames));

      if (ragTopics.length > 0) {
        try {
          const vecs = await memory.embedMany(ragTopics);
          const seen = new Set<string>();
          const receipts = [] as ReturnType<MemoryDO['searchObservations']>;
          for (const qv of vecs) {
            for (const m of memory.searchObservations(qv, RAG_PER_TOPIC, 0.3)) {
              if (!seen.has(m.id)) { seen.add(m.id); receipts.push(m); }
            }
          }
          receipts.sort((a, b) => a.score - b.score);
          const block = formatReceipts(receipts.slice(0, 12));
          if (block) blocks.push(block);
        } catch (e) {
          console.error('[load_memory] rag embed failed:', e);
        }
      }

      return blocks.filter(Boolean).join('\n\n');
    },
  },
  {
    name: 'memory_stats',
    description:
      'Size and shape of this memory store: counts of models, observations, and summaries, the text-length distribution of observations and summaries (min/max/mean/median/total chars, with a chars/4 token estimate), and per model what load_memory would actually render (cover summaries + verbatim tail). Read-only. Use when asked how big memory is, or to sanity-check growth.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (memory) => formatStats(memory.getStats()),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

// ---------- JSON-RPC plumbing ----------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function dispatch(memory: MemoryDO, req: JsonRpcRequest): Promise<object | null> {
  switch (req.method) {
    case 'initialize':
      return rpcResult(req.id, {
        protocolVersion: (req.params?.protocolVersion as string) || DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notification — no response

    case 'ping':
      return rpcResult(req.id, {});

    case 'tools/list':
      return rpcResult(req.id, {
        tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });

    case 'tools/call': {
      const name = req.params?.name as string;
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) return rpcError(req.id, -32602, `Unknown tool: ${name}`);
      const t0 = Date.now();
      try {
        const text = await tool.handler(memory, args);
        const ms = Date.now() - t0;
        if (ms > 2000) console.log('tool:slow', { tool: name, ms });
        return rpcResult(req.id, { content: [{ type: 'text', text }] });
      } catch (e) {
        const ms = Date.now() - t0;
        const message = e instanceof Error ? e.message : String(e);
        console.error('tool:error', { tool: name, ms, error: message, stack: e instanceof Error ? e.stack : undefined });
        return rpcResult(req.id, { content: [{ type: 'text', text: `Tool error: ${message}` }], isError: true });
      }
    }

    default:
      return rpcError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

/**
 * Entry point called from MemoryDO.fetch. Handles a single JSON-RPC request or
 * a batch. Embedding and synthesis run through the DO's `env.AI` binding — no
 * API key to forward, dev or prod.
 */
export async function handleMcpRequest(memory: MemoryDO, request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('MCP endpoint expects POST', { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }

  // Batch or single.
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(r => dispatch(memory, r as JsonRpcRequest)))).filter(Boolean);
    return responses.length === 0 ? new Response(null, { status: 202 }) : Response.json(responses);
  }

  const response = await dispatch(memory, body as JsonRpcRequest);
  return response === null ? new Response(null, { status: 202 }) : Response.json(response);
}

function formatStats(st: ReturnType<MemoryDO['getStats']>): string {
  const row = (label: string, z: { count: number; minChars: number; maxChars: number; meanChars: number; medianChars: number; totalChars: number; minTokens: number; maxTokens: number; meanTokens: number; medianTokens: number; totalTokens: number }) =>
    `${label} (${z.count}): min ${z.minChars} chars / ~${z.minTokens} tok · max ${z.maxChars} / ~${z.maxTokens} · mean ${z.meanChars} / ~${z.meanTokens} · median ${z.medianChars} / ~${z.medianTokens} · total ${z.totalChars} / ~${z.totalTokens}`;
  return [
    `Models: ${st.models} active · Observations: ${st.observations} (${st.embedded} embedded, dim ${st.embeddingDim}) · Summaries: ${st.summaries} (${st.summariesEmbedded} embedded)`,
    row('Observations', st.observationSize),
    row('Summaries', st.summarySize),
    '(tokens ≈ chars / 4)',
    '',
    'Per model (biggest first): obs (unsummarized tail) · obs chars/~tok · summaries (top tier) · all-summary chars/~tok · LOAD = what load_memory renders (cover + ramp summaries, tail + ramp obs) chars/~tok · span',
    ...st.perModel.map(m => {
      const flags = [m.seed ? 'seed' : '', m.archived ? 'archived' : ''].filter(Boolean).join(', ');
      const span = m.earliest && m.latest ? `${day(m.earliest)} → ${day(m.latest)}` : 'no observations';
      const tier = m.summaries ? ` (tier ${m.topTier})` : '';
      return `- ${m.name}${flags ? ` [${flags}]` : ''}: ${m.observations} obs (${m.unsummarized} tail) · ${m.observationChars}/~${m.observationTokens} · ${m.summaries} sum${tier} · ${m.summaryChars}/~${m.summaryTokens} · LOAD ${m.viewSummaries} sum + ${m.viewObservations} obs = ${m.viewChars}/~${m.viewTokens} · ${span}`;
    }),
  ].join('\n');
}

function day(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
