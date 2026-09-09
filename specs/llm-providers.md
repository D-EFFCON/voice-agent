# Spec: llm-providers

**Author:** /build spec assembler (Claude Code), on behalf of the voice-server owner
**Date:** 2026-09-09
**Status:** In Review
**Reviewers:** the owner (human gate); the contract lock flips this to Approved
**Feature map row (verbatim):** `| llm-providers | foundation:seam-contracts-and-test-doubles, foundation:config, foundation:log | llm |`
**Branch:** `build/llm-providers` (never pushed, no remote, never `main` or `release`)
**Related:** `.claude/project/blueprint.md` (component `llm (src/llm/)`, decisions "Agent core owns the tool loop" and "A scripted fake LLM provider", gate resolutions Q10, Q11, Q12); `docs/adr/0001` (degraded boot, no network at boot); `docs/adr/0002` (additive deployer contracts); `docs/adr/0003` (module-owned seam types, static registries); locked seam `src/llm/types.ts` and `src/llm/registry.ts`
**Revision:** 3 (2026-09-10), the second contract lock's objections folded in (three must-fix, thirteen nice-to-have; the two not applied are recorded with their reason in Appendix B, B-1 and B-11). Revision 2 was the contract-lock escalation decision of 2026-09-09 (human constraint 11): the first lock's validators refused twice and their objections are folded in as binding constraints, never overridden; base revision committed at 3d4f2cf on `build/llm-providers`
**Inputs folded in:** UX flows, surfaces, states and accessibility notes (13 flows, 12 surfaces), the draft contracts of the lock revision (12), the test plan of the lock revision (71 criteria, 56 edge cases, 22 NFR checks), the binding human constraints (11, the contract-lock escalation decision included)

Repository: `C:/Coding Projects/voice-agent`. Every path below is relative to it unless written absolute.

---

## Context

The LLM seam was locked at foundation:seam-contracts-and-test-doubles: `src/llm/types.ts` declares `LlmClient`, `LlmEvent`, `LlmError`, `LlmProviderModule`, and `src/llm/registry.ts` lists six providers and exposes `createLlmClient`, `llmCatalog` and `advertisedProviderIds`. Config already derives the `LLM_PROVIDER` values, the `LLM_MODEL` default text and the `<ID>_API_KEY` variables from that catalog, and the README table and `.env.example` are generated from it. What is missing is everything behind `create()`: today every provider file returns `stubClient`, so no call can be answered, the self-test can only say "not wired up yet", and the fake provider that CI and the simulator rely on has no script. This feature fills the seam without editing it (ADR 0003).

The deployer is a no-coder whose only support channel is the status page. The first-deploy failures are known: a key pasted with a stray character, a model name with a typo, a model that reasons for twenty seconds before its first word, an exhausted quota, a provider outage. Each has to surface as one plain sentence that names the variable to fix and never the value, identically on the tokened page, in `POST /selftest`, in the recent-problems list, in `call.ended.error_kind` and in the README troubleshooting section, so the deployer can go from the page to the fix by find-in-page. The blueprint fixes the machine keys (`auth`, `rate_limit`, `timeout`, `network`, `model_not_found`, `aborted`, `unknown`) and this spec fixes the sentences.

Two blueprint decisions bound the design. "Agent core owns the tool loop; the AI SDK is a stateless stream behind LlmClient": `streamText` is called once per step with tools declared but never executed by the SDK, and text-delta, tool-call and finish are normalised into `LlmEvent`s. "A scripted fake LLM provider is accepted by config for CI and the simulator": `LLM_PROVIDER=fake` is valid but never advertised. The gate added Q10 (latency proxies 1.5 s median and 3 s p95 to first text; the default OpenAI model verified at build), Q11 (verify the AI SDK's current major and API shapes against Vercel's docs before writing `aiSdkClient.ts`; confirm the exact zod pin and Node 24) and Q12 (Anthropic, Google, Mistral and Groq ship unit-tested with mocked keys only).

Verification done for this spec (2026-09-09). The npm registry `latest` tag of `ai` is 7.0.94 (6.0.278 and 5.0.253 are maintenance tags), so the blueprint's "v7" stands; `@ai-sdk/openai` 4.0.62, `@ai-sdk/anthropic` 4.0.50, `@ai-sdk/google` 4.0.65, `@ai-sdk/mistral` 4.0.40, `@ai-sdk/groq` 4.0.38 and `zod` 4.5.4 are the published versions and become exact pins. The API shapes (streamText options, fullStream part names and fields, tool definition without `execute`, abort handling, error classes, `MockLanguageModelV4` from `ai/test`) were read from ai-sdk.dev, the vercel/ai source and the published type declarations and are recorded in section 7.9 so the implementer builds against a checked list, not memory. The default OpenAI model moves from `gpt-5-mini` to `gpt-5.6-terra` with `reasoningEffort: 'none'`; the sources are recorded in section 7.6 and the owner's live check in `docs/acceptance.md` section 2 confirms the latency, never as a build gate. Re-verified for revision 2 from the published declaration files of `ai` 7.0.94 and `@ai-sdk/provider` 4.0.11 and the `dist` files of the pinned provider packages: `streamText` has a `streamRetries` option whose documentation reads "omit to disable all stream retry behavior" and an `onError` that may return `{ retry: true }`; `fullStream` emits `{ type: 'abort' }` when its `abortSignal` aborts; the part union also carries `reasoning-file`, `tool-output-denied`, `tool-approval-request` and `tool-approval-response`; `MockLanguageModelV4` reports `specificationVersion 'v4'`; `@ai-sdk/openai` 4.0.62 reads `OPENAI_BASE_URL` and `@ai-sdk/anthropic` 4.0.50 reads `ANTHROPIC_BASE_URL` through `loadOptionalSetting` while the google, mistral and groq packages read no base URL from the environment (the google entry file declares an unquoted `DEFAULT_BASE_URL` constant, which is why AC-5 tests for a JSON-quoted `"…_BASE_URL"` literal, revision 3); zod 4.5.4 types the `toJSONSchema` target as `'draft-04' | 'draft-07' | 'draft-2020-12' | 'openapi-3.0'` and only normalises `'draft-7'` as a legacy alias. Human constraint 2 still requires the implementer to repeat this check immediately before writing `src/llm/aiSdkClient.ts`; this record is an input to that check, not a substitute.

Revision 2 folds in the three binding objections of the contract lock: (a) `Deadlines` gains `abort(): void`, idempotent, which aborts the combined signal without recording an outcome, so `outcome()` stays null, a self-abort never produces a timeout sentence and NFR-5's listener count is unaffected; FR-17 and FR-31 cite it as the mechanism that releases the HTTP request after every terminal event and after the probe's first token, FR-12 keeps `abortSignal: deadlines.signal` as the single signal handed to `streamText`, an `abort` stream part arriving after the terminal is ignored, AC-10, AC-17, AC-18 and AC-37 observe `abortSignal.aborted === true` through it, and `providers/fake.ts` builds on the same shape (sections 7.2, 7.4, 8.6); (b) section 8.12 is the data model of `LLM_ERROR_TEMPLATES` / `LlmErrorTemplate { kind, variant, template }` with the primary key `(kind, variant)`, a closed `variant` enum of exactly the 13 ids of section 7.3, the fake's bare-`fail` sentence explicitly outside the table, the coverage invariant that the selector `(kind, keyEnv === null, isDefaultModel, phase, status !== undefined)` resolves to exactly one row for every reachable combination (enforced by an enumerating test, AC-66), and the closed placeholder vocabulary `<p>`, `<KEY>`, `<status>` with the invariant that no `<` or `>` survives rendering (enforced by a test over every row, AC-67); OS-4, AC-24 and NFR-17 reference that entry; (c) the revised spec is formatted with `pnpm prettier --write specs/llm-providers.md` so `pnpm lint` stays green, and committed on `build/llm-providers` (AC-71).

Revision 3 folds in the second contract lock's objections. Binding (must-fix): (a) the period rule of FR-25 is scoped to `LlmError.message` values (the 60 catalogue sentences and `FAKE_FAIL_MESSAGE`); the fake's scripted text replies end with `.` or `?` (FR-37), and the echo, which embeds caller text, is asserted only on fixed fixtures (AC-25, NFR-16); (b) AC-5's base-URL clause tests for a JSON-quoted `"…_BASE_URL"` literal, because the pinned `@ai-sdk/google` 4.0.65 entry file declares an unquoted `DEFAULT_BASE_URL` identifier that a bare substring search hits; (c) section 7.7 gains the timer obligation that agent-core arms no timer aborting `req.signal` at or before `timeoutMs`, so a production timeout is always the client's `timeout` kind and the four timeout sentences have a producer (FR-18, 8.5). Nice-to-have objections applied: the undefined-`usage` fixture leaves AC-15, because a v4 `finish` part requires `usage` (8.11); every `fullStream` read is raced against `deadlines.signal` (FR-17, FR-32, EC-5); the directory-scan helpers are named and `id` is declared unique (FR-6, AC-47, 8.1); `AiSdkClientOptions.keyEnv` is a non-empty `string`, `null` staying in `LlmErrorContext` for the fake (FR-10, 7.2, 8.2); agent-core records `toolInput` as a JSON object (7.7, EC-35); the fake's tool-call finishes carry `usage` with `outputTokens` 0 (person) and 7 (human) (FR-34, FR-35, AC-40, AC-41, 8.7); an `APICallError.statusCode` that is not an integer in 100..599 is treated as absent (FR-26, FR-27, 8.3, AC-23); the `Deadlines` state line is three independent facts (7.4); NFR-17 is restated as binding where `LlmError.message` is printed verbatim and conditional on B-3 (the JSON) and B-5 (the README); `parallelToolCalls: false` is recorded as the recommended openai addition (EC-43, B-11); the two seam-comment widenings are queued as B-10. Not applied: an `auth/missing` template row (reason in B-1) and `parallelToolCalls: false` inside `LOW_LATENCY` itself (reason in B-11).

Decisions taken in this spec that the inputs left open (each recorded once, here): (a) provider HTTP 5xx and Anthropic 529 classify as `network` because the deployer's next step is the same as for an unreachable host; (b) no retry inside a turn (`maxRetries: 0`) so `LLM_TIMEOUT_MS` stays true and an interruption stays cheap; (c) no boot-time probe (readiness stays config-only, ADR 0001; it would spend a token per deploy); (d) the probe budget is the constant `PROBE_TIMEOUT_MS = 10000` with its own sentence, because the locked `create()` signature cannot carry `LLM_TIMEOUT_MS`; (e) low-latency provider options apply only when the exact default model is in use; (f) the message length bound is 180 characters, because the `unknown` sentence with an HTTP status measures 171 to 176 characters for the shipped provider ids (the draft contract's 170 is superseded); (g) `zod` is pinned exactly at 4.5.4 as the blueprint asked, a documented exception to the caret ranges elsewhere; (h) `src/llm/stub.ts` is deleted; (i) `createAiSdkClient` accepts an optional `baseURL` for OpenAI-compatible hosts, forwarded unchanged to whichever `@ai-sdk/*` factory the sdk map names (only the openai sdk switches API on it), but no such provider file ships; (j) the fake provider's script gains `fail <kind>`, the `person` (no turn text) versus `human` (with turn text) split and an echo reply; a `goodbye` trigger is out of scope; (k) the timeout phase is decided by the first-token state, not by which timer fired: any client timer before the first forwarded token reports `first`, so with `stallMs` and `timeoutMs` both equal to `LLM_TIMEOUT_MS` (the only configuration config produces) a model that never starts answering always yields the 'did not start answering' sentence, and a same-tick tie after the first token reports `gap`; (l) plain history messages (system, user, assistant without a tool call) whose content is empty or whitespace-only are dropped before the SDK call, because the agent records an interrupted turn as `''` and Anthropic rejects empty text with HTTP 400; (m) the 13 sentence templates are exported as data (`LLM_ERROR_TEMPLATES`) and `llmError` renders from them, so the README glossary and the snapshot share one source; (n) the self-abort that releases the HTTP request after a terminal event and after the probe's first token is `Deadlines.abort()`, a member that records no outcome, rather than a second controller inside the client, so one signal reaches `streamText` and a finished turn can never become a phantom timeout (revision 2); (o) `streamRetries` is omitted from every `streamText` call, never set to 0, because the SDK documents that 0 enables an `onError`-requested retry while omission disables all stream retry behaviour, and `onError` returns `undefined`, never `{ retry: true }`, so no step is re-run after words were spoken to the caller (revision 2); (p) the zod `toJSONSchema` target literal is the typed `'draft-07'`, not the legacy alias `'draft-7'` an earlier draft of this spec used (revision 2); (q) the SDK-level `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` reads are documented in the README rather than defeated by pinning vendor URLs in code (OS-20, revision 2); (r) a non-finite token count in a `finish` part is treated as absent, so no `usage` field can render as `null` in a log line (revision 2); (s) the variant of a template is a closed enum and the selector is a total function, so a selector combination without a row fails a test at build rather than rendering an empty sentence at runtime (section 8.12, revision 2).

---

## Functional Requirements

### Registry and catalog (locked seam, unchanged)

- FR-1: `src/llm/types.ts` and `src/llm/registry.ts` MUST remain byte-identical to the foundation versions: `createLlmClient({ provider, model?, apiKey })` keeps its signature, still trims the model and falls back to `defaultModel` when the model is undefined, blank or whitespace, and still throws `Unknown LLM_PROVIDER. Valid values: openai, anthropic, google, mistral, groq.` for an unregistered id without echoing the input.
- FR-2: `providers.map((p) => p.id)` MUST equal `['openai', 'anthropic', 'google', 'mistral', 'groq', 'fake']`, `advertisedProviderIds` MUST equal the first five, and every `llmCatalog` entry MUST carry exactly the keys `advertised`, `defaultModel`, `description`, `id`, `keyDescription`, `keyEnv` with JSON-safe values.
- FR-3: `createLlmClient` MUST be synchronous and side-effect free: it MUST NOT perform I/O, MUST NOT instantiate any `@ai-sdk/*` factory (the SDK model is created lazily inside `stream()` and `probe()`), and MUST return a plain object with `provider` and `model` set.
- FR-4: Provider metadata MUST be: `defaultModel` `gpt-5.6-terra` (openai), `claude-haiku-4-5` (anthropic), `gemini-2.5-flash` (google), `mistral-small-latest` (mistral), `llama-3.3-70b-versatile` (groq), `scripted` (fake); `keyEnv` `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY` and `null` (fake); `description` and `keyDescription` byte-identical to the foundation strings; every `id` matching `/^[a-z0-9]{1,12}$/` (the 12-character cap keeps every catalogue sentence within the 180-character bound, section 8.1); `advertised` true for all but fake.
- FR-5: Every non-null `keyEnv` MUST equal the default environment variable name of the matching `@ai-sdk/<id>` package, so a snippet that relies on the SDK's default variable uses the variable this build documents.
- FR-6: Every file `src/llm/providers/<id>.ts` MUST be listed in `providers[]` with `id` equal to the file's basename, every registered `id` MUST have such a file, and `id` MUST be unique across `providers[]` (it is the primary key of the registry: `createLlmClient` resolves a provider with `find`, so a duplicate would shadow its twin silently while config still listed it, 8.1); a directory-scan test in `test/llm/registry.test.ts` compares the two sets through the helpers `unregisteredProviderFiles(dir, registeredIds): string[]` and `unfiledProviderIds(dir, registeredIds): string[]` exported by `test/helpers/providerFiles.ts` (both return sorted basenames with `.ts` stripped, and both MUST return `[]` for `src/llm/providers` and the real registry) and asserts `new Set(ids).size === providers.length` (AC-47; revision 3).
- FR-7: `src/llm/stub.ts` MUST be deleted and nothing under `src/` MUST import `./stub.js` or `../stub.js` afterwards.

### `src/llm/aiSdkClient.ts` (construction)

- FR-8: `src/llm/aiSdkClient.ts` MUST be the only file under `src/` that imports `ai`, `ai/*` or `@ai-sdk/*`, and MUST export `createAiSdkClient`, the types `AiSdkClientOptions` and `SdkFactoryId`, and the constants `PROBE_TIMEOUT_MS = 10_000`, `PROBE_MAX_OUTPUT_TOKENS = 16` and `PROBE_PROMPT = 'Reply with the single word OK.'`.
- FR-9: `createAiSdkClient(o)` MUST return synchronously and MUST NOT throw for any input; the provider package is instantiated lazily inside `stream()` and `probe()`, and a synchronous throw there (for example an unusable `baseURL`) MUST be classified like a stream error (kind `unknown`, no status).
- FR-10: `AiSdkClientOptions.apiKey` MUST be typed `string` (never `undefined`); an empty string MUST end the stream and the probe with kind `auth` without any request, and the client MUST NOT read `process.env` under any circumstance, so the selected provider's key is the only key that can ever be used. `AiSdkClientOptions.keyEnv` MUST be typed `string` and be non-empty (matching the 8.1 pattern; revision 3): a client built through `createAiSdkClient` always names the variable its `auth` sentence points at, so the `auth/nokey` sentence (whose fix clause names no variable) is reachable only through the fake, which passes `keyEnv: null` to `llmError` directly, and `''` can never render as `in .`; a provider file for a keyless OpenAI-compatible host (OS-9) still declares a key variable whose value the host ignores.
- FR-11: The `sdk` map MUST be: `openai` to `createOpenAI({ apiKey, baseURL? })` using `openai(model)` (Responses API) when `baseURL` is absent and `openai.chat(model)` (Chat Completions) when `baseURL` is present; `anthropic` to `createAnthropic`; `google` to `createGoogleGenerativeAI`; `mistral` to `createMistral`; `groq` to `createGroq`; the key and model MUST reach the factory unchanged, and `baseURL`, when set, MUST be forwarded unchanged to every factory (each `@ai-sdk/*` factory accepts `{ apiKey, baseURL }`), never ignored or rejected: only the `openai` sdk changes API on it, so a provider file copied from `groq.ts` with a `baseURL` gets the Groq SDK pointed at that host.

### `stream()` mapping

- FR-12: `stream(req)` MUST call `streamText` exactly once per call with `{ model, messages, tools, abortSignal: deadlines.signal, maxRetries: 0, providerOptions: o.providerOptions, onError: () => {} }`, where `deadlines.signal` is the single signal handed to the SDK (the client owns no second controller; releasing the request is `deadlines.abort()`, FR-17), and MUST NOT pass `streamRetries` (omitted, never set to 0: the SDK documents that 0 enables an `onError`-requested retry that re-runs the step and can re-emit deltas after words were spoken to the caller, while omitting the option disables all stream retry behaviour, EC-44), `timeout`, `onAbort`, `stopWhen`, `toolChoice`, `headers`, `fetch` or `maxOutputTokens` (the SDK default `stopWhen: stepCountIs(1)` ends the step after tool calls because no tool has `execute`).
- FR-13: `onError` MUST always be overridden with a no-op that returns `undefined` synchronously, never `{ retry: true }` and never a promise, so the SDK's default `console.error` of the raw provider error never runs and no retry is ever requested; `console.error` MUST NOT be called by anything in `src/llm`.
- FR-14: `LlmMessage[]` MUST map to SDK `ModelMessage[]` as: `system` to `{ role: 'system', content }`; `user` to `{ role: 'user', content }`; `assistant` without `toolCallId` to `{ role: 'assistant', content }`; `assistant` with `toolCallId` to an assistant message whose content is `[{ type: 'text', text: content }]` (only when `content.trim() !== ''`) followed by `{ type: 'tool-call', toolCallId, toolName: toolName ?? '', input: toolInput ?? {} }`; `tool` to `{ role: 'tool', content: [{ type: 'tool-result', toolCallId: toolCallId ?? '', toolName: toolName ?? '', output: { type: 'text', value: content } }] }`; a missing id or name MUST substitute `''` and MUST NOT throw. Before mapping, every plain message (`system`, `user`, or `assistant` without `toolCallId`) whose `content.trim()` is `''` MUST be dropped: the agent legitimately records an assistant turn as `''` when an interrupt lands before its first word, and Anthropic rejects empty or whitespace-only text with HTTP 400 (`unknown (HTTP 400)`), which would repeat on every later turn of the call while the message stays in history; the tool-call variant keeps its tool-call part and drops only its text part under the same rule, the tool-result variant is forwarded as is (an empty `content` included), and a history that is empty after the drop is passed to the SDK as is, whatever it answers being classified as usual, never a throw. Consecutive assistant tool-call messages (one per parallel call, EC-43) MUST each map independently; the seam comment on `toolCallId` ('Set on tool messages') is narrower than this use on assistant messages, a widening this spec records rather than edits (ADR 0003; the comment-only seam revision is queued as B-10). `toolInput` is mapped verbatim, so the obligation in section 7.7 that agent-core records a JSON object there (never the unparsed string FR-16 forwards for a malformed call) is what keeps the re-prompt after a malformed call from answering HTTP 400 on Anthropic and Google (EC-35; revision 3).
- FR-15: Each `LlmToolSpec` MUST be declared as `tools[spec.name] = tool({ description: spec.description, inputSchema: jsonSchema(z.toJSONSchema(spec.inputSchema, { target: 'draft-07', io: 'input', unrepresentable: 'any' })) })` with no `execute` and no `validate`, so the SDK never runs a tool and never validates its input; the target literal MUST be the typed `'draft-07'` of zod 4.5.4 (`'draft-7'` compiles only through the `{} & string` escape and works only because zod normalises the legacy alias, EC-21), and the conversion MUST NOT throw for any schema.
- FR-16: `fullStream` parts MUST map as: `text-delta { text }` to `{ type: 'text-delta', text }` forwarded immediately, unmodified and never coalesced, an empty `text` dropped but still re-arming the stall timer; `tool-call { toolCallId, toolName, input }` to `{ type: 'tool-call', toolCallId, name: toolName, input }` forwarded with the raw input even when the part carries `invalid: true` or an unknown tool name; `finish { finishReason, totalUsage }` to `{ type: 'finish', finishReason, usage }` with `stop`, `tool-calls` and `length` passed through, `content-filter` and `other` as `other`, `usage: { inputTokens, outputTokens }` with undefined fields omitted and the `usage` key itself omitted unless at least one of the two is a number (a `totalUsage` object with both undefined yields no `usage` key, never `usage: {}`); `finish` with reason `error` and no earlier error part to `{ type: 'error', error: unknown without status }`; a `totalUsage` count that is not a finite number (`NaN`, `Infinity`) treated as absent, so no `usage` field can ever serialise as `null` (EC-52); `error { error }` to `{ type: 'error', error: classify(error) }`; `abort` to the kind decided by `deadlines.outcome()` (`aborted` when the caller's signal is aborted, `timeout` with the phase `outcome()` reports when a client timer fired, else `unknown` without status) without ever reading the part's reason text, except that an `abort` part arriving after the terminal event (the SDK emits one when the client's own `deadlines.abort()` aborts the signal, EC-45) is ignored like every other later part and never mapped; an exception thrown while iterating to `{ type: 'error', error: classify(thrown) }`; `start`, `start-step`, `finish-step`, `reasoning-*` (`reasoning-file` included), `source`, `file`, `raw`, `custom`, `tool-input-*`, `tool-result`, `tool-error`, `tool-output-denied`, `tool-approval-request`, `tool-approval-response` and any part type not named in this list dropped after re-arming the stall timer, never mapped to an error (EC-51).
- FR-17: Every stream MUST emit exactly one terminal event (`finish` or `error`); after emitting it the client MUST call `deadlines.abort()` (which aborts the combined signal handed to `streamText`, so the HTTP request is released, without recording an outcome, so `outcome()` stays null and no timeout sentence can follow) and then `deadlines.clear()` (both timers cleared, the caller listener removed), stop iterating and ignore every later part, the SDK's `abort` part caused by that self-abort included; the same `abort()` then `clear()` MUST happen in the generator's `finally` when the consumer stops early; `stream()` MUST NOT throw; once `req.signal` is aborted no further non-terminal event MUST be emitted; a finished turn MUST never turn into a timeout (AC-64). Every `await` on the `fullStream` iterator MUST be raced against the abort of `deadlines.signal` (one `abort` listener on the combined signal per stream, added before the first read and removed in the same `finally`; it is the client's own per-stream signal, so NFR-5's count on the caller's signal is unaffected), so the terminal follows the abort instant even when the SDK neither emits an `abort` part nor rejects the pending read (EC-5), with the kind still taken from `outcome()` (FR-21); the read left pending by a won race MUST be settled silently (a no-op rejection handler attached, its value discarded), so no unhandled rejection can surface; the promptness criteria (AC-31, AC-35, AC-38c, NFR-2, NFR-3) therefore rest on the client, never on SDK internals (revision 3).
- FR-18: When the caller's signal and a client timer fire in the same tick the terminal MUST be kind `aborted`, never `timeout`; a caller signal that is already aborted before `stream()` is called MUST yield a single `aborted` event without any SDK call. Because the caller's signal always wins, the four timeout sentences have a producer in production only if no agent timer aborts `req.signal` first: section 7.7 binds agent-core to arm no timer that aborts `req.signal` at or before `timeoutMs`, so `req.signal` aborts only for an interrupt or a hangup, the client's `timeoutMs` and `stallMs` are the only LLM timeout, and the agent's `llm_timeout` outcome is derived from the client's `timeout` kind (revision 3).
- FR-19: The client MUST record the time of the first forwarded token only to call `firstToken()` (which moves the timeout phase from `first` to `gap` or `total`, FR-20) and to report `probe().ms`; the clock is `Date.now()` (integer milliseconds, faked by vitest's fake timers by default, which `performance.now()` is not), and it MUST NOT delay, buffer or annotate events for that purpose.

### `src/llm/deadlines.ts` (timeout and abort policy)

- FR-20: `createDeadlines({ signal, timeoutMs, stallMs })` MUST return `{ signal, touch(), firstToken(), outcome(), abort(), clear() }` where: `abort()` is idempotent, aborts the combined `signal` without recording an outcome (so `outcome()` stays null and a self-abort never yields a timeout sentence), adds no listener to the caller's signal (NFR-5's listener count is unaffected), never aborts the caller's signal, never erases an outcome a timer already recorded, and a timer firing after `abort()` is ignored; the total timer is armed at creation for `timeoutMs` and never re-armed; the stall timer is armed at creation for `stallMs` and re-armed on every `touch()` (and by `firstToken()`), so before the first token it bounds time-to-first-token as well, a deliberate widening of the seam comment on `LlmStreamRequest.stallMs` ('once streaming has started') that this spec records rather than edits (ADR 0003; the comment-only seam revision is queued as B-10) and that a consumer passing `stallMs < timeoutMs` must expect (such a consumer gets `timeout`/`first` at `stallMs`, not at `timeoutMs`); both timers are `unref`'d; the combined `signal` aborts when the caller's signal aborts or when either timer fires; the outcome is recorded once, by the first timer callback to run, and every later firing (the re-armed stall timer coming due after the total timer included) is ignored; `outcome()` returns `'caller'` whenever the caller's signal is aborted (even if a timer fired in the same tick), otherwise the phase decided by the first-token state rather than by which timer fired: `'first'` when a timer fired before `firstToken()` was called, whichever timer it was; `'gap'` when the stall timer fired after `firstToken()`; `'total'` when the total timer fired after `firstToken()`, except that when the stall timer is due at the same instant (its due time, tracked on every arm, is not later than now) the total timer's callback MUST record `'gap'`, so a same-tick tie is deterministic whichever callback Node runs first; otherwise `null`; `clear()` is idempotent, clears both timers, removes the caller listener, is safe before or after `abort()`, and a timer firing after `clear()` is ignored; an already-aborted caller signal aborts the combined signal synchronously at creation; values are used as given (config guarantees `LLM_TIMEOUT_MS` in 1000..120000; tests and the fake may pass smaller values, including 0 and 1). Consequence in production, where the agent passes `LLM_TIMEOUT_MS` for both budgets (8.5): the SDK's `start` and `start-step` parts re-arm the stall timer a few milliseconds after creation, so on a model that never starts answering the total timer fires first, and the phase rule above is what makes the 'did not start answering' sentence (never 'took longer than the LLM_TIMEOUT_MS limit to finish') the deterministic output for that case (AC-60); with equal budgets the `'gap'` phase is unreachable, because a re-armed stall timer is always due after the total timer, so a deployer's page and logs show only the `first` and `total` sentences and nobody needs to hunt for the `gap` one.
- FR-21: The kind of a timeout or abort MUST come from `outcome()` only; the SDK's `timeout` option and the free text of its abort reason MUST NOT be used to decide a kind.
- FR-22: `src/llm/deadlines.ts` and `src/llm/errors.ts` MUST import nothing but `./types.js` (no external package), so the fake provider can share them without touching the SDK.

### `src/llm/errors.ts` (kinds and the deployer-facing catalogue)

- FR-23: `src/llm/errors.ts` MUST export `LlmErrorContext`, `TimeoutPhase`, `LlmErrorVariant` (a closed union of exactly the 13 variant ids of section 7.3), `LlmErrorTemplate`, `LlmErrorSelector`, `selectVariant(sel)`, `llmError(kind, ctx, o?)`, `kindForStatus(status, responseBody?)`, `isConnectionFailure(err)`, `CONNECTION_ERROR_CODES`, `LLM_ERROR_PLACEHOLDERS` (exactly `['<p>', '<KEY>', '<status>']`) and the frozen data table `LLM_ERROR_TEMPLATES` (the 13 `(kind, variant)` rows of the section 7.3 catalogue in table order, each `{ kind, variant, template }` with the template carrying only those placeholders; the entity of section 8.12, whose primary key `(kind, variant)` is unique and whose `variant` alone is unique), MUST render every message from that table through `selectVariant`, MUST fail `pnpm typecheck` when a 14th variant id is added or one is renamed without the union changing (a `satisfies` check over the union), and MUST be the single source of every `LlmError.message` produced under `src/llm` (the fake reuses it); the fake's bare-`fail` sentence is explicitly outside the table (FR-34); the table exists so the README troubleshooting glossary (OS-4) and the snapshot are rendered from one source instead of a duplicated variant list.
- FR-24: `llmError` MUST produce exactly the sentences of the catalogue in section 7.3 for each `(kind, variant)` by resolving the variant with `selectVariant({ kind, noKey: ctx.keyEnv === null, isDefaultModel: ctx.isDefaultModel, phase: o?.phase, hasStatus: o?.status !== undefined })`, taking that row's template from `LLM_ERROR_TEMPLATES` and replacing `<p>` with the provider id, `<KEY>` with `keyEnv` and `<status>` with the status; the mapping MUST be: `auth` to `auth/nokey` when `keyEnv` is null (the `in <KEY>` clause dropped) and `auth/key` otherwise; `rate_limit` to `rate_limit`; `model_not_found` to `model_not_found/custom` ("model set in LLM_MODEL") when `isDefaultModel` is false and `model_not_found/default` ("default model of this build") when it is true; `timeout` to `timeout/<phase>` with `first` when no phase is given; `network` to `network`; `aborted` to `aborted`; `unknown` to `unknown/status` (with `(HTTP <status>)`) when a status is known and `unknown/nostatus` otherwise; a dimension a kind does not use MUST NOT change its variant; the selector MUST be total: every one of the 280 selector combinations (7 kinds x `noKey` x `isDefaultModel` x 5 phase values x `hasStatus`) resolves to exactly one existing row and every row is reached by at least one combination, enforced by an enumerating test (AC-66), so no failure can ever render as an empty sentence.
- FR-25: Every `LlmError.message` (the 60 rendered catalogue sentences and `FAKE_FAIL_MESSAGE`; the fake's scripted text replies are not `LlmError` messages and follow FR-37 instead, revision 3) MUST be one or two sentences in sentence case, MUST end with a period, MUST be at most 180 characters, MUST equal its trimmed self, MUST contain no newline, no non-breaking space and none of the characters `<`, `>`, `"`, `&` or backtick (so no placeholder and no markup survives rendering, enforced over every row and every provider, AC-67), MUST use ASCII apostrophes only (none of U+2018, U+2019, U+201C, U+201D), MUST contain no lowercase `http` (a URL), and its runs of two or more capital letters MUST be limited to `API`, `HTTP`, `LLM_MODEL`, `LLM_TIMEOUT_MS` and the provider's `keyEnv`.
- FR-26: `aiSdkClient.ts` MUST classify errors in this order: (1) `req.signal.aborted` to `aborted`; (2) a client timer fired to `timeout` with the phase `outcome()` reports (`probe` inside `probe()`); (3) `LoadAPIKeyError`, or an empty `apiKey`, to `auth`; (4) `NoSuchModelError` to `model_not_found`; (5) `RetryError` to the classification of its `lastError`; (6) `APICallError` with `statusCode` 401 or 403 to `auth`, 404 to `model_not_found`, 402, 429 or 498 to `rate_limit`, 408 or 500..599 (502, 503, 504 and 529 included) to `network`, 400 whose `responseBody` matches `/api key not valid|invalid api key|invalid_api_key|incorrect api key|authentication/i` to `auth`, 400 whose `responseBody` matches `/model_not_found|invalid model|unknown model|model .{0,60}(not found|does not exist)/i` to `model_not_found`, any other integer status in 100..599 to `unknown` with the status kept; (7) `APICallError` without `statusCode` (a `statusCode` that is not an integer in 100..599, such as `0`, `600` or `NaN`, counts as absent, so `(HTTP 0)` or `(HTTP NaN)` can never render, FR-27, 8.3; revision 3), or `isConnectionFailure(err)` (a `TypeError` whose message is `fetch failed`, or an error whose own or `cause.code` is in `CONNECTION_ERROR_CODES`), to `network` without status; (8) `TypeValidationError`, `JSONParseError`, `NoContentGeneratedError`, an `AbortError` while neither signal fired, and anything else to `unknown` without status.
- FR-27: `LlmError.status` MUST be present exactly when the kind was derived from an HTTP status (`auth`, `rate_limit`, `model_not_found`, `network` from 408 or a 5xx, `unknown` with status) and absent for `timeout`, `aborted`, connection failures, non-HTTP errors and an `APICallError` whose `statusCode` is not an integer in 100..599 (treated as no status and classified by row 7 of FR-26; 8.3, AC-23; revision 3).
- FR-28: Messages MUST be built from the templates only: provider text, response bodies, SDK messages, header values, the key and the model id MUST NOT enter a message; as a last resort every message MUST have any occurrence of `o.apiKey` (when it is 8 or more characters) replaced by `[redacted]`.
- FR-29: `aborted` MUST always carry the message `The request was stopped before the provider finished.`, and the contract for consumers (section 7.7) is that it is never spoken, never recorded into recent problems, never counted as an error outcome and never logged above debug.

### `probe()`

- FR-30: `probe()` MUST make one request with `messages: [{ role: 'user', content: PROBE_PROMPT }]`, `tools: {}`, `maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS`, `maxRetries: 0`, the same `providerOptions` as `stream()`, and deadlines `{ timeoutMs: PROBE_TIMEOUT_MS, stallMs: PROBE_TIMEOUT_MS }` with a never-aborted caller signal.
- FR-31: `probe()` MUST resolve `{ ok: true, ms }` where `ms` is the elapsed time (a `Date.now()` difference, an integer) at the first non-empty text-delta, after which the client MUST call `deadlines.firstToken()`, then `deadlines.abort()` (the self-abort that releases the request so at most `PROBE_MAX_OUTPUT_TOKENS` are billed; it records no outcome, so it is never an error and never a timeout sentence) and then `deadlines.clear()`, ignoring every later part, the SDK's `abort` part included; a request that finishes with zero text (including one answered only by a tool call) MUST resolve `{ ok: true, ms }` with `ms` measured at `finish`, followed by the same `abort()` then `clear()`.
- FR-32: On failure `probe()` MUST resolve `{ ok: false, ms, error }` using the same classifier as `stream()`, a timer yielding the `timeout` / `probe` sentence; `probe()` MUST NOT throw, MUST keep no state between calls (concurrent probes are independent), and MUST NOT return the model's text; every `fullStream` read inside `probe()` is raced against `deadlines.signal` as FR-17 requires, so the settlement bound of NFR-4 rests on the client rather than on the SDK's abort handling (EC-5; revision 3).

### `src/llm/providers/fake.ts` (scripted provider)

- FR-33: The fake's metadata MUST stay `id 'fake'`, `advertised false`, `description 'Scripted replies for tests and the simulator. No key and no network.'`, `keyEnv null`, `keyDescription 'No key needed.'`, `defaultModel 'scripted'`; `create({ model })` MUST return an `LlmClient` with `provider 'fake'` that uses `createDeadlines` (the same `Deadlines` shape as the AI SDK client, `abort()` included) and `llmError` with context `{ provider: 'fake', keyEnv: null, isDefaultModel: model === 'scripted' }`, no key and no network; the file MUST export `FAKE_FAIL_MESSAGE = 'The fake provider failed on purpose.'`, a sentence that is deliberately not a row of `LLM_ERROR_TEMPLATES` (section 8.12).
- FR-34: The script MUST run over `text`, the last user message normalised as section 7.5 defines (trimmed, runs of whitespace collapsed to one space; matched case-insensitively on whole words), with precedence fail, then slow, then person, then human: `/\bfail(?:\s+(auth|rate_limit|timeout|network|model_not_found|aborted|unknown))?\b/` yields one error event, bare `fail` or an unrecognised word after it giving `{ kind: 'unknown', message: FAKE_FAIL_MESSAGE }` (no status) and `fail <kind>` giving `llmError(kind, ctx)` (timeout with phase `first`); `/\bslow\b/` emits nothing until a deadline fires (the `timeout`/`first` sentence whichever timer fires, because no token is ever forwarded, FR-20; or `aborted` if the caller aborts first); `/\bperson\b/` with a declared tool named `handoff_to_team` emits `{ type: 'tool-call', toolCallId: 'fake-call-<n>', name: 'handoff_to_team', input: { reason: 'Caller asked for a person.', summary: cut('The caller asked to speak to a person. Last message: ' + text, 1000) } }` (`cut` and `text` as section 7.5 defines) then `finish` `tool-calls` with no turn text and `usage: { inputTokens: words(req.messages), outputTokens: 0 }` (the reply is empty, FR-35); `/\bhuman\b/` emits the words of `Sure, let me get someone for you.` as text-deltas then the same tool call and finish (its `usage.outputTokens` is 7, the words of that reply); `person` or `human` without `handoff_to_team` declared streams `I cannot transfer you right now, but I can keep helping here.` then `finish` `stop`; anything else streams `You said: <text>. How else can I help?`; an empty message streams `I did not catch that. Could you say it again?`.
- FR-35: A scripted reply MUST be split on single spaces and emitted word by word as text-deltas (each word followed by a space except the last, so the deltas joined equal the reply); the first word MUST be yielded on the first pull without any timer wait, later words about 25 ms apart; the combined `createDeadlines().signal` (never `req.signal` alone) MUST be checked before every word and during every wait, and when it is aborted the stream MUST end with the single terminal `outcome()` selects: `aborted` for the caller, the `timeout` sentence for the fired phase (a long echo cut by the total timer ends as `timeout`/`total`, EC-31); every `finish` the fake emits MUST carry `usage: { inputTokens: words(req.messages), outputTokens: words(reply) }` with `words` as section 7.5 defines and `reply` the text streamed before that finish (`''`, so `outputTokens` 0, on the `person` path; 7 on the `human` path; a text reply ends with `{ type: 'finish', finishReason: 'stop', usage }`), so no fake finish ever omits the key (AC-39, AC-40, AC-41; revision 3).
- FR-36: The handoff tool call's `reason` MUST be at most 200 characters and its `summary` at most 1000 characters with control characters stripped, so the input parses with the handoff_to_team zod schema; that `{ reason, summary }` shape is the blueprint's ToolSeam decision (reason and summary are the tool's only arguments), the schema itself is written by tools-and-automation-webhook, and section 7.7 records the obligation that it keeps accepting exactly this shape (no added required field) so the simulator's person and human path cannot silently break; `toolCallId` values MUST be distinct across the streams of one client, the counter being per client instance (closure state of `create()`, never module-level), so two fake clients each start at `fake-call-1`; a tool call MUST NOT be emitted for a tool that is not declared in `req.tools`.
- FR-37: The fake's `probe()` MUST resolve exactly `{ ok: true, ms: 0 }`; every fake stream MUST emit exactly one terminal event, never throw, call `abort()` then `clear()` on its deadlines on every exit (the terminal, an early consumer exit and a fired timer included, so the fake exercises the same protocol as FR-17), and keep no state between streams beyond the per-client tool-call counter; every scripted text reply MUST end with `.` or `?` (the fixed replies `Sure, let me get someone for you.` and `I cannot transfer you right now, but I can keep helping here.` end with `.`; the echo `You said: <text>. How else can I help?` and `I did not catch that. Could you say it again?` end with `?`), the rule AC-25(b) and NFR-16 test instead of FR-25's period rule, which governs `LlmError.message` values only (revision 3).
- FR-38: The config surface for the fake MUST stay as it is: `LLM_PROVIDER=fake` accepted with the warning `LLM_PROVIDER: is a test provider that is not meant for real calls. Set it to one of openai, anthropic, google, mistral, groq when you are done testing.` and absent from the README table, `.env.example` and the valid-values sentence.

### Provider modules and low-latency defaults

- FR-39: Every real provider file MUST implement `create` as `({ model, apiKey }) => createAiSdkClient({ provider: id, sdk: id, keyEnv, model, isDefaultModel: model === defaultModel, apiKey, providerOptions: model === defaultModel ? LOW_LATENCY : undefined })` (where `keyEnv` is the file's non-null constant, typed `string` as 8.2 requires, and the same value the module exports) and MUST import only `../aiSdkClient.js` (value) and `../types.js` (type), never `ai` or `@ai-sdk/*`.
- FR-40: `LOW_LATENCY` MUST be `{ openai: { reasoningEffort: 'none' } }` for openai and `{ google: { thinkingConfig: { thinkingBudget: 0 } } }` for google, and absent for anthropic, mistral and groq; it MUST apply only when the model in use equals `defaultModel` by value (a deployer setting `LLM_MODEL` to the same name still gets it; any other model runs with the provider's own settings).
- FR-41: `openai.defaultModel` MUST change from `gpt-5-mini` to `gpt-5.6-terra`, `pnpm docs:env` MUST be run so `README.md` and `.env.example` read `openai: gpt-5.6-terra`, and a `CHANGELOG.md` entry under an Unreleased heading MUST record the default-model and price-tier change (the file is created if absent).
- FR-42: The other four `defaultModel` values MUST stay unchanged, and the owner's docs-only spot check of the four names MUST be a row in `docs/acceptance.md` section 2, never a build gate.

### Packaging and the import boundary

- FR-43: `package.json` MUST pin exactly (no caret) `ai` 7.0.94, `@ai-sdk/openai` 4.0.62, `@ai-sdk/anthropic` 4.0.50, `@ai-sdk/google` 4.0.65, `@ai-sdk/mistral` 4.0.40, `@ai-sdk/groq` 4.0.38 and `zod` 4.5.4, keep `engines.node` `24.x` and `packageManager` `pnpm@11.10.0`, and `pnpm-lock.yaml` MUST be regenerated with pnpm and committed in the same change; no `package-lock.json` or `yarn.lock` MUST exist and no npm or yarn command MUST appear in docs or scripts.
- FR-44: `test/arch/imports.test.ts` MUST pass unchanged with the new files: `llm/aiSdkClient.ts` holds the AI SDK imports, `llm/errors.ts` and `llm/deadlines.ts` import only `./types.js`, `llm/providers/fake.ts` imports `../errors.js`, `../deadlines.js` and `../types.js`, and every other provider file imports `../aiSdkClient.js` and `../types.js`.
- FR-45: Nothing under `src/llm` MUST import `src/config`, `src/log`, `src/agent`, `src/status` or `src/voice`, write a log line, or produce HTML or markup in any string it authors (the fake's echo repeats the caller's text verbatim, which is not the module producing markup; AC-25b).

### Documentation, tests and owner acceptance

- FR-46: `README.md` MUST gain, outside the generated markers, a section headed `## Add a provider` listing in order: copy `src/llm/providers/groq.ts` to `providers/<id>.ts` and fill the fields (the `id` is at most 12 lowercase letters or digits, so every sentence stays within the 180-character bound); only for a new package, `pnpm add @ai-sdk/<id>@<exact version>` plus one entry in the sdk map of `src/llm/aiSdkClient.ts`; one line in `src/llm/registry.ts`; `pnpm docs:env` then `pnpm test`; and a short `## LLM providers` section stating that the default model is tuned for speed while a model set in `LLM_MODEL` runs with the provider's own settings, that the self-test waits up to 10 seconds whatever `LLM_TIMEOUT_MS` says, that the AI SDK, its provider packages and zod are pinned exactly, and that `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL`, when set in the environment, are read by the provider packages themselves and redirect every request, so they should stay unset (EC-46; the server never reads them and never documents them as variables of its own).
- FR-47: `docs/acceptance.md` MUST gain `## 2. LLM providers, owner-run live check` with the default-model source lines above a table whose Result cells are blank, the rows listed in section 8.10, and the sentence that it never blocks a build stage.
- FR-48: The test suite MUST gain `test/llm/aiSdkClient.test.ts`, `test/llm/errors.test.ts`, `test/llm/deadlines.test.ts`, `test/llm/providers.test.ts` and `test/llm/fake.test.ts`, MUST remove the foundation test `stub clients honour the LlmClient contract`, MUST add the directory-scan and id-uniqueness tests to `test/llm/registry.test.ts` (with the helpers of FR-6 in `test/helpers/providerFiles.ts`), MUST hold the 60-sentence snapshot in `test/llm/__snapshots__/errors.test.ts.snap`, the selector enumeration test and the placeholder test over `LLM_ERROR_TEMPLATES` in `test/llm/errors.test.ts` (AC-65 to AC-67), the `streamText` option-set test with a recorded `ai` module (AC-62) and the `Deadlines.abort()` tests (AC-63, AC-64), and every `test/llm` file MUST install a `fetch` guard in `beforeAll` that throws `network call escaped the mocks: <host>` for any request.
- FR-49: The work MUST happen on `build/llm-providers` with commits as stages complete, MUST NOT push, add a remote or touch `main` or `release`, every key-like literal in code, tests, fixtures or docs MUST be an obvious placeholder such as `sk-test-not-a-real-key-0123456789`, the untracked SDK verification dumps at the repository root (`ai-index.d.ts`, `ai-test.d.ts`, `provider.d.ts`, `provider-utils.js`, `sdk-*.d.ts`, `sdk-*.js`, `sdk-*.mjs`) MUST be deleted before the stage commits and never committed (they are read by eslint's `**/*.ts` pattern and by `prettier --check .`, EC-48), and this revised spec MUST be formatted with `pnpm prettier --write specs/llm-providers.md` and committed on the branch so `pnpm lint` stays green (AC-71).

---

## Non-Functional Requirements

### Reliability and isolation

- NFR-1: The test suite MUST make 0 outbound network requests: every `test/llm` file arms a `fetch` guard that throws and fails the test naming only the host, and CI runs with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `MISTRAL_API_KEY` and `GROQ_API_KEY` unset; no test reads a real key.
- NFR-2: After the caller's signal aborts, the `aborted` terminal event MUST resolve within 100 ms (maximum over 20 repetitions under real timers, measured with `performance.now()` from `controller.abort()`).
- NFR-3: A timeout terminal MUST arrive within `[stallMs, stallMs + 100 ms]` under real timers (`stallMs` 200, 10 repetitions) and at exactly `stallMs` (or `timeoutMs`) under fake timers for the `first`, `gap` and `total` phases, `stallMs === timeoutMs` included (AC-60).
- NFR-4: `probe()` MUST settle within `PROBE_TIMEOUT_MS + 100 ms` on every path: under fake timers the promise is still pending at 9 999 ms and settled after advancing to 10 000 ms plus a microtask flush.
- NFR-5: No handle MUST leak: after 100 sequential streams on one client sharing one caller signal, `getEventListeners(signal, 'abort').length === 0` and `vi.getTimerCount() === 0`; `Deadlines.abort()` adds 0 listeners to the caller's signal (the count before and after a call is equal) and the self-abort after every terminal event leaves the count unchanged; the vitest run exits without the "something prevents the main process from exiting" warning; a Node child process that only calls `createDeadlines` from `dist/llm/deadlines.js` exits with code 0 within 2 s.
- NFR-6: Consuming and discarding a stream of 10 000 deltas MUST raise `process.memoryUsage().heapUsed` by less than 20 MB, showing events are forwarded, not buffered.

### Performance

- NFR-7: `createLlmClient` for all six providers MUST complete in under 50 ms total (`performance.now()`) with 0 `fetch` calls and 0 SDK factory calls, so boot never waits on a provider.
- NFR-8: Text deltas MUST NOT be coalesced or delayed: a mock emitting 50 deltas yields exactly 50 `text-delta` events, and under real timers each event reaches the consumer within 5 ms of the mock emitting it (maximum over 50).
- NFR-9: The fake provider MUST yield its first word within 5 ms of the first pull under real timers, complete a 10-word reply in at least 200 ms and under 400 ms, and under fake timers emit word k at exactly `25 * (k - 1)` ms.
- NFR-10: The owner-run live check (recorded in `docs/acceptance.md` section 2, never a build gate) targets first text at or under 1.5 s median and 3 s p95 over at least 20 turns (seven three-turn calls) on openai `gpt-5.6-terra`, read from Railway logs with the filter `@event:turn.timing` and the field `ms_prompt_to_first_text_out` (measured at the send call of the first text frame, not on flush); the self-test's ms to first token is recorded alongside.
- NFR-11: One self-test MUST bill at most 16 output tokens (`PROBE_MAX_OUTPUT_TOKENS`), checked by the owner on the provider's usage dashboard after a single press.
- NFR-12: The `test/llm` files MUST finish in at most 15 s wall clock on CI, every wait of 100 ms or more running under fake timers and no single test sleeping more than 500 ms of real time.

### Security and privacy

- NFR-13: 0 occurrences of the placeholder key, the model id, `RESPONSE-BODY-MARKER` and `SDK-MESSAGE-MARKER` MUST appear across every emitted `LlmError.message` and every `JSON.stringify(event)` in the suite, and `console.error` MUST be called 0 times across `test/llm/aiSdkClient.test.ts`.
- NFR-14: The gitleaks CI job MUST report no findings on the branch; the only key-like literals are `sk-test-not-a-real-key-0123456789` and `sk-env-must-not-be-used-0123456789`.
- NFR-15: `src/llm` MUST contain 0 reads of `process.env` (a grep in `test/llm/providers.test.ts`), so a stale key in another variable can never be used and the FLOW 3 promise (the old `OPENAI_API_KEY` is ignored after switching provider) holds by construction.

### Plain English and accessibility of the sentences

- NFR-16: 100 % of the 60 catalogue sentences (5 advertised providers x 12 variants) plus `FAKE_FAIL_MESSAGE` MUST satisfy FR-25 (checked by a property test, AC-25a), with the next step in the second sentence, ASCII apostrophes only (the HTML renderer escapes them as `&#39;` and the status tests compare the decoded text), no non-breaking space, and plain integers with units in words (`640 ms`, `10 second self-test limit`), no thousands separators, currencies, dates or locale-specific formats; the longest shipped sentence measures exactly 176 characters (anthropic `unknown` with a status). The fake's scripted text replies are not `LlmError` messages: they MUST end with `.` or `?` (FR-37) and satisfy the shared text properties of AC-25(b) on the fixed fixtures named there, the echo being asserted only on a fixture because it embeds the caller's text verbatim (revision 3).
- NFR-17: The same `(provider, kind, variant)` MUST always render the byte-identical sentence, so that wherever a consumer prints `LlmError.message` verbatim, find-in-page and a screen reader's search take a deployer from the page to the fix. Binding on this feature: every `LlmError.message` comes from one `LLM_ERROR_TEMPLATES` row through `llmError`, and the 60 rendered strings equal the snapshot. Binding on the consumers that take their text from the `LlmError` object under the section 7.7 contract: the tokened page's self-test line and the recent-problems detail print `LlmError.message` verbatim and never re-word from `kind`. Conditional until the owning features decide (revision 3): the `POST /selftest` JSON leg holds once the status spec adopts `error = LlmError.message` verbatim (B-3; the blueprint still reads 'plain English from LlmError.kind', so the status feature's snapshot test MUST be written against `LlmError.message`, never against a re-wording from `kind`), and the README leg holds whole-sentence only if readme-template-and-release renders the glossary per provider (B-5): with 13 placeholder rows a deployer matches a distinctive fragment such as `did not start answering`, never the whole sentence, because a placeholder row can never be byte-identical to a rendered one. The guarantee rests on the `LLM_ERROR_TEMPLATES` entity of section 8.12: the 60 rendered strings equal the snapshot, every row substituted equals the `llmError` output for its variant, all 280 selector combinations resolve to exactly one of the 13 rows and every row is reached (coverage invariant, AC-66), and 0 of the 1 680 rendered messages (6 providers x 280 selectors) contain `<` or `>` (placeholder invariant, AC-67), so a deployer never sees `<KEY>` on the page and no failure renders as an empty sentence.
- NFR-18: Meaning MUST never depend on colour or symbols: `kind` is a plain word and the sentence repeats the meaning in words; the status feature adds a visually hidden `Ok:` or `Failed:` prefix and announces the self-test result, and this feature guarantees the probe resolves within 10 s with either `ok` or a sentence, so a no-JavaScript form submit never spins and never shows an empty result.

### Build gates

- NFR-19: On a clean clone `pnpm install --frozen-lockfile`, `pnpm lint` (eslint and `prettier --check .`, which covers `specs/llm-providers.md`), `pnpm typecheck`, `pnpm build`, `pnpm test` and `pnpm docs:env --check` MUST all exit 0 (the CI job), `node_modules/ai/package.json` MUST report version 7.0.94, and the repository root MUST carry no untracked file when the stage commits (`git status --porcelain` empty), so prettier and eslint never scan the SDK verification dumps (EC-48).

---

## Acceptance Criteria

Every criterion is a Vitest case (or a CI step where stated). Placeholder keys are literals: `sk-test-not-a-real-key-0123456789` and `sk-env-must-not-be-used-0123456789`. "Mocked factory" means `vi.mock('@ai-sdk/<id>')` exporting the factory as a `vi.fn` that returns a model function (with a `chat` property for openai) resolving to a `MockLanguageModelV4` whose `doStream` returns `simulateReadableStream({ chunks, initialDelayInMs, chunkDelayInMs })` and records `options.abortSignal`. "The recorded `abortSignal`" is `doStreamCalls[i].abortSignal`, the combined `deadlines.signal` FR-12 hands to `streamText`; every assertion that it is aborted after a terminal event or after the probe's first token observes `Deadlines.abort()` (FR-17, FR-31). Revision 2 revised AC-1, AC-5, AC-10, AC-11, AC-13, AC-17, AC-18, AC-24, AC-25, AC-37, AC-42, AC-45, AC-49, AC-51 and AC-54 in place and added AC-62 to AC-71; the numbering of AC-1 to AC-61 is unchanged.

### AC-1: Registry order, advertised ids, catalog shape and the locked seam files are unchanged (FR-1, FR-2)

- **Given** `src/llm/registry.ts` and `src/llm/types.ts` after the feature, `test/llm/registry.test.ts`, and the foundation commit 3d4f2cf
- **When** the registry suite runs and `git diff 3d4f2cf -- src/llm/types.ts src/llm/registry.ts` is executed
- **Then** `providers.map(p => p.id)` equals `['openai','anthropic','google','mistral','groq','fake']`, `advertisedProviderIds` equals the first five, every `llmCatalog` entry has exactly the keys `advertised`, `defaultModel`, `description`, `id`, `keyDescription`, `keyEnv` and equals `JSON.parse(JSON.stringify(entry))`, the fake entry has `advertised === false`, and the git diff output is empty (both locked files byte-identical to the foundation).

### AC-2: createLlmClient is synchronous and performs no I/O (FR-3, NFR-7)

- **Given** `globalThis.fetch` replaced by a stub that throws and counts calls, and every `@ai-sdk/<id>` factory replaced by a `vi.fn` spy
- **When** `createLlmClient({ provider: id, apiKey: 'sk-test-not-a-real-key-0123456789' })` is called for each of the six ids
- **Then** each call returns a plain object (not a Promise) with `provider === id` and `model` equal to that provider's `defaultModel`, the fetch stub count is 0, every factory spy count is 0, and the six calls together take under 50 ms by `performance.now()`.

### AC-3: Model defaulting and the value-free unknown-id sentence (FR-1)

- **Given** `createLlmClient`
- **When** it is called with `model` undefined, `'   '`, `' custom-model '`, and with `provider: 'nope-secret'`
- **Then** `model` resolves to `defaultModel`, `defaultModel` and `'custom-model'` respectively, and the unknown id throws an `Error` whose message is exactly `Unknown LLM_PROVIDER. Valid values: openai, anthropic, google, mistral, groq.` and contains neither `nope-secret` nor `fake`.

### AC-4: Provider metadata after the default-model change (FR-4, FR-41, FR-42)

- **Given** the six provider modules under `src/llm/providers`
- **When** their metadata is read
- **Then** `defaultModel` is `gpt-5.6-terra`, `claude-haiku-4-5`, `gemini-2.5-flash`, `mistral-small-latest`, `llama-3.3-70b-versatile` and `scripted`; `keyEnv` is `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY` and `null`; `description` and `keyDescription` match the foundation snapshot, contain no newline and none of `<`, `>`, `"`, `&`; every `id` matches `/^[a-z0-9]{1,12}$/`; every non-null `keyEnv` matches `/^[A-Z][A-Z0-9_]*_API_KEY$/` (asserted generically over `providers`, not only over the five listed values, so a copied provider file with an empty or malformed `keyEnv` fails here, 8.1; revision 3); `advertised` is true for all but fake.

### AC-5: keyEnv equals the AI SDK package's own default variable (FR-5)

- **Given** each installed `@ai-sdk/<id>` package resolved with `createRequire(import.meta.url).resolve('@ai-sdk/<id>')` in a test file that does not `vi.mock` the package, and the resolved entry file read from disk
- **When** the file text is searched for the JSON-quoted literal `"<keyEnv>"` of that provider and for JSON-quoted base-URL variable names with `/"[A-Z][A-Z0-9_]*_BASE_URL"/g`
- **Then** for openai, anthropic, google, mistral and groq `indexOf > -1` for `"OPENAI_API_KEY"`, `"ANTHROPIC_API_KEY"`, `"GOOGLE_GENERATIVE_AI_API_KEY"`, `"MISTRAL_API_KEY"` and `"GROQ_API_KEY"` respectively; the openai file contains the JSON-quoted literal `"OPENAI_BASE_URL"` and the anthropic file `"ANTHROPIC_BASE_URL"` (the SDK-level environment reads recorded in EC-46, declared as `environmentVariableName: "<X>_BASE_URL"` in the pinned builds), and the base-URL regex finds no match in the google, mistral and groq files; an unquoted identifier does not count, because the pinned `@ai-sdk/google` 4.0.65 entry file declares `var DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"`, which a bare `_BASE_URL` substring search would hit although the package reads no base-URL variable (revision 3).

### AC-6: Key and model reach the mocked factory unchanged and only lazily (FR-3, FR-10, FR-11)

- **Given** mocked factories for the five advertised providers and `process.env.OPENAI_API_KEY` set to `sk-env-must-not-be-used-0123456789` for the duration of the test
- **When** `createLlmClient({ provider, model: 'model-under-test', apiKey: 'sk-test-not-a-real-key-0123456789' }).stream(req)` is consumed once for each advertised provider
- **Then** the factory spy was called exactly once with an argument whose `apiKey === 'sk-test-not-a-real-key-0123456789'` (`typeof 'string'`), the returned model function was called with `'model-under-test'`, `mockModel.doStreamCalls.length === 1`, and the string `sk-env-must-not-be-used` appears in no spy argument.

### AC-7: An empty apiKey answers auth without any request (FR-10, FR-26)

- **Given** `createAiSdkClient({ provider: 'openai', sdk: 'openai', keyEnv: 'OPENAI_API_KEY', model: 'gpt-5.6-terra', isDefaultModel: true, apiKey: '' })`
- **When** `stream(req)` is consumed and `probe()` is awaited
- **Then** the stream yields exactly one event `{ type: 'error', error: { kind: 'auth', message: 'The openai provider rejected the API key in OPENAI_API_KEY. Check the key in your Railway variables, then redeploy.' } }` with no `status` key, `probe()` resolves `{ ok: false, ms, error }` with the same kind and message and `ms <= 5`, `doStreamCalls.length === 0` and the factory spy count is 0.

### AC-8: Low-latency provider options only for the exact default model (FR-39, FR-40)

- **Given** mocked factories for all five advertised providers
- **When** `stream()` runs once with the model unset and once with `gpt-5.6-luna` (openai), `gemini-2.5-pro` (google) or any custom name (others), and once with `LLM_MODEL` set to exactly `gemini-2.5-flash`
- **Then** with the default `doStreamCalls[0].providerOptions` deep-equals `{ openai: { reasoningEffort: 'none' } }` for openai and `{ google: { thinkingConfig: { thinkingBudget: 0 } } }` for google; with a custom model `providerOptions` is undefined; for anthropic, mistral and groq it is undefined in both runs; the explicit `gemini-2.5-flash` still gets the option.

### AC-9: baseURL selects Chat Completions on the openai sdk (FR-9, FR-11)

- **Given** `createAiSdkClient({ provider: 'x', sdk: 'openai', baseURL: 'https://example.invalid/v1', keyEnv: 'X_API_KEY', model: 'm', isDefaultModel: true, apiKey: 'sk-test-not-a-real-key-0123456789' })` with the mocked `createOpenAI`
- **When** `stream()` runs
- **Then** `createOpenAI` was called once with `baseURL === 'https://example.invalid/v1'`, the factory's `chat` spy was called once with `'m'`, the bare factory (Responses API) was not called, and the fetch guard count stays 0.

### AC-10: One streamText call per step with the tool declared as draft-07 JSON Schema and never executed (FR-12, FR-15, FR-16, FR-17)

- **Given** a mock whose `doStream` returns chunks `stream-start`, `tool-input-start`, `tool-input-delta`, `tool-input-end`, `{ type: 'tool-call', toolCallId: 'call_1', toolName: 'handoff_to_team', input: '{"reason":"Caller asked for a person.","summary":"Wants a person."}' }`, `finish` with unified `tool-calls`; and `req.tools = [{ name: 'handoff_to_team', description: 'Hand the caller to a person.', inputSchema: z.object({ reason: z.string().max(200), summary: z.string().max(1000) }) }]`
- **When** `stream(req)` is consumed to the end
- **Then** events deep-equal `[{ type: 'tool-call', toolCallId: 'call_1', name: 'handoff_to_team', input: { reason: 'Caller asked for a person.', summary: 'Wants a person.' } }, { type: 'finish', finishReason: 'tool-calls', ... }]`; `doStreamCalls.length === 1` (no second step, no tool-result); `doStreamCalls[0].tools` has exactly one entry with type `function`, name `handoff_to_team`, the description above and an `inputSchema` whose `$schema === 'http://json-schema.org/draft-07/schema#'`, `type === 'object'`, `properties.reason.maxLength === 200` and `properties.summary.maxLength === 1000`; `doStreamCalls[0].abortSignal` is an `AbortSignal` whose `aborted === true` after the terminal event (released by `deadlines.abort()`, AC-64); `vi.getTimerCount() === 0`.

### AC-11: maxRetries 0 and no stream retry are observable on a retryable failure (FR-12, FR-13, FR-26)

- **Given** (a) `doStream` rejecting with `new APICallError({ message: 'SDK-MESSAGE-MARKER', url: 'https://example.invalid', requestBodyValues: {}, statusCode: 503, responseBody: 'RESPONSE-BODY-MARKER', isRetryable: true })`; (b) `doStream` resolving chunks `text-delta 'a'`, `{ type: 'error', error: <the same APICallError> }`, `text-delta 'b'`, `finish` `stop` with `chunkDelayInMs 0`; `vi.useFakeTimers()` in both
- **When** `stream(req)` is consumed without advancing time
- **Then** (a) exactly one event `{ type: 'error', error: { kind: 'network', status: 503, message: 'The server could not reach the openai provider, or the provider is down. Check the provider's status page, then try again.' } }`; (b) events deep-equal `[{ type: 'text-delta', text: 'a' }, <the same error event>]` and `'b'` is never emitted; in both cases `doStreamCalls.length === 1` (no retry, no re-run step) and `vi.getTimerCount() === 0` afterwards (no retry back-off timer).

### AC-12: Text deltas are forwarded verbatim, never coalesced, empty ones dropped (FR-16, NFR-8)

- **Given** chunks `stream-start`, `text-start`, `text-delta 'Hello'`, `text-delta ' wor'`, `text-delta 'ld.'`, `text-delta ''`, `text-end`, `finish { finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 7 }, outputTokens: { total: 3 } } }`
- **When** the stream is consumed, and in a second run a mock emits 50 deltas under real timers with a timestamp taken on each side
- **Then** events deep-equal `[{ type: 'text-delta', text: 'Hello' }, { type: 'text-delta', text: ' wor' }, { type: 'text-delta', text: 'ld.' }, { type: 'finish', finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 3 } }]`; a delta containing accented letters, an emoji and CJK characters is forwarded byte-identical; the 50-delta run yields exactly 50 `text-delta` events and the maximum mock-to-consumer delay is under 5 ms.

### AC-13: Unlisted stream parts are dropped after touching the stall timer (FR-16, FR-20)

- **Given** chunks `reasoning-start`, `reasoning-delta`, `reasoning-end`, `source`, `raw` and `response-metadata` between two text deltas, with `req { stallMs: 500, timeoutMs: 10_000 }` and the unlisted parts spaced 400 ms apart under fake timers
- **When** consumed with time advanced to 5_000
- **Then** the set of event types is exactly `{'text-delta', 'finish'}`, both deltas arrive in order, and no `timeout` event occurs (every part re-armed the stall timer).

### AC-14: Malformed tool input and unknown tool names are forwarded, never an error (FR-15, FR-16)

- **Given** (a) a `tool-call` chunk with input `'{"reason": 12'` for `handoff_to_team`; (b) a `tool-call` chunk with `toolName 'not_a_tool'` and valid JSON input; each followed by `finish` `tool-calls`
- **When** consumed with `handoff_to_team` declared
- **Then** each stream yields exactly one `tool-call` event then `finish` `tool-calls` and zero error events; (a) carries the unparsed input string `'{"reason": 12'`; (b) carries `name 'not_a_tool'`; `doStreamCalls.length === 1` in both cases.

### AC-15: Finish reasons map to the seam's four values (FR-16)

- **Given** `finish` chunks with unified `stop`, `length`, `tool-calls`, `content-filter`, `other` and `error`
- **When** consumed
- **Then** `finishReason` is `stop`, `length`, `tool-calls`, `other`, `other`; for `error` with no earlier error part the only event is `{ type: 'error', error: { kind: 'unknown', message: 'The openai provider returned an error the server does not recognise. Run the self-test again; if it keeps failing, open a GitHub issue with the text of this page.' } }` with no `status` and no `finish`; a finish whose `usage` object has both totals undefined (`{ inputTokens: { total: undefined }, outputTokens: { total: undefined } }`), and one whose totals are `NaN` and `Infinity` (EC-52), each yield a `finish` event without a `usage` key (`'usage' in event === false`, never `usage: {}`, and `JSON.stringify(event)` contains neither `undefined` nor `null`); a `finish` part with no `usage` object is not a fixture, because the v4 stream part requires `usage: LanguageModelV4Usage` and the SDK reads `usage.inputTokens.total` from it, so such a chunk may surface as a thrown `TypeError` inside `ai` and classify as `unknown` rather than as a finish without usage (8.11; revision 3).

### AC-16: An empty answer is one finish and nothing invented (FR-16, FR-17)

- **Given** chunks `stream-start` and `finish` `stop` only
- **When** consumed
- **Then** events contain exactly one element, `{ type: 'finish', finishReason: 'stop', ... }`, and no `text-delta`.

### AC-17: Exactly one terminal, then the request is released, timers cleared and later parts ignored (FR-17, FR-20, NFR-5)

- **Given** chunks `text-delta 'a'`, `{ type: 'error', error: new APICallError({ statusCode: 500, ... }) }`, `text-delta 'b'`, `finish` `stop`, delivered with `chunkDelayInMs 0`; the mock records `options.abortSignal`
- **When** `stream(req)` is consumed with `for await`, `next()` is then called twice more on the same iterator, and a second `for await` runs over the same `stream()` result
- **Then** events deep-equal `[{ type: 'text-delta', text: 'a' }, { type: 'error', error: { kind: 'network', status: 500, message: <the openai network sentence> } }]`; both extra `next()` calls resolve `{ done: true, value: undefined }`; the second iteration yields zero events and `doStreamCalls.length` stays 1; the recorded `abortSignal.aborted === true` (through `deadlines.abort()`); `vi.getTimerCount() === 0`; `getEventListeners(req.signal, 'abort').length === 0`.

### AC-18: A consumer that stops early releases the request through the generator's finally (FR-17, FR-20, NFR-5)

- **Given** a mock producing 50 deltas 10 ms apart under real timers and a caller `AbortController`
- **When** the consumer breaks out of `for await` after the first `text-delta`
- **Then** within 100 ms the recorded `abortSignal.aborted === true` (through `deadlines.abort()`), the mock's stream is not pulled again (pull count unchanged after 200 ms), `vi.getTimerCount() === 0`, `getEventListeners(controller.signal, 'abort').length === 0`, and the caller signal itself is not aborted.

### AC-19: createAiSdkClient, stream() and probe() never throw (FR-9, FR-13, FR-17, FR-32)

- **Given** (a) `doStream` throws synchronously; (b) the mocked factory throws synchronously when the model is instantiated; (c) the stream's reader errors with `new Error('boom')`; (d) `createAiSdkClient` is called with `baseURL 'not a url'`
- **When** the client is created, `stream(req)` consumed and `probe()` awaited for each
- **Then** `createAiSdkClient` returns synchronously in every case, no exception propagates from `stream` or `probe`, each stream yields exactly one event `{ type: 'error', error: { kind: 'unknown', message: <unknown-no-status sentence> } }` with no `status`, each probe resolves `{ ok: false, error: { kind: 'unknown' } }`, and `console.error` was not called.

### AC-20: Message history maps to the SDK prompt without throwing on missing ids (FR-14)

- **Given** `req.messages = [system 'S', user 'U', assistant 'A1', assistant { content: 'Sure.', toolCallId: 'call_1', toolName: 'handoff_to_team', toolInput: { reason: 'r', summary: 's' } }, tool { content: 'done', toolCallId: 'call_1', toolName: 'handoff_to_team' }, assistant { content: '', toolCallId: 'call_2', toolName: 'end_call', toolInput: {} }, tool { content: 'ended' } (no ids)]`
- **When** `stream()` runs
- **Then** `doStreamCalls[0].prompt` roles in order are system, user, assistant, assistant, tool, assistant, tool; the 4th message has a text part `'Sure.'` and a tool-call part `{ toolCallId: 'call_1', toolName: 'handoff_to_team', input: { reason: 'r', summary: 's' } }`; the 5th has a tool-result part with `toolCallId 'call_1'` and output `{ type: 'text', value: 'done' }`; the 6th has a tool-call part and no text part; the 7th has `toolCallId ''` and `toolName ''`; nothing threw.

### AC-21: The HTTP status table holds for every advertised provider (FR-24, FR-26, FR-27)

- **Given** for each of openai, anthropic, google, mistral and groq (registry to provider file to mocked factory) `doStream` rejects with `new APICallError({ statusCode, responseBody: '{"error":"RESPONSE-BODY-MARKER"}', url: 'https://example.invalid', requestBodyValues: {}, message: 'SDK-MESSAGE-MARKER' })`
- **When** `statusCode` is each of 401, 403, 404, 402, 429, 498, 408, 500, 502, 503, 504, 529, 400, 409, 422
- **Then** the single error event has kind `auth` (401, 403), `model_not_found` (404), `rate_limit` (402, 429, 498), `network` (408, 500, 502, 503, 504, 529) or `unknown` (400 with a neutral body, 409, 422); `status === statusCode` in every case; the message equals the catalogue sentence for that provider and kind, the unknown one containing `(HTTP <status>)`; the `model_not_found` sentence is the "default model of this build" variant when the client was built with the default model and the "model set in LLM_MODEL" variant with model `custom-model`.

### AC-22: 400 bodies that mean auth or model are recognised (FR-26, FR-28)

- **Given** `doStream` rejecting with `APICallError` `statusCode 400` whose `responseBody` contains, in turn, `API key not valid`, `Incorrect API key provided`, `invalid_api_key`, `model_not_found`, `The model gpt-x does not exist or you do not have access to it`, `Unknown model`, and `integer below minimum value. Expected a value >= 16`
- **When** consumed
- **Then** the kinds are `auth`, `auth`, `auth`, `model_not_found`, `model_not_found`, `model_not_found`, `unknown` (status 400), and no message contains any body text.

### AC-23: Non-HTTP failures classify by class and code (FR-26, FR-27)

- **Given** `doStream` rejecting with, in turn: `new LoadAPIKeyError({ message: 'x' })`; `new NoSuchModelError({ modelId: 'm', modelType: 'languageModel' })`; a `RetryError` whose `lastError` is an `APICallError` 429; `Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })`; `Object.assign(new Error('x'), { code: 'ENOTFOUND' })`; `Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' })`; an `APICallError` with no `statusCode`; an `APICallError` with `statusCode` `0`, one with `600` and one with `NaN` (not integers in 100..599, treated as absent, FR-26 row 7); `new Error('boom')`; a `TypeValidationError`; a `JSONParseError`; `Object.assign(new Error('x'), { name: 'AbortError' })` while neither signal fired
- **When** consumed
- **Then** the kinds are `auth`, `model_not_found`, `rate_limit` (status 429), `network`, `network`, `network`, `network`, `network`, `network`, `network`, `unknown`, `unknown`, `unknown`, `unknown`, and the `status` key is present only in the `RetryError` case (never `status: 0` or `status: NaN`, and no message contains `(HTTP 0)` or `(HTTP NaN)`).

### AC-24: The sentence catalogue is snapshot-tested per advertised provider and rendered only from LLM_ERROR_TEMPLATES (FR-23, FR-24, NFR-17)

- **Given** `llmError(kind, { provider, keyEnv, isDefaultModel }, { status, phase })` for each of openai, anthropic, google, mistral, groq across `auth`, `rate_limit`, `model_not_found` (`isDefaultModel` false and true), `timeout` (phase `first`, `gap`, `total`, `probe`), `network`, `aborted`, `unknown` (status 418 and no status): 12 strings per provider, and the entity of section 8.12
- **When** rendered and compared with `test/llm/__snapshots__/errors.test.ts.snap`
- **Then** the 60 strings equal the snapshot; openai `auth` is `The openai provider rejected the API key in OPENAI_API_KEY. Check the key in your Railway variables, then redeploy.`; `llmError('auth', { provider: 'fake', keyEnv: null, isDefaultModel: true })` is `The fake provider rejected the API key. Check the key in your Railway variables, then redeploy.`; every `aborted` message is `The request was stopped before the provider finished.`; anthropic `timeout`/`probe` is `The anthropic provider did not start answering within the 10 second self-test limit. Try a faster model with LLM_MODEL, or run the self-test again.`; groq `rate_limit` is `The groq provider refused the request because of a rate or usage limit. Check your plan and billing with the provider, then try again.`; for every row of `LLM_ERROR_TEMPLATES` and every advertised provider, `template.replace('<p>', id).replace('<KEY>', keyEnv).replace('<status>', '418')` equals the `llmError` string of that variant (the table of section 8.12 is the only source of the sentences).

### AC-25: Text and accessibility rules hold for every rendered message, and the fake's replies end with `.` or `?` (FR-25, FR-37, FR-45, NFR-16)

- **Given** (a) the 60 catalogue strings plus `FAKE_FAIL_MESSAGE` (every `LlmError.message` the module can produce for the shipped ids); (b) the fake's scripted text replies on fixed fixtures: `Sure, let me get someone for you.`, `I cannot transfer you right now, but I can keep helping here.`, `I did not catch that. Could you say it again?`, and the echo rendered for the AC-39 fixture, `You said: hello there. How else can I help?`
- **When** checked by a property test in `test/llm/errors.test.ts` (the fake's replies joined from its text-deltas)
- **Then** (a) each message ends with `.`, starts with an uppercase letter, equals `message.trim()`, contains no newline, no non-breaking space (U+00A0), none of `<`, `>`, `"`, `&`, backtick, none of U+2018, U+2019, U+201C, U+201D (ASCII apostrophes only), has length at most 180, splits on `. ` into at most 2 sentences, contains no lowercase `http`, and every match of `/[A-Z][A-Z0-9_]+/g` is one of `API`, `HTTP`, `LLM_MODEL`, `LLM_TIMEOUT_MS` or the provider's `keyEnv`; the longest string (anthropic `unknown` with status) measures 176; `llmError('unknown', { provider: 'a'.repeat(14), keyEnv: null, isDefaultModel: true }, { status: 418 })` measures 181 and fails the same length property (the 12-character id cap of AC-4 is what keeps shipped ids under the bound, EC-56); (b) each of the four fixture replies ends with `.` or `?` (FR-37: the first two with `.`, the last two with `?`) and satisfies every other property of (a) except the period rule (uppercase start, trimmed, no newline or U+00A0, none of `<`, `>`, `"`, `&`, backtick or curly quotes, at most 180 characters, at most 2 sentences on `. `, no lowercase `http`, no capital run); these properties are asserted on the fixtures only, because the echo embeds the caller's text verbatim (a 2 000-word message, EC-31, or one containing `<b>` or `"`), so for arbitrary input only FR-35's join property and FR-37's terminal `?` hold, and FR-45's markup-free rule governs strings the module authors, never caller text it echoes (revision 3).

### AC-26: Redaction and the last-resort key scrub (FR-28, NFR-13)

- **Given** every error path of AC-21, AC-22 and AC-23 executed with `apiKey 'sk-test-not-a-real-key-0123456789'`, model `model-name-under-test`, `responseBody 'RESPONSE-BODY-MARKER'` and SDK message `SDK-MESSAGE-MARKER`
- **When** every emitted `LlmError.message` and `JSON.stringify` of every event is collected
- **Then** none contains any of the four strings, and a client built with `keyEnv` equal to the `apiKey` string (contrived to reach the scrubber) yields an `auth` message containing `[redacted]` and not the key.

### AC-27: Nothing reaches console.error (FR-13, NFR-13)

- **Given** `vi.spyOn(console, 'error')` installed in `beforeAll` of `test/llm/aiSdkClient.test.ts`
- **When** the whole file runs, including every error, timeout and abort case
- **Then** the spy's call count is 0.

### AC-28: Total and stall timers drive outcome() (FR-20)

- **Given** `vi.useFakeTimers()` and `createDeadlines({ signal: new AbortController().signal, timeoutMs: 1000, stallMs: 300 })`
- **When** (a) time advances 299 then 1 more; (b) `touch()` at 250 and 500, then time reaches 799 and 800; (c) `firstToken()` at 100 then nothing until 400; (d) `firstToken()` at 100 then `touch()` every 100 ms until 1000
- **Then** (a) `outcome()` is null and `signal.aborted` is false at 299, `'first'` and true at 300; (b) null at 799, `'first'` at 800; (c) `'gap'` at 400; (d) `'total'` at 1000; in every case exactly one abort event fired on the combined signal.

### AC-29: Caller precedence, pre-aborted input, idempotent clear (FR-20, FR-21)

- **Given** `createDeadlines` with `stallMs 300` and a caller `AbortController`
- **When** (a) the stall timer fires, then the caller aborts before `outcome()` is read; (b) `createDeadlines` is called with an already-aborted signal; (c) `clear()` is called twice, then time advances past both budgets; (d) the caller aborts with `controller.abort('timeout')`
- **Then** (a) `outcome() === 'caller'`; (b) the combined `signal.aborted === true` synchronously and `outcome() === 'caller'`; (c) no throw, `vi.getTimerCount() === 0` immediately after the first `clear()`, `outcome()` stays null, and `getEventListeners(callerSignal, 'abort').length === 0`; (d) `outcome() === 'caller'` (the reason string is never read).

### AC-30: Timers are unref'd (FR-20, NFR-5)

- **Given** the built `dist/llm/deadlines.js` (CI builds before test)
- **When** a Node child process is spawned from the repo root that imports `./dist/llm/deadlines.js` and calls `createDeadlines({ signal: new AbortController().signal, timeoutMs: 60000, stallMs: 60000 })`
- **Then** the process exits with code 0 within 2 s.

### AC-31: No first token ends as timeout/first (FR-16, FR-24, FR-26, NFR-3)

- **Given** a mock with `initialDelayInMs 10_000`; `req { timeoutMs: 5_000, stallMs: 500 }`; fake timers, and a second run under real timers with `stallMs 200` repeated 10 times
- **When** time advances 499 then 1 more
- **Then** no event at 499; at 500 exactly one event `{ type: 'error', error: { kind: 'timeout', message: 'The openai provider did not start answering within the LLM_TIMEOUT_MS limit. Try a faster model with LLM_MODEL, or raise LLM_TIMEOUT_MS.' } }` with no `status`; the recorded `abortSignal.aborted === true`; `vi.getTimerCount() === 0`; under real timers every terminal arrives within `[200, 300]` ms.

### AC-32: A gap after text ends as timeout/gap (FR-19, FR-24)

- **Given** chunks `text-delta 'Hi'` followed by more deltas with `chunkDelayInMs 1_000`; `req { stallMs: 500, timeoutMs: 5_000 }`
- **When** time advances 1_500
- **Then** events deep-equal `[{ type: 'text-delta', text: 'Hi' }, { type: 'error', error: { kind: 'timeout', message: 'The openai provider stopped mid-answer for longer than the LLM_TIMEOUT_MS limit. Try a faster model with LLM_MODEL, or raise LLM_TIMEOUT_MS.' } }]`.

### AC-33: The total budget ends as timeout/total (FR-17, FR-20, FR-24)

- **Given** 100 deltas with `chunkDelayInMs 100`; `req { timeoutMs: 1_000, stallMs: 5_000 }`
- **When** time advances 1_000
- **Then** the last event is `{ type: 'error', error: { kind: 'timeout', message: 'The openai provider took longer than the LLM_TIMEOUT_MS limit to finish. Try a faster model with LLM_MODEL, or raise LLM_TIMEOUT_MS.' } }`, at least one `text-delta` precedes it, nothing follows it, and the mock's `abortSignal` is aborted.

### AC-34: Every part re-arms the stall timer (FR-16, FR-20)

- **Given** (a) 10 deltas with `chunkDelayInMs 400`; (b) empty `''` deltas every 400 ms then one real delta; `req { stallMs: 500, timeoutMs: 10_000 }`
- **When** time advances 5_000
- **Then** the events are the non-empty text deltas then `{ type: 'finish', finishReason: 'stop' }`, with no error event in either variant.

### AC-35: Caller abort mid-stream ends within 100 ms with one aborted event (FR-17, FR-29, NFR-2)

- **Given** 20 deltas 50 ms apart under real timers, repeated 20 times; the caller aborts right after the 2nd `text-delta` is received
- **When** the stream is drained
- **Then** the events are two text-deltas then exactly one `{ type: 'error', error: { kind: 'aborted', message: 'The request was stopped before the provider finished.' } }` and nothing after; the aborted event resolves at most 100 ms after `abort()` by `performance.now()` in every repetition; the recorded `abortSignal.aborted === true`; no timers remain.

### AC-36: A pre-aborted caller and same-tick precedence (FR-18, FR-21)

- **Given** (a) `req.signal` already aborted before `stream()` is called; (b) fake timers, `stallMs 500` and `initialDelayInMs 10_000`, time advanced exactly 500 so the stall timer fires, then the caller aborts synchronously before the next event is awaited
- **When** consumed
- **Then** (a) exactly one `aborted` event and `doStreamCalls.length === 0`; (b) the single terminal event has kind `aborted`, never `timeout`.

### AC-37: Probe success returns ms to the first word and self-aborts the rest without an error (FR-8, FR-19, FR-30, FR-31)

- **Given** a mock with `initialDelayInMs 640`, then `text-delta 'OK'`, then 20 more deltas 10 ms apart; fake timers
- **When** `probe()` is awaited after advancing 640, then time advances a further 1_000
- **Then** the result deep-equals `{ ok: true, ms: 640 }` (`'error' in result === false`, no text anywhere in the result); `Number.isInteger(ms)`; `doStreamCalls[0].maxOutputTokens === 16`; `doStreamCalls[0].tools` is empty or undefined; `JSON.stringify(doStreamCalls[0].prompt)` contains `Reply with the single word OK.`; `doStreamCalls[0].providerOptions` deep-equals what `stream()` sends for the same client; the recorded `abortSignal.aborted === true` immediately after resolution (through `deadlines.abort()`); the later 20 deltas produce no unhandled rejection, no `console.error` call and no change to the resolved value; `vi.getTimerCount() === 0`; the module exports `PROBE_TIMEOUT_MS === 10_000`, `PROBE_MAX_OUTPUT_TOKENS === 16` and `PROBE_PROMPT === 'Reply with the single word OK.'`.

### AC-38: Probe zero tokens, errors, the 10 s budget and re-entrancy (FR-31, FR-32, NFR-4, NFR-18)

- **Given** (a) a mock finishing with no text after 30 ms; (b) `doStream` rejecting with `APICallError` 401; (c) `initialDelayInMs 20_000`; (d) two probes started concurrently on one client
- **When** awaited under fake timers with the needed advances
- **Then** (a) `{ ok: true, ms: 30 }`; (b) `{ ok: false, ms, error: { kind: 'auth', status: 401, message: <the same auth sentence stream() gives> } }`; (c) still pending at 9_999 ms and settled by 10_000 ms plus a microtask flush with `{ ok: false, error: { kind: 'timeout', message: 'The openai provider did not start answering within the 10 second self-test limit. Try a faster model with LLM_MODEL, or run the self-test again.' } }` and the SDK signal aborted; (d) both resolve with their own `ms` and `doStreamCalls.length === 2`; the fetch guard count stays 0 throughout.

### AC-39: The fake echo reply streams word by word and finishes with counts (FR-33, FR-34, FR-35, NFR-9)

- **Given** `createLlmClient({ provider: 'fake', apiKey: '' })`; messages `[system 'You are a helpful agent.', user 'hello there']`; `tools []`; fake timers, and a second run under real timers
- **When** the first `next()` is awaited without advancing time, then time advances in 25 ms steps
- **Then** the first event is `{ type: 'text-delta', text: 'You ' }` before any advance (and within 5 ms under real timers); one further word per 25 ms; the deltas joined equal `You said: hello there. How else can I help?`; the last event is `{ type: 'finish', finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 9 } }`; a 10-word reply under real timers completes in at least 200 ms and under 400 ms; `client.provider === 'fake'` and `client.model === 'scripted'`.

### AC-40: 'person' and 'human' call the declared handoff tool (FR-34, FR-35, FR-36)

- **Given** `tools [{ name: 'handoff_to_team', description, inputSchema: z.object({ reason: z.string().max(200), summary: z.string().max(1000) }) }]`; messages `[user 'I want to speak to a PERSON please']` alone, then `[user 'human please']` alone
- **When** consumed
- **Then** for `person`: events deep-equal `[{ type: 'tool-call', toolCallId: <matches /^fake-call-\d+$/>, name: 'handoff_to_team', input: { reason: 'Caller asked for a person.', summary: 'The caller asked to speak to a person. Last message: I want to speak to a PERSON please' } }, { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 8, outputTokens: 0 } }]` with no `text-delta` (`outputTokens` 0 because no text was streamed, FR-35); for `human`: text-deltas joining to `Sure, let me get someone for you.` then the same tool call and `{ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 2, outputTokens: 7 } }`; the input parses with the declared zod schema; two streams get different `toolCallId`s.

### AC-41: 'person' without the tool declared is a text reply (FR-34, FR-35, FR-36)

- **Given** `tools []` and messages `[user 'a person please']` alone
- **When** consumed
- **Then** text-deltas join to `I cannot transfer you right now, but I can keep helping here.` followed by `{ type: 'finish', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 12 } }` (12 words in the reply, FR-35), and no `tool-call` event is emitted.

### AC-42: 'fail' and 'fail <kind>' yield the named kind; the bare-fail sentence lives outside the table (FR-23, FR-24, FR-33, FR-34)

- **Given** last user message, in turn: `fail`, `FAIL AUTH`, `fail rate_limit`, `fail network`, `fail model_not_found`, `fail timeout`, `fail aborted`, `fail unknown`, `fail bogus`
- **When** consumed
- **Then** each stream is exactly one error event; `fail` and `fail bogus` give `{ kind: 'unknown', message: 'The fake provider failed on purpose.' }` with no `status`; `FAIL AUTH` gives kind `auth` with `The fake provider rejected the API key. Check the key in your Railway variables, then redeploy.`; `fail model_not_found` gives `The fake provider does not know the default model of this build. Set LLM_MODEL to a current model name from the provider's model list.`; `fail timeout` gives the fake's `timeout`/`first` sentence; `fail aborted` gives `The request was stopped before the provider finished.`; every `kind` field equals the named kind; `providers/fake.ts` exports `FAKE_FAIL_MESSAGE === 'The fake provider failed on purpose.'` and `LLM_ERROR_TEMPLATES.some(t => t.template === FAKE_FAIL_MESSAGE) === false`.

### AC-43: 'slow' waits for the shared deadlines (FR-20, FR-22, FR-34)

- **Given** last user message `slow`; fake timers; (a) `{ stallMs: 200, timeoutMs: 1000 }`; (b) `{ stallMs: 200, timeoutMs: 100 }`; (c) `{ stallMs: 200, timeoutMs: 1000 }` with the caller aborting at 50 ms
- **When** time advances
- **Then** (a) no event before 200 ms, then exactly one `{ kind: 'timeout', message: 'The fake provider did not start answering within the LLM_TIMEOUT_MS limit. Try a faster model with LLM_MODEL, or raise LLM_TIMEOUT_MS.' }`; (b) at 100 ms the same `did not start answering` sentence, never the `took longer than the LLM_TIMEOUT_MS limit to finish` one, because the total timer fired before any token (FR-20); (c) one `aborted` event at 50 ms; `vi.getTimerCount() === 0` after each.

### AC-44: Trigger precedence and empty input (FR-34)

- **Given** last user messages `please fail slow person human`, `slow person`, `person human`, `` and `   `; `handoff_to_team` declared
- **When** consumed
- **Then** the first yields the bare-fail `unknown` error; the second the timeout; the third the person branch (tool-call with no text-delta); the last two stream `I did not catch that. Could you say it again?` then `finish` `stop`.

### AC-45: Abort between words, the fake probe, and nothing left behind (FR-35, FR-37, NFR-5)

- **Given** message `hello there friend` with the caller aborting after the 2nd `text-delta`; then a normal echo run; then a `slow` run ended by the stall timer
- **When** each stream is drained, then `probe()` is awaited
- **Then** the abort run yields 2 text-deltas then exactly one `aborted` event and nothing after; after each of the three runs `vi.getTimerCount() === 0` and `getEventListeners(callerSignal, 'abort').length === 0`; `probe()` resolves exactly `{ ok: true, ms: 0 }`.

### AC-46: The import boundary rows for the new files (FR-7, FR-8, FR-22, FR-44, FR-45)

- **Given** `test/arch/imports.test.ts` scanning `src/`
- **When** it runs
- **Then** violations equal `[]`; `llm/aiSdkClient.ts` has value imports `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/mistral` and `@ai-sdk/groq`; each advertised `llm/providers/<id>.ts` has a value import `../aiSdkClient.js` and no specifier matching `/^ai$|^@ai-sdk\//`; `src/llm/stub.ts` does not exist and no file under `src` imports `./stub.js` or `../stub.js`; `violationsFor('llm/errors.ts', value('ai'))` contains `only src/llm/aiSdkClient.ts may import the AI SDK`; `violationsFor('llm/deadlines.ts', value('../log/index.js'))` contains `llm may not import log/index.ts`; `violationsFor('llm/providers/fake.ts', value('../errors.js'), value('../deadlines.js'))` equals `[]`.

### AC-47: Every providers/*.ts is registered, every id has a file, and ids are unique (FR-6)

- **Given** `unregisteredProviderFiles(dir, registeredIds)` and `unfiledProviderIds(dir, registeredIds)` imported from `test/helpers/providerFiles.ts` (each returns sorted basenames with `.ts` stripped: the `*.ts` entries of `dir` that have no entry in `registeredIds`, respectively the ids of `registeredIds` that have no such file), `readdirSync('src/llm/providers')` and `ids = providers.map(p => p.id)`
- **When** both helpers run against `src/llm/providers` and `ids`, then both run against a temp directory holding `openai.ts` and `dummy.ts` with the real `ids`
- **Then** both helpers return `[]` for the real directory (the two sets are equal, order-insensitively); the temp directory reports `['dummy']` as unregistered and `['anthropic', 'fake', 'google', 'groq', 'mistral']` as unfiled; and `new Set(ids).size === providers.length` (a duplicate `id` fails here even though the file set and the id set still agree as sets).

### AC-48: package.json, lockfile and installed versions agree (FR-43, NFR-19)

- **Given** `package.json`, `pnpm-lock.yaml` and `node_modules`
- **When** read in a test and installed in CI
- **Then** `dependencies.ai === '7.0.94'`, `@ai-sdk/openai === '4.0.62'`, `@ai-sdk/anthropic === '4.0.50'`, `@ai-sdk/google === '4.0.65'`, `@ai-sdk/mistral === '4.0.40'`, `@ai-sdk/groq === '4.0.38'`, `zod === '4.5.4'`, each matching `/^\d+\.\d+\.\d+$/`; `engines.node === '24.x'`; `packageManager === 'pnpm@11.10.0'`; `pnpm-lock.yaml` contains `ai@7.0.94` and each `@ai-sdk/<id>@<pin>`; neither `package-lock.json` nor `yarn.lock` exists; `node_modules/ai/package.json` version is `7.0.94`; `pnpm install --frozen-lockfile` exits 0 in CI.

### AC-49: The SDK and zod export the names the tests rely on (FR-8, FR-15, FR-43)

- **Given** dynamic imports of `ai`, `ai/test` and `zod`
- **When** evaluated in a test
- **Then** `typeof MockLanguageModelV4 === 'function'` and `new MockLanguageModelV4({}).specificationVersion === 'v4'` (from `ai/test`); `simulateReadableStream`, `streamText`, `tool` and `jsonSchema` are functions and `APICallError`, `LoadAPIKeyError`, `NoSuchModelError`, `RetryError`, `NoContentGeneratedError`, `TypeValidationError` and `JSONParseError` are constructors each with `typeof isInstance === 'function'` (from `ai`); `typeof z.toJSONSchema === 'function'` and `z.toJSONSchema(z.object({ a: z.string() }), { target: 'draft-07' }).$schema === 'http://json-schema.org/draft-07/schema#'` (zod 4.5.4); a rename on a bump fails this criterion loudly (EC-4).

### AC-50: Generated files follow the default-model change (FR-4, FR-41)

- **Given** `openai.defaultModel` now `gpt-5.6-terra`
- **When** `pnpm docs:env --check` and `test/config/docs.test.ts` run
- **Then** both pass; `README.md`'s `LLM_MODEL` row and `.env.example`'s `LLM_MODEL` comment contain `openai: gpt-5.6-terra` and not `gpt-5-mini`; neither generated section matches `/\bfake\b/`; `test/config/__snapshots__/loadConfig.test.ts.snap` is unchanged by this feature (its git diff is empty); `CHANGELOG.md` contains a line naming `gpt-5.6-terra` under an Unreleased heading.

### AC-51: README 'Add a provider' steps and the pnpm-only rule (FR-43, FR-46)

- **Given** `README.md`
- **When** read
- **Then** a heading matching `/^## Add a provider/m` exists and its section names, in this order: copy `src/llm/providers/groq.ts` to `providers/<id>.ts`; `pnpm add @ai-sdk/<id>@<exact version>` plus one entry in the sdk map of `src/llm/aiSdkClient.ts` (only for a new package); one line in `src/llm/registry.ts`; `pnpm docs:env` then `pnpm test`; the first step states the 12-character limit on `id`; a heading matching `/^## LLM providers/m` exists whose text mentions `10 seconds`, `LLM_MODEL`, `pinned`, `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` (EC-46); the whole README contains no bare token matching `/\bnpm\b/` (pnpm is allowed).

### AC-52: docs/acceptance.md section 2 is present, blank and never a gate (FR-42, FR-47, NFR-10, NFR-11)

- **Given** `docs/acceptance.md`
- **When** read
- **Then** it contains the heading `## 2. LLM providers, owner-run live check`; source lines above the table name `developers.openai.com` and the date `2026-09-09` for the `gpt-5.6-terra` decision; the table has rows for: self-test ok with ms on openai `gpt-5.6-terra`; the billed output tokens of one self-test at most 16; wrong key shows the auth sentence; wrong `LLM_MODEL` shows the model_not_found sentence; three-turn call with first text under 1.5 s median and 3 s p95 using the filter `@event:turn.timing` and the field `ms_prompt_to_first_text_out`; interrupt mid-answer produces no `llm_error` entry; a docs-only spot check of the four other default model names; one row each for anthropic, google, mistral and groq marked `not run`; every Result cell is empty in the committed file; the section states it never blocks a build stage.

### AC-53: The foundation stub test is gone and the suite is offline (FR-48, NFR-1)

- **Given** `test/llm/registry.test.ts` and every `test/llm/*.test.ts`
- **When** `pnpm test` runs with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `MISTRAL_API_KEY` and `GROQ_API_KEY` unset
- **Then** a grep for `stub clients honour the LlmClient contract` finds nothing; every `test/llm` file installs a fetch guard in `beforeAll` that throws `Error('network call escaped the mocks: <host>')`; a control test proves the guard is armed by calling `fetch('https://example.invalid/')` and expecting that error; the full suite passes.

### AC-54: The stage stays on its branch with no remote, no secrets and no verification dumps (FR-49, NFR-14, NFR-19)

- **Given** the repository during and after the stage
- **When** `git branch --show-current`, `git remote -v`, `git status --porcelain` and `git ls-files` are run after the final commit, and the CI gitleaks job runs on the branch
- **Then** the branch is `build/llm-providers`; `git remote -v` prints nothing; `git status --porcelain` is empty (the untracked `ai-index.d.ts`, `ai-test.d.ts`, `provider.d.ts`, `provider-utils.js` and `sdk-*.d.ts` / `sdk-*.js` / `sdk-*.mjs` dumps are deleted, not committed); `git ls-files` matches none of `/^(ai-index\.d\.ts|ai-test\.d\.ts|provider\.d\.ts|provider-utils\.js|sdk-.*)$/`; gitleaks reports no findings (the only key-like literals are `sk-test-not-a-real-key-0123456789` and `sk-env-must-not-be-used-0123456789`).

### AC-55: The fake stays accepted by config and hidden from every list (FR-38)

- **Given** `loadConfig({ LLM_PROVIDER: 'fake', WS_SECRET: <a valid placeholder> }, catalogs)` and the generated docs
- **When** the config suite and `test/config/docs.test.ts` run
- **Then** `config.LLM_PROVIDER === 'fake'`, `config.LLM_MODEL === 'scripted'`, `config.llmApiKey === null`, `ready` is not blocked by a key problem, the problems contain the warning `LLM_PROVIDER: is a test provider that is not meant for real calls. Set it to one of openai, anthropic, google, mistral, groq when you are done testing.`, and neither `README.md`'s generated section nor `.env.example` matches `/\bfake\b/`.

### AC-56: A long stream is forwarded, not buffered (FR-16, NFR-6)

- **Given** a mock producing 10 000 deltas of 20 characters with `chunkDelayInMs 0` and `process.memoryUsage().heapUsed` sampled before the stream
- **When** the stream is consumed and every event discarded
- **Then** exactly 10 000 `text-delta` events were seen, one `finish` follows, and `heapUsed` after the stream (after `global.gc()` when exposed, otherwise as sampled) is less than 20 MB above the sample.

### AC-57: The llm suites run fast under fake timers (NFR-12)

- **Given** the vitest reporter's per-file durations for `test/llm/*.test.ts`
- **When** `pnpm test` runs on CI
- **Then** the `test/llm` files finish in at most 15 s wall clock, and a grep of `test/llm` for `setTimeout(` with a literal above 500 outside `vi.useFakeTimers()` blocks finds nothing.

### AC-58: src/llm never reads the environment (FR-10, NFR-15)

- **Given** every `.ts` file under `src/llm`
- **When** `test/llm/providers.test.ts` greps them for `process.env`
- **Then** there are 0 matches, and with `process.env.OPENAI_API_KEY` set to `sk-env-must-not-be-used-0123456789` a client built with `apiKey: ''` still answers `auth` without calling the factory.

### AC-59: A hundred streams leave nothing behind (FR-17, FR-20, NFR-5)

- **Given** one client, one caller `AbortController` reused for every stream, and mocks that finish normally
- **When** 100 streams are consumed sequentially, then the signal is aborted once after the last one
- **Then** `getEventListeners(signal, 'abort').length === 0` after each stream, `vi.getTimerCount() === 0` at the end, the late abort produces no event and no throw, and the vitest process exits without the "something prevents the main process from exiting" warning.

### AC-60: Equal budgets: no first token is timeout/first, a same-tick tie after the first token is gap (FR-16, FR-20, FR-24, NFR-3)

- **Given** fake timers and (a) `createDeadlines({ signal: new AbortController().signal, timeoutMs: 1000, stallMs: 1000 })` with `touch()` at 5 and at 20 (what the SDK's `start` and `start-step` parts do) and no `firstToken()`; (b) `createDeadlines({ ..., timeoutMs: 1000, stallMs: 500 })` with `touch()` at 400 and `firstToken()` at 500, so the stall timer and the total timer are both due at 1000; (c) `createDeadlines({ ..., timeoutMs: 1000, stallMs: 1000 })` with `firstToken()` at 300 and nothing after; (d) a mock with `initialDelayInMs 10_000` streamed with `req { timeoutMs: 1000, stallMs: 1000 }`; (e) the fake with last user message `slow` and `req { timeoutMs: 500, stallMs: 500 }`; (f) case (d) repeated 10 times under real timers with both budgets 200
- **When** time advances to 999 then 1000 (a to d), to 500 (e), and afterwards to 1300 without calling `clear()` (a to c)
- **Then** (a) `outcome()` is null at 999 and `'first'` at 1000; (b) `'gap'` at 1000; (c) `'total'` at 1000; in (a) and (c) the re-armed stall timer coming due at 1020 and at 1300 changes nothing (`outcome()` unchanged, exactly one abort event on the combined signal in total); (d) at 1000 exactly one event `{ type: 'error', error: { kind: 'timeout', message: 'The openai provider did not start answering within the LLM_TIMEOUT_MS limit. Try a faster model with LLM_MODEL, or raise LLM_TIMEOUT_MS.' } }` with no `status`, never the `took longer than the LLM_TIMEOUT_MS limit to finish` sentence, the recorded `abortSignal.aborted === true` and `vi.getTimerCount() === 0`; (e) exactly one event with `The fake provider did not start answering within the LLM_TIMEOUT_MS limit. Try a faster model with LLM_MODEL, or raise LLM_TIMEOUT_MS.` at 500; (f) every terminal is the `first` sentence and arrives within `[200, 300]` ms.

### AC-61: Empty and whitespace-only plain messages are dropped before the SDK call (FR-14)

- **Given** `req.messages = [system 'S', user 'hello', assistant '' (an interrupted turn cut before its first word), user '   ', assistant 'A', assistant { content: ' ', toolCallId: 'call_1', toolName: 'handoff_to_team', toolInput: { reason: 'r', summary: 's' } }, tool { content: '', toolCallId: 'call_1', toolName: 'handoff_to_team' }, user 'again']` and a mock finishing normally
- **When** `stream()` runs, and in a second run with `req.messages = [user '  ']` alone
- **Then** `doStreamCalls[0].prompt` roles in order are system, user, assistant, assistant, tool, user (the two empty plain messages are gone); the 4th message has a tool-call part and no text part; the 5th has a tool-result part with `toolCallId 'call_1'` and output `{ type: 'text', value: '' }`; `JSON.stringify(doStreamCalls[0].prompt)` contains neither `"content":""` nor `"content":"   "`; the second run yields exactly one terminal event (`finish` if the SDK accepts an empty prompt, otherwise `error` `unknown` without status) and nothing throws.

### AC-62: streamText receives exactly the pinned option set, streamRetries omitted and a void onError (FR-12, FR-13)

- **Given** `vi.mock('ai', async (orig) => ({ ...(await orig()), streamText: vi.fn((await orig()).streamText) }))` so every call is recorded, a mocked factory, and a client with `providerOptions { openai: { reasoningEffort: 'none' } }`
- **When** `stream(req)` with one declared tool and then `probe()` are run
- **Then** `streamText` was called exactly twice; for the stream call the option object has `maxRetries === 0`, `abortSignal instanceof AbortSignal`, `providerOptions` deep-equal to the client's, `tools` with the declared name and no `execute` property, and `'streamRetries' in opts === false`, `'timeout' in opts === false`, `'onAbort' in opts === false`, `'stopWhen' in opts === false`, `'toolChoice' in opts === false`, `'maxOutputTokens' in opts === false`; `typeof opts.onError === 'function'` and `opts.onError({ error: new Error('x') })` returns `undefined` (never `{ retry: true }`, never a promise); for the probe call `maxOutputTokens === 16`, `maxRetries === 0`, `'streamRetries' in opts === false`, and the same void `onError`.

### AC-63: Deadlines.abort() aborts the combined signal without recording an outcome and without adding a listener (FR-17, FR-20, FR-21, NFR-5)

- **Given** fake timers, a caller `AbortController`, and `d = createDeadlines({ signal: controller.signal, timeoutMs: 1000, stallMs: 300 })` with `getEventListeners(controller.signal, 'abort').length` recorded right after creation
- **When** (a) `d.abort()` is called at 100 then time advances to 2000; (b) `d.abort()` is called twice; (c) `d.clear()` then `d.abort()`; (d) `d.abort()` then `d.clear()`; (e) `d.firstToken()` at 50 then `d.abort()` at 100 then time advances to 2000; (f) the stall timer fires at 300 and `d.abort()` is called afterwards
- **Then** (a) `d.signal.aborted === true` immediately, `d.outcome() === null` at 100 and still null at 2000, exactly one abort event fired on `d.signal`, `getEventListeners(controller.signal, 'abort').length` equals the recorded value (`abort()` added nothing) and `vi.getTimerCount() === 0` after the subsequent `clear()`; (b) no throw, still one abort event; (c) and (d) no throw, `signal.aborted === true`, `outcome() === null`, `vi.getTimerCount() === 0`, caller listener count 0; (e) `outcome() === null` (no `gap` or `total` is ever recorded after `abort()`); (f) `outcome() === 'first'` (`abort()` never erases a recorded outcome); the caller signal is never aborted by any of these calls.

### AC-64: The terminal protocol self-aborts and clears after every terminal, so a finished turn never becomes a phantom timeout (FR-16, FR-17, FR-31)

- **Given** (a) chunks `text-delta 'a'`, `finish` `stop`, `text-delta 'late'`, `{ type: 'abort' }` (the part the SDK emits after the self-abort) with `chunkDelayInMs 0` and `req { timeoutMs: 1000, stallMs: 1000 }`; (b) the same with a stall timer due at 1000 and time advanced to 5000 after the `finish` without `clear()` being called by the test; (c) `probe()` against a mock emitting `OK` at 640 then an `abort` part and 20 deltas
- **When** (a) and (b) are consumed with `for await` and (c) is awaited, then time advances past every budget
- **Then** (a) events deep-equal `[{ type: 'text-delta', text: 'a' }, { type: 'finish', finishReason: 'stop', ... }]`, `'late'` and the `abort` part produce nothing, the recorded `abortSignal.aborted === true`, `vi.getTimerCount() === 0` and `getEventListeners(req.signal, 'abort').length === 0`; (b) no second event, no timeout sentence, no `console.error` call; (c) the probe result stays `{ ok: true, ms: 640 }` with no `error` key and the `abort` part is ignored; a spy on the client's `Deadlines` (the exported `createDeadlines` wrapped with `vi.spyOn` on the module) shows `abort()` called before `clear()` exactly once per stream and per probe.

### AC-65: LLM_ERROR_TEMPLATES is a constant of exactly 13 rows keyed by a closed variant enum, with a closed placeholder vocabulary (FR-23, FR-24, NFR-17)

- **Given** `src/llm/errors.ts` and the entity of section 8.12
- **When** `LLM_ERROR_TEMPLATES`, `LLM_ERROR_PLACEHOLDERS` and `FAKE_FAIL_MESSAGE` are read in `test/llm/errors.test.ts`
- **Then** `LLM_ERROR_TEMPLATES.length === 13`; `templates.map(t => t.variant)` deep-equals `['auth/key','auth/nokey','rate_limit','model_not_found/custom','model_not_found/default','timeout/first','timeout/gap','timeout/total','timeout/probe','network','aborted','unknown/status','unknown/nostatus']` in that order; `templates.map(t => t.kind)` deep-equals `['auth','auth','rate_limit','model_not_found','model_not_found','timeout','timeout','timeout','timeout','network','aborted','unknown','unknown']`; `new Set(templates.map(t => `${t.kind}|${t.variant}`)).size === 13` and `new Set(variants).size === 13`; every template is a non-empty string that equals its trimmed self; `Object.isFrozen(LLM_ERROR_TEMPLATES) === true`; `LLM_ERROR_PLACEHOLDERS` deep-equals `['<p>', '<KEY>', '<status>']`; no template equals `FAKE_FAIL_MESSAGE`; a TypeScript compile-time check (a `satisfies` over the union of the 13 literal ids) fails `pnpm typecheck` if a 14th variant id is added or one is renamed.

### AC-66: The selector resolves every reachable combination to exactly one row and reaches every row (FR-24, NFR-17)

- **Given** the enumeration of 7 kinds x `noKey` {false, true} x `isDefaultModel` {false, true} x `phase` {undefined, `'first'`, `'gap'`, `'total'`, `'probe'`} x `hasStatus` {false, true} = 280 selectors
- **When** `selectVariant(sel)` is called for each and `llmError(kind, ctx, { status: hasStatus ? 418 : undefined, phase })` is rendered for provider `openai` (`keyEnv 'OPENAI_API_KEY'`, or null when `noKey`)
- **Then** every call returns a string that is the variant of exactly one row (`LLM_ERROR_TEMPLATES.filter(t => t.variant === v).length === 1`) and never throws; the union of returned variants equals the full set of 13; the mapping table of FR-24 holds (`auth` to `noKey ? 'auth/nokey' : 'auth/key'`; `rate_limit` to `'rate_limit'`; `model_not_found` to `isDefaultModel ? 'model_not_found/default' : 'model_not_found/custom'`; `timeout` to `'timeout/' + (phase ?? 'first')`; `network` to `'network'`; `aborted` to `'aborted'`; `unknown` to `hasStatus ? 'unknown/status' : 'unknown/nostatus'`); changing `noKey`, `isDefaultModel`, `phase` or `hasStatus` on a kind that does not use that dimension leaves the variant unchanged; every rendered message is a non-empty string ending in `.`, so no selector can produce an empty sentence.

### AC-67: No placeholder survives rendering and no template uses an unknown placeholder (FR-25, NFR-16, NFR-17)

- **Given** the 280 selectors of AC-66 rendered for each of the six providers (openai, anthropic, google, mistral, groq with their `keyEnv`; fake with `keyEnv` null), and every template of `LLM_ERROR_TEMPLATES`
- **When** each rendered message is scanned for `<` and `>` and each template is scanned with `/<[^>]*>/g`
- **Then** none of the 1 680 rendered messages contains `<` or `>`; every match in every template is one of `<p>`, `<KEY>`, `<status>`; `<KEY>` appears only in the `auth/key` row and `<status>` only in the `unknown/status` row; the `aborted` row contains no placeholder at all; for every advertised provider and every row, the rendered `llmError` string equals the template with the placeholders substituted and nothing else changed.

### AC-68: kindForStatus and isConnectionFailure are total pure functions with the documented tables (FR-26, FR-27)

- **Given** `kindForStatus`, `isConnectionFailure` and `CONNECTION_ERROR_CODES` imported from `src/llm/errors.ts`
- **When** `kindForStatus(status, body)` is called for every integer status 100..599 with an undefined body, then for 400 with each body of AC-22, and `isConnectionFailure` is called with the fixtures of AC-23 plus `new Error('x')`, a string, `null` and `undefined`
- **Then** `kindForStatus` returns `auth` for 401 and 403, `model_not_found` for 404, `rate_limit` for 402, 429 and 498, `network` for 408 and every 500..599, `unknown` for every other status; with the AC-22 bodies it returns `auth`, `auth`, `auth`, `model_not_found`, `model_not_found`, `model_not_found`, `unknown`; it never returns `timeout` or `aborted` and never throws; `isConnectionFailure` is true for `TypeError('fetch failed')` with or without a cause, for errors whose own or `cause.code` is in `CONNECTION_ERROR_CODES`, and false for `new Error('x')`, for an `APICallError` with a status, and for non-object inputs; `CONNECTION_ERROR_CODES` deep-equals `['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','EPIPE','ECONNABORTED','EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']`.

### AC-69: Tool schemas are converted with target draft-07, io input and unrepresentable any, and never throw (FR-15, FR-43)

- **Given** `req.tools` with (a) the handoff schema of AC-10; (b) `z.object({ when: z.date(), n: z.number().transform(String) })`; (c) `z.object({ tag: z.string().default('x') })`
- **When** `stream()` runs against a mock that finishes normally
- **Then** (a) `doStreamCalls[0].tools[0].inputSchema.$schema === 'http://json-schema.org/draft-07/schema#'` and the schema contains no `2020-12`; (b) nothing throws, the tool is declared, and `inputSchema.properties.when` deep-equals `{}` (the `any` rendering); (c) `inputSchema.required` does not contain `tag` (`io 'input'` keeps defaulted fields optional); the source of `src/llm/aiSdkClient.ts` contains the literal `target: 'draft-07'` and not `'draft-7'`.

### AC-70: The fake provider builds on the shared Deadlines for every exit path (FR-22, FR-34, FR-35, FR-37)

- **Given** `createLlmClient({ provider: 'fake', apiKey: '' })` under fake timers; (a) a 2 000-word user message with `req { timeoutMs: 500, stallMs: 5000 }`; (b) two concurrent streams on the same client, `person` and `hello`, each with its own `AbortController`, the first aborted at 30 ms; (c) a `slow` stream with `{ timeoutMs: 400, stallMs: 400 }` and a spy on `createDeadlines`
- **When** time advances
- **Then** (a) text-deltas stream until exactly 500 ms, then the single terminal `{ kind: 'timeout', message: 'The fake provider took longer than the LLM_TIMEOUT_MS limit to finish. Try a faster model with LLM_MODEL, or raise LLM_TIMEOUT_MS.' }` and nothing after; (b) the aborted stream ends with exactly one `aborted` event while the other streams to `finish` `stop` with all its words, the two `toolCallId`s (when present) differ, and neither stream's timers leak (`vi.getTimerCount() === 0` after both); (c) `createDeadlines` was called once with `{ signal: req.signal, timeoutMs: 400, stallMs: 400 }`, the terminal at 400 is the `timeout`/`first` sentence for provider fake, and `abort()` then `clear()` were called on the returned `Deadlines` before the generator returned.

### AC-71: The revised spec and the committed tree pass the lint gate (FR-49, NFR-19; human constraint 11c)

- **Given** `specs/llm-providers.md` revised in place on `build/llm-providers` with sections 7.2, 7.4 and 8.6 amended for `abort()` and the Data Models entry 8.12 for `LLM_ERROR_TEMPLATES`
- **When** `pnpm prettier --check specs/llm-providers.md` and `pnpm lint` run on the committed tree, and `git log --oneline -- specs/llm-providers.md` is read
- **Then** both commands exit 0 with no `Code style issues` line; the spec still contains headings AC-1 through AC-61 in order plus AC-62 through AC-71; the Data Models section contains a heading naming `LLM_ERROR_TEMPLATES` with the primary key `(kind, variant)`, the 13-id closed enum and the placeholder vocabulary; section 7.4's `Deadlines` interface contains `abort(): void`; the log shows at least one commit after 3d4f2cf on `build/llm-providers` touching the spec.

---

## Edge Cases

Every external dependency of this feature has at least one entry: the AI SDK core (`ai`), the five `@ai-sdk/*` packages, each vendor's HTTP API, the network stack (undici), zod, Node timers and `AbortSignal`, the mock (`ai/test`), the docs generator, pnpm and the npm registry, gitleaks, the lint gate (eslint and prettier), the `src/main.ts` wiring, and the consumers (agent, status, README). EC-1 to EC-43 are the base revision; EC-44 to EC-56 were added at the contract-lock revision and are grouped at the end with their dependency named in the title.

### AI SDK core

- EC-1: Two terminal parts in one stream. The mock emits an `error` part (APICallError 500) and then a `finish` part with unified `error`. Exactly one error event (kind `network`, status 500) is emitted, the finish is ignored, and the iterator is done afterwards (FR-17).
- EC-2: The stream closes without any `finish` part. The reader closes after two text deltas. The client emits the two deltas then exactly one error `{ kind: 'unknown' }` without status, never hangs, and clears its timers (FR-16, FR-17).
- EC-3: No `abort` part, only an `AbortError` rejection. After the client's stall timer fires the SDK rejects the read with an `AbortError` instead of emitting an abort part. The terminal kind still comes from `deadlines.outcome()`: `timeout`/`first`; the same set-up with the caller's signal yields `aborted`; the SDK's abort reason text is never read (FR-21).
- EC-4: A version bump renames a test or stream name. A future bump of `ai` or `@ai-sdk/*` renames `MockLanguageModelV4`, a fullStream part, `text-delta.text`, `finish.totalUsage` or `streamRetries`: AC-49 and AC-62 fail loudly and the section 7.9 checklist must be re-run; a `package.json` change without a regenerated `pnpm-lock.yaml` fails `pnpm install --frozen-lockfile` in CI (FR-43).
- EC-5: `simulateReadableStream` ignores the abort signal. The mock keeps emitting after the SDK `abortSignal` aborts (after a timer, the caller, or the client's own `deadlines.abort()`). The client stops iterating on its own (AC-17, AC-64): nothing is emitted after the terminal event and the remaining chunks are never observed; a test must not assume the mock stops (FR-17). Conversely, a mock whose next chunk is seconds away (`initialDelayInMs 10_000`) never wakes the pending read when the signal aborts, so the promptness criteria (a terminal at exactly `stallMs` under fake timers, AC-31; `aborted` within 100 ms, AC-35; the probe settled at `PROBE_TIMEOUT_MS`, AC-38c) hold because FR-17 and FR-32 race every `fullStream` read against `deadlines.signal`, not because the SDK emits an `abort` part or rejects the read promptly (revision 3).
- EC-6: `finishReason` `content-filter`. The locked `LlmFinishReason` has no such value, so it arrives as `other`; the agent cannot tell a filtered answer from another early stop and this is accepted (FR-16, OS-13).

### `@ai-sdk/*` packages

- EC-7: The factory throws synchronously. `createOpenAI` (mocked) throws on instantiation, for example for `baseURL 'not a url'`. `createAiSdkClient` still returns synchronously; the first `stream()` yields one error `{ kind: 'unknown' }` without status; `probe()` resolves `{ ok: false }` (FR-9).
- EC-8: An undefined apiKey would read `process.env`. `process.env.OPENAI_API_KEY` is set to `sk-env-must-not-be-used-0123456789` while the client is created with `apiKey ''`. No request is made (auth sentence) and the marker never reaches the factory; the TypeScript type forbids `undefined` and `src/main.ts` passes `config.llmApiKey ?? ''` (FR-10).
- EC-9: A provider option the model rejects. `LLM_MODEL` set exactly to `gemini-2.5-flash` or `gpt-5.6-terra` still sends the low-latency option (value equality); a sibling model gets none; a provider that rejects an option answers 400, which maps to `unknown` with status 400 rather than a wrong-but-confident kind (FR-40, FR-26).
- EC-10: The SDK's default `onError` would print the raw provider error to `console.error`, bypassing pino redaction; the no-op override is guarded by a `console.error` spy with 0 calls, and because `src/llm` cannot import the logger the in-message key scrub is the only redaction inside the module (FR-13, FR-28).

### Vendor HTTP APIs

- EC-11: OpenAI 429 `insufficient_quota` and 401 with the key echoed in the body. The 429 maps to `rate_limit` (the sentence names plan and billing); a 401 whose body reads `Incorrect API key provided: sk-test-not-a-real-key-0123456789` maps to `auth` and the message contains neither the body nor the key (FR-26, FR-28).
- EC-12: OpenAI `max_output_tokens` below 16. A 400 with `integer below minimum value. Expected a value >= 16` maps to `unknown` with status 400; the probe never triggers it because `maxOutputTokens` is 16 (FR-30).
- EC-13: Anthropic 529 overloaded, 402 billing, 401 authentication. 529 `overloaded_error` maps to `network` with status 529; 402 `billing_error` maps to `rate_limit` with status 402; 401 `authentication_error` maps to `auth` with `The anthropic provider rejected the API key in ANTHROPIC_API_KEY. ...` (FR-26).
- EC-14: Google 400 for a bad key, 404 for a model, 429 for quota. 400 with body `API key not valid. Please pass a valid API key.` maps to `auth` with status 400; 404 with `models/x is not found` maps to `model_not_found`; 429 `RESOURCE_EXHAUSTED` maps to `rate_limit` (FR-26).
- EC-15: Mistral: an undocumented 422 for an unknown model. Mistral publishes no error page; a 422 validation error maps to `unknown` with status 422 and the sentence `(HTTP 422)`; the body is never echoed and nothing crashes (FR-26).
- EC-16: Groq 498 flex capacity and 499 cancelled. 498 maps to `rate_limit` with status 498; 499 maps to `unknown` with status 499; both messages are the catalogue sentences for provider groq (FR-26).
- EC-17: A default model id goes stale. Anthropic's `claude-haiku-4-5` carries a retirement commitment of not sooner than 2026-10-15 and Mistral's `mistral-small-latest` alias is not shown on Mistral's current overview; if a vendor drops the id the deployer sees the "default model of this build" sentence on the first self-test and can self-heal with `LLM_MODEL` without a template release (FR-24, FR-42).

### Network stack

- EC-18: Connection, DNS and TLS failures. `TypeError('fetch failed')` with `cause.code` `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_CONNECT_TIMEOUT`, and an unlisted TLS code `ERR_TLS_CERT_ALTNAME_INVALID` all map to `network` without status, because the `fetch failed` TypeError alone is a connection failure; the terminal arrives well before `stallMs` (FR-26).
- EC-19: Headers arrive but the body hangs or drips. A response that never sends a byte (`initialDelayInMs 60_000`) ends as `timeout`/`first` at `stallMs`, not `network`; a body that drips one delta every 400 ms with `stallMs 500` never stalls and ends by the total budget or `finish` (FR-20).
- EC-20: Garbage inside the stream. A `JSONParseError` raised by the SDK mid-stream maps to `unknown` without status; the deltas already forwarded stay valid and no further delta follows the error (FR-16, FR-17).

### zod

- EC-21: Unrepresentable tool schema fields and the target literal. A tool `inputSchema` containing `z.date()` or a transform is converted with `unrepresentable: 'any'` (`{}` per field) and the stream still runs (no throw, the tool is declared to the mock, AC-69); the base revision's `'draft-7'` literal works only through zod's legacy alias, so the implementation uses the typed `'draft-07'`, and a future zod that drops the alias cannot silently change the schema dialect; if zod 3 were installed `z.toJSONSchema` would be missing and AC-49 fails (FR-15, FR-43).

### Timers and signals

- EC-22: Budgets below config's floor and zero. `req { timeoutMs: 1, stallMs: 1 }` yields exactly one `timeout`/`first` terminal at 1 ms and never throws; `timeoutMs 0` yields a `timeout`/`first` on the first pull with still exactly one terminal event (FR-20).
- EC-23: A timer firing after `clear()` or `abort()`. `clear()` or `abort()` runs while a stall timer callback is already queued in the same macrotask batch; the callback is ignored, `outcome()` stays null, and no second terminal event is produced (FR-17, FR-20).
- EC-24: Caller signal reuse, late aborts and a shared abort. One caller signal reused across 100 sequential streams leaves 0 abort listeners after each stream; aborting after the terminal event produces no event and no throw; two concurrent streams sharing one signal each end with exactly one `aborted` event when it aborts once (FR-17, FR-20).

### Consumers of the stream

- EC-25: Pulling after done and iterating twice. `next()` after the terminal returns `{ done: true }` every time; iterating the same `stream()` result a second time yields nothing and starts no new request (`doStreamCalls` stays 1) (FR-17).
- EC-26: Concurrent streams on one client. Two `stream()` calls in flight on the same client produce two independent `doStream` calls with independent timers; aborting one leaves the other streaming to `finish` (FR-17).
- EC-27: Duplicate self-test submits. Two `probe()` calls started concurrently resolve independently with their own `ms` and `doStreamCalls.length === 2`; the client keeps no state between probes; the one-in-flight-per-IP rule belongs to the status feature (FR-32).
- EC-28: The status renderer and apostrophes. Several sentences contain an apostrophe (`provider's`). The HTML renderer escapes it; the status feature's snapshot must compare the unescaped text against the same catalogue string (`LlmError.message`, never a re-wording from `kind`) so the page and the recent-problems detail stay verbatim-equal, and the `POST /selftest` JSON with them once B-3 is adopted (NFR-17).
- EC-29: The test helper's aborted text differs. `test/helpers/fakeLlm.ts` emits `aborted` with `The request was aborted.` while the catalogue says `The request was stopped before the provider finished.`; consumers branch on `kind`, never on the aborted message, and snapshot tests never include the helper's text (FR-29).

### Registry, fake provider and probe

- EC-30: Casing and an empty registry. `createLlmClient({ provider: 'OpenAI' })` throws the valid-values sentence without echoing `OpenAI` (config lowercases before calling); with an empty `providers` array the sentence shape is `Unknown LLM_PROVIDER. Valid values: .` and config raises its existing blocking `registers no LLM providers` problem without crashing (FR-1).
- EC-31: An enormous utterance versus the total budget. A 2 000-word user message with `timeoutMs 500` under fake timers: the fake's echo streams word by word until the shared total timer ends it with `timeout`/`total` at exactly 500 ms (FR-34, FR-35).
- EC-32: Control characters and long text in the handoff summary. A 1 500-character message containing a bell character and the word `person` produces a summary with no character matching `/[\x00-\x1f\x7f]/`, `summary.length <= 1000` and `reason.length <= 200`, and the input parses with the handoff zod schema (FR-36).
- EC-33: Overlapping fake streams. Two fake streams in flight get distinct `toolCallId`s, keep independent timers, and aborting one does not end the other (FR-37).
- EC-34: Empty first delta and a tool-call answer to the probe. A stream whose first delta is `''` then `OK` measures `ms` at the non-empty delta; a model that answers the probe with a tool-call chunk and no text runs to `finish` and reports `{ ok: true, ms: <elapsed at finish> }` (FR-31).
- EC-35: Missing tool ids and a non-object tool input in the history. `agent-core` must set `toolCallId` and `toolName` on every tool message and assistant tool-call message; the client substitutes `''` and never throws, but a provider may reject such a history with a 400 that maps to `unknown`. Likewise `toolInput` is mapped verbatim (`toolInput ?? {}`), and Anthropic and Google require a tool call's input to be a JSON object: if the agent wrote the unparsed string FR-16 forwards for a malformed call back into history for its re-prompt, the re-prompt itself would answer HTTP 400 (`unknown (HTTP 400)`) on those providers and repeat on every later turn, the shape EC-41 fixed for empty content; section 7.7 therefore binds agent-core to record `toolInput` only as a JSON object (FR-14; revision 3).

### Docs generator, package manager and secret scanner

- EC-36: `defaultModel` edited without `pnpm docs:env`. `pnpm docs:env --check` exits 1 printing `docs:env: out of date: .env.example, README.md. Run pnpm docs:env and commit.` and `test/config/docs.test.ts` fails until the files are regenerated and committed (FR-41).
- EC-37: Stale lock or npm by mistake. Pins added to `package.json` without regenerating `pnpm-lock.yaml` make `pnpm install --frozen-lockfile` fail in CI; a `package-lock.json` created by an npm install makes AC-48 fail (FR-43).
- EC-38: A registry outage during install. If the npm registry is unreachable in CI, `pnpm install --frozen-lockfile` fails before any test runs; nothing in this feature retries or vendors packages, and the job is re-run (FR-43).
- EC-39: Placeholder keys that look real. A test using a realistic token shape instead of `sk-test-not-a-real-key-0123456789` would be flagged by the gitleaks job; the placeholders in use must pass the job on the branch (FR-49).
- EC-40: Deployers with `LLM_TIMEOUT_MS` above 10000. The self-test times out at 10 s while calls still work; the probe's own sentence names the self-test limit and the README `## LLM providers` section states the fixed budget, so the page does not raise a false alarm (FR-24, FR-46).

### History and tool-call relations (consumer obligations recorded in section 7.7)

- EC-41: An interrupted turn recorded as empty text. The agent stores the assistant turn truncated at the interrupt, which is `''` when the interrupt lands before the first word, and the caller's next utterance may itself be whitespace-only. FR-14 drops every plain message whose trimmed content is empty before the SDK call, so the anthropic provider, which rejects empty or whitespace-only text with HTTP 400, never sees it and one interrupt does not turn into an `llm_error` handoff on every later turn of the call; the tool-call variant loses only its text part and the tool-result variant is forwarded as is (FR-14, AC-61).
- EC-42: Orphaned tool relations after the history cap. The 60-turn cap could cut between an assistant tool-call message and its tool result, or drop the assistant half of a step. OpenAI requires a tool message to follow the message carrying its tool call and Anthropic requires every tool result to match a tool use in the immediately preceding assistant turn, so such a prompt is answered with HTTP 400 (`unknown (HTTP 400)`) on every turn until the orphan leaves the window. The client forwards the history as given and repairs nothing; the obligation in section 7.7 (trim only at user-turn boundaries; keep or drop a step's tool call and tool result together) is agent-core's (FR-14).
- EC-43: Parallel tool calls in one step. OpenAI returns several `tool-call` parts in one step by default; FR-16 forwards each one unchanged and FR-14 maps consecutive assistant tool-call messages independently. The locked `LlmMessage` carries one `toolCallId` per assistant message, so N calls can only be recorded as N consecutive assistant messages, each of which the providers require to be answered by a tool result before the next stream; the blueprint's agent executes at most one tool per turn, so how the unexecuted calls are represented is agent-core's decision under the section 7.7 obligation. `providerOptions.openai.parallelToolCalls: false` (typed `boolean` for both the Responses and the Chat Completions options in `@ai-sdk/openai` 4.0.62) is the recommended additive change to openai's `LOW_LATENCY` entry, because it closes the hazard on the default path at no cost, though it covers only the exact default model and stays the owner's call (B-11); the obligation on agent-core in section 7.7 remains the mechanism for every other model and provider (FR-14, FR-16, FR-40; revision 3).

### Added at the contract-lock revision

- EC-44 (AI SDK core): The `streamRetries` trap re-speaks words to the caller. Setting `streamRetries: 0` (the natural "disable" reflex) enables an `onError`-requested retry, and an `onError` returning `{ retry: true }` re-runs the step and can re-emit deltas after words were already spoken; FR-12 omits `streamRetries` entirely and FR-13 makes `onError` return `undefined`; AC-11(b) and AC-62 fail if either changes (FR-12, FR-13).
- EC-45 (AI SDK core): The self-abort after `finish` produces an SDK `abort` part. After a normal `finish` the client calls `deadlines.abort()`; `streamText` then emits `{ type: 'abort' }` on `fullStream`; because `outcome()` is null and the client has stopped reading, no timeout sentence, no second terminal and no recent-problems entry can result (AC-64); a regression that maps the `abort` part with `outcome()` null to `unknown` would surface here (FR-16, FR-17).
- EC-46 (`@ai-sdk/*`): SDK-level environment reads redirect traffic. With `baseURL` undefined, `@ai-sdk/openai` 4.0.62 reads `OPENAI_BASE_URL` and `@ai-sdk/anthropic` 4.0.50 reads `ANTHROPIC_BASE_URL` from `process.env` (`loadOptionalSetting`), so a deployer-set `OPENAI_BASE_URL` silently redirects every request while `src/llm` itself never reads `process.env` (AC-58 stays true); keys are safe because a string `apiKey` (`''` included) short-circuits `loadApiKey`; the README `## LLM providers` section documents the two variables (FR-46, AC-51) rather than pinning vendor URLs in code (OS-20); AC-5 pins the literals in the installed packages (FR-10, FR-46).
- EC-47 (npm dist-tags): `latest` drifts from 7.0.94 before implementation. Human constraint 2 requires re-verifying the current major immediately before writing `aiSdkClient.ts`; if `latest` has moved, the exact pins still install 7.0.94 deterministically, but every SDK-facing name in this spec (`MockLanguageModelV4`, the v4 chunk shapes, `streamRetries`, `createGoogleGenerativeAI`, the `reasoningEffort` union) must be re-derived and the pins, AC-48 and AC-49 updated together (FR-43).
- EC-48 (lint gate): Untracked SDK verification dumps at the repository root. `ai-index.d.ts`, `ai-test.d.ts`, `provider.d.ts`, `provider-utils.js` and `sdk-*.d.ts` / `sdk-*.js` / `sdk-*.mjs` sit untracked at the root during this revision; eslint's `**/*.ts` pattern includes `.d.ts` files and `prettier --check .` scans them, so `pnpm lint` fails or hangs on 400 KB files if they remain; they are deleted before the stage commits (AC-54) and never committed (FR-49).
- EC-49 (`src/main.ts` wiring): `LLM_PROVIDER` `''` would crash boot. Config yields `''` from its fallback path or an empty registry; `createLlmClient('')` throws the valid-values sentence, which at boot would violate ADR 0001; the integration feature builds no client and lets `POST /selftest` report the blocking config problem (section 7.7); AC-3 pins the throw so the guard cannot be forgotten silently (FR-1).
- EC-50 (timers): A timer and `abort()` in the same macrotask. The stall timer's callback and a consumer-driven `abort()` (the `finish` arrived in the same tick) race; whichever runs first wins deterministically: a recorded outcome is never erased by `abort()` (AC-63f) and `abort()` before the callback leaves `outcome()` null (AC-63a); either way exactly one terminal is emitted, because the terminal was already chosen from the `finish` part (FR-17, FR-20).
- EC-51 (v4 provider stream): `response-metadata` and other parts the base list omitted. The `LanguageModelV4` stream carries `response-metadata`, `fullStream` carries `reasoning-file`, `tool-output-denied`, `tool-approval-request` and `tool-approval-response`, and providers may add custom parts; anything not in the FR-16 mapping table is dropped after `touch()` (AC-13), never mapped to an error, so a new benign part type in a future provider release cannot end a call (FR-16).
- EC-52 (garbage usage): Non-finite token counts. A `finish` part whose `totalUsage.inputTokens` is `NaN` or `Infinity` is `typeof 'number'` and `JSON.stringify` would render it as `null` in a `turn.timing` log line; FR-16 treats a non-finite count as absent (the `usage` field omitted), and AC-15's `NaN` / `Infinity` fixture with its "no `null` in `JSON.stringify(event)`" check catches a leak; a `finish` part with no `usage` object at all is not a fixture, because the v4 part requires `usage` (8.11; revision 3) (FR-16).
- EC-53 (UTF-16): A surrogate pair split across two deltas. A provider may split an emoji into `'\ud83d'` and `'\ude00'` across deltas; the client forwards each string verbatim (never re-encodes or drops a lone surrogate) so the consumer's join reproduces the character; a "sanitising" change that strips lone surrogates would corrupt speech output and fail AC-12's verbatim check when this fixture is added (FR-16, NFR-8).
- EC-54 (probe budget): A host that accepts the connection and never answers. `initialDelayInMs` beyond 10_000 with no bytes: the probe settles at exactly `PROBE_TIMEOUT_MS` under fake timers with the `timeout`/`probe` sentence and the SDK signal aborted (AC-38c); `LLM_TIMEOUT_MS` is never consulted, so a deployer with `LLM_TIMEOUT_MS` 120000 still gets a bounded status page (FR-30, FR-32, NFR-4).
- EC-55 (prettier on the spec): Table and code-fence reflow. `prettier --write` reflows the markdown tables in this spec (sections 7.3, 7.5, 7.6, 8.x) and can widen a row past 100 columns; the revised spec is formatted after the last edit, and AC-71 fails if a later hand edit leaves `prettier --check` red (FR-49).
- EC-56 (sentence length): A contributor id of 13 or more characters. The `unknown`/`status` sentence is 167 characters plus the id, so 13 lands exactly on the 180 bound (still passing the length property) and 14 exceeds it (AC-25 measures 181); the real guard is AC-4's `/^[a-z0-9]{1,12}$/` on every registered id, and the README's 12-character rule (FR-46) matches it; the property test alone would let a 13-character id ship (FR-4, FR-25).

---

## API Contracts

Status of every contract below: **draft** until the contract lock; the locked seam (7.1) is already **LOCKED** and is quoted, not changed.

### 7.1 Locked seam: `src/llm/types.ts` and `src/llm/registry.ts` (LOCKED, unchanged)

```ts
// src/llm/types.ts (verbatim shapes; the file is not edited by this feature)
export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';
export interface LlmMessage {
  role: LlmRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
}
export interface LlmToolSpec {
  name: string;
  description: string;
  inputSchema: ZodType;
}
export type LlmFinishReason = 'stop' | 'tool-calls' | 'length' | 'other';
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}
export type LlmErrorKind =
  'auth' | 'rate_limit' | 'timeout' | 'network' | 'model_not_found' | 'aborted' | 'unknown';
export interface LlmError {
  kind: LlmErrorKind;
  status?: number;
  message: string;
}
export type LlmEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; name: string; input: unknown }
  | { type: 'finish'; finishReason: LlmFinishReason; usage?: LlmUsage }
  | { type: 'error'; error: LlmError };
export interface LlmStreamRequest {
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  signal: AbortSignal;
  timeoutMs: number;
  stallMs: number;
}
export interface LlmProbeResult {
  ok: boolean;
  ms: number;
  error?: LlmError;
}
export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  stream(req: LlmStreamRequest): AsyncIterable<LlmEvent>;
  probe(): Promise<LlmProbeResult>;
}
export interface LlmProviderModule {
  id: string;
  advertised: boolean;
  description: string;
  keyEnv: string | null;
  keyDescription: string;
  defaultModel: string;
  create(o: { model: string; apiKey: string }): LlmClient;
}

// src/llm/registry.ts (unchanged)
export const providers: readonly LlmProviderModule[]; // [openai, anthropic, google, mistral, groq, fake]
export interface LlmCatalogEntry {
  id;
  advertised;
  description;
  keyEnv;
  keyDescription;
  defaultModel;
}
export const llmCatalog: readonly LlmCatalogEntry[];
export const advertisedProviderIds: readonly string[];
export function createLlmClient(o: { provider: string; model?: string; apiKey: string }): LlmClient;
// Error: throws Error('Unknown LLM_PROVIDER. Valid values: openai, anthropic, google, mistral, groq.') for an unregistered id; never echoes the input.
```

### 7.2 `src/llm/aiSdkClient.ts` (new; the only importer of `ai` and `@ai-sdk/*`)

```ts
export type SdkFactoryId = 'openai' | 'anthropic' | 'google' | 'mistral' | 'groq';

export interface AiSdkClientOptions {
  provider: string; // registry id; becomes LlmClient.provider and the <p> of every sentence
  sdk: SdkFactoryId; // which @ai-sdk package builds the model; compile-time checked
  keyEnv: string; // non-empty, matching 8.1's pattern; named in the 'in <KEY>' clause of the auth sentence; null exists only in LlmErrorContext, for the fake (revision 3)
  model: string; // LlmClient.model; sent to the provider verbatim
  isDefaultModel: boolean; // selects the model_not_found sentence variant
  apiKey: string; // always a string; '' answers auth with no request; never undefined
  providerOptions?: Record<string, Record<string, unknown>>; // passed verbatim to streamText and probe()
  baseURL?: string; // optional; with sdk 'openai' the client uses openai.chat(model) (Chat Completions)
}

export function createAiSdkClient(o: AiSdkClientOptions): LlmClient; // synchronous, no I/O, never throws
export const PROBE_TIMEOUT_MS = 10_000; // total and stall budget of probe()
export const PROBE_MAX_OUTPUT_TOKENS = 16; // the smallest value every provider accepts
export const PROBE_PROMPT = 'Reply with the single word OK.';
```

`stream(req)` — one `streamText` call per invocation:

```ts
streamText({
  model, // built lazily from the sdk map with { apiKey, baseURL? }
  messages: toModelMessages(req.messages), // mapping and the empty-content drop in FR-14
  tools: toSdkTools(req.tools), // tool({ description, inputSchema: jsonSchema(z.toJSONSchema(schema, { target: 'draft-07', io: 'input', unrepresentable: 'any' })) }); no execute, no validate
  abortSignal: deadlines.signal, // createDeadlines({ signal: req.signal, timeoutMs: req.timeoutMs, stallMs: req.stallMs }): the single signal handed to the SDK
  maxRetries: 0, // SDK default 2
  providerOptions: o.providerOptions,
  onError: () => {}, // void no-op: never the SDK default (console.error of the raw error), never a { retry: true } return
});
// NOT passed: streamRetries (OMITTED, not 0: the 7.0.94 doc says omitting it disables all stream-retry behaviour, while 0 lets
// onError request one retry that re-runs the step), timeout, onAbort, stopWhen (default stepCountIs(1): no second step because
// no tool has execute), toolChoice, maxOutputTokens (probe only), headers, fetch.
```

Success responses (events, in order of arrival): zero or more `{ type: 'text-delta', text }` and `{ type: 'tool-call', toolCallId, name, input }`, then exactly one `{ type: 'finish', finishReason, usage? }`.

Error responses (exactly one, then the iterator is done): `{ type: 'error', error: LlmError }` with `kind` from the table in 7.3. `stream()` itself never throws and never rejects.

Terminal protocol (FR-17): after the one terminal event the client calls `deadlines.abort()` (aborts the combined signal handed to `streamText`, so the HTTP request is released; records no outcome, so `outcome()` stays null and no timeout sentence can follow) and then `deadlines.clear()` (both timers cleared, the caller listener removed, idempotent); every later part, the SDK's `abort` part caused by the self-abort included, is ignored; the generator's `finally` does the same when the consumer exits early; iterating one `stream()` result twice yields nothing and starts no request; concurrent streams on one client are independent. Every `await` on the `fullStream` iterator is raced against the abort of `deadlines.signal` (one listener on the client's own per-stream signal, removed in the same `finally`; the read a won race leaves pending is settled silently), so the terminal follows the abort instant even if the SDK neither emits an `abort` part nor rejects the pending read; the kind still comes from `outcome()` (FR-17, FR-21, EC-5).

`probe()`:

```ts
// Request: messages [{ role: 'user', content: PROBE_PROMPT }], no tools, maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
// maxRetries 0, providerOptions as stream(), the same void onError, streamRetries omitted,
// abortSignal: createDeadlines({ signal: <never-aborted AbortSignal>, timeoutMs: PROBE_TIMEOUT_MS, stallMs: PROBE_TIMEOUT_MS }).signal
// (LLM_TIMEOUT_MS is NOT used).
// Success: { ok: true, ms }   ms = elapsed Date.now() milliseconds (an integer) at the first non-empty text-delta, after which the
//                             client calls deadlines.firstToken(), deadlines.abort() (a self-abort: not an error, outcome() null,
//                             at most 16 output tokens billed) and deadlines.clear(); or elapsed at finish when no text arrived
//                             (zero tokens and tool-call-only answers still count as ok), followed by the same abort() and clear().
// Failure: { ok: false, ms, error: LlmError }  same classifier as stream(); a client timer yields timeout with phase 'probe'.
// Never throws; settles within PROBE_TIMEOUT_MS plus one microtask on every path (a hung host included: every read is raced
// against deadlines.signal, FR-32); no state between probes;
// concurrent probes are independent; the model's text is never returned.
```

### 7.3 `src/llm/errors.ts` (new; pure; imports only `./types.js`)

```ts
export interface LlmErrorContext {
  provider: string;
  keyEnv: string | null;
  isDefaultModel: boolean;
}
export type TimeoutPhase = 'first' | 'gap' | 'total' | 'probe';
export type LlmErrorVariant =
  // closed enum: exactly these 13 ids, in table order (section 8.12)
  | 'auth/key'
  | 'auth/nokey'
  | 'rate_limit'
  | 'model_not_found/custom'
  | 'model_not_found/default'
  | 'timeout/first'
  | 'timeout/gap'
  | 'timeout/total'
  | 'timeout/probe'
  | 'network'
  | 'aborted'
  | 'unknown/status'
  | 'unknown/nostatus';
export interface LlmErrorTemplate {
  kind: LlmErrorKind;
  variant: LlmErrorVariant;
  template: string;
}
export const LLM_ERROR_TEMPLATES: readonly LlmErrorTemplate[]; // frozen; exactly 13 rows in table order; primary key (kind, variant), unique; variant alone unique
export const LLM_ERROR_PLACEHOLDERS: readonly ['<p>', '<KEY>', '<status>']; // the closed placeholder vocabulary; no other '<...>' token exists in any template
export interface LlmErrorSelector {
  kind: LlmErrorKind;
  noKey: boolean; // ctx.keyEnv === null
  isDefaultModel: boolean;
  phase?: TimeoutPhase; // timeout only; undefined -> 'first'
  hasStatus: boolean; // status !== undefined
}
export function selectVariant(sel: LlmErrorSelector): LlmErrorVariant; // total: FR-24 mapping; every one of the 280 combinations -> exactly one row; every row reached (AC-66)
export function llmError(
  kind: LlmErrorKind,
  ctx: LlmErrorContext,
  o?: { status?: number; phase?: TimeoutPhase },
): LlmError; // = { kind, ...(o?.status !== undefined ? { status: o.status } : {}), message } with message = the selected row's template, <p> -> ctx.provider, <KEY> -> ctx.keyEnv, <status> -> String(o.status)
export function kindForStatus(
  status: number,
  responseBody?: string,
): Exclude<LlmErrorKind, 'timeout' | 'aborted'>;
export function isConnectionFailure(err: unknown): boolean;
export const CONNECTION_ERROR_CODES: readonly string[] = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
];
```

The sentence catalogue (`<p>` = provider id, `<KEY>` = keyEnv, `<status>` = HTTP status). Exactly one message per (kind, variant); printed verbatim by every consumer; snapshot-tested for every advertised provider.

| Kind / variant                   | Sentence                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth (keyEnv set)                | `The <p> provider rejected the API key in <KEY>. Check the key in your Railway variables, then redeploy.`                                                                         |
| auth (keyEnv null)               | `The <p> provider rejected the API key. Check the key in your Railway variables, then redeploy.`                                                                                  |
| rate_limit                       | `The <p> provider refused the request because of a rate or usage limit. Check your plan and billing with the provider, then try again.`                                           |
| model_not_found (LLM_MODEL set)  | `The <p> provider does not know the model set in LLM_MODEL. Check the name against the provider's model list, or remove LLM_MODEL to use the default.`                            |
| model_not_found (default in use) | `The <p> provider does not know the default model of this build. Set LLM_MODEL to a current model name from the provider's model list.`                                           |
| timeout / first                  | `The <p> provider did not start answering within the LLM_TIMEOUT_MS limit. Try a faster model with LLM_MODEL, or raise LLM_TIMEOUT_MS.`                                           |
| timeout / gap                    | `The <p> provider stopped mid-answer for longer than the LLM_TIMEOUT_MS limit. Try a faster model with LLM_MODEL, or raise LLM_TIMEOUT_MS.`                                       |
| timeout / total                  | `The <p> provider took longer than the LLM_TIMEOUT_MS limit to finish. Try a faster model with LLM_MODEL, or raise LLM_TIMEOUT_MS.`                                               |
| timeout / probe                  | `The <p> provider did not start answering within the 10 second self-test limit. Try a faster model with LLM_MODEL, or run the self-test again.`                                   |
| network                          | `The server could not reach the <p> provider, or the provider is down. Check the provider's status page, then try again.`                                                         |
| aborted                          | `The request was stopped before the provider finished.` (internal: never spoken, recorded, counted or logged above debug)                                                         |
| unknown (status known)           | `The <p> provider returned an error the server does not recognise (HTTP <status>). Run the self-test again; if it keeps failing, open a GitHub issue with the text of this page.` |
| unknown (no status)              | `The <p> provider returned an error the server does not recognise. Run the self-test again; if it keeps failing, open a GitHub issue with the text of this page.`                 |
| fake, bare `fail`                | `The fake provider failed on purpose.` (kind unknown, no status)                                                                                                                  |

Variant ids of `LLM_ERROR_TEMPLATES`, in table order: `auth/key`, `auth/nokey`, `rate_limit`, `model_not_found/custom`, `model_not_found/default`, `timeout/first`, `timeout/gap`, `timeout/total`, `timeout/probe`, `network`, `aborted`, `unknown/status`, `unknown/nostatus`; the type `LlmErrorVariant` is that closed set and nothing else; the fake's bare-`fail` sentence (`FAKE_FAIL_MESSAGE`, exported by `providers/fake.ts`) has no placeholder and no README entry, so it is deliberately not a table row. The table is the entity of section 8.12, which fixes its keys, the placeholder vocabulary and the two invariants (coverage and no surviving placeholder) that AC-65 to AC-67 enforce. The README troubleshooting glossary (OS-4) is rendered from these rows either per advertised provider (60 exact sentences) or as the 13 placeholder rows with `<p>` shown as `<provider>` and `<KEY>` and `<status>` as is; which one is B-5's decision, and NFR-17's whole-sentence guarantee reaches the README only under the first (revision 3).

Measured lengths for the shipped ids (3-digit status): the `unknown` sentence with a status is 171 (groq), 173 (openai, google), 174 (mistral) and 176 (anthropic) characters, the range decision (f) records; every other sentence is at most 165 characters (anthropic `unknown` without status). Bound: 180 (FR-25); the `unknown` sentence with a status is 167 characters plus the id, so 13 is the exact edge and section 8.1 caps `id` at 12.

Kind table (applied in order; vendor codes checked 2026-09-09 against developers.openai.com error codes, platform.claude.com API errors, ai.google.dev API errors and console.groq.com errors; Mistral publishes no error page and relies on the generic rows):

| Order | Condition                                                                                                                          | Kind                                       | status        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------- |
| 1     | `req.signal.aborted`                                                                                                               | aborted                                    | absent        |
| 2     | a client timer fired (`deadlines.outcome()`)                                                                                       | timeout, phase first / gap / total / probe | absent        |
| 3     | `LoadAPIKeyError`, or `apiKey === ''` (no request)                                                                                 | auth                                       | absent        |
| 4     | `NoSuchModelError`                                                                                                                 | model_not_found                            | absent        |
| 5     | `RetryError`                                                                                                                       | classify `lastError`                       | as classified |
| 6     | `APICallError` 401, 403                                                                                                            | auth                                       | present       |
| 6     | `APICallError` 404                                                                                                                 | model_not_found                            | present       |
| 6     | `APICallError` 402, 429, 498                                                                                                       | rate_limit                                 | present       |
| 6     | `APICallError` 408, 500..599 (502, 503, 504, 529 included)                                                                         | network                                    | present       |
| 6     | `APICallError` 400 with body matching `/api key not valid\|invalid api key\|invalid_api_key\|incorrect api key\|authentication/i`  | auth                                       | 400           |
| 6     | `APICallError` 400 with body matching `/model_not_found\|invalid model\|unknown model\|model .{0,60}(not found\|does not exist)/i` | model_not_found                            | 400           |
| 6     | `APICallError` any other status                                                                                                    | unknown                                    | present       |
| 7     | `APICallError` without `statusCode`, or `isConnectionFailure(err)`                                                                 | network                                    | absent        |
| 8     | `TypeValidationError`, `JSONParseError`, `NoContentGeneratedError`, an `AbortError` while neither signal fired, anything else      | unknown                                    | absent        |

### 7.4 `src/llm/deadlines.ts` (new; pure timers; imports only `./types.js`)

```ts
export type DeadlineOutcome = 'caller' | 'first' | 'gap' | 'total';
export interface Deadlines {
  readonly signal: AbortSignal; // combined: aborts when the caller's signal aborts, when a timer fires, or on abort(); aborted synchronously at creation when the caller's signal already is
  touch(): void; // any provider activity (every fullStream part, empty deltas included): re-arms the stall timer for stallMs (before the first token too); no-op after clear()
  firstToken(): void; // first forwarded token: from here a timer reports 'gap' (stall) or 'total' (total) instead of 'first' (also touches)
  outcome(): DeadlineOutcome | null; // 'caller' whenever the caller's signal is aborted, even if a timer fired in the same tick;
  // otherwise recorded once by the first timer callback to run: 'first' for any timer before firstToken();
  // after firstToken(): 'gap' for the stall timer, 'total' for the total timer, 'gap' on a same-tick tie;
  // otherwise null. abort() and clear() never record anything; a timer firing after abort() or clear() is ignored
  abort(): void; // revision 2, binding: idempotent; aborts the combined signal WITHOUT recording an outcome, so outcome() stays
  // null and a self-abort never yields a timeout sentence; adds no listener to the caller signal (NFR-5's count is unaffected);
  // never aborts the caller signal; never erases an outcome a timer already recorded. The mechanism FR-17 and FR-31 cite for
  // releasing the HTTP request after every terminal event and after the probe's first token; FR-12 still hands streamText the
  // single abortSignal deadlines.signal; an SDK 'abort' part arriving after the terminal is ignored; AC-10, AC-17, AC-18 and
  // AC-37 observe abortSignal.aborted === true through it; providers/fake.ts builds on the same shape
  clear(): void; // idempotent: clears both timers, removes the caller listener; safe before or after abort(); a callback already queued in the same macrotask is ignored
}
export function createDeadlines(o: {
  signal: AbortSignal;
  timeoutMs: number;
  stallMs: number;
}): Deadlines;
// Semantics: FR-20. Sentence from outcome(): 'caller' -> aborted; 'first' -> timeout/first; 'gap' -> timeout/gap;
// 'total' -> timeout/total; inside probe() any timer -> timeout/probe; null after abort() -> no sentence at all.
// With stallMs === timeoutMs (what config produces) only 'first' and 'total' are reachable. No exceptions are thrown by any member.
// Usage protocol: stream(): touch() on every part, firstToken() at the first forwarded token, terminal -> abort() then clear();
// early consumer exit -> finally abort() then clear(). probe(): firstToken() then abort() then clear() at the first non-empty delta.
// State (revision 3): three independent facts, not one exclusive state. (1) recorded: null until the first timer callback to run
// sets it once to 'first' | 'gap' | 'total'; never erased by abort() or clear() and never set after either. (2) callerAborted:
// the caller signal's own aborted flag, read live. (3) signal.aborted: true once the caller aborts, a timer fires or abort() runs.
// outcome() = callerAborted ? 'caller' : recorded, so a fired timer followed by a caller abort reports 'caller' (AC-29a), a fired
// timer followed by abort() keeps 'first' (AC-63f), and abort() with nothing recorded reports null (AC-63a).
// Lifecycle: armed -> touched* -> first-token-seen? -> signal aborted (by any of the three) -> cleared.
```

### 7.5 `src/llm/providers/fake.ts` (scripted provider; LlmProviderModule values)

```ts
export const fake: LlmProviderModule = {
  id: 'fake', advertised: false,
  description: 'Scripted replies for tests and the simulator. No key and no network.',
  keyEnv: null, keyDescription: 'No key needed.', defaultModel: 'scripted',
  create: ({ model }) => LlmClient { provider: 'fake', model }   // ctx { provider: 'fake', keyEnv: null, isDefaultModel: model === 'scripted' }
};
export const FAKE_FAIL_MESSAGE = 'The fake provider failed on purpose.'; // outside LLM_ERROR_TEMPLATES (section 8.12); kind unknown, no status
// imports '../errors.js', '../deadlines.js' and '../types.js' only; the same Deadlines shape as the AI SDK client, abort() included
```

| Trigger (last user message, trimmed, case-insensitive; precedence top to bottom)            | Events                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/\bfail(?:\s+(auth\|rate_limit\|timeout\|network\|model_not_found\|aborted\|unknown))?\b/` | one `error`: bare or unrecognised kind gives `{ kind: 'unknown', message: 'The fake provider failed on purpose.' }`; `fail <kind>` gives `llmError(kind, ctx)` (timeout phase `first`)                                                         |
| `/\bslow\b/`                                                                                | nothing until a deadline fires: the `timeout`/`first` sentence whichever timer fires (no token is ever forwarded), or `aborted` if the caller aborts first                                                                                     |
| `/\bperson\b/` with `handoff_to_team` declared                                              | `tool-call { toolCallId: 'fake-call-<n>', name: 'handoff_to_team', input: { reason: 'Caller asked for a person.', summary: cut('The caller asked to speak to a person. Last message: ' + text, 1000) } }`, then `finish` `tool-calls`; no text |
| `/\bhuman\b/` with `handoff_to_team` declared                                               | the words of `Sure, let me get someone for you.` as text-deltas, then the same tool call and finish                                                                                                                                            |
| `person` or `human` without the tool                                                        | `I cannot transfer you right now, but I can keep helping here.` then `finish` `stop`                                                                                                                                                           |
| anything else                                                                               | `You said: <text>. How else can I help?` then `finish` `stop` with `usage { inputTokens: words in req.messages, outputTokens: words in the reply }`                                                                                            |
| empty message                                                                               | `I did not catch that. Could you say it again?` then `finish` `stop`                                                                                                                                                                           |

Helpers (defined here so the script is reproducible):

- `text`: the last `user` message's `content` with leading and trailing whitespace trimmed and every run of whitespace (`/\s+/g`) collapsed to one space; the triggers match on it case-insensitively, the echo and the handoff summary quote it, and `''` after normalisation is the empty message.
- `cut(s, max)`: first removes every control character (`/[\x00-\x1f\x7f]/g`), then truncates to the first `max` characters (`slice(0, max)`) with no ellipsis; the result is at most `max` characters long and contains no control character.
- `words(s)`: `s.trim() === '' ? 0 : s.trim().split(/\s+/).length`; `words(req.messages)` is the sum of `words(content)` over every message of every role (`system`, `user`, `assistant`, `tool`), and `words(reply)` equals the number of text-deltas the reply produces (a reply is built from single-spaced text, so the two counts agree). AC-39: `You are a helpful agent.` plus `hello there` is 7; `You said: hello there. How else can I help?` is 9.

Streaming: word by word (split on single spaces, each word followed by a space except the last, so the deltas joined equal the reply), the first word on the first pull without a timer wait, then about 25 ms between words; the combined `createDeadlines().signal` is checked before every word and during every wait, and an abort ends the stream with the one terminal `outcome()` selects (`aborted` for the caller, the `timeout` sentence for the fired phase); every exit (the terminal, an early consumer exit, a fired timer) calls `abort()` then `clear()` on the deadlines (FR-37, AC-70). `probe()` resolves `{ ok: true, ms: 0 }`. The tool-call counter is per client instance. Error response shape is the shared `LlmError`; the fake never throws.

### 7.6 Provider catalogue values and low-latency defaults (`src/llm/providers/*.ts`)

Every real `create()` is `({ model, apiKey }) => createAiSdkClient({ provider: id, sdk: id, keyEnv, model, isDefaultModel: model === defaultModel, apiKey, providerOptions: model === defaultModel ? LOW_LATENCY : undefined })`.

| id        | advertised | keyEnv (equals the SDK default) | defaultModel                                | LOW_LATENCY providerOptions (default model only)        | Source checked 2026-09-09                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | ---------- | ------------------------------- | ------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openai    | true       | `OPENAI_API_KEY`                | `gpt-5.6-terra` (changed from `gpt-5-mini`) | `{ openai: { reasoningEffort: 'none' } }`               | developers.openai.com/api/docs/models (index: `gpt-5.6-terra` balances intelligence and cost, `gpt-5.6-luna` for cost-sensitive workloads); /models/gpt-5.6-terra (Responses API, function calling, streaming; reasoning none / low / medium (default) / high / xhigh / max; $2 / $12 per MTok); /models/gpt-5-mini (not deprecated; recommends GPT-5.6 Terra for new low-latency, high-volume workloads); /guides/reasoning (`none` for latency-critical tasks; GPT-6 Astra rejects `none` with HTTP 400). Alternative if the owner prefers cost: `gpt-5.6-luna` ($0.2 / $1.2 per MTok) |
| anthropic | true       | `ANTHROPIC_API_KEY`             | `claude-haiku-4-5` (unchanged)              | none (no thinking by default)                           | platform.claude.com/docs/en/models/overview (alias of `claude-haiku-4-5-20251001`, the fastest model, retirement not sooner than 2026-10-15; no newer Haiku listed)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| google    | true       | `GOOGLE_GENERATIVE_AI_API_KEY`  | `gemini-2.5-flash` (unchanged)              | `{ google: { thinkingConfig: { thinkingBudget: 0 } } }` | ai.google.dev/gemini-api/docs/models (stable; best price-performance for low-latency, high-volume tasks); ai-sdk.dev google page (`thinkingBudget: 0` disables thinking on the 2.5 family)                                                                                                                                                                                                                                                                                                                                                                                               |
| mistral   | true       | `MISTRAL_API_KEY`               | `mistral-small-latest` (unchanged)          | none                                                    | ai-sdk.dev mistral page lists the alias; docs.mistral.ai names the current Small as `mistral-small-2603` without the alias, so the owner spot check applies (Q12)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| groq      | true       | `GROQ_API_KEY`                  | `llama-3.3-70b-versatile` (unchanged)       | none                                                    | console.groq.com/docs/models (production model, about 280 tokens per second)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| fake      | false      | null                            | `scripted`                                  | n/a                                                     | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

`description` and `keyDescription` strings stay as they are. Changing a `defaultModel` requires `pnpm docs:env` (README table and `.env.example`), a CHANGELOG line and a re-run of `docs/acceptance.md` section 2.

### 7.7 Consumer slices (additive; owned by other features, quoted here so the sentences stay verbatim)

`POST /selftest`: a proposed amendment to the blueprint contract 'Status, health, chat and self-test HTTP surface', which today reads `error?: string /* plain English from LlmError.kind */`. This spec cannot edit the blueprint; the status-page-test-chat-and-selftest spec MUST adopt the shape below (additive under ADR 0002) or record why not, and NFR-17's guarantee reaches the JSON only once it has (the README leg depends on B-5 in the same way; the status feature's snapshot test MUST be written against `LlmError.message`, never against a re-wording from `kind`). Recorded here, not decided here:

```ts
// POST /selftest  (cookie required)  request body: {}
interface SelfTestResponse {
  // 200 application/json
  llm: {
    ok: boolean;
    ms: number; // time to first token
    error?: string; // PROPOSED: LlmError.message verbatim, never re-worded from kind (the blueprint says 'plain English from LlmError.kind')
    kind?: LlmErrorKind; // PROPOSED, additive, optional, absent when ok
    provider?: string; // PROPOSED, additive, optional: the in-use values
    model?: string;
  };
  webhook: { ok: boolean; status?: number; ms: number; error?: string };
}
// 401 { error } without the cookie; 429 { error: 'Too many requests. The limit is 60 per minute per address.' } (unchanged).
// Rendering: 'LLM: ok, <ms> ms to first word' or 'LLM: failed. <message>' with a visually hidden 'Ok:' or 'Failed:' prefix;
// while running: 'Testing the model, up to 10 seconds' with the button disabled; the no-JS form POST renders the same text.
```

Recent problems (status buffer; agent-core records): `{ kind: 'llm_error', detail: `${error.kind}: ${error.message}` }` for every kind except `aborted`, the same `<reason>: <message>` shape as `ws_rejected`. Tokened "in use" line: `LLM: <provider>, <model>`. Open points for the status feature, listed in Appendix B: whether to skip the probe (or hide the button) while a blocking problem names the provider's `keyEnv`, because a client built with `apiKey ''` answers the `auth/key` sentence, which reads wrong for a merely missing key; whether a failed self-test is recorded into recent problems; whether the 10 second self-test limit is printed next to the in-use line when `LLM_TIMEOUT_MS` exceeds it.

Log events (`src/llm` emits none; consumers quote `LlmClient` and `LlmError`):

```ts
// call.started   { provider: LlmClient.provider, model: LlmClient.model }
// turn.timing    ms_prompt_to_llm_first_token measured by the agent at its first text-delta or tool-call event
// call.ended     error_kind: 'auth' | 'rate_limit' | 'timeout' | 'network' | 'model_not_found' | 'unknown'   // never 'aborted'
// A provider's raw error text is never logged: LlmError carries only kind, status and the catalogue sentence.
```

`src/main.ts` wiring rule (lands with integration-drain-and-simulator): `createLlmClient({ provider: config.LLM_PROVIDER, model: config.LLM_MODEL, apiKey: config.llmApiKey ?? '' })`, constructed even when `ready` is false so `POST /selftest` can explain a rejected key, but only when `config.LLM_PROVIDER !== ''`: `loadConfig` yields `''` from its fallback config (when `load()` itself throws) and from an empty registry, `createLlmClient` throws for an unregistered id, and a throw there would crash boot against ADR 0001, so in that case no client is constructed (`llm` is null), boot completes, and `POST /selftest` reports the blocking config problem instead of a probe result. Every other value config produces is a registered id (an unknown `LLM_PROVIDER` value is replaced by the first advertised provider with a blocking problem); readiness stays config-only (ADR 0001).

History, tool and timer obligations this feature relies on (owned by agent-core and tools-and-automation-webhook, neither of which has a spec yet; recorded here because `src/llm` forwards the history as given and repairs nothing, and because the client's timeout kinds exist only if the agent does not pre-empt them):

- Every `tool` message and every assistant tool-call message carries `toolCallId` and `toolName` (EC-35).
- History is trimmed only at user-turn boundaries: after the system prompt the window starts with a `user` message, a `tool` message never appears without its assistant tool-call message immediately before it, and a step's assistant tool-call message and its tool result are kept or dropped together, so the 60-turn cap never cuts between them (EC-42).
- Every assistant tool-call message recorded in history is answered by its tool result before the next `stream()`; when a step carries several tool calls, the agent decides how the calls it did not execute are represented under the same constraint (EC-43).
- Empty-content turns may be recorded (an interrupt before the first word); this feature drops them before the SDK call (FR-14, EC-41), so agent-core need not normalise.
- The handoff_to_team zod schema written by tools-and-automation-webhook keeps accepting `{ reason: string <= 200, summary: string <= 1000 }` with no added required field, the shape the blueprint's ToolSeam decision fixed and the fake emits (FR-36, EC-32); a change there updates FR-34 and AC-40 in the same release.
- `toolInput` on an assistant tool-call message recorded in history is a JSON object (the parsed, validated input the agent executed, or `{}`); the unparsed string FR-16 forwards for a malformed call is never written back, because Anthropic and Google require a tool call's input to be an object and would answer the re-prompt with HTTP 400 on every later turn (FR-14, EC-35; revision 3).
- Agent-core MUST NOT arm any timer that aborts `req.signal` at or before `req.timeoutMs`: `req.signal` aborts only for an interrupt or a hangup; the client's `timeoutMs` and `stallMs` (both `LLM_TIMEOUT_MS`, 8.5) are the only LLM timeout; the agent's `llm_timeout` end policy is derived from the client's `timeout` kind (which is also what reaches `error_kind` and the recent-problems entry); and any agent watchdog is strictly later than `timeoutMs` and, if it ever fires first, a contract violation. Otherwise, because the caller's signal wins every tie (FR-18) and the blueprint's `CallSession` carries its own `timers.llmTimeout?` (whose t0 precedes the client's `createDeadlines`, so it would always fire first), every production timeout would classify as `aborted`: never spoken, never recorded into recent problems, never `error_kind`, no timeout sentence anywhere, and the 'model that reasons for twenty seconds' failure the Context names would be invisible (revision 3, binding).

### 7.8 Import boundary rows (`test/arch/imports.test.ts`, matrix unchanged)

```text
src/llm/aiSdkClient.ts      -> 'ai', '@ai-sdk/openai', '@ai-sdk/anthropic', '@ai-sdk/google', '@ai-sdk/mistral', '@ai-sdk/groq', 'zod', './types.js', './errors.js', './deadlines.js'
src/llm/errors.ts           -> './types.js' only
src/llm/deadlines.ts        -> './types.js' only
src/llm/providers/<id>.ts   -> '../aiSdkClient.js' (value), '../types.js' (type); never 'ai' or '@ai-sdk/*'
src/llm/providers/fake.ts   -> '../errors.js', '../deadlines.js', '../types.js'
src/llm/stub.ts             -> deleted
src/llm                     -> nothing from src/config, src/log, src/agent, src/status, src/voice
Failure texts: 'only src/llm/aiSdkClient.ts may import the AI SDK'; 'llm may not import <path>'
```

### 7.9 AI SDK v7 verification record and exact pins (Q11; human constraint 2)

Verified 2026-09-09 from the npm registry dist-tags (re-checked while writing this spec: `latest` = 7.0.94; `ai-v6` = 6.0.278; `ai-v5` = 5.0.253), ai-sdk.dev reference pages, the vercel/ai source on `main` and the published `.d.ts` of the pinned versions.

```jsonc
// package.json dependencies (exact, no caret)
"ai": "7.0.94", "@ai-sdk/openai": "4.0.62", "@ai-sdk/anthropic": "4.0.50", "@ai-sdk/google": "4.0.65",
"@ai-sdk/mistral": "4.0.40", "@ai-sdk/groq": "4.0.38", "zod": "4.5.4"
// transitive: @ai-sdk/provider 4.0.11 (spec v4), @ai-sdk/provider-utils 5.0.37; engines.node 24.x kept (ai requires >= 22); packageManager pnpm@11.10.0 kept
```

API notes the implementer builds against (re-run this list on any bump):

- `streamText` options used: `model`, `messages`, `tools`, `abortSignal`, `maxRetries` (default 2, set 0), `maxOutputTokens` (probe only), `providerOptions`, `onError` (default logs to `console.error`, always overridden with a void no-op). Available but unused: `timeout` (`{ totalMs, stepMs, firstChunkMs, chunkMs, toolMs }`), `onAbort`, `stopWhen` (default `stepCountIs(1)`), `toolChoice`, `headers`, `fetch`, and `streamRetries` (verified in the 7.0.94 declaration: "Set to 0 to disable automatic stream retries while allowing `onError` to request retries. Omit to disable all stream retry behavior. Default: 0."; `onError` is typed `StreamTextOnErrorCallback | StreamTextOnErrorRetryCallback | StreamTextOnErrorHandler`, and the retry-capable form returns `{ retry: true }` to re-run the current step while "partial output from a failed attempt that was already emitted cannot be retracted"; hence FR-12 omits the option and FR-13 returns `undefined`).
- `fullStream` `abort` part: emitted as `{ type: 'abort', reason?: string }` whenever the `abortSignal` aborts, including after the client's own `deadlines.abort()` following a `finish`; the client has stopped reading by then (FR-17, EC-45).
- `MockLanguageModelV4` (from `ai/test`) declares `specificationVersion = "v4"` and `doStreamCalls: LanguageModelV4CallOptions[]`; the `ai` entry re-exports `APICallError`, `LoadAPIKeyError`, `NoSuchModelError`, `NoContentGeneratedError`, `TypeValidationError` and `JSONParseError` from `@ai-sdk/provider` (each with a static `isInstance`) and declares `RetryError` itself.
- Provider packages and the environment: `@ai-sdk/openai` 4.0.62 resolves `baseURL` with `loadOptionalSetting` from `OPENAI_BASE_URL` and the key from `"OPENAI_API_KEY"` only when `apiKey` is not a string; `@ai-sdk/anthropic` 4.0.50 does the same with `ANTHROPIC_BASE_URL` and `"ANTHROPIC_API_KEY"`; the google, mistral and groq packages carry their key literal and no base-URL variable (AC-5, EC-46). `reasoningEffort` in 4.0.62 is typed `'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'none' | 'minimal'`; `thinkingConfig.thinkingBudget` in 4.0.65 is typed `number`.
- zod 4.5.4: `z.toJSONSchema(schema, { target?: 'draft-04' | 'draft-07' | 'draft-2020-12' | 'openapi-3.0' | ({} & string), io?: 'input' | 'output', unrepresentable?: 'throw' | 'any' })`; the implementation normalises the legacy `'draft-7'` to `'draft-07'`, so the SDK's own `zod4Schema` still works with the alias, while this client passes the typed `'draft-07'` (FR-15).
- `fullStream` (`TextStreamPart`) parts and fields: `text-delta { id, text }`; `tool-call { toolCallId, toolName, input, invalid?, error?, dynamic?, providerExecuted? }`; `tool-error`; `tool-result`; `tool-input-start`/`delta`/`end`; `start`; `start-step { request, warnings }`; `finish-step { usage, finishReason, rawFinishReason, response }`; `finish { finishReason, rawFinishReason, totalUsage }`; `error { error: unknown }`; `abort { reason?: string }`; `reasoning-delta`; `source`; `file`; `raw`; `custom`.
- `FinishReason`: `'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'`; `LanguageModelUsage { inputTokens?, outputTokens?, totalTokens?, inputTokenDetails?, outputTokenDetails? }`.
- `tool({ description, inputSchema: Zod | JSON Schema, execute? })`: `execute` is optional; without it the tool call is forwarded and no tool-result is produced. `jsonSchema(schema, { validate? })` with `validate` omitted skips validation (the raw value is returned). The SDK itself converts zod v4 with `z.toJSONSchema(schema, { target: 'draft-7', io: 'input' })` (the legacy alias); this client converts with the typed `'draft-07'` and `unrepresentable: 'any'` (FR-15, AC-69).
- `fullStream` parts the base list omitted, verified in the 7.0.94 union: `reasoning-file { file }`, `tool-output-denied`, `tool-approval-request`, `tool-approval-response`; the v4 provider stream also carries `response-metadata`; all dropped after `touch()` (FR-16, EC-51).
- Invalid input or an unknown tool name: `parseToolCall` returns `{ type: 'tool-call', invalid: true, dynamic: true, error, ... }` and the stream forwards it; no error part.
- Abort: when `abortSignal` aborts the stream emits `{ type: 'abort', reason: getErrorMessage(signal.reason) }` (free text, never relied on); an `AbortError` while the signal is aborted becomes that abort part, otherwise the stream errors (caught by the client).
- Errors: emitted as `{ type: 'error', error }` parts and passed to `onError`; classes exported from `ai`: `APICallError { statusCode?, responseBody?, responseHeaders?, isRetryable, url, cause? }` with static `isInstance`, `LoadAPIKeyError`, `NoSuchModelError { modelId, modelType }`, `RetryError { lastError, errors, reason }`, `NoSuchToolError`, `InvalidToolInputError`, `TypeValidationError`, `JSONParseError`, `NoContentGeneratedError`.
- `ModelMessage`: assistant content parts `{ type: 'text', text } | { type: 'tool-call', toolCallId, toolName, input }`; tool content `[{ type: 'tool-result', toolCallId, toolName, output: { type: 'text' | 'json' | 'error-text' | 'error-json' | 'content' | 'execution-denied', value } }]`.
- Providers: `createOpenAI({ apiKey (default env OPENAI_API_KEY), baseURL, headers, fetch })`; `openai(id)` is the Responses API, `openai.chat(id)` is Chat Completions; `providerOptions.openai.reasoningEffort` `'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`; `createAnthropic` (ANTHROPIC_API_KEY); `createGoogleGenerativeAI` (GOOGLE_GENERATIVE_AI_API_KEY; `providerOptions.google.thinkingConfig.thinkingBudget`); `createMistral` (MISTRAL_API_KEY); `createGroq` (GROQ_API_KEY).
- `ai/test`: `MockLanguageModelV4({ provider?, modelId?, doGenerate?, doStream? })` with `doStreamCalls: LanguageModelV4CallOptions[]`; `simulateReadableStream({ chunks, initialDelayInMs?, chunkDelayInMs? })` from `ai`. v4 chunk shapes: `{ type: 'stream-start', warnings: [] }`, `{ type: 'text-start', id }`, `{ type: 'text-delta', id, delta }`, `{ type: 'text-end', id }`, `{ type: 'tool-call', toolCallId, toolName, input: '<json text>' }`, `{ type: 'error', error }`, `{ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total, noCache, cacheRead, cacheWrite }, outputTokens: { total, text, reasoning } } }`.
- OpenAI Responses API: `max_output_tokens` minimum 16 (HTTP 400 `integer below minimum value. Expected a value >= 16` below it), hence `PROBE_MAX_OUTPUT_TOKENS = 16`; an unknown or inaccessible model answers HTTP 404 `The model X does not exist or you do not have access to it`.
- Vendor error codes: Anthropic 401 authentication_error, 402 billing_error, 403 permission_error, 404 not_found_error, 429 rate_limit_error, 500 api_error, 504 timeout_error, 529 overloaded_error; Google 401, 403 permission_denied, 404 model_not_found, 429 rate_limit_exceeded or quota_exceeded, 500, 503 service_unavailable, 504 deadline_exceeded; Groq 401, 403, 404, 429, 498 flex capacity, 499 cancelled, 500, 502, 503; OpenAI 401 incorrect API key, 403 region, 429 rate limit or credit_balance_exhausted or spend limits, 500, 503 server_is_overloaded.

### 7.10 Test doubles and the offline guarantee (`test/llm/*`)

```ts
// Injection (no production hook), one per provider file:
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn((opts) =>
    Object.assign((modelId) => mockModel, { chat: vi.fn(() => mockModel) }),
  ),
}));
const mockModel = new MockLanguageModelV4({
  doStream: async (options) => {
    seen.push(options);
    return { stream: simulateReadableStream({ chunks, initialDelayInMs, chunkDelayInMs }) };
  },
});
// Fetch guard, per file, in beforeAll:
globalThis.fetch = (input) => {
  throw new Error(`network call escaped the mocks: ${new URL(String(input)).host}`);
};
// Option-set recorder (AC-62): the real streamText wrapped so every call's option object is inspectable:
vi.mock('ai', async (orig) => ({
  ...(await orig()),
  streamText: vi.fn((await orig()).streamText),
}));
// Deadlines spy (AC-64, AC-70): vi.spyOn on the exported createDeadlines of src/llm/deadlines.js records abort() before clear().
// Snapshot: test/llm/__snapshots__/errors.test.ts.snap holds the 60 rendered sentences (5 advertised providers x 12 variants);
// the enumeration test (280 selectors) and the placeholder test (1 680 rendered messages) run over LLM_ERROR_TEMPLATES (AC-65 to AC-67).
// Markers 'RESPONSE-BODY-MARKER' and 'SDK-MESSAGE-MARKER' must never appear in any emitted message or JSON.stringify(event).
// Chunk fixtures (v4): text = stream-start, text-start, text-delta{delta} x n, text-end, finish{ finishReason: { unified: 'stop' }, usage };
// tool = tool-input-start/delta/end, tool-call{ input: JSON text }, finish{ unified: 'tool-calls' };
// errors = doStream rejecting with new APICallError({ statusCode, responseBody, url: 'https://example.invalid', requestBodyValues: {} }),
//          LoadAPIKeyError, NoSuchModelError, RetryError, TypeError('fetch failed') with cause.code, plain Error, finish{ unified: 'error' }.
```

---

## Data Models

No database and nothing on disk at runtime: every entity below lives in process memory for the life of one stream, one probe or the process. The locked seam types are quoted for completeness; the new entities are the ones this feature adds.

### 8.1 Provider catalogue entry (`LlmProviderModule` / `LlmCatalogEntry`, locked shape, values set by this feature)

| Field          | Type                                                | Constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id             | string                                              | `/^[a-z0-9]{1,12}$/`; unique across `providers[]` (the primary key: `createLlmClient` uses `find`, so a duplicate would shadow its twin silently; `new Set(ids).size === providers.length`, AC-47; revision 3); equals the file basename under `src/llm/providers/`; the `LLM_PROVIDER` value; the cap follows from the 180-character bound (the `unknown` sentence with a 3-digit status is 167 characters plus the id, so 13 is the exact edge and 12 keeps one character in hand) |
| advertised     | boolean                                             | true for openai, anthropic, google, mistral, groq; false for fake (hidden from README, `.env.example`, valid-values sentence)                                                                                                                                                                                                                                                                                                                                                        |
| description    | string                                              | one plain sentence, no newline, none of `<` `>` `"` `&`, never a value; unchanged from the foundation                                                                                                                                                                                                                                                                                                                                                                                |
| keyEnv         | string \| null                                      | `/^[A-Z][A-Z0-9_]*_API_KEY$/` (asserted generically over every registered provider, AC-4) and equal to the SDK's default variable; null only for fake; never `''` (a real provider passes it to `createAiSdkClient`, whose `keyEnv` is a non-empty `string`, 8.2)                                                                                                                                                                                                                    |
| keyDescription | string                                              | one plain sentence used as the fix clause of `<KEY>: is not set. <keyDescription>`; unchanged                                                                                                                                                                                                                                                                                                                                                                                        |
| defaultModel   | string                                              | non-blank, single line; openai `gpt-5.6-terra`, anthropic `claude-haiku-4-5`, google `gemini-2.5-flash`, mistral `mistral-small-latest`, groq `llama-3.3-70b-versatile`, fake `scripted`                                                                                                                                                                                                                                                                                             |
| create         | (o: { model: string; apiKey: string }) => LlmClient | synchronous; never throws; never reads `process.env`                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 8.2 `AiSdkClientOptions` (new)

| Field           | Type                                                         | Constraints                                                                                                                                                |
| --------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider        | string                                                       | registry id; becomes `LlmClient.provider` and `<p>` in every sentence                                                                                      |
| sdk             | `'openai' \| 'anthropic' \| 'google' \| 'mistral' \| 'groq'` | compile-time key of the sdk map                                                                                                                            |
| keyEnv          | string                                                       | non-empty, matching 8.1's pattern; named in the `in <KEY>` clause of the auth sentence; `null` exists only in `LlmErrorContext`, for the fake (revision 3) |
| model           | string                                                       | non-blank (the registry has already defaulted it); sent verbatim                                                                                           |
| isDefaultModel  | boolean                                                      | `model === defaultModel` by value; selects the model_not_found variant                                                                                     |
| apiKey          | string                                                       | required, may be `''` (answers auth without a request); never `undefined`                                                                                  |
| providerOptions | Record<string, Record<string, unknown>> \| undefined         | passed verbatim to `streamText` and `probe()`                                                                                                              |
| baseURL         | string \| undefined                                          | with sdk `openai` selects `openai.chat(model)`; an unusable value surfaces as `unknown` on first use, never at construction                                |

### 8.3 `LlmError` (locked shape; values fixed by this feature)

| Field   | Type                                                                                              | Constraints                                                                                                                                                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| kind    | `'auth' \| 'rate_limit' \| 'timeout' \| 'network' \| 'model_not_found' \| 'aborted' \| 'unknown'` | the machine key printed in `call.ended.error_kind` (never `aborted`) and as the recent-problems prefix                                                                                                                                                                                                                                                                  |
| status  | number \| undefined                                                                               | present exactly when derived from an HTTP status (auth, rate_limit, model_not_found, network from 408 or a 5xx, unknown with status); always an integer in 100..599, because an `APICallError.statusCode` outside that set (`0`, `600`, `NaN`, a non-number) is treated as absent by FR-26 row 7 and FR-27, so `(HTTP 0)` or `(HTTP NaN)` can never render (revision 3) |
| message | string                                                                                            | a catalogue sentence (7.3): 1 or 2 sentences, sentence case, ends with `.`, at most 180 characters, no newline, none of `<` `>` `"` `&` backtick, no lowercase `http`, capital runs only `API`, `HTTP`, `LLM_MODEL`, `LLM_TIMEOUT_MS`, keyEnv; never a key, model id or provider text; `[redacted]` replaces the key as a last resort                                   |

### 8.4 `LlmEvent` variants (locked shape; mapping fixed by this feature)

| Variant    | Field        | Type                                                        | Constraints                                                                                                                                                                                                 |
| ---------- | ------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text-delta | text         | string                                                      | non-empty (empty deltas are dropped); forwarded unmodified and immediately; UTF-8 safe, never split or joined                                                                                               |
| tool-call  | toolCallId   | string                                                      | the SDK's id verbatim (fake: `fake-call-<n>`, distinct across the streams of one client; the counter is per client instance)                                                                                |
| tool-call  | name         | string                                                      | the SDK's `toolName` verbatim, even when undeclared                                                                                                                                                         |
| tool-call  | input        | unknown                                                     | the SDK's `input` verbatim, including an unparsed string when the JSON was malformed                                                                                                                        |
| finish     | finishReason | `'stop' \| 'tool-calls' \| 'length' \| 'other'`             | `content-filter` and `other` collapse to `other`                                                                                                                                                            |
| finish     | usage        | `{ inputTokens?: number; outputTokens?: number }` \| absent | undefined fields omitted; the key is present only when at least one of the two is a finite number (both totals undefined or non-finite yields no `usage` key, never `usage: {}`); the fake always sets both |
| error      | error        | LlmError                                                    | exactly one per stream, always the last event                                                                                                                                                               |

### 8.5 `LlmStreamRequest` and `LlmProbeResult` (locked shapes; how this feature reads them)

| Entity           | Field     | Type               | Constraints                                                                                                                                                                                                                                                                                                |
| ---------------- | --------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LlmStreamRequest | messages  | LlmMessage[]       | mapped per FR-14; missing tool ids become `''`; plain messages whose trimmed content is empty are dropped before the call; `toolInput` is forwarded verbatim, so agent-core records it as a JSON object (7.7, EC-35)                                                                                       |
| LlmStreamRequest | tools     | LlmToolSpec[]      | declared without `execute`; names are the SDK tool keys                                                                                                                                                                                                                                                    |
| LlmStreamRequest | signal    | AbortSignal        | the caller's; always wins; may already be aborted; aborted by the agent only for an interrupt or a hangup, never by an agent timer at or before `timeoutMs` (7.7, FR-18), so a production timeout is always the client's `timeout` kind                                                                    |
| LlmStreamRequest | timeoutMs | number             | used as given; the agent passes `LLM_TIMEOUT_MS` (config: 1000..120000, fallback 20000); tests and the fake may pass 0 or 1                                                                                                                                                                                |
| LlmStreamRequest | stallMs   | number             | used as given; same source as timeoutMs today (`LLM_TIMEOUT_MS`), so in production only the `first` and `total` phases are reachable; armed at creation, so it bounds time-to-first-token as well as the gap between tokens, a widening of the seam comment 'once streaming has started' recorded in FR-20 |
| LlmProbeResult   | ok        | boolean            | true when the request completed (even with zero tokens)                                                                                                                                                                                                                                                    |
| LlmProbeResult   | ms        | number             | integer milliseconds as a `Date.now()` difference (never `performance.now()`, which vitest's fake timers leave real), time to first non-empty token or to finish; 0 for the fake                                                                                                                           |
| LlmProbeResult   | error     | LlmError \| absent | present exactly when `ok` is false                                                                                                                                                                                                                                                                         |

### 8.6 Deadlines (new)

| Entity          | Field                            | Type                                      | Constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | -------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deadlines       | signal                           | AbortSignal                               | combined; aborted synchronously at creation when the caller's signal already is                                                                                                                                                                                                                                                                                                                                                                                               |
| Deadlines       | touch                            | () => void                                | re-arms the stall timer for stallMs; no-op after clear()                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Deadlines       | firstToken                       | () => void                                | from here a timer reports `gap` (stall) or `total` (total) instead of `first`; also touches                                                                                                                                                                                                                                                                                                                                                                                   |
| Deadlines       | outcome                          | () => DeadlineOutcome \| null             | `'caller'` whenever the caller's signal is aborted; else recorded once by the first timer callback to run: `'first'` for any timer before firstToken(), after it `'gap'` for the stall timer and `'total'` for the total timer with `'gap'` on a same-tick tie; else null; `abort()` and `clear()` never record anything and a timer firing after either is ignored                                                                                                           |
| Deadlines       | abort                            | () => void                                | revision 2, binding: idempotent; aborts the combined `signal` WITHOUT recording an outcome (so `outcome()` stays null and a self-abort never yields a timeout sentence); adds no listener to the caller signal (NFR-5's count unaffected); never aborts the caller signal; never erases a recorded outcome; the mechanism FR-17 and FR-31 cite for releasing the HTTP request after every terminal event and after the probe's first token; the fake builds on the same shape |
| Deadlines       | clear                            | () => void                                | idempotent; clears both timers and the caller listener; safe before or after `abort()`; a callback already queued in the same macrotask is ignored                                                                                                                                                                                                                                                                                                                            |
| DeadlineOutcome | value                            | `'caller' \| 'first' \| 'gap' \| 'total'` | maps to aborted, timeout/first, timeout/gap, timeout/total (probe: any timer maps to timeout/probe)                                                                                                                                                                                                                                                                                                                                                                           |
| TimeoutPhase    | value                            | `'first' \| 'gap' \| 'total' \| 'probe'`  | the `phase` option of `llmError` for kind timeout; default `first`                                                                                                                                                                                                                                                                                                                                                                                                            |
| LlmErrorContext | provider, keyEnv, isDefaultModel | string, string \| null, boolean           | the three inputs every sentence needs; built once per client                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 8.7 Fake provider script row (new; one per trigger)

| Field     | Type                                                                                                                                                       | Constraints                                                                                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| trigger   | RegExp                                                                                                                                                     | whole-word, case-insensitive, over the trimmed last user message; precedence fail, slow, person, human, echo                                                                                                               |
| needsTool | string \| null                                                                                                                                             | `handoff_to_team` for person and human; the tool-call is emitted only when a tool with that name is in `req.tools`                                                                                                         |
| text      | string \| null                                                                                                                                             | the words streamed before the terminal (null for person, slow and fail); always ends with `.` or `?` (FR-37)                                                                                                               |
| toolCall  | `{ toolCallId: 'fake-call-<n>'; name: 'handoff_to_team'; input: { reason: string <= 200; summary: string <= 1000, control characters stripped } }` \| null | parses with the handoff_to_team zod schema; the input shape is the blueprint's ToolSeam decision and section 7.7 records that tools-and-automation-webhook keeps the schema accepting it; `<n>` counts per client instance |
| terminal  | `finish stop` \| `finish tool-calls` \| `error <kind>` \| `deadline`                                                                                       | exactly one; `deadline` means the shared timers decide (slow)                                                                                                                                                              |
| usage     | `{ inputTokens: number; outputTokens: number }`                                                                                                            | present on every `finish` the fake emits: `words(req.messages)` and `words(reply)` as section 7.5 defines, integers >= 0; `outputTokens` is 0 on the person path (no text) and 7 on the human path (revision 3)            |

### 8.8 Sdk map entry and package pins (new)

| Entity        | Field   | Type                                                  | Constraints                                                                                                                                                                                 |
| ------------- | ------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sdk map entry | id      | SdkFactoryId                                          | one entry per `@ai-sdk/*` package; adding a package is one entry plus `pnpm add @ai-sdk/<id>@<exact>`                                                                                       |
| Sdk map entry | factory | (o: { apiKey: string; baseURL?: string }) => provider | `createOpenAI`, `createAnthropic`, `createGoogleGenerativeAI`, `createMistral`, `createGroq`; `baseURL` is forwarded unchanged to every one of them (only openai switches API on it, FR-11) |
| Sdk map entry | model   | (provider, modelId, baseURL?) => LanguageModel        | `openai.chat(id)` when baseURL is set, else `provider(id)`                                                                                                                                  |
| Package pin   | name    | string                                                | `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/mistral`, `@ai-sdk/groq`, `zod`                                                                                     |
| Package pin   | version | string                                                | exact `/^\d+\.\d+\.\d+$/`: 7.0.94, 4.0.62, 4.0.50, 4.0.65, 4.0.40, 4.0.38, 4.5.4; mirrored in `pnpm-lock.yaml`                                                                              |

### 8.9 Consumer records that quote this feature (owned elsewhere; field constraints this feature relies on or proposes)

| Entity                        | Field                                    | Type                                                                                 | Constraints                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RecentProblem (status buffer) | kind                                     | `'llm_error'`                                                                        | recorded by the agent for every kind except `aborted`                                                                                                                                                     |
| RecentProblem                 | detail                                   | string                                                                               | `<error.kind>: <error.message>`; value-free; scrubbed by the logger's value redaction as well                                                                                                             |
| TurnTiming (agent)            | ms_prompt_to_llm_first_token             | number \| null                                                                       | measured by the agent at its first text-delta or tool-call event; the client adds no delay                                                                                                                |
| call.ended (log)              | error_kind                               | `'auth' \| 'rate_limit' \| 'timeout' \| 'network' \| 'model_not_found' \| 'unknown'` | never `aborted`                                                                                                                                                                                           |
| SelfTestResponse.llm (status) | ok, ms, error?, kind?, provider?, model? | boolean, number, string, LlmErrorKind, string, string                                | PROPOSED for the status spec to adopt (section 7.7): `error` is `LlmError.message` verbatim; `kind`, `provider`, `model` are additive and optional; this feature cannot guarantee a shape it does not own |

### 8.10 `docs/acceptance.md` section 2 row (owner-run; committed with blank results)

| Field    | Type   | Constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step     | string | one of: self-test ok with ms on openai `gpt-5.6-terra`; billed output tokens of one self-test at most 16; wrong key shows the auth sentence; wrong `LLM_MODEL` shows the model_not_found sentence; three-turn call with first text under 1.5 s median and 3 s p95 (`@event:turn.timing`, `ms_prompt_to_first_text_out`); interrupt mid-answer produces no `llm_error` entry; docs-only spot check of the four other default model names; anthropic, google, mistral, groq live rows |
| Expected | string | the sentence or number from this spec, quoted verbatim                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Result   | string | empty in the committed file; `not run` when skipped; never a build gate                                                                                                                                                                                                                                                                                                                                                                                                             |

### 8.11 Test fixture chunk (v4 `MockLanguageModelV4` stream part; test-only)

| Field                 | Type                                                                                                                                                                                                                                                   | Constraints                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| type                  | `'stream-start' \| 'text-start' \| 'text-delta' \| 'text-end' \| 'tool-input-start' \| 'tool-input-delta' \| 'tool-input-end' \| 'tool-call' \| 'error' \| 'finish' \| 'reasoning-start' \| 'reasoning-delta' \| 'reasoning-end' \| 'source' \| 'raw'` | the v4 provider spec names; renamed parts fail AC-49                                                                                                                                                                                                         |
| delta / input / error | string / string / unknown                                                                                                                                                                                                                              | `text-delta.delta` is the text; `tool-call.input` is JSON text (possibly malformed on purpose)                                                                                                                                                               |
| finishReason          | `{ unified: FinishReason; raw?: string }`                                                                                                                                                                                                              | `unified` drives the mapping in FR-16                                                                                                                                                                                                                        |
| usage                 | `{ inputTokens: { total, ... }; outputTokens: { total, ... } }`                                                                                                                                                                                        | required by the v4 `finish` part (`provider.d.ts`: `usage: LanguageModelV4Usage`; the SDK reads `usage.inputTokens.total`), so no fixture omits it; `total` fields become `LlmUsage`; both totals undefined or non-finite yields no `usage` key (revision 3) |

### 8.12 `LLM_ERROR_TEMPLATES` / `LlmErrorTemplate` (new; the sentence catalogue as data; revision 2, binding)

A frozen in-memory constant exported by `src/llm/errors.ts` (FR-23); the single source of every `LlmError.message` produced under `src/llm`, of the 60-sentence snapshot (AC-24) and of the README troubleshooting glossary (OS-4). NFR-17's byte-identical guarantee rests on this entity.

| Field    | Type                                                                                                                                                                                                                                                                    | Constraints                                                                                                                                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| kind     | `'auth' \| 'rate_limit' \| 'timeout' \| 'network' \| 'model_not_found' \| 'aborted' \| 'unknown'`                                                                                                                                                                       | the locked `LlmErrorKind`; every one of the seven kinds has at least one row                                                                                                                                                                                                                                                 |
| variant  | `LlmErrorVariant` = `'auth/key' \| 'auth/nokey' \| 'rate_limit' \| 'model_not_found/custom' \| 'model_not_found/default' \| 'timeout/first' \| 'timeout/gap' \| 'timeout/total' \| 'timeout/probe' \| 'network' \| 'aborted' \| 'unknown/status' \| 'unknown/nostatus'` | a closed enum of exactly these 13 ids in this (table) order: auth x2, rate_limit, model_not_found x2, timeout x4, network, aborted, unknown x2; unique on its own; a 14th id or a rename fails `pnpm typecheck` (a `satisfies` check) and AC-65; the prefix before `/` (or the whole id) equals `kind`                       |
| template | string                                                                                                                                                                                                                                                                  | non-empty, equal to its trimmed self; the sentence of section 7.3 for the variant, verbatim, carrying only placeholders from `LLM_ERROR_PLACEHOLDERS`; `<KEY>` appears only in `auth/key`, `<status>` only in `unknown/status`, `<p>` in every row except `aborted`, which carries no placeholder; obeys FR-25 once rendered |

Keys, cardinality and membership:

| Property          | Constraint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary key       | `(kind, variant)`, unique; `variant` alone is also unique; the row order is the section 7.3 table order                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Cardinality       | exactly 13 rows, `Object.isFrozen(LLM_ERROR_TEMPLATES) === true`; no empty state and no loading state exist (a constant), so a missing row can only fail a test at build, never render an empty message at runtime                                                                                                                                                                                                                                                                                                      |
| Outside the table | the fake provider's bare-`fail` sentence `The fake provider failed on purpose.` (`FAKE_FAIL_MESSAGE`, exported by `src/llm/providers/fake.ts`; kind `unknown`, no status) is explicitly not a row: no placeholder, no README entry; `LLM_ERROR_TEMPLATES.some((t) => t.template === FAKE_FAIL_MESSAGE) === false` (AC-42)                                                                                                                                                                                               |
| Placeholders      | `LLM_ERROR_PLACEHOLDERS = ['<p>', '<KEY>', '<status>']` is the closed vocabulary: every match of `/<[^>]*>/g` in every template is one of the three (AC-67); `<p>` renders as the provider id, `<KEY>` as `keyEnv`, `<status>` as the HTTP status; the README glossary (B-5) renders the rows either per advertised provider, exactly as `llmError` does, or as placeholder rows with `<p>` shown as `<provider>` and the other two as is; only the first makes a README row byte-identical to a page sentence (NFR-17) |

Selector (`LlmErrorSelector`, the input of `selectVariant`, FR-24):

| Field          | Type                                                  | Derived from                                            | Effect                                                             |
| -------------- | ----------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| kind           | `LlmErrorKind`                                        | the classifier (section 7.3 kind table) or the fake     | picks the kind's row group                                         |
| noKey          | boolean                                               | `ctx.keyEnv === null`                                   | `auth` only: `auth/nokey` when true, `auth/key` when false         |
| isDefaultModel | boolean                                               | `model === defaultModel` by value                       | `model_not_found` only: `/default` when true, `/custom` when false |
| phase          | `'first' \| 'gap' \| 'total' \| 'probe'` \| undefined | `deadlines.outcome()`; `probe` inside `probe()`         | `timeout` only: `timeout/<phase>`, `first` when undefined          |
| hasStatus      | boolean                                               | `status !== undefined` (an HTTP status was seen, FR-27) | `unknown` only: `/status` when true, `/nostatus` when false        |

Invariants (each enforced by a test in `test/llm/errors.test.ts`):

- Coverage (AC-66): the selector is total. Every one of the 280 combinations (7 kinds x `noKey` {false, true} x `isDefaultModel` {false, true} x `phase` {undefined, `first`, `gap`, `total`, `probe`} x `hasStatus` {false, true}) resolves to exactly one existing row, and every one of the 13 rows is reached by at least one combination; a dimension a kind does not use never changes its variant; every rendered message is a non-empty string ending in `.`.
- No surviving placeholder (AC-67): for every row rendered for every provider (the five advertised ids with their `keyEnv`, and fake with `keyEnv` null; 6 x 280 = 1 680 messages) no `<` or `>` character survives, so a deployer never sees `<KEY>` on the page, in `POST /selftest` or in recent problems; for every advertised provider and every row the rendered string equals the template with the placeholders substituted and nothing else changed (AC-24).
- Text bounds (AC-25, FR-25): every rendered sentence is at most 180 characters (the longest shipped is 176), which with the `unknown/status` row at 167 characters plus the id is what caps a provider id at 12 characters (8.1, EC-56).

Consumers of the entity: `llmError` (the only renderer), `providers/fake.ts` (`fail <kind>`), the 60-sentence snapshot, and readme-template-and-release, which renders the 13 rows in table order into the README troubleshooting glossary and never hand-writes a sentence (OS-4).

---

## Out of Scope

- OS-1: The agent's tool loop, `FALLBACK_MESSAGE`, `HANDOFF_MESSAGE`, the `llm_error` / `llm_timeout` end policy and the `turn.timing` measurement. Reason: they belong to agent-core (blueprint decision "Agent core owns the tool loop"); this feature only guarantees the events and sentences the agent consumes.
- OS-2: Rendering of the self-test result, the recent-problems list, the "in use" line and the additive `kind`, `provider` and `model` fields of `POST /selftest`. Reason: owned by status-page-test-chat-and-selftest; section 7.7 records the shape as a proposed blueprint amendment that spec must adopt so the sentences stay verbatim.
- OS-3: Wiring `createLlmClient` into `src/main.ts`. Reason: lands with integration-drain-and-simulator; the wiring rule (`apiKey: config.llmApiKey ?? ''`, constructed even when not ready, skipped only for the empty id of the fallback config) is recorded in 7.7 so it cannot drift.
- OS-4: The README troubleshooting glossary (one entry per kind and variant with `<provider>`, `<KEY>` and `<status>` placeholders; 13 rows in table order, the fake's bare-`fail` sentence excluded) and the `error_kind` glossary. Reason: rendered by readme-template-and-release from the entity of section 8.12; this feature ships `LLM_ERROR_TEMPLATES` (the closed variant list as data, primary key `(kind, variant)`), the `llmError` function that renders it, the coverage and placeholder invariants that test it and the snapshot that freezes it, so the glossary comes from the table rather than a duplicated list; whether the glossary is rendered per provider (60 exact sentences that match whole-sentence find-in-page) or as 13 placeholder rows is that feature's choice (Appendix B).
- OS-5: Live network tests for Anthropic, Google, Mistral and Groq. Reason: gate resolution Q12; they ship wired and unit-tested with mocked keys, and a live row in `docs/acceptance.md` runs only if the owner supplies a key.
- OS-6: A boot-time probe that records a rejected key before anyone presses the self-test. Reason: readiness is config-only with no network at boot (ADR 0001) and a probe per deploy spends the deployer's credits; it can be added later as an additive change in the integration feature if the owner wants it.
- OS-7: Any retry inside a turn (one immediate retry on 429 or 5xx included). Reason: `maxRetries: 0` keeps `LLM_TIMEOUT_MS` true and an interruption cheap; a retry would add silent seconds before the fallback, and the agent's policy is one shot per step.
- OS-8: Appending the provider's short error code token (for example `insufficient_quota`) to the `unknown` or `rate_limit` sentence, or logging the scrubbed provider text at debug. Reason: the locked `LlmError` has no field for it, `src/llm` cannot log, and a code token is a value-shaped string that the redaction rules keep out of deployer-facing text.
- OS-9: Shipping an OpenAI-compatible provider file (DeepSeek, xAI, Together, OpenRouter). Reason: the five-provider set is fixed for v1; `AiSdkClientOptions.baseURL` exists so a contributor can add one as one file plus one registry line without touching `aiSdkClient.ts`. Such a file still declares a non-empty `keyEnv` (FR-10, 8.2): a keyless host (Ollama, LM Studio, vLLM) gets a variable whose value it ignores, and dropping the key requirement for those hosts is a later additive change to FR-10.
- OS-10: A `goodbye` trigger in the fake provider that calls `end_call`. Reason: `end_call` is an agent capability, not a registry tool; the fake's script is additive and integration-drain-and-simulator can add the trigger when the simulator needs outcome `completed`.
- OS-11: A family-prefix rule for low-latency options (every `gpt-5.6-*` or `gemini-2.5-*` model). Reason: a model that rejects the option answers HTTP 400, which maps to `unknown`; value equality with `defaultModel` is the only rule that cannot misfire.
- OS-12: An environment variable for reasoning effort or thinking budget. Reason: blueprint decision "Configuration surface kept small"; a deployer who sets `LLM_MODEL` runs with the provider's own settings and the README says so.
- OS-13: A distinct `content-filter` finish reason. Reason: the locked `LlmFinishReason` has four values and the seam is not edited (ADR 0003); `content-filter` arrives as `other`.
- OS-14: Passing `LLM_TIMEOUT_MS` into `probe()`. Reason: the locked `create({ model, apiKey })` signature cannot carry it; the probe has the fixed `PROBE_TIMEOUT_MS` with its own sentence and the README states the 10 second budget.
- OS-15: `providerOptions.openai.store = false` or any other provider-side data-retention flag. Reason: whether caller transcripts may be stored by the provider is an owner privacy decision; it is an additive `providerOptions` change when decided.
- OS-16: Audio, Media Streams, speech-to-text or text-to-speech inside `src/llm`. Reason: the seam is text-level by design; audio adapters live under `src/voice/`.
- OS-17: Executing tools, validating tool input or running more than one step inside the SDK (`execute`, `stopWhen`, `toolChoice`). Reason: blueprint decision; the agent's zod check and re-prompt loop are the single validator and the tool runner.
- OS-18: Any Railway account action, Twilio call or live deployment during the build. Reason: human constraint 6; the owner runs `docs/acceptance.md` section 2 and records what a real deploy showed.
- OS-19: Editing `src/config`, `src/log`, `src/agent`, `src/status`, `src/voice`, `src/tools` or the arch test matrix. Reason: the feature map row names `llm` as the only module; the config text changes come from the catalogue through `pnpm docs:env`, not from a schema edit, so `test/config/__snapshots__/loadConfig.test.ts.snap` stays unchanged.
- OS-20: Passing each vendor's default base URL explicitly to defeat the `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` reads inside `@ai-sdk/openai` and `@ai-sdk/anthropic` (EC-46). Reason: a vendor URL pinned in code goes stale with the SDK, a deployer who sets those variables did so deliberately, and `src/llm` still reads no environment itself (NFR-15); the README `## LLM providers` section documents the two variables instead (FR-46, AC-51), and a decision to pin them can land later as an additive `baseURL` default.
- OS-21: A comprehension check of the catalogue sentences with real no-coders ("what would you do next?"). Reason: the personas behind the sentences are derived from `.claude/project/profile.md` alone (no deployer research exists); the check is owner logistics for the release stage, recorded in `docs/acceptance.md` by readme-template-and-release, and its outcome can only re-word a template row, which the snapshot and the README glossary then follow from the one source (section 8.12).

---

## Appendix A: Traceability (generated from the criteria titles)

| Requirement | Acceptance criteria                                                                |
| ----------- | ---------------------------------------------------------------------------------- |
| FR-1        | AC-1, AC-3                                                                         |
| FR-2        | AC-1                                                                               |
| FR-3        | AC-2, AC-6                                                                         |
| FR-4        | AC-4, AC-50                                                                        |
| FR-5        | AC-5                                                                               |
| FR-6        | AC-47                                                                              |
| FR-7        | AC-46                                                                              |
| FR-8        | AC-37, AC-46, AC-49                                                                |
| FR-9        | AC-9, AC-19                                                                        |
| FR-10       | AC-6, AC-7, AC-58                                                                  |
| FR-11       | AC-6, AC-9                                                                         |
| FR-12       | AC-10, AC-11, AC-62                                                                |
| FR-13       | AC-11, AC-19, AC-27, AC-62                                                         |
| FR-14       | AC-20, AC-61                                                                       |
| FR-15       | AC-10, AC-14, AC-49, AC-69                                                         |
| FR-16       | AC-10, AC-12, AC-13, AC-14, AC-15, AC-16, AC-31, AC-34, AC-56, AC-60, AC-64        |
| FR-17       | AC-10, AC-16, AC-17, AC-18, AC-19, AC-33, AC-35, AC-59, AC-63, AC-64               |
| FR-18       | AC-36                                                                              |
| FR-19       | AC-32, AC-37                                                                       |
| FR-20       | AC-13, AC-17, AC-18, AC-28, AC-29, AC-30, AC-33, AC-34, AC-43, AC-59, AC-60, AC-63 |
| FR-21       | AC-29, AC-36, AC-63                                                                |
| FR-22       | AC-43, AC-46, AC-70                                                                |
| FR-23       | AC-24, AC-42, AC-65                                                                |
| FR-24       | AC-21, AC-24, AC-31, AC-32, AC-33, AC-42, AC-60, AC-65, AC-66                      |
| FR-25       | AC-25, AC-67                                                                       |
| FR-26       | AC-7, AC-11, AC-21, AC-22, AC-23, AC-31, AC-68                                     |
| FR-27       | AC-21, AC-23, AC-68                                                                |
| FR-28       | AC-22, AC-26                                                                       |
| FR-29       | AC-35                                                                              |
| FR-30       | AC-37                                                                              |
| FR-31       | AC-37, AC-38, AC-64                                                                |
| FR-32       | AC-19, AC-38                                                                       |
| FR-33       | AC-39, AC-42                                                                       |
| FR-34       | AC-39, AC-40, AC-41, AC-42, AC-43, AC-44, AC-70                                    |
| FR-35       | AC-39, AC-40, AC-41, AC-45, AC-70                                                  |
| FR-36       | AC-40, AC-41                                                                       |
| FR-37       | AC-25, AC-45, AC-70                                                                |
| FR-38       | AC-55                                                                              |
| FR-39       | AC-8                                                                               |
| FR-40       | AC-8                                                                               |
| FR-41       | AC-4, AC-50                                                                        |
| FR-42       | AC-4, AC-52                                                                        |
| FR-43       | AC-48, AC-49, AC-51, AC-69                                                         |
| FR-44       | AC-46                                                                              |
| FR-45       | AC-25, AC-46                                                                       |
| FR-46       | AC-51                                                                              |
| FR-47       | AC-52                                                                              |
| FR-48       | AC-53                                                                              |
| FR-49       | AC-54, AC-71                                                                       |
| NFR-1       | AC-53                                                                              |
| NFR-2       | AC-35                                                                              |
| NFR-3       | AC-31, AC-60                                                                       |
| NFR-4       | AC-38                                                                              |
| NFR-5       | AC-17, AC-18, AC-30, AC-45, AC-59, AC-63                                           |
| NFR-6       | AC-56                                                                              |
| NFR-7       | AC-2                                                                               |
| NFR-8       | AC-12                                                                              |
| NFR-9       | AC-39                                                                              |
| NFR-10      | AC-52                                                                              |
| NFR-11      | AC-52                                                                              |
| NFR-12      | AC-57                                                                              |
| NFR-13      | AC-26, AC-27                                                                       |
| NFR-14      | AC-54                                                                              |
| NFR-15      | AC-58                                                                              |
| NFR-16      | AC-25, AC-67                                                                       |
| NFR-17      | AC-24, AC-65, AC-66, AC-67                                                         |
| NFR-18      | AC-38                                                                              |
| NFR-19      | AC-48, AC-54, AC-71                                                                |

Every FR and NFR appears above; every AC names at least one requirement; every EC names the FR it exercises. Counts: 49 FR, 19 NFR, 71 AC, 56 EC, 21 OS.

---

## Appendix B: Open questions handed to other features (recorded, not decided here)

Each item names its owner; none blocks this feature, and none changes a sentence, a kind or a seam shape.

- B-1 (status-page-test-chat-and-selftest): Self-test while Not ready. A client built with `apiKey ''` answers the `auth/key` sentence (`rejected the API key in OPENAI_API_KEY`), which reads wrong when the key is merely missing. Skip the probe and show the blocking `OPENAI_API_KEY: is not set.` problem whenever a blocking problem names the provider's `keyEnv`, or hide the self-test button while Not ready; section 7.7 records only that the client is constructed. The second contract lock proposed a third option, an `auth/missing` row of `LLM_ERROR_TEMPLATES` selected when the client knows no request was made (`apiKey ''`); revision 3 did not add it, because the deployer's fix is the same for a missing and a rejected key (set the key in the Railway variables, then redeploy), the blocking `<KEY>: is not set.` problem already names the missing case on the same page, and a 14th row would reopen the entity revision 2 fixed as binding (the 13-id enum, the 280-selector enumeration, the 60-sentence snapshot and the README glossary: AC-24, AC-25 and AC-65 to AC-67). If the status feature prefers the row to skipping the probe, it is one additive row plus a `noRequest` selector dimension, decided there.
- B-2 (status-page-test-chat-and-selftest): Whether a failed `POST /selftest` is also recorded into recent problems so the page remembers it after a refresh; today only agent-core records `llm_error` entries.
- B-3 (status-page-test-chat-and-selftest): The proposed `SelfTestResponse.llm` amendment (`error` = `LlmError.message` verbatim plus additive `kind`, `provider`, `model`) conflicts with the blueprint text "plain English from LlmError.kind"; until adopted, NFR-17 does not span the JSON. Needs a recorded decision in the status spec.
- B-4 (status-page-test-chat-and-selftest): Print the 10 second self-test limit next to the in-use line when `LLM_TIMEOUT_MS` exceeds 10000 (EC-40), and show the kind word and the sentence inline on a failed test-chat turn instead of only in recent problems; wrap variable names in `<code>` for screen-reader grouping.
- B-5 (readme-template-and-release): Render the glossary per advertised provider (60 exact sentences, whole-sentence find-in-page matches) or keep 13 placeholder rows with an instruction to search a distinctive fragment such as `did not start answering`; and whether to mark the `timeout/gap` row as reachable only when `stallMs` differs from `timeoutMs`.
- B-6 (owner): The `rate_limit` sentence points at "plan and billing" for every 402, 429 and 498 although a transient per-minute 429 needs only a retry; the locked `LlmError` cannot carry the vendor's code token (OS-8). Keep one sentence, or accept a future additive kind split when the seam is next revised.
- B-7 (agent-core): Log `aborted` at debug with the turn number so the owner can correlate interrupts with `turn.timing` `interrupted=true` during the live check; this feature only fixes that `aborted` is never logged above debug (FR-29).
- B-8 (owner, release stage): The five-person comprehension check of the catalogue sentences (OS-21) and a screen-reader pronunciation check of names such as `LLM_TIMEOUT_MS` and `GOOGLE_GENERATIVE_AI_API_KEY`; verbatim names are required, so the mitigation is `<code>` wrapping on the page, not rewording.
- B-9 (implementer, human constraint 2): Re-verify the AI SDK current major, the exact API shapes recorded in section 7.9 and the OpenAI default model (`gpt-5.6-terra` with `reasoningEffort 'none'`) against the published docs immediately before writing `src/llm/aiSdkClient.ts`; this spec's 2026-09-09 record is an input to that check, not a substitute; the only UX dependency is that the "default model of this build" sentence never names the model.
- B-10 (owner, with the next revision of the locked seam): Two behaviours of this spec widen doc comments in `src/llm/types.ts` that FR-1 forbids editing: `LlmStreamRequest.stallMs` is documented as 'Longest allowed gap between two events once streaming has started' but the stall timer is armed at creation (FR-20), so a consumer passing `stallMs < timeoutMs` gets `timeout`/`first` at `stallMs` (unobservable today only because config passes one value for both); and `toolCallId` is documented as 'Set on tool messages' but assistant tool-call messages carry it too (FR-14). Agent-core will be written from the seam file, so record both in ADR 0003's refinements (or the README contributor section) and queue a comment-only seam revision; until then FR-14 and FR-20 are the authoritative text.
- B-11 (owner): Add `parallelToolCalls: false` to openai's `LOW_LATENCY` entry (EC-43). Recommended: OpenAI returns parallel tool calls by default, the locked `LlmMessage` carries one `toolCallId` per assistant message and the blueprint's agent executes one tool per turn, so on the default model the option removes the orphaned-call hazard at no cost. Revision 3 did not put it in FR-40 because it covers only the exact default model (the section 7.7 obligation stays the mechanism for every other model and provider), is not a latency setting, and changes AC-8's expected object; it lands as one additive line in FR-40, 7.6 and AC-8 when the owner decides.
