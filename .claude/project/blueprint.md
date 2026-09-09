# Blueprint — voice-server
Status: Approved 2026-09-09

Source: /build front half, run wf_aecb5d46-33f (discovery PM; domain, pragmatic and risk architects; synthesis judge). Approved at the human gate on 2026-09-09 with the resolutions recorded in the last section. Decisions link to docs/adr/.

## Overview
One Node 24 / TypeScript-strict Fastify service on a single Railway instance with no persistence, arranged as one-directional modules: config, log and security are leaves; llm and tools are seams that each expose a types file plus a static registry array; agent is the domain core (in-memory CallSession, generation-numbered streaming turns, single-flight tool execution, guards, a fixed end policy) and imports only seam types; voice adapters (ConversationRelay now, text-chat for the status page, Media Streams later) translate wire protocols onto the agent's session API; status renders the page; src/main.ts is the only composition root. The process always boots into degraded mode with value-free, plain-English ConfigProblems (blocking or warning) so the status page can explain any fault, and GET /health is always 200. Every WebSocket upgrade passes one fixed gate (path secret -> readiness -> Twilio signature over the wss URL -> capacity -> setup within 5 s); every rejection is logged with the exact URL the server signed and shown on a token-gated status page that also carries self-check facts, a recent-problems buffer, a self-test and a test chat driving the real core. Contracts that live in deployer-owned systems (env vars, HandoffData read by Studio, the webhook payload read by Make/Zapier/n8n) are versioned and additive-only, and the Railway template deploys from a release branch, never main. Adding a provider, tool or adapter is one file plus one registry line, fenced by an architecture test over import specifiers.

## Components
### config (src/config/)
Declares every env var once as an EnvSpec (key, description, required rule, default, secret flag, parser, valid values, setBy railway); loadConfig(env, catalogs) never throws and returns a frozen AppConfig (invalid values fall back to defaults), ConfigProblem[] with severity blocking|warning built by helpers that never receive the value, ready, publicHost (PUBLIC_HOST ?? RAILWAY_PUBLIC_DOMAIN) with hostSource, wssUrl, the signature URL variants and the list of secret values for log scrubbing. Valid LLM_PROVIDER/AUTOMATION_PROVIDER values and provider key names come from the llm registry and preset catalog metadata so a new provider needs no config edit. scripts/docs-env.ts generates .env.example and the README env table from the specs; --check fails CI on drift. A table-driven test covers every fault named in the success criteria with its exact message and severity.

Depends on: llm (src/llm/) registry metadata only; tools (src/tools/) preset catalog metadata only

### log (src/log/)
pino JSON to stdout at LOG_LEVEL; redaction by path (authorization, every secret config key) and by value (a formatter that replaces any registered secret value inside any string field with [redacted], covering SDK errors that echo headers); forCall(callSid) child loggers; event-name constants; utterance and model text only at debug so default logs carry timings and outcomes, not transcripts; Fastify request logging disabled so query strings never reach logs.

Depends on: config (src/config/)

### security (src/security/)
safeEqual (timingSafeEqual on equal-length buffers); Twilio signature validation, hand-rolled base64(HMAC-SHA1(TWILIO_AUTH_TOKEN, url)) tried over the documented variant set (wss and https scheme, with and without :443) returning which variant matched; UpgradeGate composing the fixed rejection order with plain-English messages and the signed URL; status-token one-time query-to-cookie exchange; security headers (no-store, nonce CSP, frame deny, no-referrer, nosniff); @fastify/rate-limit registration (60/min per first-hop client IP on HTTP routes, trustProxy on, plain-English 429) with a separate generous bucket for the WebSocket upgrade route (300/min per IP) so a Twilio burst is never refused; verified on a plain route and on the upgrade route. TWILIO_SIGNATURE_MODE=warn is a page-visible escape hatch, never the default.

Depends on: config (src/config/); log (src/log/)

### llm (src/llm/)
types.ts declares LlmClient, LlmEvent, LlmError, LlmProviderModule; aiSdkClient.ts is the only file importing 'ai' or '@ai-sdk/*' (v7, exact pins) and maps streamText fullStream parts to LlmEvents with abort passthrough, LLM_TIMEOUT_MS as total and inter-token stall timeout, first-token timestamp and LlmError kinds (auth, rate_limit, timeout, network, model_not_found, aborted, unknown) so the page can say 'your OPENAI_API_KEY was rejected'; providers/{openai,anthropic,google,mistral,groq}.ts each export id, keyEnv, defaultModel, description, create(); providers/fake.ts is a scripted provider (mentions of 'human' or 'person' trigger the handoff tool, 'slow' stalls, 'fail' errors) accepted by config but not advertised so CI and the simulator need no key; registry.ts lists providers one line each and exposes createLlmClient and catalog metadata. probe() gives the self-test a one-token request.

Depends on: nothing

### tools (src/tools/)
types.ts declares ToolDefinition (terminal flag), ToolContext, ToolResult, AutomationPreset, AutomationClient; handoff-to-team.ts is the single v1 registry tool (zod input reason <= 200 and summary <= 1000 chars, control characters stripped; builds the versioned HandoffPayload with transcript only when HANDOFF_INCLUDE_TRANSCRIPT=true; calls the client; always returns end with reasonCode live-agent-handoff whatever the webhook did); automation/client.ts uses global fetch with AbortSignal.timeout(AUTOMATION_TIMEOUT_MS), https only, redirects refused, 64 KB response cap, guarded JSON parse, allowlisted merge (transfer_to, ticket_id, note, each <= 200 chars), never throws; automation/presets/{none,make,zapier,n8n}.ts declare label, default key header, response mode (merge-json | ack-only | none) and a docs hint; registry.ts exports the tools array and the preset catalog.

Depends on: config (src/config/); log (src/log/)

### agent (src/agent/)
The domain core. CallSession state machine (created -> active -> ending -> ended) owning history (capped at 60 turns, system prompt kept), timings and tool results; SessionRegistry (Map by callSid, MAX_CONCURRENT_CALLS for calls, a separate cap of 3 for text-chat sessions with 10-minute idle expiry, per-session hard deadline at MAX_CALL_SECONDS + 30 s that force-removes leaks, 60 s sweep, closeAll for drain). Turn loop: on utterance bump the generation, start an AbortController, stream LlmEvents to out.say with the generation, record first-token and completion timestamps, execute at most one tool call per turn single-flight (terminal tools: flush turn text, speak HANDOFF_MESSAGE if the turn produced no text, run the tool, then end), emit exactly one turn.timing. Interrupt: abort, store the assistant turn truncated to utteranceUntilInterrupt (full text marked interrupted when it is not a prefix). End policy table: MAX_CALL_SECONDS -> CLOSING_MESSAGE then end-call/max_call_seconds; IDLE_TIMEOUT_SECONDS -> end-call/idle; LLM error or timeout -> FALLBACK_MESSAGE then live-agent-handoff/llm_error|llm_timeout within 2 s; handoff tool -> live-agent-handoff/caller_request; SIGTERM -> live-agent-handoff/server_restart; an end watchdog guarantees exactly one end even if a tool promise never settles. capabilities/endCall.ts is the built-in end_call capability (not a registry tool) visible to the model when AGENT_END_CALL=true. prompt.ts holds the bundled complaints-line default. Imports only src/llm/types.ts, src/tools/types.ts, src/voice/types.ts, config types and log.

Depends on: llm (src/llm/) types only; tools (src/tools/) types only; voice (src/voice/) types only; config (src/config/) types only; log (src/log/)

### voice (src/voice/)
types.ts declares CallInfo, VoiceOut, AgentPort, SessionFactory, VoiceAdapter (kind text|audio) so any Twilio product maps onto the text-level session API and an audio adapter keeps STT/TTS inside its own folder. conversationrelay/wire.ts holds zod schemas for every inbound and outbound frame (exported for tests); conversationrelay/route.ts registers GET /twilio/conversationrelay/:secret as a WebSocket route behind the UpgradeGate, requires a valid setup within 5 s, replaces an older session on a duplicate callSid, caps inbound at 20 msg/s and payloads at 64 KB, records every attempt in the recent-problems buffer; conversationrelay/link.ts is the per-connection translator (setup -> SessionFactory; prompt last:true -> onUtterance; last:false, dtmf, error, unknown -> log and ignore; interrupt -> onInterrupt; malformed JSON -> log, end transport_error, close 1003; socket close before end -> onClose caller_hangup; say -> text frame gated by generation; end -> end frame with handoffData string after a bounded grace delay, then close). textchat/adapter.ts drives the same SessionFactory in-process for the status page and unit tests, buffering tokens into a reply with timings and any handoffData. index.ts lists adapters one line each.

Depends on: agent (src/agent/); security (src/security/); config (src/config/); log (src/log/)

### status (src/status/)
Server-rendered monochrome HTML at GET / from escape-everything tagged-template functions; the renderer takes {ready, problems, facts, recent} so it renders even when config is broken. Tokenless view: readiness and the full problem list (variable, what, fix; never a value; blocking first) plus the hint to open the page with STATUS_TOKEN for the Twilio URL, the self-test and the test chat. Tokened view (cookie): problems by variable with what and fix, the exact wss URL, provider/model/automation preset/signature mode, commit or local, uptime, active calls, self-check facts (host source, X-Forwarded-Proto seen, URL the server will sign), the recent-problems ring buffer (last 20 runtime events, never attempted paths), the rate-limit sentence, a self-test button and the test chat with the single nonce inline script. GET /health JSON always 200. POST /chat drives the textchat adapter through the real core, tools and LLM; POST /selftest runs llm.probe() and an event:'test' webhook post and reports plain-English results. Chat and self-test require the cookie, are rate limited and allow one in-flight request per IP.

Depends on: config (src/config/); log (src/log/); security (src/security/); agent (src/agent/); voice (src/voice/) textchat adapter; llm (src/llm/) types only; tools (src/tools/) types only

### app shell and composition root (src/app.ts, src/main.ts)
buildApp(deps) creates Fastify with trustProxy, bodyLimit 64 KB, requestTimeout 30 s, disabled request logging, @fastify/websocket (maxPayload 64 KB), @fastify/cookie, @fastify/rate-limit, security headers, an error handler returning a generic body with an error id and never a stack trace or config value, GET /health, and registers adapters and status; exported for tests with fakes. src/main.ts is wiring only and the only file importing concrete providers, presets and adapters: loadConfig -> logger.registerSecrets -> createLlmClient -> tools + presets -> SessionRegistry -> buildApp -> listen 0.0.0.0:PORT -> SIGTERM/SIGINT drain (stop accepting upgrades, ask every session to speak then end with server_restart, wait up to 8 s, exit 0). Any wiring throw is logged as one fatal line with a hint and the degraded status page is still served when the app could be built. No Railway healthcheck path is configured.

Depends on: config (src/config/); log (src/log/); security (src/security/); llm (src/llm/); tools (src/tools/); agent (src/agent/); voice (src/voice/); status (src/status/)

### simulator (scripts/simulate-relay.ts)
Scripted ConversationRelay client: connects to the secret path signing the upgrade like Twilio when given an auth token, sends setup then prompts, asserts token streaming before the fake LLM finishes, interrupt behaviour (zero tokens after interrupt), exactly one last:true per turn, end frame shape, and parses stdout for every required log field. Run in CI against the built server with LLM_PROVIDER=fake and usable by the owner against a live deployment for the 20-call clean-call run.

Depends on: voice (src/voice/) wire schemas; security (src/security/)

### examples (examples/)
twilio-studio-flow.json (Say notice placeholder -> Call Recording ON -> ConversationRelay widget with URL and welcomeGreeting placeholders -> Split on HandoffData contains 'live-agent-handoff' -> Connect Call To human-number placeholder, else Hangup; widget Failed -> Connect Call To), make-blueprint.json (Custom webhook -> Router on event: test -> Webhook response {ok:true}; handoff -> placeholder roster/CRM modules -> Webhook response {transfer_to, ticket_id, note} within 5 s), examples/README.md with every placeholder and the Zapier (Catch Hook, ack only) and n8n (Webhook + Respond to Webhook) equivalents. Built against the locked HandoffPayload and HandoffData contracts; a Vitest test parses both files and asserts the widget chain, transitions, substring condition and placeholders.

Depends on: tools (src/tools/) HandoffPayload contract; agent (src/agent/) HandoffData contract

### test harness (test/helpers/, test/arch/)
FakeLlmClient (scripted LlmEvent streams with delays, tool calls, errors, stalls), FakeVoiceOut (records chunks and end), FakeSocket for the relay link, MockWebhookServer per preset, spawnBuiltServer (free port, node dist/main.js, parses stdout JSON lines), signature helper, misconfig boot matrix, redaction run, and test/arch/imports.test.ts enforcing the allowed import matrix by parsing import specifiers.

Depends on: agent (src/agent/); voice (src/voice/); app shell and composition root (src/app.ts, src/main.ts)

### ci and release (.github/, release branch, docs/)
ci.yml runs pnpm install --frozen-lockfile, lint, typecheck, test, build, docs:env --check and gitleaks on every push and PR. The Railway template points at the release branch; main is never the template source; releases are tagged with a CHANGELOG listing env-var additions (always defaulted), deprecations (old name aliased for one major with a status-page warning) and HandoffData/payload changes (additive under v:1). Rollback: owner reverts release; deployer uses Railway Rollback. Issue template asks for the status page text; docs/acceptance.md records dated live checklists.

Depends on: test harness (test/helpers/, test/arch/)

## Data model
No database and nothing written to disk at runtime; every entity lives in process memory and dies with the session or the process.

Config (owned by config, frozen after boot): AppConfig, ConfigProblem[] {variable, severity, what, fix}, ready, derived facts {publicHost, hostSource, wssUrl, signatureUrlVariants}, secretValues[]. Only src/main.ts holds the whole thing; other modules receive slices.

SessionRegistry (owned by agent): Map<callSid, CallSession>; calls capped at MAX_CONCURRENT_CALLS, text-chat sessions (key chat:<uuid>) capped at 3 with 10-minute idle expiry; 60 s sweep; entry deleted on every end path (tests assert size() === 0 after caller hangup, max-call timeout, idle, LLM error, handoff, end_call and drain).

CallSession { info: CallInfo {callSid, sessionId, from, to, direction, channel, startedAt, custom}; state created|active|ending|ended; generation: number; abort?: AbortController; history: LlmMessage[] (system prompt first, cap 60 turns, assistant turn truncated after an interrupt); current?: {turn, assistantText, t0, llmFirstTokenAt?, llmCompleteAt?, firstTextOutAt?, lastTextOutAt?, toolName?, toolMs?}; timings: TurnTiming[] (kept only for chat sessions; calls log and drop); toolResults: ToolResult[]; timers {maxCall, idle, hardDeadline, llmTimeout?, endWatchdog?}; outcome? }. Invariants: exactly one end per session; a chunk whose turn is not the current generation is never sent; tool execution is single-flight per turn.

HandoffData v1 (assembled by agent, transported by the adapter as a JSON string): reasonCode first key, v, reason, summary, callSid, from, to, startedAt, durationSec, webhook status, allowlisted transfer_to/ticket_id/note; <= 4 KB; server-owned keys are never overwritten by the webhook response.

RecentProblems (owned by status): ring buffer of 20 {at, kind: ws_rejected|llm_error|webhook_failed|chat_limit, detail redacted, signedUrl?}.

Data crossing the process boundary: inbound env vars, ConversationRelay frames, automation webhook responses, chat text; outbound HandoffPayload v1 to the automation URL (summary only unless HANDOFF_INCLUDE_TRANSCRIPT=true), end.handoffData to Twilio, JSON log lines to stdout. Nothing is reported back to the owner.

State outside the process and its migration path: each deployer's Railway variables (additive schema, defaults, aliases for one major), each deployer's Studio flow (substring routing on reasonCode, v field, additive fields), each deployer's automation scenario (payload v field, event discriminator, additive fields), the template's release branch (tags, revert or Railway Rollback). Secrets rotate by changing the variable and redeploying; the status page prints the new URL.

## Contracts
| Contract | Kind | Status |
|---|---|---|
| Environment schema (.env.example and README table generated from it) | file | draft |
| VoiceSeam (adapter <-> agent core) | rpc | draft |
| ConversationRelay wire protocol and upgrade gate | event | draft |
| LlmClient and provider registry | rpc | draft |
| ToolSeam (agent core <-> tools) and AutomationClient | rpc | draft |
| Automation webhook (server -> Make/Zapier/n8n) | REST | draft |
| HandoffData (Studio contract) | event | draft |
| Agent session API | rpc | draft |
| Status, health, chat and self-test HTTP surface | REST | draft |
| Log events (pino JSON, one object per line) | event | draft |
| Example files (Studio flow and Make blueprint) | file | draft |
| Import boundary (architecture test) | rpc | draft |
| Release and compatibility policy | file | draft |

### Environment schema (.env.example and README table generated from it)
Kind: file · Status: draft

```
// src/config/schema.ts: one EnvSpec per key { key; description; required: boolean | (partial) => boolean; default?; secret; validValues?; setBy?: 'railway'; parse } — enums and provider key names derived from src/llm/registry.ts and the preset catalog
PORT 3000 | LOG_LEVEL fatal|error|warn|info|debug (info; debug logs utterances) | PUBLIC_HOST? host only, default RAILWAY_PUBLIC_DOMAIN; neither => blocking
WS_SECRET secret, required, >= 24 chars | TWILIO_AUTH_TOKEN secret, required when TWILIO_SIGNATURE_MODE=enforce | TWILIO_SIGNATURE_MODE enforce|warn (enforce; warn => warning shown on the page) | STATUS_TOKEN secret >= 16 chars; unset => warning: URL, chat and self-test hidden, calls still allowed; no open tokenless mode
LLM_PROVIDER openai|anthropic|google|mistral|groq (default openai; 'fake' accepted, not advertised; unknown => blocking, message lists valid values) | LLM_MODEL (provider defaultModel) | OPENAI_API_KEY ANTHROPIC_API_KEY GOOGLE_GENERATIVE_AI_API_KEY MISTRAL_API_KEY GROQ_API_KEY (the selected provider's key is blocking-required) | LLM_TIMEOUT_MS 20000
SYSTEM_PROMPT multi-line, bundled complaints-line default (agent and business names live inside it) | FALLBACK_MESSAGE | HANDOFF_MESSAGE | CLOSING_MESSAGE (bundled defaults, spoken by the server)
AUTOMATION_PROVIDER none|make|zapier|n8n (none => warning 'handoff completes but nobody is notified'; unknown => blocking) | AUTOMATION_WEBHOOK_URL https only, no loopback or link-local host; required unless none; malformed => blocking | AUTOMATION_WEBHOOK_KEY? secret | AUTOMATION_WEBHOOK_KEY_HEADER? (preset default) | AUTOMATION_TIMEOUT_MS 5000
HANDOFF_INCLUDE_TRANSCRIPT false | AGENT_END_CALL true | MAX_CALL_SECONDS 900 | IDLE_TIMEOUT_SECONDS 60 | MAX_CONCURRENT_CALLS 10 (numbers out of range => warning + default)
RAILWAY_PUBLIC_DOMAIN, RAILWAY_GIT_COMMIT_SHA platform-provided, read-only, documented as such
type ConfigProblem = { variable: string; severity: 'blocking'|'warning'; what: string; fix: string } // never contains a value; rendered as '{variable}: {what}. {fix}.' — these strings are the README troubleshooting keys and are snapshot-tested
loadConfig(env: NodeJS.ProcessEnv, catalogs: { llm: LlmCatalog; automation: PresetCatalog }): { config: AppConfig /* frozen; invalid => default */; problems: ConfigProblem[]; ready: boolean /* no blocking */; publicHost: string | null; hostSource: 'PUBLIC_HOST'|'RAILWAY_PUBLIC_DOMAIN'|null; wssUrl: string | null; signatureUrlVariants: string[]; secretValues: string[] } // never throws
scripts/docs-env.ts regenerates .env.example and the README table between <!-- env:start --> and <!-- env:end -->; --check fails CI on drift
```

### VoiceSeam (adapter <-> agent core)
Kind: rpc · Status: draft

```
// src/voice/types.ts — the only voice import allowed inside src/agent/
export type Channel = 'conversationrelay' | 'textchat' | 'mediastreams';
export interface CallInfo { callSid: string; sessionId: string; from: string; to: string; direction: 'inbound'|'outbound'|'unknown'; channel: Channel; startedAt: string; custom: Record<string, string> }
export interface VoiceOut {                          // adapter implements, core calls; no-op after close
  say(chunk: { text: string; last: boolean; turn: number; interruptible?: boolean }): void;  // adapter drops chunks whose turn !== current generation
  end(data: HandoffData): Promise<void>;             // send end frame with JSON.stringify(data), wait for flush plus bounded grace, close
}
export interface AgentPort {                         // core implements, adapter calls
  onUtterance(text: string, lang?: string): void;    // adapters forward only last:true prompts
  onInterrupt(utteranceUntilInterrupt: string, durationMs?: number): void;
  onDtmf(digit: string): void;                       // v1: logged only
  onClose(cause: 'caller_hangup' | 'transport_error'): void;
}
export type SessionFactory = (info: CallInfo, out: VoiceOut) => { ok: true; port: AgentPort } | { ok: false; reason: 'not_ready' | 'capacity' };
export interface VoiceAdapter { id: Channel; kind: 'text' | 'audio'; register(app: FastifyInstance, deps: { sessions: SessionFactory; gate: UpgradeGate; recent: RecentProblems; log: Logger }): void }
// src/voice/index.ts: export const adapters: VoiceAdapter[] = [conversationRelay]; adding an adapter = one folder + one line; an audio adapter turns STT text into onUtterance and say chunks into TTS inside its own folder
```

### ConversationRelay wire protocol and upgrade gate
Kind: event · Status: draft

```
Route: GET /twilio/conversationrelay/:secret (WebSocket upgrade). Gate order, fixed: (1) safeEqual(secret, WS_SECRET) else 404 empty body, no session; (2) readiness: any blocking problem => 503 'not ready, open the status page'; (3) lowercase x-twilio-signature == base64(HMAC-SHA1(TWILIO_AUTH_TOKEN, url)) for the first matching url in signatureUrlVariants ['wss://<host><path>', 'https://<host><path>', same with :443] else 403 (TWILIO_SIGNATURE_MODE=warn: allow and record a warning); (4) active calls >= MAX_CONCURRENT_CALLS => 503; (5) a valid setup frame within 5 s else close 1002. Every rejection => ws.rejected {reason, signedUrl, variantsTried, ip} and a recent-problems entry; a 503 lands on the Studio widget's Failed transition, that is, on a human.
Inbound (zod; unknown types logged and ignored):
  { type:'setup'; sessionId; callSid; from; to; direction; accountSid; parentCallSid?; forwardedFrom?; callerName?; applicationSid?; customParameters?: Record<string,string> }  // must be the first frame
  { type:'prompt'; voicePrompt: string; lang: string; last: boolean }   // acted on only when last === true
  { type:'interrupt'; utteranceUntilInterrupt: string; durationUntilInterruptMs: number }
  { type:'dtmf'; digit: string }   { type:'error'; description: string }
Outbound (validated in tests against the documented schema):
  { type:'text'; token: string; last: boolean; interruptible?: boolean; preemptible?: boolean }
  { type:'end'; handoffData: string /* JSON.stringify(HandoffData) */ }   (play, sendDigits, language reserved, unused in v1)
Rules: prompt last:false, dtmf, error => log and ignore; malformed JSON => log, end(live-agent-handoff/transport_error), close 1003; socket close before end => onClose('caller_hangup'); a second setup for a registered callSid replaces the older session (closed and logged); inbound cap 20 msg/s; maxPayload 64 KB; bufferedAmount above 256 KB => drop chunk with a warning; before sending end the adapter waits a grace delay derived from the words sent in the ending turn, capped at 2 s on fault paths and 4 s on handoff (tuned during live acceptance; zero if Twilio confirms end waits for playback).
```

### LlmClient and provider registry
Kind: rpc · Status: draft

```
// src/llm/types.ts; 'ai' and '@ai-sdk/*' are imported only in src/llm/aiSdkClient.ts
export interface LlmMessage { role: 'system'|'user'|'assistant'|'tool'; content: string; toolCallId?: string; toolName?: string; toolInput?: unknown }
export interface LlmToolSpec { name: string; description: string; inputSchema: z.ZodType }
export type LlmEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; name: string; input: unknown }
  | { type: 'finish'; finishReason: 'stop'|'tool-calls'|'length'|'other'; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: 'error'; error: LlmError };
export type LlmError = { kind: 'auth'|'rate_limit'|'timeout'|'network'|'model_not_found'|'aborted'|'unknown'; status?: number; message: string /* redacted */ }
export interface LlmClient { readonly provider: string; readonly model: string; stream(req: { messages: LlmMessage[]; tools: LlmToolSpec[]; signal: AbortSignal; timeoutMs: number; stallMs: number }): AsyncIterable<LlmEvent> /* never throws; always ends with finish or error */; probe(): Promise<{ ok: boolean; ms: number; error?: LlmError }> /* one-token request for the self-test */ }
export interface LlmProviderModule { id: string; keyEnv: string; keyDescription: string; defaultModel: string; create(o: { model: string; apiKey: string }): LlmClient }
// src/llm/registry.ts: export const providers: LlmProviderModule[] = [openai, anthropic, google, mistral, groq, fake]; export const llmCatalog = providers.map(({ id, keyEnv, keyDescription, defaultModel }) => ...); export function createLlmClient(o: { provider: string; model?: string; apiKey: string }): LlmClient
// adding a provider = providers/<id>.ts + one array entry; config derives the enum and key names from the array; run pnpm docs:env
```

### ToolSeam (agent core <-> tools) and AutomationClient
Kind: rpc · Status: draft

```
// src/tools/types.ts
export interface ToolContext { call: CallInfo; history: readonly LlmMessage[]; settings: Pick<AppConfig, 'HANDOFF_INCLUDE_TRANSCRIPT'|'AUTOMATION_TIMEOUT_MS'>; log: Logger; signal: AbortSignal }
export type WebhookStatus = 'ok'|'ack'|'failed'|'timeout'|'skipped';
export type MergedFields = Partial<Record<'transfer_to'|'ticket_id'|'note', string>>;  // allowlist, each <= 200 chars
export interface ToolResult { modelText: string; end?: { reasonCode: HandoffReasonCode; reason: HandoffReason; summary?: string; webhook?: WebhookStatus; fields?: MergedFields } }
export interface ToolDefinition<I = unknown> { name: string; description: string; inputSchema: z.ZodType<I>; terminal: boolean; run(input: I, ctx: ToolContext): Promise<ToolResult> /* never throws */ }
export interface AutomationPreset { id: 'none'|'make'|'zapier'|'n8n'; label: string; defaultKeyHeader: string | null; responseMode: 'merge-json'|'ack-only'|'none'; docsHint: string }
export interface AutomationClient { post(payload: HandoffPayload, signal?: AbortSignal): Promise<{ status: WebhookStatus; httpStatus?: number; fields: MergedFields; error?: string; ms: number }> /* never throws */ }
// src/tools/registry.ts: export const tools: ToolDefinition[] = [handoffToTeam]  (v1: exactly one); export const presets: AutomationPreset[] = [none, make, zapier, n8n]
// end_call is an agent capability (src/agent/capabilities/endCall.ts, terminal, reasonCode end-call/agent_end_call), model-visible only when AGENT_END_CALL=true; it is not in the tools array
// Core loop: text-delta -> out.say(turn); tool-call -> validate input -> if terminal: flush turn text (last:true), speak HANDOFF_MESSAGE when the turn produced no text, run the tool, then out.end(HandoffData); else append tool message and stream again (max 3 steps); single-flight per turn
```

### Automation webhook (server -> Make/Zapier/n8n)
Kind: REST · Status: draft

```
POST {AUTOMATION_WEBHOOK_URL} (https only, redirects refused)  Content-Type: application/json  timeout AUTOMATION_TIMEOUT_MS (5000), single attempt
Header `${AUTOMATION_WEBHOOK_KEY_HEADER ?? preset.defaultKeyHeader}: ${AUTOMATION_WEBHOOK_KEY}` when a key is set. Preset defaults to verify at build: make 'x-make-apikey'; n8n 'x-api-key' (Header Auth credential); zapier none (secret URL; optional key header for a Filter step).
interface HandoffPayload { v: 1; event: 'handoff' | 'test'; callSid: string; from: string; to: string; channel: 'conversationrelay'|'textchat'; startedAt: string; requestedAt: string; durationSec: number; reason: string /* <= 200 */; summary: string /* <= 1000, control characters stripped */; custom?: Record<string, string> /* Studio customParameters */; transcript?: { role: 'user'|'assistant'; text: string }[] /* only when HANDOFF_INCLUDE_TRANSCRIPT=true */ }
Response handling: make | n8n 2xx JSON object -> allowlisted transfer_to, ticket_id, note (strings <= 200 chars, body <= 64 KB) merged into HandoffData, status ok; non-JSON 2xx -> ok with a warning, nothing merged; zapier 2xx -> body ignored, status ack; non-2xx -> failed; no answer in time -> timeout; AUTOMATION_PROVIDER=none or URL unset -> skipped. The end message is sent in every case (four cases tested per preset against a mock server). event 'test' is sent by POST /selftest; the example Make blueprint answers it with {ok:true}. The payload is documented as untrusted caller-derived text.
```

### HandoffData (Studio contract)
Kind: event · Status: draft

```
// JSON.stringify'd into the end frame; Studio reads {{widgets.<name>.HandoffData}} after the widget finishes; additive-only under v:1
export type HandoffReasonCode = 'live-agent-handoff' | 'end-call';   // the only routing key Studio needs (substring match)
export type HandoffReason = 'caller_request'|'llm_error'|'llm_timeout'|'transport_error'|'server_restart'|'capacity'|'max_call_seconds'|'idle'|'agent_end_call';
export interface HandoffData { reasonCode: HandoffReasonCode /* always the first key */; v: 1; reason: HandoffReason; summary: string; callSid: string; from: string; to: string; startedAt: string; durationSec: number; webhook: WebhookStatus; transfer_to?: string; ticket_id?: string; note?: string }  // <= 4 KB; reserved keys never overwritten by the webhook
End policy: caller_request (HANDOFF_MESSAGE first unless the turn spoke), llm_error | llm_timeout | transport_error (FALLBACK_MESSAGE first), server_restart, capacity => live-agent-handoff; max_call_seconds (CLOSING_MESSAGE first), idle, agent_end_call => end-call.
call.ended outcome mapping: caller_request -> handoff; agent_end_call -> completed; max_call_seconds -> timeout; idle -> idle; llm_error | llm_timeout | transport_error -> error; server_restart -> server_restart; socket closed by the caller before end -> caller_hangup (handoff_pending:true when a webhook was in flight).
Example flow: Split on HandoffData contains 'live-agent-handoff' -> Connect Call To; else -> Hangup; widget Failed -> Connect Call To. transfer_to via Set Variables (parse as JSON) is optional until verified on a real Studio account.
```

### Agent session API
Kind: rpc · Status: draft

```
// src/agent/types.ts
export type Outcome = 'handoff'|'completed'|'caller_hangup'|'timeout'|'idle'|'error'|'server_restart';
export interface TurnTiming { turn: number; ms_prompt_to_llm_first_token: number | null; ms_llm_first_to_complete: number | null; ms_prompt_to_first_text_out: number | null; ms_prompt_to_last_text_out: number | null; tool_name?: string; tool_ms?: number; interrupted: boolean; tokens_out: number }
export interface AgentSettings extends Pick<AppConfig, 'SYSTEM_PROMPT'|'FALLBACK_MESSAGE'|'HANDOFF_MESSAGE'|'CLOSING_MESSAGE'|'AGENT_END_CALL'|'MAX_CALL_SECONDS'|'IDLE_TIMEOUT_SECONDS'|'MAX_CONCURRENT_CALLS'|'LLM_TIMEOUT_MS'> {}
export interface AgentDeps { llm: LlmClient; tools: ToolDefinition[]; settings: AgentSettings; log: Logger; recent: RecentProblems; now?: () => number }
export interface SessionRegistry { open: SessionFactory; size(): number; activeCalls(): number; snapshot(callSid: string): { state; history; timings; toolResults } | undefined; closeAll(cause: 'shutdown'): Promise<void> /* speak, then end live-agent-handoff/server_restart on every session; 8 s cap */ }
CallSession: state created -> active -> ending -> ended; generation counter bumped per utterance (a new prompt aborts the previous turn); one AbortController; timers maxCall, idle, hardDeadline (MAX_CALL_SECONDS + 30 s force-remove), llmTimeout, endWatchdog; history capped at 60 turns with the system prompt kept; exactly one end per session; registry entry deleted on every end path.
```

### Status, health, chat and self-test HTTP surface
Kind: REST · Status: draft

```
GET /health -> 200 always, application/json: { ready: boolean; uptime_s: number; commit: string /* RAILWAY_GIT_COMMIT_SHA | 'local' */; active_calls: number; problems: ConfigProblem[] }  // no values, no URL, no token needed
GET / -> 200 text/html, server-rendered, escaped, monochrome, system fonts, no imagery, works with JavaScript disabled. Headers: Cache-Control no-store; CSP default-src 'none' with a per-request nonce for the one inline chat script and inline style; X-Frame-Options DENY; Referrer-Policy no-referrer; X-Content-Type-Options nosniff.
GET /?token=<STATUS_TOKEN> once -> Set-Cookie status_token (HttpOnly; Secure when https; SameSite=Strict) + 302 to / (the token never stays in a URL; request logging is off). Wrong token -> tokenless view with 'Token did not match'.
Tokenless view: 'Ready' | 'Not ready', the problem list (variable, what, fix; never a value; blocking first), 'Open this page with ?token=<STATUS_TOKEN> (find it in your Railway variables) to see the Twilio URL, the self-test and the test chat.'
Tokened view, in order: readiness; problems (variable, what, fix; blocking first); Twilio URL wss://<host>/twilio/conversationrelay/<WS_SECRET> in a copy field; in use (LLM provider, model, automation preset, signature mode); build (commit, uptime, active calls, MAX_* values); self-check (host source, X-Forwarded-Proto seen on this request, the URL the server will sign); recent problems (last 20: ws.rejected reason + signed URL, LLM error kind, webhook status, chat limit); rate-limit sentence; self-test button; test chat (note: 'this runs your prompt and calls your automation webhook'; the form works without JS for a single reply, the script only improves the transcript view). Exact message strings are snapshot-tested and quoted verbatim in the README troubleshooting section.
POST /chat (cookie required) { sessionId?: string; message: string /* <= 1000 chars */ } -> 200 { sessionId: string; reply: string; ended: boolean; handoffData?: HandoffData; timing: TurnTiming; toolCalls: { name; input; result }[] } | 401 { error } | 409 { error: 'Not ready'; problems } | 429. Limits: 3 chat sessions, 30 turns each, 10 min idle, one in-flight request per IP; separate from MAX_CONCURRENT_CALLS.
POST /selftest (cookie required) {} -> 200 { llm: { ok: boolean; ms: number; error?: string /* plain English from LlmError.kind */ }; webhook: { ok: boolean; status?: number; ms: number; error?: string } }
Rate limit: 60 requests per minute per client IP (trustProxy) on every HTTP route, and a separate bucket of 300 per minute per IP on the WebSocket upgrade route -> 429 { error: 'Too many requests. The limit is 60 per minute per address.' }; the HTML page carries the same sentence. No secret appears in any body except the wss URL on the tokened view.
```

### Log events (pino JSON, one object per line)
Kind: event · Status: draft

```
Every line: { level, time, msg, event, ...fields }; callSid on every in-call line; secrets redacted by path and by value; utterance and model text only at debug; Fastify request logging off.
server.listening { port, host_source, commit }
config.problem { variable, severity, what }              // names only
ws.rejected { reason: 'path'|'not_ready'|'signature'|'capacity'|'setup_timeout', signedUrl?, variantsTried?, ip }
call.started { callSid, from, to, channel, provider, model, automation }
turn.timing { callSid, turn, ms_prompt_to_llm_first_token, ms_llm_first_to_complete, ms_prompt_to_first_text_out, ms_prompt_to_last_text_out, tool_name?, tool_ms?, interrupted, tokens_out }   // exactly one per turn; ms_prompt_to_first_text_out is measured when the adapter hands the first text frame to the socket (the send call), not on flush
tool.called { callSid, tool, ms, ok }
handoff.webhook { callSid, preset, status: WebhookStatus, http_status?, ms, merged_keys }
call.ended { callSid, outcome: Outcome, reason, duration_ms, turns, error_kind?, handoff_pending?, rss_mb }
server.draining { active_calls, deadline_ms }
README filter for the clean-call rate: @event:call.ended, then count outcome values; error_kind separates server faults from provider faults.
```

### Example files (Studio flow and Make blueprint)
Kind: file · Status: draft

```
examples/twilio-studio-flow.json (Studio v2 export): say_notice (Say: '<<EDIT: recording notice>>') -> record_call (Call Recording, ON) -> ai_stage (ConversationRelay: url 'wss://<<EDIT: paste from the status page>>', welcomeGreeting '<<EDIT: greeting>>') -> split_handoff (Split on {{widgets.ai_stage.HandoffData}} contains 'live-agent-handoff' -> connect_human; no match -> hangup); ai_stage Failed -> connect_human; connect_human (Connect Call To {{flow.variables.human_number}}, placeholder '<<EDIT: +human number>>') -> hangup.
examples/make-blueprint.json: Custom webhook (accept JSON, API key auth header x-make-apikey) -> Router on {{1.event}}: 'test' -> Webhook response 200 {"ok": true}; 'handoff' -> '<<EDIT: your roster / CRM modules>>' -> Webhook response 200 {"transfer_to": "...", "ticket_id": "...", "note": "..."} within 5 s.
examples/README.md: placeholder table (what, where to find it), the Zapier equivalent (Catch Hook, ack only, no response fields) and the n8n equivalent (Webhook with Header Auth + Respond to Webhook, same JSON body).
CI test asserts: both files parse; the widget names, types, transitions and the substring condition exist; the Failed transition targets connect_human; the Make blueprint contains the webhook, router and webhook-response modules; a reviewer's grep finds no locale, currency or country-specific constants.
```

### Import boundary (architecture test)
Kind: rpc · Status: draft

```
Allowed import matrix, enforced by test/arch/imports.test.ts parsing import specifiers under src/:
src/config -> src/llm/registry.ts, src/tools/registry.ts (metadata only)
src/log -> src/config
src/security -> src/config, src/log
src/llm -> (nothing internal); src/llm/aiSdkClient.ts is the only file importing 'ai' or '@ai-sdk/*'
src/tools -> src/config, src/log
src/agent -> src/llm/types.ts, src/tools/types.ts, src/voice/types.ts, src/config (types), src/log   // never providers/, presets/, conversationrelay/, status/, security/, 'ai', '@ai-sdk/*', '@fastify/*'
src/voice -> src/agent, src/security, src/config, src/log
src/status -> src/config, src/security, src/voice/textchat, src/agent/types.ts, src/llm/types.ts, src/tools/types.ts, src/log
src/app.ts -> src/config, src/log, src/security; src/main.ts -> anything; no other file imports src/app.ts or src/main.ts
Contributor check: the README 'Add a provider' guide is followed by adding providers/dummy.ts plus one registry line with the suite green and src/agent/ untouched.
```

### Release and compatibility policy
Kind: file · Status: draft

```
Railway template source = branch 'release' (verify at build that Railway templates honour branch selection); main is never deployed to strangers. Release = fast-forward merge to release + tag vX.Y.Z + CHANGELOG entry listing env-var additions (always defaulted), deprecations (old name aliased for one major with a status-page warning), removals (major only), and HandoffData / HandoffPayload changes (additive under v:1; v bumps only for breaking changes). Rollback: owner reverts 'release' (every non-ejected deployer auto-redeploys); a deployer uses Railway Rollback; both documented. Secret rotation: change WS_SECRET or STATUS_TOKEN in Railway, redeploy, re-paste the URL from the status page / reopen the page. docs/acceptance.md holds the dated live checklists and the non-owner 30-minute rehearsal record.
```

## Foundations order
1. foundation:scaffold-ci-and-hello-deploy — package.json (engines.node 24.x, packageManager pnpm@<exact>, scripts dev/build/start/lint/typecheck/test/docs:env, no Dockerfile), pnpm-lock.yaml, tsconfig strict NodeNext, ESLint flat config + Prettier, Vitest, MIT LICENSE, .gitignore (.env* except .env.example), .github/workflows/ci.yml (install --frozen-lockfile, lint, typecheck, test, build, docs:env --check, gitleaks), a placeholder src/main.ts listening on 0.0.0.0:PORT answering GET /health {ready:false}; the release branch exists; the hello-deploy from a fresh Railway account is an owner action recorded as the first item of docs/acceptance.md, never a build blocker
2. foundation:seam-contracts-and-test-doubles — src/voice/types.ts, src/llm/types.ts, src/tools/types.ts, src/agent/types.ts, src/security/types.ts exactly as drafted; src/llm/registry.ts with the six provider files carrying metadata (id, keyEnv, defaultModel) and create() stubs; src/tools/registry.ts with the four preset metadata modules; src/voice/conversationrelay/wire.ts zod validators for every inbound and outbound frame; src/voice/index.ts; test/helpers (FakeLlmClient, FakeVoiceOut, FakeSocket, MockWebhookServer, spawnBuiltServer, signature helper); test/arch/imports.test.ts. This is the contract-lock point: features build against these files and never edit them
3. foundation:config — EnvSpecs with every key and description, loadConfig that never throws, ConfigProblem model with blocking/warning severity and value-free messages listing valid values from the catalogs, derived publicHost/hostSource/wssUrl/signatureUrlVariants/secretValues, scripts/docs-env.ts generating .env.example and the README env-var listing, parity test, and the case-driven severity test covering every fault named in the success criteria
4. foundation:log — pino to stdout with LOG_LEVEL, path redaction, value redaction via registerSecrets, forCall child loggers, event-name constants, request logging off, and the redaction test harness later suites reuse
5. foundation:security-primitives — safeEqual, Twilio signature validation over the URL variants with known-answer tests, UpgradeGate with the fixed order and plain-English messages, the status-page unlock query-to-cookie exchange, security headers with nonce CSP, rate-limit registration with trustProxy (60/min per IP on HTTP routes, a separate 300/min bucket on the WebSocket upgrade route) verified on a plain route and on a websocket route
6. foundation:app-shell-and-degraded-page — buildApp(deps) with plugins, limits and the generic error handler, GET /health, the locked GET / (no unlock cookie) rendering readiness and the value-free problem list, the WebSocket route registered but answering 503 not-ready, SIGTERM drain skeleton, and src/main.ts wiring whatever registries exist so the process boots on any env

## Feature map
| Feature | Depends on | Parallel class |
|---|---|---|
| llm-providers | foundation:seam-contracts-and-test-doubles, foundation:config, foundation:log | llm |
| tools-and-automation-webhook | foundation:seam-contracts-and-test-doubles, foundation:config, foundation:log | tools |
| agent-core | foundation:seam-contracts-and-test-doubles, foundation:config, foundation:log | agent |
| conversationrelay-adapter-and-upgrade-gate | foundation:seam-contracts-and-test-doubles, foundation:security-primitives, foundation:app-shell-and-degraded-page | voice |
| status-page-test-chat-and-selftest | agent-core, foundation:security-primitives, foundation:app-shell-and-degraded-page | status |
| studio-flow-and-make-blueprint | foundation:seam-contracts-and-test-doubles | examples |
| integration-drain-and-simulator | llm-providers, tools-and-automation-webhook, agent-core, conversationrelay-adapter-and-upgrade-gate, status-page-test-chat-and-selftest | integration |
| readme-template-and-release | integration-drain-and-simulator, studio-flow-and-make-blueprint | release |
| live-acceptance-and-kpi-runs | readme-template-and-release | release |

### llm-providers
Verify AI SDK v7 streamText/fullStream/tool/abort shapes against Vercel's docs first; implement src/llm/aiSdkClient.ts (LlmEvent mapping, AbortSignal passthrough, total and stall timeouts, first-token timestamp, LlmError kinds, probe()); fill create() in providers/{openai,anthropic,google,mistral,groq}.ts with the AI SDK default key names and fast default models; providers/fake.ts scripted for the simulator; unit tests with mocked keys resolve every LLM_PROVIDER value and an unknown value yields the message listing valid values; OpenAI verified live by the owner.

### tools-and-automation-webhook
handoff-to-team.ts (zod input caps and sanitisation, HandoffPayload v1 builder honouring HANDOFF_INCLUDE_TRANSCRIPT and Studio customParameters, always returns end live-agent-handoff/caller_request with the webhook status and allowlisted fields), automation/client.ts (fetch + AbortSignal.timeout, https only, redirects refused, 64 KB cap, guarded parse, never throws, event 'test' support), presets none/make/zapier/n8n with default key headers and response modes, AUTOMATION_WEBHOOK_KEY_HEADER override; MockWebhookServer tests per preset for 2xx JSON, non-JSON 2xx, non-2xx, timeout and URL unset asserting end is returned in every case and only allowlisted keys merge.

### agent-core
CallSession state machine, SessionRegistry with channel caps, hard deadline, sweep and closeAll, streaming turn loop with generation-gated say, single-flight tool execution with terminal-tool handling (flush text, HANDOFF_MESSAGE when silent, run, end), interrupt abort and truncation, end policy table (max_call_seconds with CLOSING_MESSAGE, idle, llm_error/llm_timeout with FALLBACK_MESSAGE within timeout + 2 s, caller_request, server_restart, capacity), end watchdog, built-in end_call capability behind AGENT_END_CALL, bundled default prompt, turn.timing/call.started/tool.called/call.ended emission; tested entirely with FakeLlmClient and FakeVoiceOut including zero chunks after interrupt, exactly one end, and registry size 0 after every end path; the import-boundary test proves no concrete provider or adapter import.

### conversationrelay-adapter-and-upgrade-gate
src/voice/conversationrelay/{route,link}.ts: WebSocket route behind the UpgradeGate in the fixed order (path 404, not ready 503, signature 403 with signed URL and variants logged, capacity 503, setup within 5 s), duplicate-callSid replacement, inbound rate and payload caps, per-connection translation of every frame (prompt last:true only; last:false, dtmf, error, unknown logged; malformed JSON ends cleanly; socket close -> caller_hangup), generation-gated text frames, end frame with handoffData string after the bounded grace delay, recent-problems recording; one line in src/voice/index.ts; FakeSocket tests including streaming-before-completion, outbound shape validation and 429 on the upgrade route.

### status-page-test-chat-and-selftest
src/voice/textchat/adapter.ts driving the same SessionFactory in-process; src/status: escaped tagged-template renderer (tokenless and tokened views, problems by variable with what and fix, wss URL, in-use facts, build facts, self-check facts, recent-problems buffer, rate-limit sentence), token cookie exchange, security headers, GET /health, POST /chat with session/turn/idle/in-flight limits, POST /selftest (llm.probe + webhook test event), the single nonce inline script; tests: every fault renders Not ready with variable/what/fix and no values, JS-disabled rendering, no secret value in any response body, token gating hides URL, chat and self-test, and 'I want to speak to a person' with the fake LLM shows handoffData and timings.

### studio-flow-and-make-blueprint
examples/twilio-studio-flow.json, examples/make-blueprint.json and examples/README.md with every placeholder and the Zapier and n8n equivalents; Vitest asserts JSON validity, the widget chain, the Failed transition, the substring Split condition and the Make router/response modules; the owner imports both into real Studio and Make accounts once and records the result, including whether a Split can read HandoffData as JSON.

### integration-drain-and-simulator
src/main.ts wiring of the real registries, SIGTERM drain with server_restart handoff; scripts/simulate-relay.ts and the CI simulator suite against the built server with LLM_PROVIDER=fake (setup, prompt, tokens then exactly one last:true with the first token before the fake stream ends, interrupt with zero tokens after, handoff end frame, hangup, every required log field parsed from stdout); misconfig boot matrix (unknown LLM_PROVIDER, missing provider key, unknown AUTOMATION_PROVIDER, malformed AUTOMATION_WEBHOOK_URL, missing WS_SECRET, missing TWILIO_AUTH_TOKEN) asserting 200 Not ready pages and refused upgrades; end-to-end redaction run over stdout and every response body; env-example parity and architecture tests green; pnpm lint, typecheck, test and build exit 0 on a clean clone.

### readme-template-and-release
README (deploy button, prerequisites: upgraded Twilio account with a number and AI/ML terms accepted, numbered quickstart from button click to first call including Studio import and pasting the wss URL, generated env table, troubleshooting keyed to the exact status-page strings, add-a-provider and add-a-voice-adapter guides verified by adding a dummy provider, privacy and recording-consent disclaimer, jurisdiction-neutral and English-only statement, Railway log filter for the clean-call rate, RAILPACK_NODE_VERSION escape hatch, disable-app-sleeping note, secret rotation, eject-to-own-repo path); Railway template published by the owner from the release branch with described variables, ${{secret(32)}} for WS_SECRET and STATUS_TOKEN and HTTP public networking on; issue template asking for the status page text; fresh-account deploy-button rehearsal.

### live-acceptance-and-kpi-runs
Owner-run dated checklist in docs/acceptance.md: three-turn live call with LLM_PROVIDER=openai, live handoff with the human phone ringing within 10 s and the Make response merged into handoffData, end-frame TTS cut-off check and grace-delay tuning, 20 consecutive scripted calls (goodbye, hangup, handoff mix) with zero error and zero timeout outcomes plus median and p95 ms_prompt_to_first_text_out recorded, and the non-owner 30-minute rehearsal (tester, date, elapsed time) in the release notes.

## Decisions
- **Degraded boot with an always-200 /health instead of fail-fast** → [ADR 0001](../../docs/adr/0001-degraded-boot-always-200-health.md). loadConfig never throws; the process boots on any env, refuses WebSocket upgrades while blocking problems exist, and GET / and GET /health always answer 200 with a ready flag and value-free problems; no Railway healthcheck path is configured. Why: A crash loop or a 503 makes the status page unreachable, and the status page is the only support channel a deployer who cannot read logs has. The trade-off is a misconfigured server that keeps running and must be self-explaining.
- **Deployer-owned contracts are versioned and additive-only, and the template deploys from a release branch** → [ADR 0002](../../docs/adr/0002-additive-deployer-contracts-and-release-branch.md). HandoffData (read by Studio) and HandoffPayload (read by Make/Zapier/n8n) carry v:1 and only gain fields; env vars gain defaults, aliases for one major, removals only in a major; the Railway template tracks the release branch, never main. Why: Template deployments attach to the template repo and may redeploy on every push; Studio flows and automation scenarios live in systems the owner cannot update. Once strangers deploy, these shapes are effectively frozen, so the cost is paid up front in discipline rather than later in broken deployments.
- **Module-owned seam types with static registries; the agent core imports only types** → [ADR 0003](../../docs/adr/0003-module-owned-seam-types-and-static-registries.md). src/llm/types.ts, src/tools/types.ts and src/voice/types.ts own the seams next to their registry arrays; src/agent/ imports only those types; src/main.ts is the only file importing concretes; a Vitest over import specifiers enforces the matrix. Why: Keeps the 'one file plus one registry line, never touching src/agent/' promise literal for contributors and lets config derive enum values from the registries. Rejected agent-owned hexagonal ports (contributors would touch two folders) and directory-scan discovery (fails at runtime instead of typecheck). Reversing this later means moving every seam.
- **HandoffData routes on two reasonCode values and faults hand the caller to a human**. reasonCode is 'live-agent-handoff' or 'end-call' with a detailed reason field; LLM error, LLM timeout, transport error, capacity and server restart end as live-agent-handoff after the fallback sentence; only max-call, idle and agent_end_call hang up. Why: Dropping a caller on a server fault is the failure the clean-call KPI exists to prevent, and a two-value substring condition works whether or not Studio parses HandoffData as JSON. The success criteria's 'handoffData reason error' maps to reason llm_error under reasonCode live-agent-handoff.
- **Twilio signature enforced over the wss URL with documented variants and a visible warn mode**. TWILIO_AUTH_TOKEN is required by default; validation is hand-rolled HMAC-SHA1 (no twilio package) tried over wss/https with and without :443; the log and status page show the exact URL signed; TWILIO_SIGNATURE_MODE=warn is an explicit, page-visible escape hatch. Why: Signature mismatch behind Railway's proxy is the top silent-failure risk; naming the signed URL makes it diagnosable from the page, and the warn mode is for the deployer who is stuck, never the default.
- **STATUS_TOKEN unlocks via a one-time query-to-cookie exchange; tokenless page shows readiness and the value-free problem list**. GET /?token=... once sets an HttpOnly cookie and redirects to /; request logging is off; without the cookie the page shows Ready/Not ready, the problem list without values (variable, what, fix) and a hint; an unset STATUS_TOKEN is a warning that hides the URL, chat and self-test (no open mode). Why: The page prints the WebSocket secret and the chat spends LLM credits on a guessable domain; the exchange keeps the token out of persistent URLs while still letting the README say 'open this link'.
- **Built-in end_call is an agent capability, shipped enabled by default**. src/agent/capabilities/endCall.ts (not in the tools registry) is model-visible when AGENT_END_CALL=true, default true; the default prompt and tool description require an explicit goodbye; call.ended carries reason agent_end_call and turns so short completions are visible. Why: Without it the AI can never close a call and outcome 'completed' is unreachable; IDLE_TIMEOUT_SECONDS covers the caller who walks away either way. The default is flagged for the human gate because the risk lens argues premature endings are undetectable.
- **Agent core owns the tool loop; the AI SDK is a stateless stream behind LlmClient**. streamText is called once per step with tools declared but never executed by the SDK; text-delta, tool-call and finish are normalised; the core runs at most one tool per turn single-flight and at most 3 steps. Why: Terminal-tool semantics (bridging sentence, webhook wait, exactly one end, outcome) must not live in SDK callbacks whose loop API changed across the last three majors.
- **Generation-numbered turns and adapter-side drop of stale chunks**. Every say chunk carries the turn generation; the adapter drops chunks whose generation is not current; the core also checks the abort flag before every say. Why: Deltas already yielded after an abort would otherwise reach Twilio after an interrupt; the invariant is provable by test.
- **Webhook response merge is an allowlist**. Only transfer_to, ticket_id and note (strings <= 200 chars) merge into HandoffData; reserved keys are never overwritten; https-only URL, redirects refused, 64 KB response cap. Why: A buggy or compromised scenario must not inject arbitrary fields into every deployer's Studio flow; the example flow only ever reads transfer_to, and more keys are additive later.
- **Summary is written by the model as a tool argument; transcript stays on the server by default**. No second LLM call; reason and summary are handoff_to_team arguments; HANDOFF_INCLUDE_TRANSCRIPT defaults to false; utterances are logged only at debug. Why: A second call adds seconds of silence before transfer, and shipping caller speech to a third-party tool must be the deployer's explicit choice.
- **Configuration surface kept small: names live in SYSTEM_PROMPT, rate limit and chat caps are constants**. No AGENT_NAME, BUSINESS_NAME or RATE_LIMIT_PER_MINUTE variables; 60/min, 3 chat sessions, 30 turns and 10-minute idle are code constants shown on the page. Why: Every variable is a form field a no-coder must understand; the default prompt already carries the names and the caps only matter to the owner.
- **.env.example and the README env table are generated from the config schema**. scripts/docs-env.ts writes both from the EnvSpecs; CI runs --check. Why: A parity test alone still lets descriptions drift; generation makes the schema the single source of truth the success criteria demand.
- **A scripted fake LLM provider is accepted by config for CI and the simulator**. LLM_PROVIDER=fake is valid but not advertised; the simulator spawns the built server with it, and the same script signs upgrades like Twilio for live 20-call runs. Why: An OpenAI-compatible mock server would be brittle against SDK and API format changes; a 60-line provider behind the same seam also exercises the registry and config paths.

## Open questions / dissent
### Resolved at the gate (2026-09-09)
- Q1: AGENT_END_CALL defaults to true. The built-in end_call capability is tolerated by the criterion, which now reads 'handoff_to_team is the only registry tool visible to the model'.
- Q2: Tokenless status page shows readiness and the full problem list without values (variable, what, fix). STATUS_TOKEN still gates the Twilio URL, the test chat and the self-test.
- Q3: STATUS_TOKEN unset is a warning that hides the URL, chat and self-test; calls still run. It is the same tokenless view, not a second mode.
- Q4: LLM error and timeout end as reasonCode live-agent-handoff with reason llm_error / llm_timeout after FALLBACK_MESSAGE; call.ended outcome is error. 'reason timeout' in the criteria means reason max_call_seconds under end-call.
- Q10: Latency targets 1.5 s median and 3 s p95 to first text are accepted as proxies; ms_prompt_to_first_text_out is measured at the send call of the first text frame; the default OpenAI model name is verified at build.
- Q12: Anthropic, Google, Mistral and Groq ship unit-tested with mocked keys only; live smoke tests only if the owner supplies keys.
- Q13: The Make blueprint stays the minimal receive-and-respond scenario with a router on event; Zapier and n8n are README notes only.
- Q14: The WebSocket upgrade route gets its own rate-limit bucket (300/min per IP); HTTP routes keep 60/min.
- Q15: POST /selftest ships in v1; the example Make blueprint routes event 'test'.
- Q16: The greeting is Studio's Welcome Greeting; the server waits for the first prompt.
- Q17: The example flow keeps an editable placeholder Say sentence for the consent notice.
- Q19: The name is voice-server. The owner verifies the deploy button from a fresh Railway account at the release stage; the hello-deploy is an owner action, never a build blocker.
- Q20: Accepted: clean-call rate and support load are observable only on the owner's deployment and GitHub Issues; the issue template asks for the status page text.

### Verify at build (owned by the build stages; record the answer in the feature spec)
- Q5: Verify at build the exact URL Twilio signs for the ConversationRelay upgrade (wss vs https scheme, port) and whether the variant set can be reduced to one; confirm the header arrives lowercase.
- Q6: Verify whether Twilio's end frame waits for queued TTS; tune or zero the grace delay and reconcile with the 'ends before the timeout window plus 2 seconds' criterion.
- Q7: Verify Make custom webhook API-key header name (x-make-apikey), the n8n Header Auth convention and that Zapier Catch Hook returns only a fixed acknowledgement; confirm AUTOMATION_WEBHOOK_KEY_HEADER as the override.
- Q8: Verify on a real Studio account whether a Split widget can read {{widgets.X.HandoffData.reasonCode}} and how transfer_to reaches Connect Call To (Set Variables parse-as-JSON or a fixed flow variable); until then the example dials the fixed variable.
- Q9: Verify that Railway templates honour a source branch and whether pushes to that branch redeploy every non-ejected deployer; confirm the release-branch policy and whether the README documents the eject-to-own-repo path.
- Q11: AI SDK v7 API shapes (streamText fullStream part names, tool definition, abort, mock language model) must be verified by web fetch against Vercel's docs before llm-providers starts; confirm the v7 pin, exact zod pin and Node 24.

### Owner logistics before the release stage
- Q18: Who is the non-owner tester for the 30-minute rehearsal and when; confirm the prerequisite 'upgraded Twilio account, owned number, AI/ML terms accepted' and how the trial-account limitation is documented.

### Original open questions (verbatim, numbered as at the gate)
1. AGENT_END_CALL default: true (drafted, matches two lenses and the brief's recommendation) or false (risk lens: premature endings are undetectable)? Also confirm the success-criterion wording 'handoff_to_team is the only tool visible to the model' tolerates the built-in capability.
2. Tokenless status page: readiness plus problem count only (drafted, matches the criterion) or the full problem list without values (pragmatic lens) so a deployer sees what to fix before hunting for the token?
3. STATUS_TOKEN unset: warning that hides the URL, chat and self-test (drafted) or a blocking problem (pragmatic lens: no second mode)?
4. Fault end policy: confirm that LLM error and timeout end as reasonCode live-agent-handoff with reason llm_error/llm_timeout (caller goes to a human) rather than a separate 'error' reasonCode, and that 'reason timeout' in the criteria maps to reason max_call_seconds under end-call.
5. Verify at build the exact URL Twilio signs for the ConversationRelay upgrade (wss vs https scheme, port) and whether the variant set can be reduced to one; confirm the header arrives lowercase.
6. Verify whether Twilio's end frame waits for queued TTS; tune or zero the grace delay and reconcile with the 'ends before the timeout window plus 2 seconds' criterion.
7. Verify Make custom webhook API-key header name (x-make-apikey), the n8n Header Auth convention and that Zapier Catch Hook returns only a fixed acknowledgement; confirm AUTOMATION_WEBHOOK_KEY_HEADER as the override.
8. Verify on a real Studio account whether a Split widget can read {{widgets.X.HandoffData.reasonCode}} and how transfer_to reaches Connect Call To (Set Variables parse-as-JSON or a fixed flow variable); until then the example dials the fixed variable.
9. Verify that Railway templates honour a source branch and whether pushes to that branch redeploy every non-ejected deployer; confirm the release-branch policy and whether the README documents the eject-to-own-repo path.
10. Default OpenAI model: verify the current fast non-reasoning model name at build; confirm latency targets 1.5 s median and 3 s p95 to first text and whether timing measures agent emission or socket flush.
11. AI SDK v7 API shapes (streamText fullStream part names, tool definition, abort, mock language model) must be verified by web fetch against Vercel's docs before llm-providers starts; confirm the v7 pin, exact zod pin and Node 24.
12. Does the owner have Anthropic, Google, Mistral or Groq keys for a live smoke test, or do the four ship unit-tested only?
13. Make blueprint scope: the minimal receive-and-respond scenario with a router on event (drafted) or the owner's real roster lookup plus CRM flow? Are Zapier and n8n example exports wanted beyond README notes?
14. Rate limit of 60/min per IP applied to the upgrade route as well: confirm it cannot refuse legitimate Twilio bursts from shared egress IPs at MAX_CONCURRENT_CALLS=10, or give the upgrade route its own bucket (domain lens).
15. Self-test endpoint: confirm the extra surface (POST /selftest with an event 'test' webhook post the Make blueprint must route) is wanted for v1.
16. Greeting ownership: Studio Welcome Greeting with the server waiting for the first prompt (drafted, no server round trip). Confirm.
17. Consent notice: keep an editable placeholder Say sentence in the example flow (drafted) or leave the Say widget empty and rely on the README disclaimer?
18. Who is the non-owner tester for the 30-minute rehearsal and when; confirm the prerequisite 'upgraded Twilio account, owned number, AI/ML terms accepted' and how the trial-account limitation is documented.
19. Repo and template naming (voice-server vs voice-agent) and who verifies the deploy button from a fresh Railway account; confirm HTTP public networking is on in the template so RAILWAY_PUBLIC_DOMAIN exists at first boot.
20. KPI measurement without telemetry: accept that clean-call rate and support load are only observable on the owner's deployment plus GitHub Issues, with the issue template asking for status page text.

### Dissent (verbatim from the architecture lenses, with the gate's resolution where one was made)
1. end_call default — risk lens (rejected option): "Built-in end_call capability enabled by default — LLMs end calls prematurely often enough that it would silently degrade caller experience without a measurable signal; ships opt-in (AGENT_END_CALL=false) and the idle timeout covers the caller who walks away." Domain lens: "AGENT_END_CALL: boolean /*true, flag for the open question*/". Pragmatic lens: "end_call (built-in, reasonCode completed) deviates from the literal 'exactly one tool' wording; without it the AI can never close a call and outcome 'completed' is unreachable; mitigation: it is one registry line to remove if the gate says no." Draft ships default true. **Gate: default true (open question 1).**
2. Status token transport — domain lens (rejected option): "STATUS_TOKEN passed as a query string — Tokens in URLs end up in Railway HTTP logs and browser history; an unlock form setting an HttpOnly cookie works without JavaScript and keeps the secret out of URLs." Risk lens: "statusTokenGate: accepts ?token= once, sets an HttpOnly, Secure, SameSite=Strict cookie and redirects to / without the query so the token never persists in Railway HTTP logs or browser history". Pragmatic lens keeps the token on every request: "GET / [?token=STATUS_TOKEN]" with "Fastify request logging is disabled so query strings (the status token) never reach logs." Draft takes the one-time exchange.
3. Tokenless page content — pragmatic lens: "Tokenless status page shows problem names and fixes (no values) rather than readiness only, deviating from the literal criterion so a deployer sees what to fix before hunting for the token; mitigation: gate decision, one branch in page.ts to change." Risk lens: "Tokenless: 'Ready'/'Not ready' + problem count + 'Open this page with your STATUS_TOKEN (see Railway variables)'." Draft takes readiness plus count. **Gate: pragmatic option, the value-free problem list is shown without the token (open question 2).**
4. STATUS_TOKEN required or warning — pragmatic lens (rejected option): "Optional no-token status page mode — Two security modes double the page's test matrix and leave an anonymous LLM-spend endpoint on a guessable domain; STATUS_TOKEN is always required, generated by the template, with a dev placeholder in .env.example." Risk lens: "STATUS_TOKEN: secret (>= 16 chars) // warning if unset: wss URL and chat hidden, calls still allowed; no tokenless mode". Draft takes the warning. **Gate: warning, as drafted (open question 3).**
5. Fault end policy — risk lens (rejected option): "Hang up on LLM error or timeout — Dropping a caller on a server fault is the failure mode the clean-call KPI exists to prevent; faults route to live-agent-handoff after the fallback sentence." Domain lens: "LLM_TIMEOUT_MS and LLM errors (speak FALLBACK_MESSAGE then end error)" with "reasonCode: 'live-agent-handoff'|'completed'|'timeout'|'error'". Pragmatic lens: "LLM timeout/error path that speaks FALLBACK_MESSAGE and ends with reasonCode error". Draft takes the two-value reasonCode with faults routed to a human; the success criteria say "the session ends with handoffData reason error". **Gate: faults route to a human, as drafted (open question 4).**
6. Webhook response merge — domain lens: "make|n8n 2xx with JSON object -> fields merged into HandoffData (status ok)" with "server-owned keys cannot be overwritten by the response". Pragmatic lens: "scalar fields (string | number | boolean, at most 20 keys, strings cut to 500 chars, reserved HandoffData keys ignored) merged into HandoffData". Risk lens (rejected option): "Let the webhook response be merged wholesale into handoffData — A buggy or compromised scenario could inject arbitrary fields into the Studio flow; a three-key allowlist with length caps." Draft takes the allowlist.
7. Transcript flag and name variables — pragmatic lens (rejected option): "HANDOFF_INCLUDE_TRANSCRIPT, agent-name and business-name env vars — Not load-bearing for v1; names live in SYSTEM_PROMPT, the transcript stays on the server for privacy, and both are additive later without breaking the payload." Domain lens: "HANDOFF_INCLUDE_TRANSCRIPT: boolean /*false*/" and "AGENT_NAME: string; BUSINESS_NAME: string". Draft keeps the transcript flag (default false) and drops the name variables.
8. Rate limiting the upgrade route — domain lens: "Twilio upgrades share few egress IPs, so the WebSocket route gets its own generous bucket to avoid refusing legitimate calls during a burst." Risk lens: "rate-limit configuration (60/min per first-hop X-Forwarded-For IP, trustProxy on, applied to every HTTP route including the upgrade route, verified by test)". Draft applies one limit everywhere and flags the bucket question. **Gate: separate bucket for the upgrade route (open question 14).**
9. Signature warn mode — pragmatic lens: "TWILIO_AUTH_TOKEN (required; signature always validated)". Risk lens (rejected option): "Make Twilio signature validation optional (warn) by default — A default that silently accepts unsigned upgrades is unsafe for strangers to deploy; enforce is the default and warn is an explicit, page-visible escape hatch." Draft ships enforce by default with the warn escape hatch.
