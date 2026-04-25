import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { register as registerSlug } from './slug.js';
import { register as registerTime } from './time.js';
import { register as registerHabitat } from './habitat.js';
import { register as registerVersionConsistency } from './version_consistency.js';
import { register as registerMemoryQuery } from './memory_query.js';
import { register as registerFeedback } from './feedback.js';

export function registerAllTools(server: McpServer): void {
  registerSlug(server);
  registerTime(server);
  registerHabitat(server);
  registerVersionConsistency(server);
  registerMemoryQuery(server);
  registerFeedback(server);
}
