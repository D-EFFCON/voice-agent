import type { AutomationPreset } from '../../types.js';

// Verify at tools-and-automation-webhook (blueprint Q7): the n8n Header Auth convention.
export const n8n: AutomationPreset = {
  id: 'n8n',
  label: 'n8n',
  defaultKeyHeader: 'x-api-key',
  responseMode: 'merge-json',
  docsHint:
    'Add a Webhook node with Header Auth and paste its production URL into AUTOMATION_WEBHOOK_URL; set AUTOMATION_WEBHOOK_KEY to the credential value. Use a Respond to Webhook node to return transfer_to, ticket_id or note as JSON within 5 seconds.',
};
