/**
 * MCP transport — JSON-RPC over Streamable HTTP, hosted directly inside the
 * per-user MemoryDO (no McpAgent, no separate session DO). Stateless: each
 * request routes to the user's DO by principal; there's no conversation/session
 * state to keep (memory is global per user).
 *
 * Tools are thin wrappers over the DO's storage methods (called directly on the
 * in-DO instance, so they're synchronous). Embedding needs the user's OpenAI
 * key, which the Worker forwards on the request (dev: header; prod: from OAuth).
 */
import type { MemoryDO } from './memory-do.js';
import { embedText } from './embeddings.js';

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

Use \`recall\` to verify specific facts (names, dates, numbers, quotes) before stating them.

Bracketed metadata like \`[client-cristi · 12 obs · spans 3mo · latest 2026-05-20]\` tells you how much backs a memory and how fresh it is — calibrate your confidence accordingly. Never mention models, clusters, or that memory was "loaded"; weave recollections in as your own knowing.`;

// ---------- Tool definitions ----------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (memory: MemoryDO, apiKey: string, args: Record<string, unknown>) => Promise<string>;
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
    handler: async (memory, apiKey, args) => {
      const text = String(args.text ?? '').trim();
      const models = Array.isArray(args.models) ? args.models.map(String) : [];
      if (!text) return 'No observation text provided.';
      if (models.length === 0) return 'No models provided. Pass at least one model name in "models".';

      // Embed first so the observation is immediately recallable. Cheap; if no
      // key is configured we still store it and it can be backfilled later.
      let embedding: number[] | undefined;
      if (apiKey) {
        try { embedding = await embedText(text, apiKey); }
        catch (e) { console.error('[record_observation] embed failed, storing without vector:', e); }
      }

      const res = memory.addObservation(text, models, 'direct', embedding);
      if (!res.ok) {
        return `Unknown model name(s): ${res.unknown.join(', ')}. Call create_model first, or pick existing names from the model index.`;
      }
      if (res.deduped) return 'Skipped as duplicate of a recent observation.';
      return `Recorded against: ${res.tagged.join(', ')}.`;
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
    handler: async (memory, _apiKey, args) => {
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
    handler: async (memory, _apiKey, args) => {
      const name = String(args.name ?? '').trim();
      const description = String(args.description ?? '').trim();
      if (!name || !description) return 'Both name and description are required.';
      const ok = memory.updateModelDescription(name, description);
      return ok ? `Updated description for "${name}".` : `No model named "${name}". Call create_model if you intended to create it.`;
    },
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

async function dispatch(memory: MemoryDO, apiKey: string, req: JsonRpcRequest): Promise<object | null> {
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
      try {
        const text = await tool.handler(memory, apiKey, args);
        return rpcResult(req.id, { content: [{ type: 'text', text }] });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return rpcResult(req.id, { content: [{ type: 'text', text: `Tool error: ${message}` }], isError: true });
      }
    }

    default:
      return rpcError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

/**
 * Entry point called from MemoryDO.fetch. Handles a single JSON-RPC request or
 * a batch. The user's OpenAI key arrives on the `x-openai-key` header (dev);
 * in prod the Worker injects it from the OAuth-stored key (Task #8).
 */
export async function handleMcpRequest(memory: MemoryDO, request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('MCP endpoint expects POST', { status: 405 });
  }
  const apiKey = request.headers.get('x-openai-key') ?? '';

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }

  // Batch or single.
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(r => dispatch(memory, apiKey, r as JsonRpcRequest)))).filter(Boolean);
    return responses.length === 0 ? new Response(null, { status: 202 }) : Response.json(responses);
  }

  const response = await dispatch(memory, apiKey, body as JsonRpcRequest);
  return response === null ? new Response(null, { status: 202 }) : Response.json(response);
}
