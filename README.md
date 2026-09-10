# voice-server

Setting up voice agents as simple as one two three.

One Node.js service that sits between Twilio's voice products, the LLM you choose and the automation tool you already use (Make, Zapier or n8n). Deploys from GitHub to Railway. No database.

**Status: app shell.** The server boots on any environment, checks every variable at start-up, serves the status page at `/` (readiness and the problem list) and `GET /health`, and answers the Twilio WebSocket path through the upgrade gate. It cannot take calls yet: the ConversationRelay adapter, the agent core, the LLM providers and the unlocked status page land in the next build stages.

## Run it locally

You need Node.js 24 and pnpm 11 (see https://pnpm.io/installation).

```sh
pnpm install
pnpm dev
```

Then open http://localhost:3000/health. Without any variables set the server reports `ready: false` and lists what is missing; copy `.env.example` to `.env`, fill it in and start with `node --env-file=.env dist/main.js` after `pnpm build` (or set the variables in your shell before `pnpm dev`).

`pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test` are what CI runs, in that order: the test suite boots the built server from `dist/`, so build before you test. `pnpm docs:env` regenerates `.env.example` and the tables below from the environment schema; CI fails when they drift.

## What the server answers

- `GET /` is the status page. Without the unlock cookie it shows Ready or Not ready, every problem as `VARIABLE: what is wrong. What to do.` (blocking first, then warnings, never a value) and the hint `Open this page with ?token=<STATUS_TOKEN> (find it in your Railway variables) to see the Twilio URL, the self-test and the test chat.` Opening `/?token=<STATUS_TOKEN>` once sets the cookie and redirects to `/`; a wrong token shows `Token did not match.` The page is plain HTML with no script, so it reads the same with JavaScript off.
- `GET /health` is always 200 JSON: `ready`, `uptime_s`, `commit`, `active_calls` and the same `problems` list. It carries no value and no URL.
- `GET /twilio/conversationrelay/<WS_SECRET>` is the WebSocket path Twilio connects to. Every upgrade passes the gate in a fixed order: wrong secret 404 with an empty body, a blocking problem 503, a missing or wrong Twilio signature 403, every call slot in use 503. In this build an upgrade that passes the gate is still refused with 503 and `This build has no call adapter, so it cannot take calls yet.` Each refusal is one `ws.rejected` log line with the reason, the URL the server signed and the address, and an entry in the recent-problems buffer the unlocked status page will show.
- Anything else is `404 {"error":"Not found."}`, never echoing the path. A server fault is `500 {"error":"Something went wrong on the server. Search the deploy log for the error id.","error_id":"..."}`; the `request.error` log line with that id has the details, and no body ever carries a stack trace or a value. A body over 64 KB gets 413. More than 60 requests a minute from one address get `429 {"error":"Too many requests. The limit is 60 per minute per address."}`.
- On SIGTERM or SIGINT (a Railway redeploy, Ctrl+C) the server logs `server.draining`, refuses new upgrades, asks every call to end, waits up to 8 seconds, logs `server.stopped` and exits 0.

## Configuration

Every variable is declared once in `src/config/schema.ts` and read at start-up by `loadConfig`, which never throws: an invalid value falls back to its default and becomes a problem. Each problem is one line, `VARIABLE: what is wrong. What to do.`, and never contains a value. A **blocking** problem (a missing secret, an unknown provider, a bad webhook URL) keeps the server in `ready: false`, so it refuses calls but still answers `/` and `/health` and explains itself. A **warning** (no `STATUS_TOKEN`, `AUTOMATION_PROVIDER` unset, a number out of range) is shown but calls still run.

The valid values of `LLM_PROVIDER` and `AUTOMATION_PROVIDER`, and the `*_API_KEY` variables, come from the registries: after adding a provider or a preset, run `pnpm docs:env` and the tables below update themselves.

## Layout

`src/app.ts` is the app shell: `buildApp(deps)` creates the Fastify instance with the plugins, the limits, the error handler, `/health`, the locked status page and the voice adapters, and returns it with a `drain()`; `src/main.ts` is the only file that wires the concrete registries, the gate and the unlock into it. Each seam owns its types next to a static registry: `src/llm/types.ts` + `registry.ts` (providers, one file each under `providers/`), `src/tools/types.ts` + `registry.ts` (tools and the automation presets), `src/voice/types.ts` + `index.ts` (adapters). `src/agent/types.ts` holds the session API and the HandoffData contract; `src/security/types.ts` the upgrade gate. Adding a provider, tool or adapter is one file plus one registry line, and `test/arch/imports.test.ts` fails when a module imports something outside its row of the allowed matrix. Test doubles for the seams live in `test/helpers/`.

Logging goes through `src/log/`: every line is one JSON object on stdout with `level`, `time`, `msg` and an `event` name from `src/log/events.ts`, so a Railway log filter like `@event:call.ended` finds it. Secrets are redacted twice, by field name (`authorization`, `cookie`, every `*_SECRET`, `*_TOKEN` and `*_API_KEY` variable) and by value (every secret in the environment is replaced with `[redacted]` wherever it appears). Per-request logging is off, so nothing from a URL reaches the logs; what callers and the model say is logged only at `LOG_LEVEL=debug`.

Security lives in `src/security/`. `safeEqual` compares every secret in constant time. The Twilio signature check is hand-rolled HMAC-SHA1, tried over the wss and https forms of the connection URL with and without `:443`, and reports which form matched, so a mismatch can be read off the status page instead of a packet capture. Every WebSocket connection passes one gate in a fixed order (path secret, readiness, Twilio signature, capacity); each refusal is a plain sentence with no value in it, and `TWILIO_SIGNATURE_MODE=warn` lets an unsigned connection through while saying so on the page, never by default. The status page unlocks once: `/?token=<STATUS_TOKEN>` sets an HttpOnly, SameSite=Strict cookie and redirects to `/`, so the token never stays in a URL. Every response carries `Cache-Control: no-store`, a Content Security Policy with a per-request nonce, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. Requests are limited to 60 per minute per address on HTTP routes and 300 per minute per address on the WebSocket upgrade route, keyed by the address the Railway proxy saw, so a forged `X-Forwarded-For` header buys nothing.

## Environment variables

<!-- env:start -->
### Server

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `3000` | Port the server listens on. Railway sets this for you. |
| `LOG_LEVEL` | no | `info` | How much the server logs. debug also logs what callers and the model say. Values: fatal, error, warn, info, debug. |
| `PUBLIC_HOST` | when RAILWAY_PUBLIC_DOMAIN is not set |  | Host name Twilio connects to, without https:// or a path. Leave it unset on Railway: RAILWAY_PUBLIC_DOMAIN is used. |

### Twilio and secrets

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `WS_SECRET` (secret) | yes |  | Random string that becomes part of the WebSocket URL you paste into Twilio. At least 24 letters, digits, - or _. |
| `TWILIO_AUTH_TOKEN` (secret) | when TWILIO_SIGNATURE_MODE is enforce |  | Your Twilio Auth Token, used to check that each connection really comes from Twilio. Find it in the Account Info panel of the Twilio Console. |
| `TWILIO_SIGNATURE_MODE` | no | `enforce` | enforce refuses connections with a missing or wrong Twilio signature. warn lets them through and shows a warning on the status page; use it only while you are stuck. Values: enforce, warn. |
| `STATUS_TOKEN` (secret) | no |  | Unlocks the Twilio URL, the self-test and the test chat on the status page: open /?token=<STATUS_TOKEN> once. At least 16 letters, digits, - or _. Unset keeps those parts hidden. |

### LLM

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `LLM_PROVIDER` | no | `openai` | Which LLM answers callers. Values: openai, anthropic, google, mistral, groq. |
| `LLM_MODEL` | no | the provider's default (openai: gpt-4o-mini, anthropic: claude-haiku-4-5-20251001, google: gemini-2.5-flash, mistral: mistral-small-latest, groq: llama-3.3-70b-versatile) | Model name for the provider. Unset uses the provider's fast default. |
| `OPENAI_API_KEY` (secret) | when LLM_PROVIDER is openai |  | API key for OpenAI. Create one at platform.openai.com under API keys. |
| `ANTHROPIC_API_KEY` (secret) | when LLM_PROVIDER is anthropic |  | API key for Anthropic. Create one at console.anthropic.com under API keys. |
| `GOOGLE_GENERATIVE_AI_API_KEY` (secret) | when LLM_PROVIDER is google |  | API key for Google Generative AI. Create one in Google AI Studio. |
| `MISTRAL_API_KEY` (secret) | when LLM_PROVIDER is mistral |  | API key for Mistral. Create one at console.mistral.ai under API keys. |
| `GROQ_API_KEY` (secret) | when LLM_PROVIDER is groq |  | API key for Groq. Create one at console.groq.com under API keys. |
| `LLM_TIMEOUT_MS` | no | `20000` | How long to wait for the model, in milliseconds: for the whole reply and for any gap between words. On timeout the caller hears FALLBACK_MESSAGE and goes to a person. |

### Prompt and spoken messages

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SYSTEM_PROMPT` | no | the bundled complaints-line prompt (src/config/defaults.ts) | Instructions for the AI, including its name and your business name. Multi-line values are fine. |
| `FALLBACK_MESSAGE` | no | `Sorry, I am having trouble right now. Let me put you through to a person.` | Spoken when the model fails or times out, before the caller goes to a person. |
| `HANDOFF_MESSAGE` | no | `One moment while I put you through to the team.` | Spoken when the AI hands the caller to a person and has not already said so. |
| `CLOSING_MESSAGE` | no | `We have reached the time limit for this call. Thank you for calling. Goodbye.` | Spoken when a call reaches MAX_CALL_SECONDS, before it ends. |

### Automation

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AUTOMATION_PROVIDER` | no | `none` | Which automation tool receives each handoff. none completes the handoff without telling anyone. Values: none, make, zapier, n8n. |
| `AUTOMATION_WEBHOOK_URL` | unless AUTOMATION_PROVIDER is none |  | The webhook URL from your automation tool. Must start with https://. |
| `AUTOMATION_WEBHOOK_KEY` (secret) | no |  | Key sent in a header with each webhook call, if your webhook checks one. |
| `AUTOMATION_WEBHOOK_KEY_HEADER` | no | the preset's header | Header that carries AUTOMATION_WEBHOOK_KEY. Unset uses the preset's header (make: x-make-apikey, n8n: x-api-key). |
| `AUTOMATION_TIMEOUT_MS` | no | `5000` | How long to wait for the webhook to answer, in milliseconds. |
| `HANDOFF_INCLUDE_TRANSCRIPT` | no | `false` | true sends the call transcript to the webhook with each handoff. false sends the summary only. Values: true, false. |

### Call limits

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AGENT_END_CALL` | no | `true` | true lets the AI end the call after saying goodbye. false means only a handoff, the caller or a timeout ends it. Values: true, false. |
| `MAX_CALL_SECONDS` | no | `900` | Longest a call may run. At the limit the server speaks CLOSING_MESSAGE and ends the call. |
| `IDLE_TIMEOUT_SECONDS` | no | `60` | How long a caller may stay silent before the call ends. |
| `MAX_CONCURRENT_CALLS` | no | `10` | Calls handled at the same time. Further calls are refused and take the failure path of your Studio flow. |

### Set by Railway

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `RAILWAY_PUBLIC_DOMAIN` | set by Railway |  | Set by Railway when you generate a domain for the service. Used as the public host when PUBLIC_HOST is unset. |
| `RAILWAY_GIT_COMMIT_SHA` | set by Railway |  | Set by Railway to the deployed commit. Shown as the build on the status page and in the logs. |
<!-- env:end -->

## Deploy

Railway builds this repository natively, with no Dockerfile: Node from `engines.node`, pnpm from `packageManager`, then `pnpm build` and `pnpm start`. The Railway template tracks the `release` branch, never `main`. If you must override the Node version on Railway, set `RAILPACK_NODE_VERSION`.

## Licence

MIT. See `LICENSE`.
