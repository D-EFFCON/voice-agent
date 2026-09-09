/**
 * Agent session API and the HandoffData contract Studio reads.
 *
 * Locked at foundation:seam-contracts-and-test-doubles. Features build against this file and
 * never edit it (ADR 0003). src/agent imports only seam type files, config types and log.
 */
import type { Logger } from 'pino';
import type { LlmClient, LlmMessage } from '../llm/types.js';
import type { ToolDefinition, ToolResult, WebhookStatus } from '../tools/types.js';
import type { SessionFactory } from '../voice/types.js';

// --- HandoffData (Studio contract; additive-only under v: 1, ADR 0002) -----------------------

/** The only routing key Studio needs: a Split widget matches it as a substring. */
export type HandoffReasonCode = 'live-agent-handoff' | 'end-call';

export type HandoffReason =
  | 'caller_request'
  | 'llm_error'
  | 'llm_timeout'
  | 'transport_error'
  | 'server_restart'
  | 'capacity'
  | 'max_call_seconds'
  | 'idle'
  | 'agent_end_call';

/**
 * JSON.stringify'd into the end frame; Studio reads {{widgets.<name>.HandoffData}} after the
 * widget finishes. reasonCode must be the first key when assembled. At most 4 KB. The webhook
 * response may add transfer_to, ticket_id and note but never overwrites a server-owned key.
 */
export interface HandoffData {
  reasonCode: HandoffReasonCode;
  v: 1;
  reason: HandoffReason;
  summary: string;
  callSid: string;
  from: string;
  to: string;
  startedAt: string;
  durationSec: number;
  webhook: WebhookStatus;
  transfer_to?: string;
  ticket_id?: string;
  note?: string;
}

// --- Session API ---------------------------------------------------------------------------

export type Outcome =
  'handoff' | 'completed' | 'caller_hangup' | 'timeout' | 'idle' | 'error' | 'server_restart';

export type SessionState = 'created' | 'active' | 'ending' | 'ended';

/** Exactly one per turn; the field names are the turn.timing log fields. */
export interface TurnTiming {
  turn: number;
  ms_prompt_to_llm_first_token: number | null;
  ms_llm_first_to_complete: number | null;
  /** Measured when the adapter hands the first text frame to the socket, not on flush. */
  ms_prompt_to_first_text_out: number | null;
  ms_prompt_to_last_text_out: number | null;
  tool_name?: string;
  tool_ms?: number;
  interrupted: boolean;
  tokens_out: number;
}

/**
 * The slice of AppConfig the agent receives. Declared structurally because config is built
 * after this contract locks; config's AppConfig must satisfy it (its tests assert so).
 */
export interface AgentSettings {
  SYSTEM_PROMPT: string;
  FALLBACK_MESSAGE: string;
  HANDOFF_MESSAGE: string;
  CLOSING_MESSAGE: string;
  AGENT_END_CALL: boolean;
  MAX_CALL_SECONDS: number;
  IDLE_TIMEOUT_SECONDS: number;
  MAX_CONCURRENT_CALLS: number;
  LLM_TIMEOUT_MS: number;
}

// --- Recent problems -----------------------------------------------------------------------

export type RecentProblemKind = 'ws_rejected' | 'llm_error' | 'webhook_failed' | 'chat_limit';

export interface RecentProblem {
  /** ISO timestamp, stamped by the buffer. */
  at: string;
  kind: RecentProblemKind;
  /** Redacted, value-free text for the status page. */
  detail: string;
  signedUrl?: string;
}

/**
 * The status page's ring buffer of the last 20 runtime events. The instance is owned by
 * status and created in src/main.ts; the interface lives here because agent and voice record
 * into it and neither may import status.
 */
export interface RecentProblems {
  record(entry: Omit<RecentProblem, 'at'>): void;
  /** Newest first. */
  list(): readonly RecentProblem[];
}

// --- Dependencies and registry -------------------------------------------------------------

export interface AgentDeps {
  llm: LlmClient;
  tools: ToolDefinition[];
  settings: AgentSettings;
  log: Logger;
  recent: RecentProblems;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export interface SessionSnapshot {
  state: SessionState;
  history: readonly LlmMessage[];
  timings: readonly TurnTiming[];
  toolResults: readonly ToolResult[];
}

export interface SessionRegistry {
  open: SessionFactory;
  size(): number;
  activeCalls(): number;
  snapshot(callSid: string): SessionSnapshot | undefined;
  /** Speak, then end live-agent-handoff/server_restart on every session; resolves within 8 s. */
  closeAll(cause: 'shutdown'): Promise<void>;
}
