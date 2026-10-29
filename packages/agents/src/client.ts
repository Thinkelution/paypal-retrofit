import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Server-side refusal fallback: the API re-runs a declined request on a suitable model in the same call. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function claudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client: Anthropic | null = null;

/** Credentials come from the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile). */
export function claude(): Anthropic {
  client ??= new Anthropic({ maxRetries: 3 });
  return client;
}

export function model(): string {
  return process.env.RETROFIT_MODEL || DEFAULT_MODEL;
}

export class AgentUnavailableError extends Error {
  constructor() {
    super('Claude is not configured. Set ANTHROPIC_API_KEY in .env to use the agents.');
  }
}

export function describeApiError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key (401).';
  if (e instanceof Anthropic.RateLimitError) return 'Claude rate limit reached; try again shortly.';
  if (e instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status}: ${e.message}`;
  return (e as Error).message;
}
