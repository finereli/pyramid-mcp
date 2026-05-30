/**
 * pyramid-mcp — Worker entrypoint.
 *
 * The MCP transport (McpAgent) + Google OAuth land in later tasks (#4, #8).
 * For now we export the MemoryDO so the storage layer (Task #2) is deployable
 * and testable. See SPEC.md for the full design.
 */
import { MemoryDO } from './memory-do.js';

export { MemoryDO };

export interface Env {
  MEMORY_DO: DurableObjectNamespace<MemoryDO>;
}

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response('pyramid-mcp: storage layer only — MCP transport not wired yet (see SPEC.md)', {
      status: 501,
    });
  },
};
