/**
 * Every live call in this process, and the only thing that decides whether a new one may start.
 *
 * There is no database and no shared state: one Railway instance holds its calls in this Map and
 * forgets them when they end. That is sized for the template's brief, about a hundred calls a month
 * per deployment, and the interface is small enough to put behind Redis later without touching the
 * turn loop.
 *
 * Phone calls and status-page test chats share the machinery but not the budget. A deployer trying
 * the prompt in a browser must never use up the capacity a real caller needs, so the caps are
 * counted separately and MAX_CONCURRENT_CALLS applies to calls alone.
 */
import { events } from '../log/index.js';
import type { CallInfo, SessionFactory, SessionOpenResult, VoiceOut } from '../voice/types.js';
import { createEndCallCapability } from './capabilities/endCall.js';
import { CallSession } from './session.js';
import type { ToolSettings } from '../tools/types.js';
import type { AgentDeps, AgentSettings, SessionRegistry, SessionSnapshot } from './types.js';

/** Test chats a deployment will hold at once. Small: it is a diagnostic, not a product. */
export const MAX_CHAT_SESSIONS = 3;

/** A browser tab left open must not hold a chat session for ever. */
export const CHAT_IDLE_MS = 10 * 60 * 1000;

/** How often abandoned chat sessions are looked for. */
export const SWEEP_INTERVAL_MS = 60_000;

/** How long closeAll() waits for every session to end before it stops waiting. */
export const CLOSE_ALL_DEADLINE_MS = 8_000;

export interface SessionRegistryOptions extends Omit<AgentDeps, 'settings'> {
  /** Both slices, because a session hands the tools' own slice to every tool it runs. */
  settings: AgentSettings & ToolSettings;
  /** LoadedConfig.ready. A deployment with a blocking problem takes no calls (ADR 0001). */
  ready: boolean;
}

const isChat = (info: CallInfo): boolean => info.channel === 'textchat';

export interface AgentSessionRegistry extends SessionRegistry {
  /** Stops the sweep. The process exits after drain, so this matters only to tests. */
  stop(): void;
}

export function createSessionRegistry(options: SessionRegistryOptions): AgentSessionRegistry {
  const { log, settings } = options;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, CallSession>();
  const lastSeen = new Map<string, number>();

  /**
   * end_call is added here rather than in the tools registry: it is part of how a call ends, not a
   * tool that reaches the deployer's systems, and AGENT_END_CALL decides whether the model sees it.
   */
  const tools = settings.AGENT_END_CALL
    ? [...options.tools, createEndCallCapability()]
    : [...options.tools];

  const countCalls = (): number => {
    let calls = 0;
    for (const session of sessions.values()) if (session.channel !== 'textchat') calls += 1;
    return calls;
  };

  const countChats = (): number => {
    let chats = 0;
    for (const session of sessions.values()) if (session.channel === 'textchat') chats += 1;
    return chats;
  };

  const forget = (callSid: string): void => {
    sessions.delete(callSid);
    lastSeen.delete(callSid);
  };

  const open: SessionFactory = (info: CallInfo, out: VoiceOut): SessionOpenResult => {
    if (!options.ready) return { ok: false, reason: 'not_ready' };

    if (isChat(info)) {
      if (countChats() >= MAX_CHAT_SESSIONS) {
        options.recent.record({
          kind: 'chat_limit',
          detail: `The test chat is limited to ${String(MAX_CHAT_SESSIONS)} conversations at once.`,
        });
        return { ok: false, reason: 'capacity' };
      }
    } else if (countCalls() >= settings.MAX_CONCURRENT_CALLS) {
      log.warn(
        { event: events.wsRejected, reason: 'capacity', active_calls: countCalls() },
        'at MAX_CONCURRENT_CALLS',
      );
      options.recent.record({
        kind: 'ws_rejected',
        detail: `capacity: this deployment is set to take ${String(settings.MAX_CONCURRENT_CALLS)} calls at once.`,
      });
      return { ok: false, reason: 'capacity' };
    }

    // Twilio retrying a setup, or a reconnect, must not leave two sessions speaking to one caller.
    const existing = sessions.get(info.callSid);
    if (existing !== undefined) {
      log.warn(
        { callSid: info.callSid, event: 'call.replaced' },
        'a second setup replaced this call',
      );
      forget(info.callSid);
      void existing.endForShutdown();
    }

    const session: CallSession = new CallSession({
      info,
      out,
      llm: options.llm,
      tools,
      settings,
      log,
      recent: options.recent,
      now,
      /**
       * Identity-checked, not just keyed. A replaced session ends after its replacement is already
       * registered under the same callSid, and a plain delete would then evict the live call and
       * quietly leave the new caller with a session nothing can find.
       */
      onEnded: (callSid) => {
        if (sessions.get(callSid) === session) forget(callSid);
      },
    });

    sessions.set(info.callSid, session);
    lastSeen.set(info.callSid, now());
    return { ok: true, port: session };
  };

  const sweep = setInterval(() => {
    const cutoff = now() - CHAT_IDLE_MS;
    for (const [callSid, session] of sessions) {
      if (session.channel !== 'textchat') continue;
      if ((lastSeen.get(callSid) ?? 0) > cutoff) continue;
      log.info({ callSid, event: 'chat.expired' }, 'test chat abandoned');
      forget(callSid);
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  return {
    open,

    size: () => sessions.size,

    activeCalls: countCalls,

    snapshot: (callSid: string): SessionSnapshot | undefined => {
      const session = sessions.get(callSid);
      if (session === undefined) return undefined;
      // Reading a chat session is how the page keeps it alive.
      lastSeen.set(callSid, now());
      return session.snapshot();
    },

    async closeAll(): Promise<void> {
      const live = [...sessions.values()];
      if (live.length === 0) return;
      await Promise.race([
        Promise.allSettled(live.map((session) => session.endForShutdown())),
        new Promise<void>((resolve) => setTimeout(resolve, CLOSE_ALL_DEADLINE_MS).unref()),
      ]);
      // Whatever did not finish in time is dropped: the process is going away regardless.
      sessions.clear();
      lastSeen.clear();
    },

    stop(): void {
      clearInterval(sweep);
    },
  };
}
