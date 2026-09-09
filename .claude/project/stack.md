# Stack — voice-server

**Platform targets:** API / server. A Node.js service on Railway with a minimal built-in web status page. No mobile app, no separate frontend.

**Frontend:** Server-rendered status page at `/`: validates every env var with plain-English messages, prints the exact WebSocket URL to paste into Twilio, and hosts a text test chat that exercises the prompt and tools without a phone call. No frontend framework.

**Backend:** Node.js current LTS, TypeScript in strict mode, Fastify with its WebSocket plugin.

**Database:** None. Conversation state is held in memory per call and discarded when the call ends.

**Auth:** No user accounts. A per-deployment secret embedded in the WebSocket URL path gates the Twilio connection. Twilio request signature validation wherever Twilio provides one. Status page protection: (not set) — decide at build whether an optional token is needed.

**Hosting & deploy:** Railway, native Node build with no Dockerfile. Node version pinned in package.json, pnpm lockfile committed. Deploy on push from GitHub. Published as a Railway template with a deploy button.

**Payments:** None.

**Analytics:** None. Structured JSON logs via pino, readable in Railway logs, with per-stage timing (Twilio message in, LLM first token, LLM complete, message out) so latency problems are diagnosable from logs alone.

**Automation tools in use:** Agent tools are outbound webhooks. `AUTOMATION_PROVIDER` selects a preset for Make, Zapier or n8n covering auth headers and response shape. The owner's own deployment uses Make for team roster lookup and CRM.

**MCP servers connected:** context7 (library docs), crawl4ai (self-hosted scraping and browser). supabase is configured but not authorized and is not used by this project. No Twilio, Make, Zapier or n8n MCP server is connected; those are reached over their HTTP APIs with keys held in Railway env vars, never in this file.

**Integrations / APIs:**
- Twilio, input side only. v1: Studio as the outer call-flow controller (recording, failure handling, human transfer via Connect Call To) and ConversationRelay as the AI stage, sending text to the server over WebSocket and receiving text back. The server ends the ConversationRelay session with an `end` message carrying handoff data, which Studio uses to dial a human. Planned adapters within Twilio's range: Media Streams (raw audio over WebSocket with speech-to-text and text-to-speech in the loop) and TwiML endpoints so the server can run without Studio. Twilio Voice SDK browser calls still reach the server through those same products.
- LLM, user-selectable. Vercel AI SDK with `LLM_PROVIDER`, `LLM_MODEL` and the provider's key. OpenAI first; Anthropic, Google, Mistral, Groq and others are available through the SDK without code changes.
- Automation, user-selectable. Webhook tools with Make, Zapier and n8n presets. v1 ships one tool, `handoff_to_team`, which ends the AI stage and returns the call to Twilio.

**Repos & environments:** Public GitHub repo, URL (not set). Production is each deployer's own Railway URL. Owner's own deployment URL: (not set).

**Conventions:**
- pnpm, TypeScript strict, ESLint, Prettier, Vitest. MIT licence.
- One module per seam, each selected by an env var. Adding a provider means adding one file, never editing the core.
- The voice module is designed for two kinds of Twilio input from day one: text relay (ConversationRelay) and audio stream (Media Streams). Text ships first.
- Every env var is documented in `.env.example` and validated at boot; failures appear on the status page in plain English.
- Secrets are never logged, never rendered, never committed.
- `examples/` holds an importable Twilio Studio flow and a Make blueprint for the v1 complaints-line use case.
- Design references studied at init, not dependencies: Pipecat for its transport-plus-serializer split and per-stage metrics; Dograh for the browser test panel idea; LiveKit agents-js for its session and plugin API shape. None is forked; Pipecat and Dograh are Python.
- Proposed layout, confirm at build: `src/voice/`, `src/llm/`, `src/tools/`, `src/agent/`, `src/status/`, `examples/`.
