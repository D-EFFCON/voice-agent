import type { AutomationPreset } from '../../types.js';

// Verify at tools-and-automation-webhook (blueprint Q7): the Make custom webhook API key header.
export const make: AutomationPreset = {
  id: 'make',
  label: 'Make',
  defaultKeyHeader: 'x-make-apikey',
  responseMode: 'merge-json',
  docsHint:
    'Create a Custom webhook in Make and paste its URL into AUTOMATION_WEBHOOK_URL. If the webhook has an API key, set AUTOMATION_WEBHOOK_KEY. Answer with a Webhook response module within 5 seconds; JSON keys transfer_to, ticket_id and note reach Twilio.',
};
