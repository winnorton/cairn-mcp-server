import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { register as registerSlug } from './slug.js';
import { register as registerTime } from './time.js';
import { register as registerHabitat } from './habitat.js';
import { register as registerVersionConsistency } from './version_consistency.js';
import { register as registerMemoryQuery } from './memory_query.js';
import { register as registerFeedback } from './feedback.js';
import { register as registerSessionDistill } from './session_distill.js';
import { register as registerOverclaimCheck } from './overclaim_check.js';
import { register as registerLessonReplay } from './lesson_replay.js';
import { register as registerNamespaceAudit } from './namespace_audit.js';
import { register as registerHabitatProgress } from './habitat_progress.js';

export function registerAllTools(server: McpServer): void {
  registerSlug(server);
  registerTime(server);
  registerHabitat(server);
  registerVersionConsistency(server);
  registerMemoryQuery(server);
  registerFeedback(server);
  // v0.2.0 session-learning tools
  registerSessionDistill(server);
  registerOverclaimCheck(server);
  registerLessonReplay(server);
  registerNamespaceAudit(server);
  registerHabitatProgress(server);
}
