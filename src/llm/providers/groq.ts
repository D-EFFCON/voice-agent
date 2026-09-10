import { defineSdkProvider } from '../aiSdkClient.js';

/** Wired and unit tested; a live call on this provider is the deployer's own smoke test. */
export const groq = defineSdkProvider({
  id: 'groq',
  sdk: 'groq',
  description: 'Open models served fast through the Groq API.',
  keyEnv: 'GROQ_API_KEY',
  keyDescription: 'API key for Groq. Create one at console.groq.com under API keys.',
  defaultModel: 'llama-3.3-70b-versatile',
});
