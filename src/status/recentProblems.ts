/**
 * RecentProblems: the status page's ring buffer of the last 20 runtime events (blueprint data
 * model "RecentProblems"). The interface lives in src/agent/types.ts because the agent and the
 * voice adapters record into it; the instance is created in src/main.ts and handed to every
 * module that records, and to the status page that renders it.
 *
 * Details are passed through the scrubber src/main.ts supplies (the logger's value scrubbing),
 * so a provider error that echoes a key never reaches the page. The signed URL is kept as it
 * is: it carries WS_SECRET and belongs on the tokened view only, next to the wss URL itself.
 */
import type { RecentProblem, RecentProblems } from '../agent/types.js';

export const RECENT_PROBLEMS_CAPACITY = 20;

export interface RecentProblemsOptions {
  /** Default 20. */
  capacity?: number;
  /** Applied to every detail before it is stored. Default: identity. */
  scrub?: (text: string) => string;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export function createRecentProblems(options: RecentProblemsOptions = {}): RecentProblems {
  const capacity = options.capacity ?? RECENT_PROBLEMS_CAPACITY;
  const scrub = options.scrub ?? ((text: string): string => text);
  const now = options.now ?? ((): Date => new Date());
  const entries: RecentProblem[] = [];
  return {
    record(entry) {
      const stored: RecentProblem = {
        at: now().toISOString(),
        kind: entry.kind,
        detail: scrub(entry.detail),
      };
      if (entry.signedUrl !== undefined) stored.signedUrl = entry.signedUrl;
      entries.unshift(stored);
      if (entries.length > capacity) entries.length = capacity;
    },
    list() {
      return entries.map((e) => ({ ...e }));
    },
  };
}
