# Deployer-owned contracts are additive-only and the template deploys from a release branch

Once strangers deploy the template, three contracts live in systems the owner cannot update: each deployer's Railway variables, the Studio flow that reads `HandoffData`, and the Make, Zapier or n8n scenario that reads the webhook payload. `HandoffData` and `HandoffPayload` therefore carry `v: 1` and only ever gain fields; environment variables gain defaults, an old name is aliased for one major with a status-page warning, and removals happen only in a major. The Railway template tracks the `release` branch, never `main`, so a push to `main` cannot redeploy every non-ejected deployer.

## Consequences

Breaking a shape means a `v` bump plus a documented migration. A release is a fast-forward merge to `release`, a tag, and a CHANGELOG entry listing env-var and payload changes. Whether Railway templates honour a source branch is verified during the scaffold foundation; if they do not, the README documents the eject-to-own-repo path as the deployer's protection instead.
