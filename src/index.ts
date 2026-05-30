/**
 * pyramid-mcp — Worker entrypoint.
 *
 * Two auth modes:
 *   - DEV_AUTH=true (.dev.vars only): header-based dev auth (dev-handler.ts).
 *     Used for local development and the eval/seed scripts.
 *   - otherwise: Google OAuth via @cloudflare/workers-oauth-provider (oauth.ts).
 *     The authenticated principal keys the per-user MemoryDO; the user's OpenAI
 *     key is captured at onboarding and stored in their DO. See SETUP.md.
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { MemoryDO } from './memory-do.js';
import { devHandler } from './dev-handler.js';
import { googleAuthHandler, mcpApiHandler } from './oauth.js';

export { MemoryDO };

export interface Env {
  MEMORY_DO: DurableObjectNamespace<MemoryDO>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  DEV_AUTH?: string;
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
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    if (env.DEV_AUTH === 'true') return devHandler(request, env);
    return oauthProvider.fetch(request, env, ctx);
  },
};
