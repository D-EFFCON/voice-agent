import { defineSdkProvider } from '../aiSdkClient.js';

/** Wired and unit tested; a live call on this provider is the deployer's own smoke test. */
export const anthropic = defineSdkProvider({
  id: 'anthropic',
  sdk: 'anthropic',
  description: 'Claude models through the Anthropic API.',
  keyEnv: 'ANTHROPIC_API_KEY',
  keyDescription: 'API key for Anthropic. Create one at console.anthropic.com under API keys.',
  defaultModel: 'claude-haiku-4-5-20251001',
});
