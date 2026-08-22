/**
 * Dev handler — header-based auth for local development and the eval/seed
 * scripts. Active only when DEV_AUTH=true (set in .dev.vars, never in prod).
 * Routes by `x-user-id`. Embedding + synthesis run on Workers AI (env.AI), so
 * there's no key to pass. Production uses the OAuth path in oauth.ts instead.
 */
import type { Env } from './index.js';
import { landingResponse } from './landing.js';

export async function devHandler(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/seed' && request.method === 'POST') {
    const userId = request.headers.get('x-user-id');
    if (!userId) return new Response('Missing x-user-id', { status: 401 });
    const { models, observations } = (await request.json()) as { models?: any[]; observations?: any[] };
    const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(userId));
    return Response.json(await stub.bulkLoad(models ?? [], observations ?? []));
  }

  if (url.pathname === '/advance' && request.method === 'POST') {
    const userId = request.headers.get('x-user-id');
    if (!userId) return new Response('Missing x-user-id', { status: 401 });
    const { model, maxCalls } = (await request.json().catch(() => ({}))) as { model?: string; maxCalls?: number };
    const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(userId));
    return Response.json(await stub.advanceAll({ model, maxCalls }));
  }

  if (url.pathname === '/mcp') {
    const userId = request.headers.get('x-user-id');
    if (!userId) return new Response('Missing x-user-id (dev auth)', { status: 401 });
    const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(userId));
    return stub.fetch(request);
  }

  if (url.pathname === '/' && request.method === 'GET') return landingResponse();

  return new Response('pyramid-mcp (dev auth) — POST /mcp with x-user-id. See SPEC.md.', { status: 200 });
}

/**
 * Admin handler — token-gated bulk operations against a specific user's DO,
 * for seeding/migration in production (where the dev /seed path is disabled).
 * Gated by the ADMIN_TOKEN secret; takes an explicit userId (the principal the
 * MemoryDO is keyed by). Runs before OAuth in index.ts.
 */
export async function adminHandler(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN || request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
    return new Response('forbidden', { status: 403 });
  }
  const url = new URL(request.url);
  const stubFor = (uid: string) => env.MEMORY_DO.get(env.MEMORY_DO.idFromName(uid));

  if (url.pathname === '/admin/seed' && request.method === 'POST') {
    const { userId, models, observations } = (await request.json()) as { userId?: string; models?: any[]; observations?: any[] };
    if (!userId) return new Response('userId required', { status: 400 });
    return Response.json(await stubFor(userId).bulkLoad(models ?? [], observations ?? []));
  }

  // Grow a user's pyramids incrementally (tier-0 batches, then rollups), bounded
  // by maxCalls LLM calls per request. Loop until `remaining` is false. Optional
  // `model` restricts to one model. Idempotent and resumable: summaries are
  // immutable and provenance-tracked, so re-running never duplicates work.
  if (url.pathname === '/admin/advance' && request.method === 'POST') {
    const { userId, model, maxCalls } = (await request.json()) as { userId?: string; model?: string; maxCalls?: number };
    if (!userId) return new Response('userId (body) required', { status: 400 });
    return Response.json(await stubFor(userId).advanceAll({ model, maxCalls: maxCalls ?? 10 }));
  }

  // Read-only — inspect a user's DO (counts + embedding dimension) before a migration.
  if (url.pathname === '/admin/stats' && request.method === 'POST') {
    const { userId } = (await request.json()) as { userId?: string };
    if (!userId) return new Response('userId (body) required', { status: 400 });
    return Response.json(await stubFor(userId).getStats());
  }

  // Read-only — dump one model (row, summaries, observations) for inspection.
  if (url.pathname === '/admin/model' && request.method === 'POST') {
    const { userId, model } = (await request.json()) as { userId?: string; model?: string };
    if (!userId || !model) return new Response('userId + model (body) required', { status: 400 });
    const out = await stubFor(userId).exportModel(model);
    return out ? Response.json(out) : new Response('model not found', { status: 404 });
  }

  // Read-only — run a recall against a user's DO (verifies the full embed+search
  // path end-to-end, e.g. after a migration). Returns top matches.
  if (url.pathname === '/admin/recall' && request.method === 'POST') {
    const { userId, query, limit } = (await request.json()) as { userId?: string; query?: string; limit?: number };
    if (!userId || !query) return new Response('userId + query (body) required', { status: 400 });
    const stub = stubFor(userId);
    const qv = await stub.embed(query);
    return Response.json(await stub.searchObservations(qv, limit ?? 8, 0.3));
  }

  // In-place migration — re-embed a batch of observations to the current model's
  // dimension (bge-m3). Loop until remaining hits 0. Non-destructive.
  if (url.pathname === '/admin/reembed' && request.method === 'POST') {
    const { userId, limit } = (await request.json()) as { userId?: string; limit?: number };
    if (!userId) return new Response('userId (body) required', { status: 400 });
    return Response.json(await stubFor(userId).reembedBatch(limit ?? 20));
  }

  // Surgical undo — drop one model's summaries + provenance so its pyramid regrows
  // from the observations (which are untouched). Requires confirm:true.
  if (url.pathname === '/admin/unsummarize' && request.method === 'POST') {
    const { userId, model, confirm } = (await request.json()) as { userId?: string; model?: string; confirm?: boolean };
    if (!userId || !model || confirm !== true) return new Response('userId + model + confirm:true (body) required', { status: 400 });
    return Response.json(await stubFor(userId).unsummarizeModel(model));
  }

  // Destructive — wipe a user's memory back to the seed models. Requires confirm:true.
  if (url.pathname === '/admin/reset' && request.method === 'POST') {
    const { userId, confirm } = (await request.json()) as { userId?: string; confirm?: boolean };
    if (!userId || confirm !== true) return new Response('userId + confirm:true (body) required', { status: 400 });
    return Response.json(await stubFor(userId).resetMemory());
  }

  return new Response('unknown admin route', { status: 404 });
}
