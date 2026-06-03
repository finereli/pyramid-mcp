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

  if (url.pathname === '/rebuild' && request.method === 'POST') {
    const userId = request.headers.get('x-user-id');
    if (!userId) return new Response('Missing x-user-id', { status: 401 });
    const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(userId));
    return Response.json(await stub.rebuildAllSummaries());
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

  if (url.pathname === '/admin/rebuild' && request.method === 'POST') {
    const { userId } = (await request.json()) as { userId?: string };
    if (!userId) return new Response('userId (body) required', { status: 400 });
    return Response.json(await stubFor(userId).rebuildAllSummaries());
  }

  // Read-only — inspect a user's DO (counts + embedding dimension) before a migration.
  if (url.pathname === '/admin/stats' && request.method === 'POST') {
    const { userId } = (await request.json()) as { userId?: string };
    if (!userId) return new Response('userId (body) required', { status: 400 });
    return Response.json(await stubFor(userId).getStats());
  }

  // Destructive — wipe a user's memory back to the seed models. Requires confirm:true.
  if (url.pathname === '/admin/reset' && request.method === 'POST') {
    const { userId, confirm } = (await request.json()) as { userId?: string; confirm?: boolean };
    if (!userId || confirm !== true) return new Response('userId + confirm:true (body) required', { status: 400 });
    return Response.json(await stubFor(userId).resetMemory());
  }

  return new Response('unknown admin route', { status: 404 });
}
