/**
 * Vorlo Handler — LangChain.js callback handler that captures every step
 * of an agent's execution for debugging and observability.
 *
 * Faithful port of the Python `handler.py`.
 *
 * Design principles:
 * - NEVER crash or slow the agent — all sends are fire-and-forget
 * - Capture cross-step context for root cause analysis
 * - Classify every tool as sensor (read) or actuator (write)
 * - Include OTel-compatible trace/span IDs
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { LLMResult } from '@langchain/core/outputs';
import type { BaseMessage } from '@langchain/core/messages';
import type { AgentAction, AgentFinish } from '@langchain/core/agents';
import type { ChainValues } from '@langchain/core/utils/types';

import { translateError, truncateKeepTail, type ErrorDiagnosis } from './errorTranslator.js';
import { AsyncSender, type TraceEvent } from './sender.js';
import { VorloSession } from './session.js';

// ── Tool type classification ────────────────────────────────────────────
const SENSOR_PREFIXES = [
  'get_', 'read_', 'fetch_', 'search_', 'list_', 'find_', 'query_', 'lookup_', 'check_',
];
const ACTUATOR_PREFIXES = [
  'send_', 'create_', 'update_', 'delete_', 'charge_', 'post_', 'write_', 'set_', 'remove_', 'put_',
];

const MAX_INPUT_CHARS = 2000;
const MAX_OUTPUT_CHARS = 2000;
const MAX_REASONING_CHARS = 3000;

// Hard cap so a stream of un-paired start events can never leak memory.
const MAX_TRACKED_SPANS = 5000;

// A bare \b([1-5]\d{2})\b would treat ANY 3-digit number as an HTTP status
// ("KeyError at line 403 of utils.py" → diagnosed as 403 Forbidden), and a
// wrong diagnosis is worse than none. Only extract a code when it appears in
// an HTTP-shaped context. Mirrors the Python SDK's _HTTP_STATUS_PATTERNS.
const HTTP_STATUS_PATTERNS: RegExp[] = [
  // "HTTP 403", "HTTP/1.1 403", "HTTPS 503", "http status: 403"
  /\bhttps?(?:\/\d\.\d)?\s*(?:status)?\s*[:=]?\s*([1-5]\d{2})\b/i,
  // "status code 403", "status: 403", "status_code=404", "StatusCode: 429"
  /\bstatus(?:[ _-]?code)?\s*[:=]?\s*([1-5]\d{2})\b/i,
  // "error code: 429", "code=503"
  /\b(?:error\s+)?code\s*[:=]\s*([1-5]\d{2})\b/i,
  // "returned 503", "responded with 502", "got a 404", "received 429"
  /\b(?:returned|respond(?:ed)?\s+with|got(?:\s+a)?|received)\s+([1-5]\d{2})\b/i,
  // "SomeError: 403", "ToolError(429)" — a code immediately after an error label
  /\b\w*(?:error|exception)\w*\s*[:(]\s*([1-5]\d{2})\b/i,
  // "rate limited: 429", "rate limit (429)"
  /\brate[ -]?limit\w*\s*[:=(]?\s*([1-5]\d{2})\b/i,
  // "403 Forbidden", "429 Too Many Requests" — a code paired with ITS OWN
  // canonical reason phrase ("503 not found in table" must not match).
  new RegExp(
    '\\b(?:' +
      '(400)\\s+bad request|(401)\\s+unauthorized|(402)\\s+payment required|' +
      '(403)\\s+forbidden|(404)\\s+not found|(405)\\s+method not allowed|' +
      '(406)\\s+not acceptable|(408)\\s+request timeout|(409)\\s+conflict|' +
      '(410)\\s+gone|(412)\\s+precondition failed|(413)\\s+payload too large|' +
      '(422)\\s+unprocessable|(429)\\s+too many requests|' +
      '(500)\\s+internal server error|(501)\\s+not implemented|' +
      '(502)\\s+bad gateway|(503)\\s+service unavailable|(504)\\s+gateway timeout' +
      ')\\b',
    'i',
  ),
];

function classifyTool(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (SENSOR_PREFIXES.some((p) => lower.startsWith(p))) return 'sensor';
  if (ACTUATOR_PREFIXES.some((p) => lower.startsWith(p))) return 'actuator';
  // Default to actuator for safety — unknown tools are treated as state-changing
  return 'actuator';
}

function truncate(value: unknown, maxLength: number): string {
  const text = safeStr(value);
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

function safeStr(value: unknown): string {
  try {
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  } catch {
    return '<unserializable>';
  }
}

export function extractHttpStatus(message: string): number | null {
  for (const pattern of HTTP_STATUS_PATTERNS) {
    const match = pattern.exec(message);
    if (match) {
      // The paired code+reason pattern has many groups; take the one that hit.
      const codeStr = match.slice(1).find((g) => g !== undefined);
      if (codeStr === undefined) continue;
      const code = Number(codeStr);
      if (code >= 100 && code <= 599) return code;
    }
  }
  return null;
}

function messageType(msg: BaseMessage): string {
  const m = msg as unknown as { _getType?: () => string; getType?: () => string };
  try {
    if (typeof m.getType === 'function') return m.getType();
    if (typeof m._getType === 'function') return m._getType();
  } catch {
    /* fall through */
  }
  return 'message';
}

interface ActiveStep {
  step_number: number;
  tool_name: string;
  tool_type: string;
  input: string;
  start_time: number;
  span_id: string;
  parent_span_id: string;
  reasoning: string;
  cost_tokens: number;
}

/**
 * Extract total token usage from an LLMResult, across provider shapes:
 * OpenAI-style llmOutput.tokenUsage, Anthropic-style llmOutput.usage, and
 * per-message usage_metadata (newer LangChain chat models).
 * Returns 0 when usage is unavailable — never throws.
 */
export function extractTotalTokens(output: LLMResult): number {
  try {
    const llmOutput = (output?.llmOutput ?? {}) as Record<string, any>;
    const usage = llmOutput.tokenUsage ?? llmOutput.token_usage ?? llmOutput.usage ?? {};
    let total =
      usage.totalTokens ??
      usage.total_tokens ??
      (usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0) +
        (usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0);
    if (total > 0) return Number(total) || 0;

    for (const genList of output?.generations ?? []) {
      for (const gen of genList) {
        const meta = (gen as unknown as { message?: { usage_metadata?: Record<string, number> } })
          .message?.usage_metadata;
        if (meta) {
          total = meta.total_tokens ?? (meta.input_tokens ?? 0) + (meta.output_tokens ?? 0);
          if (total > 0) return Number(total) || 0;
        }
      }
    }
  } catch {
    /* usage extraction must never affect the agent */
  }
  return 0;
}

export interface VorloHandlerOptions {
  serverUrl: string;
  apiKey: string;
  agentName?: string;
  /** Scrub PII/secrets from captured strings before they leave the process. */
  redact?: (text: string) => string;
}

export class VorloHandler extends BaseCallbackHandler {
  name = 'VorloHandler';
  override awaitHandlers = false;
  override raiseError = false;

  private readonly sender: AsyncSender;
  private readonly session: VorloSession;
  private readonly apiKey: string;
  private readonly redact?: (text: string) => string;

  private readonly activeSteps = new Map<string, ActiveStep>();
  // OTel span registry — maps every runId (chain, llm, tool) to a span_id
  // so a child run can resolve its parent_span_id from parentRunId.
  private readonly spanByRun = new Map<string, string>();

  constructor(opts: VorloHandlerOptions) {
    super();
    this.sender = new AsyncSender(opts.serverUrl, opts.apiKey);
    this.session = new VorloSession(opts.agentName ?? 'default');
    this.apiKey = opts.apiKey;
    this.redact = opts.redact;
  }

  /**
   * Apply the user's redact callback before anything leaves the process.
   * If the callback throws we drop the content rather than ship it raw —
   * the privacy-safe failure mode.
   */
  private scrub(text: string): string {
    if (!this.redact || !text) return text;
    try {
      return String(this.redact(text));
    } catch {
      return '<redacted: redact callback raised>';
    }
  }

  get sessionId(): string {
    return this.session.session_id;
  }

  get agentName(): string {
    return this.session.agent_name;
  }

  /** Drain in-flight sends. Primarily for tests. */
  async flush(): Promise<void> {
    await this.sender.flush();
  }

  // ── Span registry helpers ────────────────────────────────────────────

  private registerSpan(runId: string): string {
    let spanId = this.spanByRun.get(runId);
    if (spanId === undefined) {
      if (this.spanByRun.size >= MAX_TRACKED_SPANS) this.spanByRun.clear();
      spanId = this.session.generateSpanId();
      this.spanByRun.set(runId, spanId);
    }
    return spanId;
  }

  private resolveParentSpan(parentRunId?: string): string {
    if (!parentRunId) return '';
    return this.spanByRun.get(parentRunId) ?? '';
  }

  private releaseSpan(runId: string): void {
    this.spanByRun.delete(runId);
  }

  // ── Tool callbacks ───────────────────────────────────────────────────

  override handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    try {
      // LangChain.js passes the real tool name as `runName`. The serialized
      // `tool.name` is usually the class ("DynamicStructuredTool"), so prefer
      // runName, then a non-class serialized name, then the id tail.
      const serialized = tool as unknown as { name?: string; id?: string[] };
      const serializedName =
        serialized.name && serialized.name !== 'DynamicStructuredTool' ? serialized.name : '';
      const toolName =
        runName || serializedName || serialized.id?.[serialized.id.length - 1] || 'unknown';
      const stepNumber = this.session.nextStep();
      const toolType = classifyTool(toolName);
      const spanId = this.registerSpan(runId);
      const parentSpanId = this.resolveParentSpan(parentRunId);
      const scope = parentRunId ?? '';
      const reasoning = this.session.consumeReasoning(scope);

      this.activeSteps.set(runId, {
        step_number: stepNumber,
        tool_name: toolName,
        tool_type: toolType,
        input: truncate(this.scrub(input), MAX_INPUT_CHARS),
        start_time: Date.now(),
        span_id: spanId,
        parent_span_id: parentSpanId,
        reasoning: reasoning ? truncate(reasoning, MAX_REASONING_CHARS) : '',
        // Tokens spent by the LLM call(s) that decided this tool call
        cost_tokens: this.session.consumeTokens(scope),
      });
    } catch {
      /* never affect the agent */
    }
  }

  override handleToolEnd(output: unknown, runId: string): void {
    try {
      this.releaseSpan(runId);
      const stepData = this.activeSteps.get(runId);
      if (stepData === undefined) return;
      this.activeSteps.delete(runId);

      const outputStr = truncate(this.scrub(safeStr(output)), MAX_OUTPUT_CHARS);
      const latencyMs = Date.now() - stepData.start_time;

      const event = this.buildEvent(stepData, 'success', outputStr, latencyMs, '', null);
      this.sender.send(event);

      this.session.addCompletedStep({
        step_number: stepData.step_number,
        tool_name: stepData.tool_name,
        tool_type: stepData.tool_type,
        status: 'success',
        output_preview: outputStr.slice(0, 200),
      });
    } catch {
      /* swallow */
    }
  }

  override handleToolError(error: unknown, runId: string): void {
    try {
      this.releaseSpan(runId);
      const stepData = this.activeSteps.get(runId);
      if (stepData === undefined) return;
      this.activeSteps.delete(runId);

      const latencyMs = Date.now() - stepData.start_time;
      // Scrub BEFORE translating so PII never reaches the diagnosis text
      const errorStr = this.scrub(error instanceof Error ? error.message : safeStr(error));
      const errorType = error instanceof Error ? error.name : typeof error;
      const httpStatus = extractHttpStatus(errorStr);

      const diagnosis = translateError(
        stepData.tool_name,
        errorType,
        httpStatus,
        errorStr,
        this.session.getPreviousSteps(),
      );

      const event = this.buildEvent(stepData, 'failed', '', latencyMs, errorStr, diagnosis);
      this.sender.send(event);

      this.session.addCompletedStep({
        step_number: stepData.step_number,
        tool_name: stepData.tool_name,
        tool_type: stepData.tool_type,
        status: 'failed',
        output_preview: errorStr.slice(0, 200),
        error_code: diagnosis.code,
      });
    } catch {
      /* swallow */
    }
  }

  // ── LLM callbacks ────────────────────────────────────────────────────

  override handleLLMStart(
    _llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
  ): void {
    try {
      this.registerSpan(runId);
      // Scoped by parent run so parallel agents don't steal each other's reasoning.
      const combined = prompts && prompts.length ? prompts.join('\n') : '';
      this.session.setReasoning(truncate(combined, MAX_REASONING_CHARS), parentRunId ?? '');
    } catch {
      /* swallow */
    }
  }

  override handleLLMEnd(output: LLMResult, runId: string, parentRunId?: string): void {
    try {
      this.releaseSpan(runId);
      const scope = parentRunId ?? '';
      this.session.addTokens(extractTotalTokens(output), scope);
      const generations = output?.generations;
      if (generations && generations.length) {
        const firstGen = generations[0];
        if (firstGen && firstGen.length) {
          const text = firstGen[0]?.text ?? '';
          const current = this.session.consumeReasoning(scope) ?? '';
          const combined = current ? `${current}\n---LLM OUTPUT---\n${text}` : text;
          this.session.setReasoning(truncate(combined, MAX_REASONING_CHARS), scope);
        }
      }
    } catch {
      /* swallow */
    }
  }

  override handleChatModelStart(
    _llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
  ): void {
    try {
      this.registerSpan(runId);
      const all: string[] = [];
      for (const msgList of messages) {
        for (const msg of msgList) {
          all.push(`[${messageType(msg)}] ${safeStr(msg.content)}`);
        }
      }
      this.session.setReasoning(truncate(all.join('\n'), MAX_REASONING_CHARS), parentRunId ?? '');
    } catch {
      /* swallow */
    }
  }

  // ── Agent callbacks ──────────────────────────────────────────────────

  override handleAgentAction(action: AgentAction, runId: string): void {
    try {
      // Agent actions fire on the executor's chain run, and tools started by
      // that executor get THIS runId as their parent — so the scope for the
      // upcoming tool is runId. The LLM call that produced this decision
      // stored its reasoning under the same scope (its parent is also the
      // executor run).
      const scope = runId ?? '';
      const parts: string[] = [];
      const current = this.session.consumeReasoning(scope);
      if (current) parts.push(current);
      parts.push(
        `Agent decided to call tool '${action.tool}' with input: ` +
          `${truncate(action.toolInput, 500)}`,
      );
      if (action.log) parts.push(`Agent reasoning: ${truncate(action.log, 1000)}`);
      this.session.setReasoning(truncate(parts.join('\n'), MAX_REASONING_CHARS), scope);
    } catch {
      /* swallow */
    }
  }

  override handleAgentEnd(action: AgentFinish): void {
    try {
      const event: TraceEvent = {
        event_type: 'session_complete',
        session_id: this.session.session_id,
        trace_id: this.session.trace_id,
        agent_name: this.session.agent_name,
        api_key: this.apiKey,
        status: 'success',
        latency_ms: this.session.duration_ms,
        duration_ms: this.session.duration_ms,
        total_steps: this.session.step_count,
        output: truncate(this.scrub(safeStr(action.returnValues)), MAX_OUTPUT_CHARS),
      };
      this.sender.send(event);
    } catch {
      /* swallow */
    }
  }

  // ── Chain callbacks ──────────────────────────────────────────────────

  override handleChainStart(
    _chain: Serialized,
    inputs: ChainValues,
    runId: string,
    parentRunId?: string,
  ): void {
    try {
      this.registerSpan(runId);
      if (!parentRunId) {
        const event: TraceEvent = {
          event_type: 'session_start',
          session_id: this.session.session_id,
          trace_id: this.session.trace_id,
          agent_name: this.session.agent_name,
          api_key: this.apiKey,
          input: truncate(this.scrub(safeStr(inputs)), MAX_INPUT_CHARS),
        };
        this.sender.send(event);
      }
    } catch {
      /* swallow */
    }
  }

  override handleChainEnd(outputs: ChainValues, runId: string, parentRunId?: string): void {
    try {
      this.releaseSpan(runId);
      if (!parentRunId) {
        const event: TraceEvent = {
          event_type: 'session_complete',
          session_id: this.session.session_id,
          trace_id: this.session.trace_id,
          agent_name: this.session.agent_name,
          api_key: this.apiKey,
          status: 'success',
          latency_ms: this.session.duration_ms,
          duration_ms: this.session.duration_ms,
          total_steps: this.session.step_count,
          output: truncate(this.scrub(safeStr(outputs)), MAX_OUTPUT_CHARS),
        };
        this.sender.send(event);
      }
    } catch {
      /* swallow */
    }
  }

  override handleChainError(error: unknown, runId: string, parentRunId?: string): void {
    try {
      this.releaseSpan(runId);
      if (!parentRunId) {
        const event: TraceEvent = {
          event_type: 'session_error',
          session_id: this.session.session_id,
          trace_id: this.session.trace_id,
          agent_name: this.session.agent_name,
          api_key: this.apiKey,
          status: 'failed',
          latency_ms: this.session.duration_ms,
          duration_ms: this.session.duration_ms,
          total_steps: this.session.step_count,
          error: truncateKeepTail(
            this.scrub(error instanceof Error ? error.message : safeStr(error)),
            MAX_OUTPUT_CHARS,
          ),
        };
        this.sender.send(event);
      }
    } catch {
      /* swallow */
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private buildEvent(
    stepData: ActiveStep,
    status: string,
    output: string,
    latencyMs: number,
    error: string,
    diagnosis: ErrorDiagnosis | null,
  ): TraceEvent {
    const event: TraceEvent = {
      event_type: 'step',
      session_id: this.session.session_id,
      trace_id: this.session.trace_id,
      span_id: stepData.span_id,
      parent_span_id: stepData.parent_span_id,
      agent_name: this.session.agent_name,
      api_key: this.apiKey,
      step_number: stepData.step_number,
      tool_name: stepData.tool_name,
      tool_type: stepData.tool_type,
      input: stepData.input,
      output,
      status,
      latency_ms: latencyMs,
      cost_tokens: stepData.cost_tokens,
      reasoning: this.scrub(stepData.reasoning),
      previous_step_context: this.session.getPreviousSteps(),
    };

    if (diagnosis) {
      event.error = diagnosis.plain_english;
      event.error_diagnosis = diagnosis;
    } else {
      event.error = error;
    }

    return event;
  }
}
