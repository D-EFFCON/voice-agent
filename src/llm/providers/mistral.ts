import { defineSdkProvider } from '../aiSdkClient.js';

/** Wired and unit tested; a live call on this provider is the deployer's own smoke test. */
export const mistral = defineSdkProvider({
  id: 'mistral',
  sdk: 'mistral',
  description: 'Mistral models through the Mistral API.',
  keyEnv: 'MISTRAL_API_KEY',
  keyDescription: 'API key for Mistral. Create one at console.mistral.ai under API keys.',
  defaultModel: 'mistral-small-latest',
});
