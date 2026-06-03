# Deploy & connect (Google OAuth)

The OAuth path (oauth.ts) is written but **untested until deployed** with real
Google credentials. Local development uses the dev-auth bypass and doesn't need
any of this.

## Local dev (no OAuth)

`.dev.vars` (gitignored):
```
DEV_AUTH=true
# WORKERS_AI_TOKEN=...   # only for `build-seed --embed`; CLOUDFLARE_API_TOKEN works too
```
Then `npm run dev`, `tsx scripts/load-seed.ts --user eli`, and connect Claude
Code with `--header "x-user-id: eli"`. Embeddings + synthesis run on Workers AI
(`env.AI`) — no key to pass.

## Production deploy

1. **Google OAuth client** — Google Cloud Console → APIs & Services →
   Credentials → Create OAuth client ID (Web application).
   - Authorized redirect URI: `https://<your-worker-domain>/callback`
   - Note the client ID + secret.

2. **KV namespace** for the OAuth provider's tokens/grants:
   ```bash
   wrangler kv namespace create OAUTH_KV
   ```
   Paste the returned id into `wrangler.jsonc` → `kv_namespaces[0].id`.

3. **Secrets** (do NOT set DEV_AUTH in prod — its absence enables OAuth):
   ```bash
   wrangler secret put GOOGLE_CLIENT_ID
   wrangler secret put GOOGLE_CLIENT_SECRET
   ```

4. **Deploy:**
   ```bash
   wrangler deploy
   ```

5. **Connect a client** (Claude, ChatGPT) to `https://<your-worker-domain>/mcp`.
   The client runs the OAuth flow → you sign in with Google → done. No API key
   to paste — embeddings + synthesis run on Workers AI (`env.AI`).

## Auth flow (what oauth.ts does)

```
MCP client → /authorize → redirect to Google
Google → /callback → exchange code, fetch userinfo (sub, email)
        → completeAuthorization(props:{userId:sub})  (no BYOK step)
MCP client now calls /mcp with a bearer token; props.userId routes to the DO.
```

## Things to verify on first deploy (untested paths)

- `parseAuthRequest` / `completeAuthorization` field names match the installed
  `@cloudflare/workers-oauth-provider` version.
- `ctx.props` is populated in the api handler (the lib injects it from the token).
- MCP client dynamic client registration hits `/register` (enabled).
- The Google redirect URI exactly matches the deployed domain.
