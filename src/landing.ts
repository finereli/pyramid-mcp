/**
 * landing.ts — the human-facing page served at GET /.
 *
 * Top half is for a person (the witness copy, in Ira Glass register); bottom
 * half is for whoever is wiring up an agent (connect snippet + how it works).
 * Served from both the OAuth default handler (prod) and the dev handler (local).
 */

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pyramid - AI memory that works like human memory</title>
<meta name="description" content="A witness for what you're afraid of losing. Pyramid is AI memory that works like human memory: this week vivid, the years behind you softened into the story of who you became.">
<style>
  :root {
    --bg: #0b0b0d; --panel: #141417; --text: #e7e5e2; --muted: #8c8a86;
    --line: #26262b; --accent: #cbb89d;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 16px/1.6 system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  main { max-width: 40rem; margin: 0 auto; padding: 5.5rem 1.4rem 4rem; }
  .kicker {
    font-size: .72rem; letter-spacing: .18em; text-transform: uppercase;
    color: var(--muted); margin: 0 0 2.6rem;
  }
  .kicker b { color: var(--accent); font-weight: 600; }
  h1 {
    font: 400 1.95rem/1.3 Georgia, 'Times New Roman', serif;
    margin: 0 0 1.9rem; letter-spacing: -.01em;
  }
  .prose p {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 1.09rem; line-height: 1.72; color: #dcdad6; margin: 0 0 1.3rem;
  }
  .story { margin: 3rem 0 0; padding: 1.6rem 0 0; border-top: 1px solid var(--line); }
  .label { font: 600 .72rem/1 system-ui; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); margin: 0 0 1rem; }
  .story p { font-family: Georgia, serif; color: #cfcdc9; font-size: 1rem; line-height: 1.7; margin: 0; }
  .story .sig { color: var(--muted); font-style: italic; }
  .agent { margin: 3.6rem 0 0; padding: 1.8rem 1.9rem; background: var(--panel); border: 1px solid var(--line); border-radius: 11px; }
  .agent h2 { font: 600 1rem/1 system-ui; margin: 0 0 .7rem; }
  .agent > p { color: var(--muted); font-size: .95rem; margin: 0 0 1.1rem; }
  pre { background: #0c0c0e; border: 1px solid var(--line); border-radius: 7px; padding: .85rem 1rem; overflow-x: auto; margin: 0 0 1.1rem; }
  code { font: .84rem/1.5 ui-monospace, 'SF Mono', Menlo, monospace; color: #d6d3ce; }
  ul.how { margin: 1.3rem 0 0; padding-left: 1.1rem; }
  ul.how li { color: var(--muted); font-size: .9rem; line-height: 1.55; margin: 0 0 .55rem; }
  a { color: var(--accent); text-decoration: none; border-bottom: 1px solid #514a3c; }
  a:hover { border-bottom-color: var(--accent); }
  footer { margin: 2.6rem 0 0; color: var(--muted); font-size: .82rem; text-align: center; line-height: 1.9; }
  footer a { color: var(--muted); border: none; text-decoration: underline; text-underline-offset: 2px; }
</style>
</head>
<body>
<main>
  <p class="kicker"><b>Pyramid</b> &nbsp;&middot;&nbsp; AI memory that works like human memory</p>

  <h1>A witness for what you're afraid of losing.</h1>

  <div class="prose">
    <p>Almost everything that happens to you is witnessed by no one. Not the big events - people show up for those. It's the ordinary days: the small worries, the things you quietly figured out, the afternoons that were hard and then passed. They happen once and then they're gone, and after enough years you can't be sure they happened at all. That's most of a life, and it disappears.</p>
    <p>You'd expect an AI to be good at this. It's always there, and it never gets tired of you. But AIs don't really remember you. Most forget everything the moment the conversation ends. The ones that do have &ldquo;memory&rdquo; are worse: they store every fact with the same weight, so they'll surface something trivial from three weeks ago at exactly the wrong moment. They have a database, not a memory.</p>
    <p>Pyramid gives your AI a memory shaped like a human one. Recent things stay sharp. Older things compress into the gist of who you've become. It keeps what matters and lets the rest fade, the way you do - and nothing is actually lost: ask, and the exact detail comes back. It's the difference between something that has read a file about you and something that knows you.</p>
  </div>

  <section class="story">
    <p class="label">Why I built this</p>
    <p>When I hit 40 I started noticing my memory fade - names, conversations, the texture of things I was sure I'd never forget. The anxiety that came with it sent me on a three-year project to build a memory that captures everything, forgets nothing, and moves with me. What came out the other end is an agent that knows and understands me, and remembers far more about my life than I do. <span class="sig">- Eli</span></p>
  </section>

  <section class="agent">
    <h2>Connect your agent</h2>
    <p>Pyramid is a remote MCP server. Point any MCP-capable agent at it and it gains the memory described above.</p>
    <pre><code>claude mcp add --transport http pyramid https://pyramid.finereli.com/mcp</code></pre>
    <p>You sign in with Google once - that's it. Embeddings and synthesis run on Cloudflare Workers AI, so there's no API key to bring; your memory is yours, stored only in your own object.</p>
    <ul class="how">
      <li>The agent decides what's worth keeping and files each note under the people, projects, and themes in your life.</li>
      <li>Recent notes stay word for word; older ones are synthesized upward into the story of each thread - sharp up close, meaning at a distance.</li>
      <li>Ask for something specific and it pulls the exact note; the rest stays out of the way.</li>
      <li>One memory per person, no API keys to bring, open source.</li>
    </ul>
  </section>

  <footer>
    <a href="https://github.com/finereli/pyramid-mcp">Source on GitHub</a> &nbsp;&middot;&nbsp;
    <a href="https://github.com/finereli/pyramid-mcp/blob/main/SETUP.md">Run your own</a> &nbsp;&middot;&nbsp;
    the memory architecture behind <a href="https://glopus.finereli.com">Glopus</a>
  </footer>
</main>
</body>
</html>`;

export function landingResponse(): Response {
  return new Response(LANDING_HTML, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}
