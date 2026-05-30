/**
 * pyramid-mcp — Worker entrypoint.
 *
 * Routes `POST /mcp` to the authenticated user's MemoryDO, which hosts the MCP
 * JSON-RPC server directly (see mcp.ts). Auth is a dev stub for now — an
 * `x-user-id` header keys the DO and `x-openai-key` carries the embedding key.
 * Google OAuth (Task #8) swaps in here without touching the DO or tools.
 */
import { MemoryDO } from './memory-do.js';

export { MemoryDO };

export interface Env {
  MEMORY_DO: DurableObjectNamespace<MemoryDO>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/mcp') {
      // Dev auth — replaced by OAuth principal resolution in Task #8.
      const userId = request.headers.get('x-user-id');
      if (!userId) {
        return new Response('Missing x-user-id (dev auth — OAuth lands in Task #8)', { status: 401 });
      }
      const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(userId));
      return stub.fetch(request);
    }

    return new Response('pyramid-mcp — MCP server at POST /mcp. See SPEC.md.', { status: 200 });
  },
};
