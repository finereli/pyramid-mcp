/**
 * pyramid-mcp — Worker entrypoint.
 *
 * Two auth modes:
 *   - DEV_AUTH=true (.dev.vars only): header-based dev auth (dev-handler.ts).
 *     Used for local development and the eval/seed scripts.
 *   - otherwise: Google OAuth via @cloudflare/workers-oauth-provider (oauth.ts).
 *     The authenticated principal keys the per-user MemoryDO. Embedding and
 *     synthesis run on Workers AI (env.AI) — no per-user key. See SETUP.md.
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { MemoryDO } from './memory-do.js';
import { devHandler, adminHandler } from './dev-handler.js';
import { googleAuthHandler, mcpApiHandler } from './oauth.js';

export { MemoryDO };

export interface Env {
  MEMORY_DO: DurableObjectNamespace<MemoryDO>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  AI: Ai;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  DEV_AUTH?: string;
  ADMIN_TOKEN?: string;
}

const oauthProvider = new OAuthProvider({
  apiRoute: '/mcp',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiHandler: mcpApiHandler as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: googleAuthHandler as any,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['memory'],
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const start = Date.now();
    let response: Response;
    try {
      if (url.pathname.startsWith('/admin/')) {
        response = await adminHandler(request, env);
      } else if (env.DEV_AUTH === 'true') {
        response = await devHandler(request, env);
      } else {
        response = await oauthProvider.fetch(request, env, ctx);
      }
    } catch (err) {
      console.error('Unhandled error', { path: url.pathname, method: request.method, error: String(err), stack: err instanceof Error ? err.stack : undefined });
      response = new Response('Internal error', { status: 500 });
    }
    const ms = Date.now() - start;
    if (ms > 1000 || response.status >= 500) {
      console.log('req', { method: request.method, path: url.pathname, status: response.status, ms });
    }
    return response;
  },
};
