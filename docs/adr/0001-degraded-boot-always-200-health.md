# Degraded boot with an always-200 /health instead of fail-fast

The deployers are no-coders whose only support channel is the status page, and a Railway crash loop or a failing health check makes that page unreachable. So `loadConfig` never throws: the process boots on any environment, refuses WebSocket upgrades while a blocking configuration problem exists, and `GET /` and `GET /health` always answer 200 with a `ready` flag and a value-free problem list. No Railway healthcheck path is configured.

## Consequences

A misconfigured server keeps running and must explain itself: every fault needs a plain-English problem entry with a fix, and "ready" is a field in the body, never an HTTP status. Anyone adding a config check adds its message at the same time.
