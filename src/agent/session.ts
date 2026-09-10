/**
 * One call. Holds its history in memory, runs a turn when the caller finishes speaking, and ends
 * exactly once.
 *
 * Four invariants shape this file, and each has a test named after it:
 *
 * 1. Exactly one end per session. Timers, a tool, an LLM failure, a hangup and a shutdown can all
 *    race to end the same call; the first one wins and the rest are ignored.
 * 2. Nothing is spoken out of turn. Every utterance bumps a generation number, and no chunk from an
 *    older generation ever reaches the socket. That is what makes an interrupt sound instant.
 * 3. One tool call per turn, run once. A model that emits two calls gets the first one honoured.
 * 4. Exactly one turn.timing line per turn, so latency in the logs is countable.
 *
 * There is deliberately NO LLM timeout timer here. The client owns that budget, and a timer in the
 * agent would abort the request first, which the client would report as an interrupt: every real
 * timeout would then be invisible in the logs and no caller would hear the fallback line. The only
 * timers here are the call length, the caller going quiet, and a backstop for a stuck adapter.
 */
import type { Logger } from 'pino';
import { events } from '../log/index.js';
import type { LlmClient, LlmEvent, LlmMessage, LlmToolSpec } from '../llm/types.js';
import type {
  MergedFields,
  ToolDefinition,
  ToolResult,
  ToolSettings,
  WebhookStatus,
} from '../tools/types.js';
import type { AgentPort, CallInfo, CloseCause, VoiceOut } from '../voice/types.js';
import { buildHandoffData, END_POLICY, HANGUP_OUTCOME, type Spoken } from './endPolicy.js';
import type {
  AgentSettings,
  HandoffReason,
  Outcome,
  RecentProblems,
  SessionSnapshot,
  SessionState,
  TurnTiming,
} from './types.js';

/** Turns kept in history. Older ones are dropped; the system prompt is never dropped. */
export const HISTORY_TURN_CAP = 60;

/** Model steps per utterance. One reply, or one non-terminal tool and its follow-up, and stop. */
export const MAX_STEPS = 3;

/** How long out.end() gets before the session is torn down anyway. */
export const END_DEADLINE_MS = 5_000;

/** Grace past MAX_CALL_SECONDS after which the session is force-removed, leak or no leak. */
export const HARD_DEADLINE_GRACE_MS = 30_000;

export interface SessionDeps {
  info: CallInfo;
  out: VoiceOut;
  llm: LlmClient;
  /** The registry tools plus, when AGENT_END_CALL is on, the end_call capability. */
  tools: readonly ToolDefinition[];
  /** Both slices: the turn loop reads the agent's, and a tool receives the tools' own. */
  settings: AgentSettings & ToolSettings;
  log: Logger;
  recent: RecentProblems;
  now: () => number;
  /** Called once, on the single end path, so the registry can forget this call. */
  onEnded: (callSid: string) => void;
}

interface PendingInterrupt {
  generation: number;
  spoken: string;
}

export class CallSession implements AgentPort {
  private readonly deps: SessionDeps;
  private readonly log: Logger;
  private readonly startedMs: number;
  private readonly toolSpecs: readonly LlmToolSpec[];

  private state: SessionState = 'created';
  private generation = 0;
  private turn = 0;
  private abort: AbortController | undefined;
  private history: LlmMessage[] = [];
  private timings: TurnTiming[] = [];
  private toolResults: ToolResult[] = [];
  private pendingInterrupt: PendingInterrupt | undefined;
  private ending = false;
  private outcome: Outcome | undefined;

  private maxCallTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private hardDeadlineTimer: NodeJS.Timeout | undefined;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.log = deps.log.child({ callSid: deps.info.callSid });
    this.startedMs = deps.now();
    this.toolSpecs = deps.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    this.history.push({ role: 'system', content: deps.settings.SYSTEM_PROMPT });
    this.state = 'active';

    this.log.info(
      {
        event: events.callStarted,
        from: deps.info.from,
        to: deps.info.to,
        channel: deps.info.channel,
        provider: deps.llm.provider,
        model: deps.llm.model,
      },
      'call started',
    );

    this.armMaxCall();
    this.armIdle();
    this.armHardDeadline();
  }

  // --- AgentPort ------------------------------------------------------------------------------

  onUtterance(text: string): void {
    if (this.ending || this.state === 'ended') return;
    const said = text.trim();
    if (said === '') {
      this.armIdle();
      return;
    }
    void this.runTurn(said);
  }

  onInterrupt(utteranceUntilInterrupt: string): void {
    if (this.ending || this.state === 'ended') return;
    // Recorded against the running generation so the turn loop knows how much the caller heard.
    this.pendingInterrupt = { generation: this.generation, spoken: utteranceUntilInterrupt };
    this.abort?.abort();
    this.armIdle();
    this.log.debug({ event: 'turn.interrupted', turn: this.turn }, 'caller interrupted');
  }

  onDtmf(digit: string): void {
    // v1 logs and ignores: the flow that needs digits belongs in Studio, before the AI stage.
    this.log.debug({ event: 'call.dtmf', digit }, 'dtmf ignored');
  }

  onClose(cause: CloseCause): void {
    if (cause === 'caller_hangup') {
      // No end frame: the socket is already gone. Just stop and record it.
      void this.finish({ reason: null, outcome: HANGUP_OUTCOME });
      return;
    }
    void this.endBecause('transport_error');
  }

  // --- Lifecycle used by the registry ----------------------------------------------------------

  /** The shutdown path: speak, then hand the caller to a person. */
  endForShutdown(): Promise<void> {
    return this.endBecause('server_restart');
  }

  snapshot(): SessionSnapshot {
    return {
      state: this.state,
      history: [...this.history],
      timings: [...this.timings],
      toolResults: [...this.toolResults],
    };
  }

  get hasEnded(): boolean {
    return this.state === 'ended';
  }

  get channel(): CallInfo['channel'] {
    return this.deps.info.channel;
  }

  // --- The turn -------------------------------------------------------------------------------

  private async runTurn(said: string): Promise<void> {
    // A new utterance supersedes whatever was still streaming: barge-in without an interrupt frame.
    this.abort?.abort();
    const generation = ++this.generation;
    this.turn += 1;
    const turn = this.turn;
    const controller = new AbortController();
    this.abort = controller;
    this.armIdle();

    this.pushHistory({ role: 'user', content: said });
    this.log.debug({ event: 'turn.utterance', turn, text: said }, 'caller said');

    const t0 = this.deps.now();
    const timing: TurnTiming = {
      turn,
      ms_prompt_to_llm_first_token: null,
      ms_llm_first_to_complete: null,
      ms_prompt_to_first_text_out: null,
      ms_prompt_to_last_text_out: null,
      interrupted: false,
      tokens_out: 0,
    };

    let spokenThisTurn = '';
    let failure: HandoffReason | undefined;
    let terminalResult: { tool: ToolDefinition; result: ToolResult; ms: number } | undefined;

    for (let step = 1; step <= MAX_STEPS; step += 1) {
      let firstTokenMs: number | undefined;
      let completeMs: number | undefined;
      let stepText = '';
      /** Single-flight: only the first tool call of a step is honoured. */
      let call: { toolCallId: string; name: string; input: unknown } | undefined;
      let errored: HandoffReason | undefined;

      for await (const event of this.deps.llm.stream({
        messages: this.history,
        tools: [...this.toolSpecs],
        signal: controller.signal,
        timeoutMs: this.deps.settings.LLM_TIMEOUT_MS,
        stallMs: this.deps.settings.LLM_TIMEOUT_MS,
      })) {
        // Superseded or ending: stop reading and speak nothing more for this generation.
        if (generation !== this.generation || this.ending) break;

        const handled = this.handleEvent(event, {
          generation,
          timing,
          t0,
          onText: (text) => {
            stepText += text;
            spokenThisTurn += text;
          },
          onFirstToken: (at) => {
            firstTokenMs ??= at;
          },
          onComplete: (at) => {
            completeMs = at;
          },
          onToolCall: (c) => {
            call ??= c;
          },
        });
        if (handled !== undefined) {
          errored = handled;
          break;
        }
      }

      if (firstTokenMs !== undefined) {
        timing.ms_prompt_to_llm_first_token ??= firstTokenMs - t0;
        if (completeMs !== undefined) timing.ms_llm_first_to_complete = completeMs - firstTokenMs;
      }

      if (generation !== this.generation || this.ending) return;

      if (errored !== undefined) {
        failure = errored;
        break;
      }

      // The assistant's own words go into history before any tool result, in the order they happened.
      if (stepText !== '') this.pushHistory({ role: 'assistant', content: stepText });

      const toolCall = call;
      if (toolCall === undefined) break;

      const tool = this.deps.tools.find((t) => t.name === toolCall.name);
      if (tool === undefined) {
        // A model naming a tool that does not exist is a prompt problem, not a caller problem.
        this.log.warn({ event: events.toolCalled, tool: toolCall.name, ok: false }, 'unknown tool');
        this.pushHistory({
          role: 'tool',
          content: `There is no tool called ${toolCall.name}.`,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.name,
        });
        continue;
      }

      const ran = await this.runTool(tool, toolCall);
      timing.tool_name = tool.name;
      timing.tool_ms = ran.ms;

      if (ran.kind === 'threw') {
        failure = 'llm_error';
        break;
      }

      if (ran.kind === 'refused') {
        this.pushHistory({
          role: 'tool',
          content: ran.modelText,
          toolCallId: toolCall.toolCallId,
          toolName: tool.name,
        });
        continue;
      }

      this.toolResults.push(ran.result);

      if (tool.terminal) {
        terminalResult = { tool, result: ran.result, ms: ran.ms };
        break;
      }

      this.pushHistory({
        role: 'tool',
        content: ran.result.modelText,
        toolCallId: toolCall.toolCallId,
        toolName: tool.name,
      });
    }

    if (generation !== this.generation || this.ending) return;

    // The interrupt, if one landed on this generation, decides what history says the caller heard.
    this.applyInterrupt(generation, timing, spokenThisTurn);

    const saidSomething = spokenThisTurn.trim() !== '';
    const end = terminalResult?.result.end;
    /**
     * A handoff whose turn was silent would drop the caller into dead air while the transfer
     * happens, so the bundled line becomes this turn's speech rather than an extra utterance.
     */
    const bridging =
      !saidSomething && end !== undefined && END_POLICY[end.reason].spoken === 'handoff'
        ? this.deps.settings.HANDOFF_MESSAGE
        : '';

    // ConversationRelay needs exactly one frame with last:true to finish an utterance, and none at
    // all when the turn had nothing to say: on those paths the end policy does the speaking.
    if (!timing.interrupted && (saidSomething || bridging !== '')) {
      this.say(bridging, true, generation);
    }

    this.emitTiming(timing);

    if (failure !== undefined) {
      await this.endBecause(failure);
      return;
    }

    if (terminalResult !== undefined) {
      if (end === undefined) {
        await this.endBecause('agent_end_call');
        return;
      }
      await this.endBecause(end.reason, {
        summary: end.summary,
        webhook: end.webhook,
        fields: end.fields,
      });
    }
  }

  /** Invariant 4: exactly one of these per turn. Kept in memory only for the test chat. */
  private emitTiming(timing: TurnTiming): void {
    if (this.deps.info.channel === 'textchat') this.timings.push(timing);
    this.log.info({ event: events.turnTiming, ...timing }, 'turn');
  }

  /** Returns a failure reason when the stream ended badly, otherwise undefined. */
  private handleEvent(
    event: LlmEvent,
    ctx: {
      generation: number;
      timing: TurnTiming;
      t0: number;
      onText: (text: string) => void;
      onFirstToken: (at: number) => void;
      onComplete: (at: number) => void;
      onToolCall: (call: { toolCallId: string; name: string; input: unknown }) => void;
    },
  ): HandoffReason | undefined {
    switch (event.type) {
      case 'text-delta': {
        const at = this.deps.now();
        ctx.onFirstToken(at);
        ctx.onText(event.text);
        ctx.timing.tokens_out += 1;
        // Measured at the send call, which is the moment the adapter hands the frame to the socket.
        ctx.timing.ms_prompt_to_first_text_out ??= at - ctx.t0;
        ctx.timing.ms_prompt_to_last_text_out = at - ctx.t0;
        this.say(event.text, false, ctx.generation);
        return undefined;
      }
      case 'tool-call': {
        ctx.onToolCall({ toolCallId: event.toolCallId, name: event.name, input: event.input });
        return undefined;
      }
      case 'finish': {
        ctx.onComplete(this.deps.now());
        return undefined;
      }
      case 'error': {
        // An abort is our own doing (an interrupt, a new utterance, or an end already under way),
        // so it is never a fault to report.
        if (event.error.kind === 'aborted') return undefined;
        this.log.warn(
          { event: 'llm.error', error_kind: event.error.kind, status: event.error.status },
          event.error.message,
        );
        this.deps.recent.record({
          kind: 'llm_error',
          detail: `${event.error.kind}: ${event.error.message}`,
        });
        return event.error.kind === 'timeout' ? 'llm_timeout' : 'llm_error';
      }
    }
  }

  /**
   * Three outcomes, and they are not the same thing. 'ran' is the tool's own answer. 'refused' is a
   * model mistake the model can recover from, so the call carries on and it is told what happened;
   * ending a call because a model sent a bad argument would be its own bug. 'threw' is our bug, and
   * the caller gets a person rather than paying for it.
   */
  private async runTool(
    tool: ToolDefinition,
    call: { toolCallId: string; name: string; input: unknown },
  ): Promise<
    | { kind: 'ran'; result: ToolResult; ms: number }
    | { kind: 'refused'; modelText: string; ms: number }
    | { kind: 'threw'; ms: number }
  > {
    const startedMs = this.deps.now();
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      this.log.warn(
        { event: events.toolCalled, tool: tool.name, ms: 0, ok: false },
        'tool input did not match its schema',
      );
      return {
        kind: 'refused',
        modelText: `The ${tool.name} tool was called with arguments it cannot use. Check the arguments and try again.`,
        ms: 0,
      };
    }

    try {
      const result = await tool.run(parsed.data, {
        call: this.deps.info,
        history: this.history,
        settings: this.deps.settings,
        log: this.log,
        signal: this.abort?.signal ?? new AbortController().signal,
      });
      const ms = this.deps.now() - startedMs;
      this.log.info({ event: events.toolCalled, tool: tool.name, ms, ok: true }, 'tool ran');
      return { kind: 'ran', result, ms };
    } catch (err) {
      const ms = this.deps.now() - startedMs;
      this.log.error(
        { event: events.toolCalled, tool: tool.name, ms, ok: false, err },
        'tool threw',
      );
      return { kind: 'threw', ms };
    }
  }

  private applyInterrupt(generation: number, timing: TurnTiming, spoken: string): void {
    const interrupt = this.pendingInterrupt;
    if (interrupt === undefined || interrupt.generation !== generation) return;
    this.pendingInterrupt = undefined;
    timing.interrupted = true;

    // History should say what the caller actually heard. Twilio reports the words it managed to
    // speak; when that is a prefix of what we sent, it is the truth, so use it.
    const heard = interrupt.spoken.trim();
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const message = this.history[i];
      if (message?.role !== 'assistant') continue;
      if (heard !== '' && spoken.startsWith(heard)) message.content = heard;
      else if (heard !== '') message.content = heard;
      else this.history.splice(i, 1);
      break;
    }
  }

  // --- Speaking -------------------------------------------------------------------------------

  /** Never speaks for an older generation: invariant 2. */
  private say(text: string, last: boolean, generation: number): void {
    if (generation !== this.generation) return;
    if (this.state === 'ended') return;
    this.deps.out.say({ text, last, turn: generation, interruptible: true });
  }

  // --- Ending ---------------------------------------------------------------------------------

  /**
   * The single end path. Invariant 1 lives here: the first caller through the door wins, and every
   * later one returns without doing anything.
   */
  private async endBecause(
    reason: HandoffReason,
    over: { summary?: string; webhook?: WebhookStatus; fields?: MergedFields } = {},
  ): Promise<void> {
    if (this.ending || this.state === 'ended') return;
    this.ending = true;
    this.state = 'ending';
    this.clearTimers();

    const policy = END_POLICY[reason];
    // A new generation, so nothing still in flight from the last turn can be spoken after this.
    const generation = ++this.generation;
    this.abort?.abort();

    const line = this.spokenLine(policy.spoken);
    if (line !== undefined) {
      this.deps.out.say({ text: line, last: true, turn: generation, interruptible: false });
    }

    const data = buildHandoffData({
      reason,
      summary: over.summary ?? this.spokenSummary(),
      callSid: this.deps.info.callSid,
      from: this.deps.info.from,
      to: this.deps.info.to,
      startedAt: this.deps.info.startedAt,
      durationSec: Math.max(0, Math.round((this.deps.now() - this.startedMs) / 1000)),
      webhook: over.webhook ?? 'skipped',
      ...(over.fields === undefined ? {} : { fields: over.fields }),
    });

    // A stuck adapter must not keep the session, and its timers, alive.
    await Promise.race([
      this.deps.out.end(data).catch((err: unknown) => {
        this.log.warn({ event: 'call.end_failed', err }, 'could not send the end frame');
      }),
      new Promise<void>((resolve) => setTimeout(resolve, END_DEADLINE_MS).unref()),
    ]);

    await this.finish({ reason, outcome: policy.outcome });
  }

  /** Records the outcome and lets the registry forget this call. Runs once. */
  private finish(input: { reason: HandoffReason | null; outcome: Outcome }): Promise<void> {
    if (this.state === 'ended') return Promise.resolve();
    this.state = 'ended';
    this.ending = true;
    this.clearTimers();
    this.abort?.abort();
    this.outcome = input.outcome;

    this.log.info(
      {
        event: events.callEnded,
        outcome: input.outcome,
        reason: input.reason,
        duration_ms: this.deps.now() - this.startedMs,
        turns: this.turn,
        rss_mb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
      },
      'call ended',
    );

    this.deps.onEnded(this.deps.info.callSid);
    return Promise.resolve();
  }

  private spokenLine(spoken: Spoken): string | undefined {
    switch (spoken) {
      case 'closing':
        return this.deps.settings.CLOSING_MESSAGE;
      case 'fallback':
        return this.deps.settings.FALLBACK_MESSAGE;
      // The handoff line is spoken by the turn loop only when the model said nothing itself, so it
      // is not repeated here.
      case 'handoff':
      case 'none':
        return undefined;
    }
  }

  /** Something for a person picking the call up, when no tool supplied a summary. */
  private spokenSummary(): string {
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const message = this.history[i];
      if (message?.role === 'user') return message.content.slice(0, 200);
    }
    return 'The call ended before the caller said anything.';
  }

  // --- Timers ---------------------------------------------------------------------------------

  private armMaxCall(): void {
    clearTimeout(this.maxCallTimer);
    this.maxCallTimer = setTimeout(() => {
      void this.endBecause('max_call_seconds');
    }, this.deps.settings.MAX_CALL_SECONDS * 1000);
    this.maxCallTimer.unref();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.endBecause('idle');
    }, this.deps.settings.IDLE_TIMEOUT_SECONDS * 1000);
    this.idleTimer.unref();
  }

  /**
   * The backstop. If anything above fails to end the call, this removes the session so a leak
   * cannot occupy a slot for the life of the process.
   */
  private armHardDeadline(): void {
    clearTimeout(this.hardDeadlineTimer);
    this.hardDeadlineTimer = setTimeout(
      () => {
        if (this.state === 'ended') return;
        this.log.error(
          { event: 'call.force_removed', turns: this.turn },
          'session outlived its deadline',
        );
        void this.finish({ reason: null, outcome: 'error' });
      },
      this.deps.settings.MAX_CALL_SECONDS * 1000 + HARD_DEADLINE_GRACE_MS,
    );
    this.hardDeadlineTimer.unref();
  }

  private clearTimers(): void {
    clearTimeout(this.maxCallTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.hardDeadlineTimer);
  }

  // --- History --------------------------------------------------------------------------------

  /** The only way history grows, so the cap below is never bypassed. */
  private pushHistory(message: LlmMessage): void {
    this.history.push(message);
    this.trimHistory();
  }

  /** Keeps the system prompt and the most recent turns; the middle of a long call is dropped. */
  private trimHistory(): void {
    const overBy = this.history.length - 1 - HISTORY_TURN_CAP;
    if (overBy > 0) this.history.splice(1, overBy);
  }

  /** For the test chat, which shows the outcome of a finished conversation. */
  get endedOutcome(): Outcome | undefined {
    return this.outcome;
  }
}
