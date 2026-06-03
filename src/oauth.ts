/**
 * Production auth — Google as the upstream IdP, fronted by
 * @cloudflare/workers-oauth-provider. Two handlers wired in index.ts:
 *
 *   - googleAuthHandler (defaultHandler): the authorization UI. /authorize
 *     redirects to Google; /callback exchanges the code and completes the OAuth
 *     grant. No BYOK step — embedding + synthesis run on Workers AI (env.AI),
 *     billed to the account, so memory works the moment a user signs in.
 *   - mcpApiHandler (apiHandler): token-protected /mcp. The authenticated
 *     principal (Google `sub`, in ctx.props.userId) keys the MemoryDO. No headers.
 *
 * UNTESTED until deployed with real Google credentials — see SETUP.md.
 */
import type { Env } from './index.js';
import { landingResponse } from './landing.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

const b64urlEncode = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s: string) => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));

// ---------- defaultHandler: Google auth UI ----------

export const googleAuthHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    // 0. Browser hitting the root → the human-facing landing page.
    if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      return landingResponse();
    }

    // 1. MCP client begins auth → stash the parsed OAuth request in Google's state.
    if (url.pathname === '/authorize') {
      const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const g = new URL(GOOGLE_AUTH);
      g.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
      g.searchParams.set('redirect_uri', `${origin}/callback`);
      g.searchParams.set('response_type', 'code');
      g.searchParams.set('scope', 'openid email profile');
      g.searchParams.set('access_type', 'online');
      g.searchParams.set('state', b64urlEncode(oauthReq));
      return Response.redirect(g.toString(), 302);
    }

    // 2. Google redirects back → exchange code, then complete the OAuth grant.
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) return new Response('Missing code/state', { status: 400 });

      const tokenRes = await fetch(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${origin}/callback`,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) return new Response(`Google token exchange failed: ${await tokenRes.text()}`, { status: 502 });
      const { access_token } = (await tokenRes.json()) as { access_token: string };

      const infoRes = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${access_token}` } });
      if (!infoRes.ok) return new Response('Google userinfo failed', { status: 502 });
      const { sub, email } = (await infoRes.json()) as { sub: string; email: string };

      // No BYOK step — Workers AI (env.AI) handles embedding + synthesis, so we
      // complete the grant straight away.
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: b64urlDecode(state),
        userId: sub,
        scope: ['memory'],
        metadata: { email },
        props: { userId: sub, email },
      });
      return Response.redirect(redirectTo, 302);
    }

    return new Response('pyramid-mcp', { status: 200 });
  },
};

// ---------- apiHandler: token-protected MCP ----------

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    // props were set in completeAuthorization and ride the access token.
    const userId = (ctx as unknown as { props?: { userId?: string } }).props?.userId;
    if (!userId) return new Response('Unauthorized', { status: 401 });
    const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(userId));
    return stub.fetch(request);
  },
};
