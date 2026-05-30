/**
 * Production auth — Google as the upstream IdP, fronted by
 * @cloudflare/workers-oauth-provider. Two handlers wired in index.ts:
 *
 *   - googleAuthHandler (defaultHandler): the authorization UI. /authorize
 *     redirects to Google; /callback exchanges the code, then shows a one-field
 *     page to capture the user's OpenAI key (per-user BYOK); /finish stores the
 *     key in the user's MemoryDO and completes the OAuth grant.
 *   - mcpApiHandler (apiHandler): token-protected /mcp. The authenticated
 *     principal (Google `sub`, in ctx.props.userId) keys the MemoryDO; the DO
 *     reads its own stored OpenAI key. No headers.
 *
 * UNTESTED until deployed with real Google credentials — see SETUP.md.
 */
import type { Env } from './index.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

const b64urlEncode = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s: string) => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));

function html(body: string): Response {
  return new Response(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><style>body{font:16px/1.5 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem}input{font:inherit;width:100%;padding:.6rem;margin:.4rem 0;box-sizing:border-box}button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}</style>${body}`, { headers: { 'content-type': 'text/html' } });
}

// ---------- defaultHandler: Google auth UI ----------

export const googleAuthHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

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

    // 2. Google redirects back → exchange code, then ask for the OpenAI key.
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

      // Carry the principal + original OAuth request into the key-capture form.
      const carry = b64urlEncode({ oauthReq: b64urlDecode(state), sub, email });
      return html(`<h2>Connect your memory</h2><p>Signed in as <b>${email}</b>. Paste your OpenAI API key — it's stored only in your own memory object and used for your embeddings + synthesis.</p>
<form method="POST" action="/finish"><input type="password" name="openai_key" placeholder="sk-..." autocomplete="off" required><input type="hidden" name="carry" value="${carry}"><button type="submit">Finish</button></form>`);
    }

    // 3. Store the key in the user's DO, then complete the OAuth grant.
    if (url.pathname === '/finish' && request.method === 'POST') {
      const form = await request.formData();
      const openaiKey = String(form.get('openai_key') ?? '').trim();
      const { oauthReq, sub, email } = b64urlDecode(String(form.get('carry') ?? ''));
      if (!openaiKey || !sub) return new Response('Missing key or session', { status: 400 });

      const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(sub));
      await stub.setApiKey(openaiKey);

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReq,
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
