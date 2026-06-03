# pyramid-mcp

AI memory that works like human memory - a remote MCP server on Cloudflare.

**A witness for what you're afraid of losing.**

Almost everything that happens to you is witnessed by no one. Not the big events - people show up for those. It's the ordinary days: the small worries, the things you quietly figured out, the afternoons that were hard and then passed. They happen once and then they're gone, and after enough years you can't be sure they happened at all. That's most of a life, and it disappears.

You'd expect an AI to be good at this. It's always there, and it never gets tired of you. But AIs don't really remember you. Most forget everything the moment the conversation ends. The ones that do have "memory" are worse: they store every fact with the same weight, so they'll surface something trivial from three weeks ago at exactly the wrong moment. They have a database, not a memory.

Pyramid gives your AI a memory shaped like a human one. Recent things stay sharp. Older things compress into the gist of who you've become. It keeps what matters and lets the rest fade, the way you do - and nothing is actually lost: ask, and the exact detail comes back. It's the difference between something that has read a file about you and something that knows you.

## Why I built this

When I hit 40 I started noticing my memory fade - names, conversations, the texture of things I was sure I'd never forget. The anxiety that came with it sent me on a three-year project to build an AI memory that would capture everything, forget nothing, and move with me and my experiences. What came out the other end is an agent that truly knows and understands me, and remembers far more about my life than I do. Pyramid is that memory, repackaged so any agent can have one.

## Set it up

Pyramid runs on your own Cloudflare account - your memory is yours, not a vendor's.

1. **Deploy** to Cloudflare Workers (one `wrangler deploy`).
2. **Sign in** once with Google - that identity is the only thing that keys your memory.
3. **No API key to bring.** Embeddings and summaries run on Cloudflare Workers AI, billed to your own account.
4. **Connect your agent** to `https://<your-worker>/mcp`. In Claude:
   ```bash
   claude mcp add --transport http pyramid https://<your-worker>/mcp
   ```

Full walkthrough - Google OAuth client, KV namespace, secrets - in **[SETUP.md](./SETUP.md)**. To try it locally first with no OAuth, see [Develop](#develop) below.

## How it works

The pitch above is the experience; this is the machinery.

- **One Durable Object per person.** All of your memory - notes, models, summaries - lives in a single Cloudflare Durable Object keyed by your Google identity. Nothing is shared across users.
- **Mental models, not a flat log.** The agent tags each observation to one or more models (people, projects, themes). Recent notes are kept verbatim; older ones are summarized upward into a small, durable pyramid per model.
- **Recall is two moves.** The agent loads the models relevant to the topic, and vector search (Workers AI `bge-m3` embeddings, brute-force cosine inside the DO) pulls the matching raw notes for receipts.
- **Agent-authored, so it doesn't drift.** The agent decides what's worth recording and when, guided by the server's MCP `instructions`. No separate extraction model second-guesses it.
- **No keys to bring.** Embeddings (`bge-m3`) and synthesis (Llama 3.3 70B) run on Cloudflare Workers AI, billed to your account. (Synthesis is provider-agnostic so it can move to MCP sampling - the host's own model - once clients support it.)
- **Speaks MCP over Streamable HTTP.** Any MCP-capable client - Claude, ChatGPT, your own - connects the same way.

This is the memory architecture proven inside [Glopus](https://glopus.finereli.com), repackaged so any MCP-capable backend can plug into it. See **[SPEC.md](./SPEC.md)** for the full design.

## Develop

```bash
npm install
npm run dev      # wrangler dev on :8787
npm test         # vitest (workerd runtime)
```

## Try it locally (dev auth, no OAuth yet)

You can connect an MCP client to a local instance using header-based dev auth
(`x-user-id` keys your memory DO). Embeddings + synthesis run on Workers AI via
the `env.AI` binding, so there's no key to pass. Google OAuth replaces the dev
header for real deployment.

```bash
# 1. Enable dev auth (the AI binding needs no key)
echo 'DEV_AUTH=true' > .dev.vars

# 2. Build the embedded seed (one-time; reads Glopus test6.db — see --db flag).
#    --embed uses Workers AI bge-m3; needs CLOUDFLARE_API_TOKEN (Workers AI perm)
#    or WORKERS_AI_TOKEN in .dev.vars.
npx tsx scripts/build-seed.ts --embed

# 3. Run the server, then load your memory under a user id
npm run dev
npx tsx scripts/load-seed.ts --user eli      # in another shell

# 4. Connect Claude Code (custom header)
claude mcp add --transport http pyramid http://127.0.0.1:8787/mcp \
  --header "x-user-id: eli"
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
