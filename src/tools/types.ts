/**
 * Tool seam (agent core <-> tools) and the automation client contract.
 *
 * Locked at foundation:seam-contracts-and-test-doubles. Features build against this file and
 * never edit it (ADR 0003). Cross-seam references are type-only imports of other seam files,
 * which the architecture test allows from every module except src/llm.
 */
import type { Logger } from 'pino';
import type { ZodType } from 'zod';
import type { HandoffReason, HandoffReasonCode } from '../agent/types.js';
import type { LlmMessage } from '../llm/types.js';
import type { CallInfo } from '../voice/types.js';

/**
 * The slice of AppConfig tools receive. Declared structurally because config is built after
 * this contract locks; config's AppConfig must satisfy it.
 */
export interface ToolSettings {
  HANDOFF_INCLUDE_TRANSCRIPT: boolean;
  HANDOFF_INCLUDE_PROMPT: boolean;
  AUTOMATION_TIMEOUT_MS: number;
}

export interface ToolContext {
  call: CallInfo;
  /** The provider id and model the call is running on, as LlmClient reports them. */
  llm: { provider: string; model: string };
  history: readonly LlmMessage[];
  settings: ToolSettings;
  log: Logger;
  signal: AbortSignal;
}

export type WebhookStatus = 'ok' | 'ack' | 'failed' | 'timeout' | 'skipped';

/** The allowlist of keys a webhook response may add to HandoffData. Each value <= 200 chars. */
export type MergedFieldKey = 'transfer_to' | 'ticket_id' | 'note';

export type MergedFields = Partial<Record<MergedFieldKey, string>>;

export interface ToolResult {
  /** What the model is told the tool returned. */
  modelText: string;
  /** Present when the tool ends the call. */
  end?: {
    reasonCode: HandoffReasonCode;
    reason: HandoffReason;
    summary?: string;
    webhook?: WebhookStatus;
    fields?: MergedFields;
  };
}

export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<I>;
  /** A terminal tool ends the call after it runs. */
  terminal: boolean;
  /** Never throws. */
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export type AutomationPresetId = 'none' | 'make' | 'zapier' | 'n8n';

export type AutomationResponseMode = 'merge-json' | 'ack-only' | 'none';

export interface AutomationPreset {
  id: AutomationPresetId;
  label: string;
  /** Header that carries AUTOMATION_WEBHOOK_KEY unless AUTOMATION_WEBHOOK_KEY_HEADER overrides it. */
  defaultKeyHeader: string | null;
  responseMode: AutomationResponseMode;
  /** One or two plain sentences for the README and the status page. */
  docsHint: string;
}

/** Posted to AUTOMATION_WEBHOOK_URL. Additive-only under v: 1 (ADR 0002). Caller-derived text. */
export interface HandoffPayload {
  v: 1;
  event: 'handoff' | 'test';
  callSid: string;
  from: string;
  to: string;
  channel: 'conversationrelay' | 'textchat';
  startedAt: string;
  requestedAt: string;
  durationSec: number;
  /** <= 200 chars. */
  reason: string;
  /** <= 1000 chars, control characters stripped. */
  summary: string;
  /** Studio customParameters. */
  custom?: Record<string, string>;
  /** Only when HANDOFF_INCLUDE_TRANSCRIPT=true. */
  transcript?: { role: 'user' | 'assistant'; text: string }[];
  /** The LLM provider id the call ran on. */
  provider: string;
  /** The model the call ran on. */
  model: string;
  /** Only when HANDOFF_INCLUDE_PROMPT=true. The deployer's SYSTEM_PROMPT, verbatim. */
  systemPrompt?: string;
}

export interface AutomationPostResult {
  status: WebhookStatus;
  httpStatus?: number;
  fields: MergedFields;
  /** Plain English, never a value. */
  error?: string;
  ms: number;
}

export interface AutomationClient {
  /** Never throws. */
  post(payload: HandoffPayload, signal?: AbortSignal): Promise<AutomationPostResult>;
}
