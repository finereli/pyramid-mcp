# pyramid-mcp

Portable agent-authored memory as a remote MCP server on Cloudflare.

You tell the agent things. It decides what's worth remembering and which mental model(s) it belongs to. For each model it keeps recent notes verbatim and older notes summarized. When you ask it something, it grabs the relevant models and looks at its notes.

This is the memory architecture proven inside [Glopus](https://glopus.finereli.com), repackaged so any MCP-capable agent backend can plug into it — one Durable Object per user, all data in one place, BYOK.

See **[SPEC.md](./SPEC.md)** for the full design.

## Status

Early scaffold. Build order is tracked as tasks; see SPEC.md for scope.

## Develop

```bash
npm install
npm run dev      # wrangler dev on :8787
npm test         # vitest (workerd runtime)
```

## Try it locally (dev auth, no OAuth yet)

You can connect an MCP client to a local instance using header-based dev auth
(`x-user-id` keys your memory DO, `x-openai-key` is your embedding/synthesis key).
Google OAuth replaces this for real deployment.

```bash
# 1. Put your OpenAI key where the server + scripts can read it
echo 'OPENAI_API_KEY=sk-...' > .dev.vars

# 2. Build the embedded seed (one-time; reads Glopus test6.db — see --db flag)
npx tsx scripts/build-seed.ts --embed

# 3. Run the server, then load your memory under a user id
npm run dev
npx tsx scripts/load-seed.ts --user eli      # in another shell

# 4. Connect Claude Code (custom headers)
claude mcp add --transport http pyramid http://127.0.0.1:8787/mcp \
  --header "x-user-id: eli" --header "x-openai-key: sk-..."
```

Then ask Claude Code to recall a fact or load a topic — the server's MCP
`instructions` tell the agent to `load_memory` at the start of a chat and
`record_observation` as it goes.

## Eval

`scripts/eval-recall.ts` loads the seed into a fresh DO and runs the recall gate
(direct + integrative) end-to-end through `/mcp`, asserting high-confidence facts
and writing a human-readable report. Personal seed data and reports are gitignored.

## License

MIT
