/**
 * Event names: the `event` field of every structured log line (blueprint contract "Log events").
 *
 * Features log with these constants rather than string literals, so a rename is one edit and the
 * README's Railway filters (@event:call.ended) keep matching. The field list on each event is the
 * contract; callSid rides on every in-call line through forCall(). Utterances and model text go
 * out at debug only, so default logs carry timings and outcomes, not transcripts.
 */
export const events = {
  /** { port, host_source, commit } once, after listen. */
  serverListening: 'server.listening',
  /** { signal, active_calls, deadline_ms } on SIGTERM or SIGINT, before sessions are asked to end. */
  serverDraining: 'server.draining',
  /**
   * { signal, sessions: 'done'|'timeout'|'failed', close: 'done'|'timeout'|'failed', ms } once,
   * when the drain has finished and the process is about to exit.
   */
  serverStopped: 'server.stopped',
  /**
   * { error_id, status, method, route, code } one per request the error handler answered, with
   * err on a 5xx. route is the route pattern, never the URL, so a path secret never reaches the
   * logs; error_id is the id the response body carries.
   */
  requestError: 'request.error',
  /** { variable, severity, what } one per ConfigProblem at boot: names only, never a value. */
  configProblem: 'config.problem',
  /** { reason, signedUrl?, variantsTried?, ip } one per refused WebSocket upgrade. */
  wsRejected: 'ws.rejected',
  /** { callSid, from, to, channel, provider, model, automation } */
  callStarted: 'call.started',
  /**
   * { callSid, turn, ms_prompt_to_llm_first_token, ms_llm_first_to_complete,
   *   ms_prompt_to_first_text_out, ms_prompt_to_last_text_out, tool_name?, tool_ms?, interrupted,
   *   tokens_out } exactly one per turn (see TurnTiming in src/agent/types.ts).
   */
  turnTiming: 'turn.timing',
  /** { callSid, tool, ms, ok } */
  toolCalled: 'tool.called',
  /** { callSid, preset, status, http_status?, ms, merged_keys } */
  handoffWebhook: 'handoff.webhook',
  /**
   * { callSid, outcome, reason, duration_ms, turns, error_kind?, handoff_pending?, rss_mb }
   * exactly one per session. The README's clean-call filter counts outcome values here.
   */
  callEnded: 'call.ended',
} as const;

export type EventName = (typeof events)[keyof typeof events];
