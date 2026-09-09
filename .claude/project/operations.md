# Operations — voice-server (light)

**Legal & privacy regime:** None applies to the template itself; it stores no data and runs no service. Each deployer is responsible for the privacy law and call-recording consent rules of their own jurisdiction. The README states this plainly. The owner is in Australia but the template is jurisdiction-neutral.

**Terms & policies:** MIT licence in the repo. No terms of service or privacy policy, since nothing is operated as a service.

**Support:** GitHub Issues only. Best effort, no promised response time. YouTube comments are redirected to Issues so every answer stays public and searchable.

**Billing ops:** None.

**Fulfillment (e-commerce):** n/a

**Client delivery (agency):** n/a

**Key vendors:** GitHub, Railway, Twilio. Each deployer brings their own LLM provider and automation tool.

**Security posture:**
- Secrets live only in Railway env vars; never in the repo, the logs or the status page.
- A per-deployment secret in the WebSocket URL gates Twilio's connection; Twilio signatures are validated wherever provided.
- Rate limiting on HTTP endpoints.
- 2FA on GitHub and Railway: (not set)
- Backups: n/a, no data is stored.
