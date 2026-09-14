# voice-server

Setting up voice agents as simple as one two three.

This is the missing piece between a phone number and an AI. Twilio answers the call, this server does the thinking, and your automation tool gets told when a human is needed. You host it yourself on Railway, you pick the AI, and you own the whole thing. There is no per-minute fee to anyone but Twilio and your AI provider.

You do not need to be a developer. You need to be comfortable pasting keys into a form and clicking around Twilio. You will never have to read this code.

**What works today:** a caller rings your number, the AI answers and talks with them, and when they ask for a person the call is handed to a human and your automation tool is told why. **Not built yet:** the one-click deploy button, the browser test chat, and a ready-made Twilio flow you can import. Those are listed at the bottom.

---

## Before you start

Four accounts. Get these open in tabs before you begin.

1. **Twilio**, with a phone number you own. Upgrade from trial before you go live: a trial account plays its own message before your greeting, and the handoff dials out, so the human's number would have to be verified first.
2. **An AI provider.** OpenAI is the default and the one that is tested. Anthropic, Google, Mistral and Groq also work.
3. **Railway**, where this server will live. The cheapest tier is enough.
4. **GitHub**, to hold your copy of this code.

**One Twilio setting first, or nothing will work.** In the Twilio Console go to **Voice**, then **Settings**, then **Privacy & Security**. Find the line about the predictive and generative AI/ML features addendum, accept it, and save. Twilio will not let ConversationRelay run until you do.

Set aside about thirty minutes.

---

## 1. Get your own copy

Click **Fork** at the top of this repository. That gives you your own copy on GitHub that Railway can deploy from. Nothing else to do here.

## 2. Put it on Railway

In Railway, click **New Project**, then **Deploy from GitHub repo**, and pick the copy you just forked. Railway works out how to build it on its own. There is nothing to configure about the build.

The first deploy will finish but the server will say it is not ready. That is expected. It has no settings yet.

While you are here, give the service a public address: open **Settings**, then **Networking**, and click **Generate Domain**. Copy the domain it gives you. It looks like `something.up.railway.app`.

## 3. Fill in the settings

In Railway open the **Variables** tab and add these four.

| Variable | What to put in it |
| --- | --- |
| `WS_SECRET` | A long random string, at least 24 letters and numbers. Make one up or use a password generator. This is what stops strangers connecting to your server. |
| `TWILIO_AUTH_TOKEN` | From the Twilio Console front page, the Account Info panel. |
| `OPENAI_API_KEY` | From platform.openai.com, under API keys. |
| `STATUS_TOKEN` | Another long random string, at least 16 characters. This is the password for your own status page. |

Railway redeploys itself when you save. Wait for it to finish.

**Want to try it before spending anything on AI?** Set `LLM_PROVIDER` to `fake` and skip the OpenAI key. You get a scripted agent that talks back, hands over when you ask for a person, and costs nothing. Everything else in this guide works the same. Change it to `openai` when you are ready for the real thing.

## 4. Check it is ready

Open your Railway domain in a browser, like `https://something.up.railway.app`.

You should see **Ready**. If you see **Not ready**, the page lists exactly what is wrong and what to do about it, one line per problem. Fix those in the Variables tab and reload. The page never shows your keys.

Now write down your **WebSocket URL**. Take your Railway domain, put `wss://` in front, then `/twilio/conversationrelay/` and your `WS_SECRET` on the end:

```
wss://something.up.railway.app/twilio/conversationrelay/YOUR_WS_SECRET
```

Use your real domain and your real secret. Keep this URL private. Anyone who has it can talk to your agent.

## 5. Build the Twilio flow

This is the part that connects your phone number to the server. In the Twilio Console go to **Studio**, then **Create new Flow**, name it something like `voice-agent`, and choose **Start from scratch**.

Drag in three widgets and connect them like this.

**a. The AI stage.** Drag in a **Conversation Relay** widget. Connect **Incoming Call** to it. Then set:

- **WebSocket URL**: the URL you wrote down in step 4.
- **Welcome Greeting**: what the caller hears first, before the AI says anything. Something like `Hi, you've reached Example Company. How can I help?`
- Leave everything else alone for now. Language, voice and speech settings all have sensible defaults, and you can come back to them.

Note the widget's name. It will be something like `run_crelay_1`. You need it in the next step.

**b. The decision.** Drag in a **Split Based On...** widget. Connect the Conversation Relay widget's **Success** transition to it. Set:

- **Variable to Test**: `{{widgets.run_crelay_1.HandoffData}}`, using your widget's actual name.
- Add one condition: **Contains** the value `live-agent-handoff`.

**c. The human.** Drag in a **Connect Call To** widget and set it to the phone number a person will answer. Connect two things to it:

- The **Contains live-agent-handoff** branch of your Split widget.
- The **Failed** transition of the Conversation Relay widget. This matters. If your server is ever down or misconfigured, the caller reaches a person instead of dead air.

The Split widget's **No Match** branch can go to a **Hangup** widget. That is a call the AI finished normally.

Click **Publish**.

## 6. Point your number at it and call

In the Twilio Console open **Phone Numbers**, then your number. Under **Voice Configuration**, set **A call comes in** to **Studio Flow**, and pick the flow you just published. Save.

Now ring your own number. You should hear your greeting, then be able to talk to the agent.

Say **"I'd like to speak to a person."** The agent should say it is putting you through, and the phone you set in step 5c should ring.

That is a working voice agent.

---

## Telling your automation tool about handoffs

Right now a handoff transfers the caller but nobody gets a notification. To send each handoff to Make, Zapier or n8n, add two more variables in Railway:

| Variable | What to put in it |
| --- | --- |
| `AUTOMATION_PROVIDER` | `make`, `zapier` or `n8n` |
| `AUTOMATION_WEBHOOK_URL` | The webhook URL from that tool. It must start with `https://`. |

Add `AUTOMATION_WEBHOOK_KEY` too if your webhook expects a key. The server sends it in the header your tool expects, so you do not have to work that out.

Every handoff then posts JSON with the caller's number, why they want a person, and a summary of what they said.

**Make and n8n can answer back.** If your scenario replies within five seconds with JSON, three fields are read and carried into the handoff data Twilio receives: `transfer_to`, `ticket_id` and `note`. Everything else in your reply is ignored, on purpose, so a mistake in your scenario cannot break the call.

Those three arrive in Twilio, but the flow in step 5 does not use them yet: it always dials the fixed number in the Connect Call To widget. Routing the call to `transfer_to` needs another Studio step to pull the value out, which this guide does not cover yet. `ticket_id` and `note` are useful today for whatever your scenario does with them.

**Zapier only acknowledges.** Catch Hook cannot reply in time, so nothing comes back and the transfer uses the number in your Studio flow.

If your webhook is slow, broken or switched off, **the caller still gets transferred**. The handoff never depends on it.

---

## Changing how the agent behaves

**What it says and how it acts** is one variable: `SYSTEM_PROMPT`. It ships with a complaints-line prompt for a made-up company, so you will want to change it. Write it as instructions to a person answering your phone. Keep it short, tell it to keep replies to a sentence or two, and tell it when to hand over.

**Which AI it uses** is `LLM_PROVIDER` plus that provider's key. The default is `openai` with the `gpt-4o-mini` model, chosen because it starts talking fastest. Newer models think before they answer, which on a phone call sounds like a dead line. Set `LLM_MODEL` if you want a different one.

**The spoken lines** for handing over, apologising and closing a long call are `HANDOFF_MESSAGE`, `FALLBACK_MESSAGE` and `CLOSING_MESSAGE`.

Every setting is in the table at the bottom of this page.

---

## When something is wrong

**Start at your status page.** Every problem it can see is listed there in plain English with what to do about it. These are the real messages:

- `OPENAI_API_KEY: is not set. API key for OpenAI. Create one at platform.openai.com under API keys.`
- `LLM_PROVIDER: is not one of openai, anthropic, google, mistral, groq. Set it to one of those values.`
- `AUTOMATION_WEBHOOK_URL: is not an https URL. Paste the full webhook URL from your automation tool; it must start with https://.`

**The call connects but the agent never speaks.** Your AI key is probably wrong or out of credit. The caller hears the fallback line and goes to a person, which is deliberate. Check your Railway logs for `llm.error`.

**The call fails immediately and goes straight to a person.** Twilio could not connect. Almost always the WebSocket URL. Check it starts with `wss://`, that the domain matches Railway exactly, and that the secret on the end matches `WS_SECRET` character for character.

**Twilio says the connection was refused.** In the Railway logs look for `ws.rejected`. The `reason` tells you which check failed: `path` means the secret in the URL is wrong, `signature` means `TWILIO_AUTH_TOKEN` does not match your account, `not_ready` means fix the problems on the status page first, and `capacity` means all your call slots are busy.

**Reading the logs.** Railway's log view accepts a filter. `@event:call.ended` shows one line per finished call with an `outcome`: `handoff` means a person took over, `completed` means the AI finished normally, `caller_hangup` means they hung up, and `error` or `timeout` mean something went wrong. `@event:turn.timing` shows how fast each reply was.

Still stuck? Open an issue on GitHub and paste what your status page says. Do not paste your keys.

---

## Privacy and recording

This server has no database. A conversation lives in memory during the call and is gone when it ends. Nothing is sent anywhere except the AI provider you chose and the webhook you configured.

The logs are the exception, and they are worth knowing about. Every call writes lines carrying its Twilio call SID and the caller's and called numbers, and your host keeps those lines for you to read — Railway holds them for days. So "nothing is stored" is true of the conversation, not of who rang and when. Leave `LOG_LEVEL` at `info` in production: at `debug` the logs also carry what the caller said, turn by turn.

**Recording calls and telling callers about it is your responsibility, not this template's.** The rules differ by country and by state, and in many places you must tell the caller before recording. This template records nothing by default and takes no position on your local law. If you turn on Twilio's call recording, or if your automation stores what callers say, find out what your jurisdiction requires and put it in your greeting.

`HANDOFF_INCLUDE_TRANSCRIPT` is off by default. Turning it on sends what the caller said to your automation tool.

---

## Not built yet

Being straight with you about what is missing:

- **A one-click deploy button.** Step 2 is manual until the Railway template is published.
- **The unlocked status page.** It shows readiness and problems today. Showing the WebSocket URL, a browser test chat and a self-test button is next, which is why step 4 has you build the URL by hand.
- **A Studio flow you can import.** Step 5 is manual for now.
- **A Media Streams adapter** and TwiML endpoints, for people who do not want to use Studio.

---

## For developers

You need Node.js 24 and pnpm 11 (https://pnpm.io/installation). Never npm.

```sh
pnpm install
pnpm dev
```

`pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test` are what CI runs, in that order. Build before you test: the integration suite boots the built server from `dist/` and drives a real call over a real WebSocket. `pnpm docs:env` regenerates `.env.example` and the table below from the environment schema, and CI fails when they drift.

**Layout.** Each seam owns its types next to a registry, and adding a provider, tool or voice adapter is one file plus one line: `src/llm/` (providers), `src/tools/` (the handoff tool and the automation presets), `src/voice/` (adapters), with `src/agent/` as the domain core that imports only seam types. `src/main.ts` is the only file that wires concrete things together. `test/arch/imports.test.ts` fails if a module reaches outside its row of the allowed matrix. The decisions behind that are in `docs/adr/`.

**The call path.** A WebSocket upgrade passes one gate in a fixed order (path secret, readiness, Twilio signature, capacity), then `src/voice/conversationrelay/` translates Twilio's frames onto the agent's session API. The agent core runs the turn, streams words back as they arrive, and ends the call through one policy table in `src/agent/endPolicy.ts`. Anything that goes wrong on the server routes to `live-agent-handoff`, so a caller reaches a person rather than silence; only a long call, a quiet caller and the agent's own goodbye hang up.

**Logs** are one JSON object per line on stdout with an `event` name from `src/log/events.ts`. Secrets are redacted twice, by field name and by value. What callers and the model say is logged only at `LOG_LEVEL=debug`.

---

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
