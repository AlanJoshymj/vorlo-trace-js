/**
 * vorlo-trace — AI agent observability SDK for LangChain.js / Node.
 *
 * Add 2 lines of code to see exactly why your agent failed:
 *
 *     import * as vorlo from 'vorlo-trace';
 *     vorlo.init({ apiKey: 'vrlo_...', agentName: 'my-agent' });
 *
 *     // Then pass the handler to your agent:
 *     await agent.invoke({ input: '...' }, { callbacks: [vorlo.getHandler()] });
 *
 *     // Or use the convenience wrapper:
 *     await vorlo.trace(agent, { input: '...' });
 */
import { VorloHandler } from './handler.js';

export { VorloHandler } from './handler.js';
export type { ErrorDiagnosis, PreviousStep } from './errorTranslator.js';
export { translateError } from './errorTranslator.js';

export const VERSION = '0.1.0';

// Default server URL — points to Vorlo production server
const DEFAULT_SERVER_URL = 'https://vorlo-server-production.up.railway.app';

// Module-level singleton — one handler per process
let handlerSingleton: VorloHandler | null = null;

export interface InitOptions {
  /** Your Vorlo API key. Falls back to the VORLO_API_KEY env var. */
  apiKey?: string;
  /** Vorlo server URL. Falls back to VORLO_SERVER_URL, then the default. */
  serverUrl?: string;
  /** A name for this agent (shown in the dashboard). */
  agentName?: string;
  /**
   * Optional callback applied to every captured string (tool inputs/outputs,
   * errors, reasoning) BEFORE it leaves the process — use it to scrub PII or
   * secrets. If it throws, the content is dropped rather than shipped raw.
   */
  redact?: (text: string) => string;
}

export function init(options: InitOptions = {}): VorloHandler {
  const resolvedKey = options.apiKey || process.env.VORLO_API_KEY || '';
  if (!resolvedKey) {
    throw new Error(
      "Vorlo API key is required. Pass apiKey: 'vrlo_...' to init() " +
        'or set the VORLO_API_KEY environment variable.',
    );
  }

  const resolvedUrl =
    options.serverUrl || process.env.VORLO_SERVER_URL || DEFAULT_SERVER_URL;

  handlerSingleton = new VorloHandler({
    serverUrl: resolvedUrl,
    apiKey: resolvedKey,
    agentName: options.agentName ?? 'default',
    redact: options.redact,
  });
  return handlerSingleton;
}

export function getHandler(): VorloHandler {
  if (handlerSingleton === null) {
    throw new Error(
      "Vorlo is not initialized. Call init({ apiKey: 'vrlo_...' }) first.",
    );
  }
  return handlerSingleton;
}

interface Invokable {
  invoke(input: unknown, config?: Record<string, unknown>): Promise<unknown>;
}

/** Convenience wrapper — runs an agent with Vorlo tracing enabled. */
export async function trace(
  agent: Invokable,
  input: unknown = { input: '' },
  config: Record<string, unknown> = {},
): Promise<unknown> {
  const handler = getHandler();
  const callbacks = Array.isArray(config.callbacks) ? [...config.callbacks] : [];
  callbacks.push(handler);
  return agent.invoke(input, { ...config, callbacks });
}
