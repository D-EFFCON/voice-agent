import { defineSdkProvider } from '../aiSdkClient.js';

/** Wired and unit tested; a live call on this provider is the deployer's own smoke test. */
export const google = defineSdkProvider({
  id: 'google',
  sdk: 'google',
  description: 'Gemini models through the Google Generative AI API.',
  keyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
  keyDescription: 'API key for Google Generative AI. Create one in Google AI Studio.',
  defaultModel: 'gemini-2.5-flash',
});
