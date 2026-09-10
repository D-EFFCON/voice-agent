import { defineSdkProvider } from '../aiSdkClient.js';

/**
 * The default provider, and the one verified end to end on a live call.
 *
 * defaultModel is gpt-4o-mini rather than a newer mini. On a phone call the only latency that
 * matters is time to the first word, and the GPT-5 minis reason before they answer, which adds a
 * pause the caller hears as a dead line. A deployer who wants a newer model sets LLM_MODEL.
 */
export const openai = defineSdkProvider({
  id: 'openai',
  sdk: 'openai',
  description: 'OpenAI models through the OpenAI API.',
  keyEnv: 'OPENAI_API_KEY',
  keyDescription: 'API key for OpenAI. Create one at platform.openai.com under API keys.',
  defaultModel: 'gpt-4o-mini',
});
