import type { AutomationPreset } from '../../types.js';

export const none: AutomationPreset = {
  id: 'none',
  label: 'No automation',
  defaultKeyHeader: null,
  responseMode: 'none',
  docsHint:
    'Handoffs complete but nobody is notified. Set AUTOMATION_PROVIDER to make, zapier or n8n to post each handoff to a webhook.',
};
