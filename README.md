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
npm run dev      # wrangler dev
npm test         # vitest
```

## License

MIT
