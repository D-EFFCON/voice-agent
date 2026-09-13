/**
 * Every ConfigProblem the server can raise, built from variable names and static text.
 *
 * Nothing here receives a value. The rendered form is '{variable}: {what}. {fix}.'; the
 * strings double as the README troubleshooting keys, so a change here is a deployer-facing
 * change. Lists of valid values come from the registries at load time.
 */
import type { ConfigProblem, ProblemSeverity } from './types.js';

const make =
  (severity: ProblemSeverity) =>
  (variable: string, what: string, fix: string): ConfigProblem => ({
    variable,
    severity,
    what,
    fix,
  });

export const blocking = make('blocking');
export const warning = make('warning');

/** How the status page and the README print a problem. */
export function formatProblem(p: ConfigProblem): string {
  return `${p.variable}: ${p.what}. ${p.fix}.`;
}

/** 'a, b, c' */
export const listValues = (values: readonly string[]): string => values.join(', ');

/** 'a, b or c' */
export function listOr(values: readonly string[]): string {
  if (values.length <= 1) return values.join('');
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1] ?? ''}`;
}

const withoutTrailingPeriod = (text: string): string => text.trim().replace(/\.+$/, '');

const HOST_EXAMPLE = 'my-app.up.railway.app';

export const messages = {
  // PUBLIC_HOST
  publicHostMissing: blocking(
    'PUBLIC_HOST',
    'is not set and Railway did not provide RAILWAY_PUBLIC_DOMAIN',
    `Generate a domain for the service in Railway under Settings, Networking, or set PUBLIC_HOST to the host name Twilio will connect to, like ${HOST_EXAMPLE}`,
  ),
  publicHostInvalid: blocking(
    'PUBLIC_HOST',
    'is not a host name',
    `Set it to the host only, like ${HOST_EXAMPLE}, with no https:// and no path, or remove it to use RAILWAY_PUBLIC_DOMAIN`,
  ),
  publicHostTidied: warning(
    'PUBLIC_HOST',
    'contains a scheme or a path, which the server ignored',
    `Set it to the host only, like ${HOST_EXAMPLE}`,
  ),
  railwayDomainInvalid: warning(
    'RAILWAY_PUBLIC_DOMAIN',
    'is not a host name, so it is ignored',
    'Set PUBLIC_HOST to the host name Twilio will connect to',
  ),

  // WS_SECRET
  wsSecretMissing: blocking(
    'WS_SECRET',
    'is not set',
    'Set it to a random string of at least 24 letters and digits. The Railway template generates one for you',
  ),
  wsSecretShort: blocking(
    'WS_SECRET',
    'is shorter than 24 characters',
    'Set it to a random string of at least 24 letters and digits',
  ),
  wsSecretChars: blocking(
    'WS_SECRET',
    'contains characters that cannot go in a URL',
    'Use only letters, digits, - and _',
  ),

  // TWILIO_AUTH_TOKEN and TWILIO_SIGNATURE_MODE
  authTokenMissing: blocking(
    'TWILIO_AUTH_TOKEN',
    'is not set',
    'Copy the Auth Token from the Account Info panel of the Twilio Console',
  ),
  authTokenMissingWarnMode: warning(
    'TWILIO_AUTH_TOKEN',
    'is not set, so Twilio signatures cannot be checked',
    'Copy the Auth Token from the Account Info panel of the Twilio Console',
  ),
  signatureModeWarn: warning(
    'TWILIO_SIGNATURE_MODE',
    'is warn, so connections with a missing or wrong Twilio signature are allowed',
    'Set it to enforce once your calls connect',
  ),

  // STATUS_TOKEN
  statusTokenMissing: warning(
    'STATUS_TOKEN',
    'is not set, so the status page hides the Twilio URL, the self-test and the test chat',
    'Set it to a random string of at least 16 letters and digits, then open the page with ?token=<STATUS_TOKEN>',
  ),
  statusTokenShort: warning(
    'STATUS_TOKEN',
    'is shorter than 16 characters, so it is ignored and the page stays locked',
    'Set it to a random string of at least 16 letters and digits',
  ),
  statusTokenChars: warning(
    'STATUS_TOKEN',
    'contains characters that cannot go in a URL, so it is ignored and the page stays locked',
    'Use only letters, digits, - and _',
  ),

  // LLM
  llmProviderUnknown: (advertised: readonly string[]): ConfigProblem =>
    blocking(
      'LLM_PROVIDER',
      `is not one of ${listValues(advertised)}`,
      'Set it to one of those values',
    ),
  llmProviderTestOnly: (advertised: readonly string[]): ConfigProblem =>
    warning(
      'LLM_PROVIDER',
      'is a test provider that is not meant for real calls',
      `Set it to one of ${listValues(advertised)} when you are done testing`,
    ),
  noProvidersRegistered: blocking(
    'LLM_PROVIDER',
    'cannot be used because this build registers no LLM providers',
    'Report this as a bug; the registry in src/llm/registry.ts is empty',
  ),
  providerKeyMissing: (keyEnv: string, keyDescription: string): ConfigProblem =>
    blocking(keyEnv, 'is not set', withoutTrailingPeriod(keyDescription)),

  // Automation
  automationProviderUnknown: (presetIds: readonly string[]): ConfigProblem =>
    blocking(
      'AUTOMATION_PROVIDER',
      `is not one of ${listValues(presetIds)}`,
      'Set it to one of those values',
    ),
  automationNone: (otherPresetIds: readonly string[]): ConfigProblem =>
    warning(
      'AUTOMATION_PROVIDER',
      'is none, so a handoff completes but nobody is notified',
      `Set it to ${listOr(otherPresetIds)} and put your webhook URL in AUTOMATION_WEBHOOK_URL to post each handoff to your automation tool`,
    ),
  webhookUrlMissing: blocking(
    'AUTOMATION_WEBHOOK_URL',
    'is not set',
    'Paste the webhook URL from your automation tool, or set AUTOMATION_PROVIDER to none',
  ),
  webhookUrlInvalid: blocking(
    'AUTOMATION_WEBHOOK_URL',
    'is not an https URL',
    'Paste the full webhook URL from your automation tool; it must start with https://',
  ),
  webhookUrlLocal: blocking(
    'AUTOMATION_WEBHOOK_URL',
    'points at an address inside a private network, which the server cannot reach',
    'Use the public https URL of your webhook',
  ),
  webhookUrlIgnored: (otherPresetIds: readonly string[]): ConfigProblem =>
    warning(
      'AUTOMATION_WEBHOOK_URL',
      'is set but AUTOMATION_PROVIDER is none, so it is ignored',
      `Set AUTOMATION_PROVIDER to ${listOr(otherPresetIds)}`,
    ),
  webhookHeaderInvalid: warning(
    'AUTOMATION_WEBHOOK_KEY_HEADER',
    "is not a valid header name, so the preset's header is used",
    'Use letters, digits and - only, or remove it',
  ),
  webhookKeyWithoutHeader: warning(
    'AUTOMATION_WEBHOOK_KEY',
    'is set but the selected preset has no default header, so the key is not sent',
    'Set AUTOMATION_WEBHOOK_KEY_HEADER to the header name your automation checks, or remove the key',
  ),

  // Generic shapes
  numberInvalid: (key: string, min: number, max: number, fallback: number): ConfigProblem =>
    warning(
      key,
      `is not a whole number between ${min} and ${max}, so ${fallback} is used`,
      'Set it to a whole number in that range, or remove it',
    ),
  enumInvalid: (key: string, values: readonly string[], fallback: string): ConfigProblem =>
    warning(
      key,
      `is not one of ${listValues(values)}, so ${fallback} is used`,
      'Set it to one of those values, or remove it',
    ),
  booleanInvalid: (key: string, fallback: boolean): ConfigProblem =>
    warning(
      key,
      `is not true or false, so ${String(fallback)} is used`,
      'Set it to true or false, or remove it',
    ),

  /** Raised only if loadConfig itself hits a bug: the process still boots (ADR 0001). */
  internalFailure: blocking(
    'config',
    'could not be loaded because of a bug in the server, so every default is in use',
    'Report this on GitHub with the text of this page and the first lines of the deploy log',
  ),
} as const;
