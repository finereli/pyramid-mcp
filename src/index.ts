/**
 * pyramid-mcp — entrypoint.
 *
 * Scaffold only. The real implementation lands across the tracked tasks:
 *   - MemoryDO: per-principal Durable Object holding all memory in DO-SQLite (Task #2)
 *   - embeddings + in-DO cosine search (Task #3)
 *   - reactive tools: record_observation / create_model / update_model_description (Task #4)
 *   - recall (Task #5), pyramid summarization (Task #6), load_memory (Task #7)
 *   - Google OAuth → principal → DO routing (Task #8)
 *
 * See SPEC.md for the full design.
 */

export default {
  async fetch(_request: Request, _env: unknown): Promise<Response> {
    return new Response('pyramid-mcp: not implemented yet — see SPEC.md', { status: 501 });
  },
};
