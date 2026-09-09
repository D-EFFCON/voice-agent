# Profile — voice-server

**Name:** voice-server (folder currently `voice-agent`; owner will rename manually)

**One-liner:** A free, open-source voice agent server template: one Node.js WebSocket service that plugs into Twilio's voice products on the input side and into any LLM and any automation tool on the output side, deployable from GitHub to Railway by no-coders and low-coders.

**Type:** app

**Business model / monetization:** Free giveaway. Public GitHub repo under MIT, mentioned in the owner's YouTube video. No direct revenue; indirect value is audience growth and goodwill for the owner's business.

**Stage:** idea

**Goals (ranked, top 3):**
1. v1 public on GitHub with a Railway deploy button. Twilio ConversationRelay plus OpenAI working end to end, including the human handoff back to Twilio Studio. A no-coder goes from fork to first live call in under 30 minutes.
2. First deployments by people who are not the owner, with docs and a status page good enough that they never need to ask for help.
3. (lower priority) Second adapter on each seam: a second Twilio voice product (Media Streams) and a second LLM provider, proving the modules are real rather than wrappers.

**Priorities (trade-off order):** Speed first, quality a close second, cost last.

**Expected volume:** 0 deployers now → about 100 deployers in 12 months. Each deployment handles about 100 calls per month. Sized for a single Railway instance on the cheapest tier; no horizontal scaling required.

**KPIs:**
- Deployments: Railway template deploys plus repo forks, against the 100 target
- Fork to first live call: median time for a new deployer, target under 30 minutes
- Clean call rate: share of calls ending in a handoff or a normal goodbye with no server error, target above 99%
- Support requests per deployment: target close to zero

**Jurisdiction & locale:** Not country or currency specific by design. Language: English. The owner operates from Australia, but the template must not bake in any locale, phone-number format, currency or legal assumption.

**ICP summary:** No-coders and low-coders who are comfortable with APIs, webhooks and tools like Make, Zapier and n8n, and who want a voice agent on a phone number without hiring a developer or paying a per-minute hosted platform. They can set env vars in Railway and build a Twilio Studio flow, but they cannot debug a server, so anything that breaks must explain itself in plain English.

**Team:** Solo (the owner).

**Constraints:**
- Ships as one repo, one Node.js service, one Railway deployment. No database, no extra hosted infrastructure.
- Configuration surface is environment variables only, plus a read-only status page at the root URL.
- Input side is Twilio-specific but must work across Twilio's voice range (ConversationRelay first, Media Streams and TwiML endpoints later). LLM and automation sides are user-selectable modules.
- Safe for strangers to deploy: no secrets exposed, sane defaults, every misconfiguration surfaced on the status page.
- Privacy law and call-recording consent are the deployer's responsibility, stated plainly in the README.
- No deadline set. (not set)
- Budget ceiling: (not set)
