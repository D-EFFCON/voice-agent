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
 * 5. A terminal tool runs at most once per call. Its side effect leaves the process, so once one
 *    starts the call is committed and nothing the caller does can reach a second one.
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

/**
 * Characters of conversation kept in history, the system prompt excluded. The turn cap bounds how
 * many messages go to the model on each turn but says nothing about how big they are, and every
 * turn resends the lot. This bounds what one long call can cost and how slow its last turn is.
 */
export const HISTORY_CHAR_CAP = 24_000;

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

/**
 * One turn, kept after the turn loop has gone. Twilio interrupts playback rather than generation,
 * and playback outlives generation, so an interrupt frame can arrive with nobody left to act on it;
 * it is also why the turn's history entry is held by reference rather than looked up later, when
 * the newest assistant message may well belong to a different turn.
 */
interface TurnRecord {
  generation: number;
  timing: TurnTiming;
  /** The history entry this turn's words went into, if it said any. */
  assistant: LlmMessage | undefined;
  /** False once something else has been pushed after it, so the next words open a new entry. */
  assistantOpen: boolean;
  /** Everything handed to the voice for this turn, which an interrupt report is checked against. */
  spoken: string;
  /** The turn loop is still running, so it will do the finalising itself. */
  generating: boolean;
  /** The assistant entry carrying a call this turn has not pushed a result for yet. */
  pendingCall: LlmMessage | undefined;
  /** Invariant 4: the timing line goes out exactly once. */
  timed: boolean;
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
  /** The newest turn, running or finished. A late interrupt has nothing else to aim at. */
  private current: TurnRecord | undefined;
  private ending = false;
  /** Invariant 5: set the moment a terminal tool starts, never cleared. */
  private handingOff = false;
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
    if (this.ending || this.handingOff || this.state === 'ended') return;
    const said = text.trim();
    if (said === '') {
      this.armIdle();
      return;
    }
    void this.runTurn(said);
  }

  onInterrupt(utteranceUntilInterrupt: string): void {
    if (this.ending || this.handingOff || this.state === 'ended') return;
    // Recorded against the running generation so the turn loop knows how much the caller heard.
    this.pendingInterrupt = { generation: this.generation, spoken: utteranceUntilInterrupt };
    this.abort?.abort();
    this.armIdle();
    this.log.debug({ event: 'turn.interrupted', turn: this.turn }, 'caller interrupted');

    const record = this.current;
    if (record === undefined) return;

    /**
     * Rewritten here rather than left to the aborted turn loop, which only resumes a tick or more
     * later. Twilio can deliver the interrupt and the caller's next words in one batch of frames,
     * and the request for those words is built from this.history the moment they arrive: every
     * word the caller talked over would go to the model as a word they had heard.
     */
    this.applyInterrupt(record);

    // Twilio interrupts the speaking, not the generating, and the speaking outlasts it: an
    // interrupt routinely arrives after the turn loop has finished and gone. Nothing would come
    // back for it, and the turn's latency would never reach the logs.
    if (!record.generating) this.finalizeTurn(record);
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
    /**
     * The superseded turn may have left a call in history whose result is still being waited on,
     * and it will not be back to finish the pair before the request below goes out. A provider
     * refuses a prompt whose call has no result - the SDK raises MissingToolResultsError and the
     * call dies on the caller's next word - so the call goes now, and the result that arrives
     * behind it is dropped as the widow it has become.
     */
    if (this.current !== undefined) this.dropUnansweredCall(this.current);
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
    const record: TurnRecord = {
      generation,
      timing,
      assistant: undefined,
      assistantOpen: false,
      spoken: '',
      generating: true,
      pendingCall: undefined,
      timed: false,
    };
    this.current = record;

    let failure: HandoffReason | undefined;
    let terminalResult: { tool: ToolDefinition; result: ToolResult; ms: number } | undefined;

    for (let step = 1; step <= MAX_STEPS; step += 1) {
      // Superseded or ending, most likely while the tool above ran. There is nobody left to
      // speak to, so the next step is not worth a request the answer to which is discarded.
      if (generation !== this.generation || this.ending) break;

      let firstTokenMs: number | undefined;
      let completeMs: number | undefined;
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
          record,
          t0,
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

      // Superseded or ending. Not a return: the turn still has to be finalised below, or an
      // interrupt that landed on it is never applied and its latency never reaches the logs.
      if (generation !== this.generation || this.ending) break;

      if (errored !== undefined) {
        failure = errored;
        break;
      }

      const toolCall = call;
      if (toolCall === undefined) break;

      /**
       * The call goes onto this turn's own assistant entry, or onto a new empty one when the model
       * called the tool without saying anything first. A provider refuses a tool result whose call
       * it cannot see, so from here on the two travel together.
       */
      this.recordToolCall(record, toolCall);

      const tool = this.deps.tools.find((t) => t.name === toolCall.name);
      if (tool === undefined) {
        // A model naming a tool that does not exist is a prompt problem, not a caller problem.
        this.log.warn({ event: events.toolCalled, tool: toolCall.name, ok: false }, 'unknown tool');
        this.pushToolResult(record, {
          role: 'tool',
          content: `There is no tool called ${toolCall.name}.`,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.name,
        });
        continue;
      }

      /**
       * Arguments are checked before the commit below, not inside runTool, and that order is the
       * whole point. Bad arguments are a model mistake the model recovers from, so the turn carries
       * on and it is told what happened; committing the call to a handoff over one would strand the
       * caller, because from that moment onUtterance ignores every word they say.
       */
      const parsed = tool.inputSchema.safeParse(toolCall.input);
      if (!parsed.success) {
        this.log.warn(
          { event: events.toolCalled, tool: tool.name, ms: 0, ok: false },
          'tool input did not match its schema',
        );
        timing.tool_name = tool.name;
        timing.tool_ms = 0;
        this.pushToolResult(record, {
          role: 'tool',
          content: `The ${tool.name} tool was called with arguments it cannot use. Check the arguments and try again.`,
          toolCallId: toolCall.toolCallId,
          toolName: tool.name,
        });
        continue;
      }

      /**
       * Invariant 5. A terminal tool hands the caller to a person, and its side effect - the
       * webhook post - cannot be called back once it is in flight. Aborting the request does not
       * un-send it. So the call commits here, before the await: a new utterance or an interrupt
       * arriving mid-post can no longer abort this tool, supersede this turn and let the model
       * reach the same tool a second time, which would have notified the team twice.
       */
      if (tool.terminal) this.handingOff = true;

      const ran = await this.runTool(tool, parsed.data);
      timing.tool_name = tool.name;
      timing.tool_ms = ran.ms;

      if (ran.kind === 'threw') {
        failure = 'llm_error';
        break;
      }

      this.toolResults.push(ran.result);

      if (tool.terminal) {
        terminalResult = { tool, result: ran.result, ms: ran.ms };
        break;
      }

      this.pushToolResult(record, {
        role: 'tool',
        content: ran.result.modelText,
        toolCallId: toolCall.toolCallId,
        toolName: tool.name,
      });
    }

    record.generating = false;

    if (generation !== this.generation || this.ending) {
      // Superseded, or the call is already ending. Nothing more may be spoken for this generation
      // and there is no ending left to decide, but the turn did happen: what the caller heard of it
      // and how long it took are still owed.
      this.finalizeTurn(record);
      return;
    }

    // The interrupt, if one landed on this generation, decides what history says the caller heard.
    this.applyInterrupt(record);

    const saidSomething = record.spoken.trim() !== '';
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

    this.finalizeTurn(record);

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

  /**
   * Everything a turn still owes once it stops generating, on whichever path gets here first: the
   * turn loop finishing, the turn loop finding itself superseded, or an interrupt arriving after
   * the loop has gone. Each part runs at most once per turn.
   */
  private finalizeTurn(record: TurnRecord): void {
    this.applyInterrupt(record);
    // Words entered history as they were spoken rather than through pushHistory, so the caps get
    // their one look at the finished turn here.
    this.trimHistory();
    this.emitTiming(record);
  }

  /** Invariant 4: exactly one of these per turn. Kept in memory only for the test chat. */
  private emitTiming(record: TurnRecord): void {
    if (record.timed) return;
    record.timed = true;
    if (this.deps.info.channel === 'textchat') this.timings.push(record.timing);
    this.log.info({ event: events.turnTiming, ...record.timing }, 'turn');
  }

  /**
   * The turn's words go into history as they are spoken rather than in one push at the end of the
   * step. That is what lets a turn the caller talks over leave behind what they did hear: the entry
   * is already in place, and in the right place, before the next utterance pushes its own message.
   */
  private appendAssistant(record: TurnRecord, text: string): void {
    record.spoken += text;
    this.openAssistant(record).content += text;
  }

  /** This turn's open assistant entry, opening a new one when the last was closed behind it. */
  private openAssistant(record: TurnRecord): LlmMessage {
    const open = record.assistantOpen ? record.assistant : undefined;
    if (open !== undefined) return open;
    const entry: LlmMessage = { role: 'assistant', content: '' };
    record.assistant = entry;
    record.assistantOpen = true;
    this.pushHistory(entry);
    return entry;
  }

  /** Records the call on the assistant entry, so the result that answers it is never unpaired. */
  private recordToolCall(
    record: TurnRecord,
    call: { toolCallId: string; name: string; input: unknown },
  ): void {
    const entry = this.openAssistant(record);
    entry.toolCallId = call.toolCallId;
    entry.toolName = call.name;
    entry.toolInput = call.input;
    // Closed here: what comes next is the result, not more speech.
    record.assistantOpen = false;
    record.pendingCall = entry;
  }

  /** The result for the call this turn made. Pushing it is what completes the pair. */
  private pushToolResult(record: TurnRecord, message: LlmMessage): void {
    record.pendingCall = undefined;
    this.pushHistory(message);
  }

  /**
   * The other half of dropUnpairedToolResults, for the half that goes missing the other way round:
   * a call whose result is still being waited on when the caller speaks again. The two are never
   * both in flight - this one runs before the next request, and the late result is a widow by the
   * time it arrives, which trimHistory then drops.
   *
   * A turn that spoke before calling keeps its words: the caller heard them.
   */
  private dropUnansweredCall(record: TurnRecord): void {
    const entry = record.pendingCall;
    if (entry === undefined) return;
    record.pendingCall = undefined;
    delete entry.toolCallId;
    delete entry.toolName;
    delete entry.toolInput;
    if (entry.content !== '') return;
    const at = this.history.indexOf(entry);
    if (at !== -1) this.history.splice(at, 1);
    if (record.assistant === entry) {
      record.assistant = undefined;
      record.assistantOpen = false;
    }
  }

  /** Returns a failure reason when the stream ended badly, otherwise undefined. */
  private handleEvent(
    event: LlmEvent,
    ctx: {
      record: TurnRecord;
      t0: number;
      onFirstToken: (at: number) => void;
      onComplete: (at: number) => void;
      onToolCall: (call: { toolCallId: string; name: string; input: unknown }) => void;
    },
  ): HandoffReason | undefined {
    const timing = ctx.record.timing;
    switch (event.type) {
      case 'text-delta': {
        // The caller talked over this turn and history already says what they heard. What is still
        // draining out of the aborted stream never reached the ear, so it is neither spoken nor
        // written: appending it would grow the entry straight back past the truncation.
        if (timing.interrupted) return undefined;
        const at = this.deps.now();
        ctx.onFirstToken(at);
        this.appendAssistant(ctx.record, event.text);
        timing.tokens_out += 1;
        // Measured at the send call, which is the moment the adapter hands the frame to the socket.
        timing.ms_prompt_to_first_text_out ??= at - ctx.t0;
        timing.ms_prompt_to_last_text_out = at - ctx.t0;
        this.say(event.text, false, ctx.record.generation);
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
   * Two outcomes. 'ran' is the tool's own answer. 'threw' is our bug, and the caller gets a person
   * rather than paying for it. Arguments that do not match the schema never reach here: the turn
   * loop refuses them before the call is committed, because ending a call, or committing it to a
   * handoff, because a model sent a bad argument would be its own bug.
   */
  private async runTool(
    tool: ToolDefinition,
    input: unknown,
  ): Promise<{ kind: 'ran'; result: ToolResult; ms: number } | { kind: 'threw'; ms: number }> {
    const startedMs = this.deps.now();
    try {
      const result = await tool.run(input, {
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

  private applyInterrupt(record: TurnRecord): void {
    const interrupt = this.pendingInterrupt;
    if (interrupt === undefined || interrupt.generation !== record.generation) return;
    // Taking it is what makes this idempotent: whichever path gets here first does the rewriting,
    // and a later pass over the same turn finds nothing left to apply.
    this.pendingInterrupt = undefined;
    record.timing.interrupted = true;

    // History should say what the caller actually heard, not everything the model produced.
    // Twilio reports the words it managed to speak, and that report is the better account of what
    // reached the ear either way, so it is what gets written.
    //
    // It is normally a prefix of what we sent. When it is not - text normalisation rewriting a
    // number on its way to the voice is the usual cause - the report and our text have diverged,
    // and that is worth a line, because it is the one thing that would put this truncation in the
    // wrong place and it is otherwise invisible. It is logged rather than acted on: the words
    // Twilio spoke are still closer to the truth than the full text the caller plainly did not
    // hear, since they interrupted it.
    const heard = interrupt.spoken.trim();
    if (heard !== '' && !record.spoken.startsWith(heard)) {
      this.log.debug(
        { event: 'turn.interrupted', turn: record.timing.turn, spoken_prefix: false },
        'the words Twilio reported speaking are not a prefix of the words sent',
      );
    }

    // This turn's own entry, held by reference. Searching back for the newest assistant message
    // would find a different turn's words as soon as an interrupt arrives a moment late.
    const entry = record.assistant;
    if (entry === undefined) return;
    if (heard !== '') {
      entry.content = heard;
      return;
    }
    // None of it reached the ear, so the entry goes - unless it carries the call a tool result
    // below answers, which would leave that result unpaired.
    if (entry.toolCallId !== undefined) {
      entry.content = '';
      return;
    }
    const at = this.history.indexOf(entry);
    if (at !== -1) this.history.splice(at, 1);
    record.assistant = undefined;
    record.assistantOpen = false;
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
    // Anything pushed behind the turn's words closes that entry: whatever the model says next
    // belongs after this message rather than appended to the one before it.
    const record = this.current;
    if (record !== undefined && message !== record.assistant) record.assistantOpen = false;
    this.history.push(message);
    this.trimHistory();
  }

  /** Keeps the system prompt and the most recent turns; the middle of a long call is dropped. */
  private trimHistory(): void {
    const overBy = this.history.length - 1 - HISTORY_TURN_CAP;
    if (overBy > 0) this.history.splice(1, overBy);

    // Then by size, oldest first. The newest message is always kept, however long it is: the
    // caller just said it, and the wire already cut it to UTTERANCE_MAX_CHARS.
    let chars = 0;
    for (let i = 1; i < this.history.length; i += 1) chars += this.history[i]?.content.length ?? 0;
    while (chars > HISTORY_CHAR_CAP && this.history.length > 2) {
      chars -= this.history[1]?.content.length ?? 0;
      this.history.splice(1, 1);
    }

    this.dropUnpairedToolResults();
  }

  /**
   * Both caps work from the oldest message forward and know nothing about pairs, so either can drop
   * the assistant message that made a call and leave the result standing behind it. A provider
   * refuses a tool result whose call it cannot see, and that refusal costs the whole turn rather
   * than the one line of context, so the widow goes with it.
   */
  private dropUnpairedToolResults(): void {
    const calls = new Set<string>();
    for (let i = 0; i < this.history.length; i += 1) {
      const message = this.history[i];
      if (message === undefined) continue;
      if (message.role === 'assistant') {
        if (message.toolCallId !== undefined) calls.add(message.toolCallId);
        continue;
      }
      if (message.role !== 'tool') continue;
      if (message.toolCallId !== undefined && calls.has(message.toolCallId)) continue;
      this.history.splice(i, 1);
      i -= 1;
    }
  }

  /** For the test chat, which shows the outcome of a finished conversation. */
  get endedOutcome(): Outcome | undefined {
    return this.outcome;
  }
}
