/**
 * Vorlo Async Sender — fire-and-forget HTTP sender for trace events.
 *
 * Node is single-threaded, so "fire-and-forget" means we kick off a fetch()
 * without awaiting it and swallow every failure — the SDK must never affect
 * the agent. We bound the number of in-flight requests so an unreachable
 * server can never grow memory without limit.
 */
import type { ErrorDiagnosis, PreviousStep } from './errorTranslator.js';

const SDK_VERSION = '0.2.0';
const SEND_TIMEOUT_MS = 2000;
const MAX_IN_FLIGHT = 10_000; // drop events rather than grow unbounded

const DEBUG = ['1', 'true', 'yes'].includes((process.env.VORLO_DEBUG ?? '').toLowerCase());

function debug(...args: unknown[]): void {
  if (DEBUG) console.error('[vorlo]', ...args);
}

export interface TraceEvent {
  event_type: string;
  session_id?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  agent_name?: string;
  api_key?: string;
  step_number?: number;
  tool_name?: string;
  tool_type?: string;
  input?: string;
  output?: string;
  error?: string;
  error_diagnosis?: Omit<ErrorDiagnosis, never> | null;
  reasoning?: string;
  status?: string;
  latency_ms?: number;
  cost_tokens?: number;
  previous_step_context?: PreviousStep[];
  created_at?: string;
  [key: string]: unknown;
}

interface TracePayload {
  session_id: string;
  agent_name: string;
  api_key: string;
  step: Record<string, unknown>;
}

const SESSION_EVENT_TYPES = new Set(['session_start', 'session_complete', 'session_error']);

export interface SessionPayload {
  session_id: string;
  api_key: string;
  event_type: string;
  agent_name: string;
  trace_id: string;
  input: string;
  output: string;
  error: string;
  total_steps: number;
  duration_ms: number;
  created_at: string;
  status?: string;
}

/** Convert SDK lifecycle event shape into the server's /v1/session contract. */
export function toSessionPayload(event: TraceEvent): SessionPayload | null {
  if (!SESSION_EVENT_TYPES.has(event.event_type)) return null;

  const payload: SessionPayload = {
    session_id: event.session_id ?? '',
    api_key: event.api_key ?? '',
    event_type: event.event_type,
    agent_name: event.agent_name ?? '',
    trace_id: event.trace_id ?? '',
    input: String(event.input ?? ''),
    output: String(event.output ?? ''),
    error: String(event.error ?? ''),
    total_steps: Number(event.total_steps ?? 0) || 0,
    // Older handler shapes reported wall duration as latency_ms
    duration_ms: Number(event.duration_ms ?? event.latency_ms ?? 0) || 0,
    created_at: event.created_at ?? new Date().toISOString(),
  };
  if (event.status === 'running' || event.status === 'success' || event.status === 'failed') {
    payload.status = event.status;
  }
  return payload;
}

export function toTracePayload(event: TraceEvent): TracePayload | null {
  if (event.event_type !== 'step') return null;

  let toolType = String(event.tool_type ?? 'sensor').toUpperCase();
  if (toolType !== 'SENSOR' && toolType !== 'ACTUATOR') toolType = 'ACTUATOR';

  const step: Record<string, unknown> = {
    step_number: event.step_number ?? 1,
    tool_name: event.tool_name ?? 'unknown',
    tool_type: toolType,
    input: event.input ?? '',
    output: event.output ?? '',
    error: event.error ?? '',
    error_diagnosis: event.error_diagnosis ?? null,
    reasoning: event.reasoning ?? '',
    status: event.status ?? 'success',
    latency_ms: event.latency_ms ?? 0,
    cost_tokens: event.cost_tokens ?? 0,
    previous_step_context: event.previous_step_context ?? [],
    trace_id: event.trace_id ?? '',
    span_id: event.span_id ?? '',
    parent_span_id: event.parent_span_id ?? '',
    created_at: event.created_at ?? new Date().toISOString(),
  };

  return {
    session_id: event.session_id ?? '',
    agent_name: event.agent_name ?? '',
    api_key: event.api_key ?? '',
    step,
  };
}

export class AsyncSender {
  private readonly traceEndpoint: string;
  private readonly sessionEndpoint: string;
  private readonly apiKey: string;
  private readonly headers: Record<string, string>;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(serverUrl: string, apiKey: string) {
    const base = serverUrl.replace(/\/+$/, '');
    this.traceEndpoint = `${base}/v1/trace`;
    this.sessionEndpoint = `${base}/v1/session`;
    this.apiKey = apiKey;
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': `vorlo-trace-sdk-js/${SDK_VERSION}`,
    };
  }

  /** Enqueue an event for async sending. Never blocks, never rejects. */
  send(event: TraceEvent): void {
    if (this.inFlight.size >= MAX_IN_FLIGHT) {
      debug('In-flight cap reached — dropping event for session', event.session_id ?? '?');
      return;
    }

    // Steps go to /v1/trace, lifecycle events to /v1/session; anything else is dropped.
    let endpoint: string;
    let payload: TracePayload | SessionPayload | null;
    if (event.event_type === 'step') {
      endpoint = this.traceEndpoint;
      payload = toTracePayload(event);
    } else {
      endpoint = this.sessionEndpoint;
      payload = toSessionPayload(event);
    }
    if (payload === null) return;

    const promise = this.postEvent(endpoint, payload).catch(() => {
      // swallow — the SDK must never surface a network error to the agent
    });
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  /** Wait for in-flight sends to drain. Used primarily in tests. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  private async postEvent(
    endpoint: string,
    payload: TracePayload | SessionPayload,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      debug('Sent', 'step' in payload ? 'step' : payload.event_type, 'for session', payload.session_id);
    } finally {
      clearTimeout(timer);
    }
  }
}
