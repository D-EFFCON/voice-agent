import type { AutomationPreset } from '../../types.js';

// Verify at tools-and-automation-webhook (blueprint Q7): Catch Hook answers with a fixed acknowledgement only.
export const zapier: AutomationPreset = {
  id: 'zapier',
  label: 'Zapier',
  defaultKeyHeader: null,
  responseMode: 'ack-only',
  docsHint:
    'Start a Zap with Webhooks by Zapier, Catch Hook, and paste the hook URL into AUTOMATION_WEBHOOK_URL. Zapier acknowledges at once; nothing comes back to the caller. Set AUTOMATION_WEBHOOK_KEY and AUTOMATION_WEBHOOK_KEY_HEADER to add a header a Filter step can check.',
};
