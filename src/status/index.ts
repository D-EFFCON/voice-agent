/**
 * Status: what the page shows about the running server. The recent-problems buffer lands
 * with the app shell because the adapters record into it; the page renderer, POST /chat and
 * POST /selftest arrive with status-page-test-chat-and-selftest.
 */
export { createRecentProblems, RECENT_PROBLEMS_CAPACITY } from './recentProblems.js';
export type { RecentProblemsOptions } from './recentProblems.js';
