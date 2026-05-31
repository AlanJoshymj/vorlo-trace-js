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

import { translateError, type ErrorDiagnosis } from './errorTranslator.js';
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

const HTTP_STATUS_RE = /\b([1-5]\d{2})\b/;

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

function extractHttpStatus(message: string): number | null {
  const match = HTTP_STATUS_RE.exec(message);
  if (match) {
    const code = Number(match[1]);
    if (code >= 100 && code <= 599) return code;
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
}

export interface VorloHandlerOptions {
  serverUrl: string;
  apiKey: string;
  agentName?: string;
}

export class VorloHandler extends BaseCallbackHandler {
  name = 'VorloHandler';
  override awaitHandlers = false;
  override raiseError = false;

  private readonly sender: AsyncSender;
  private readonly session: VorloSession;
  private readonly apiKey: string;

  private readonly activeSteps = new Map<string, ActiveStep>();
  // OTel span registry — maps every runId (chain, llm, tool) to a span_id
  // so a child run can resolve its parent_span_id from parentRunId.
  private readonly spanByRun = new Map<string, string>();

  constructor(opts: VorloHandlerOptions) {
    super();
    this.sender = new AsyncSender(opts.serverUrl, opts.apiKey);
    this.session = new VorloSession(opts.agentName ?? 'default');
    this.apiKey = opts.apiKey;
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
      const reasoning = this.session.consumeReasoning();

      this.activeSteps.set(runId, {
        step_number: stepNumber,
        tool_name: toolName,
        tool_type: toolType,
        input: truncate(input, MAX_INPUT_CHARS),
        start_time: Date.now(),
        span_id: spanId,
        parent_span_id: parentSpanId,
        reasoning: reasoning ? truncate(reasoning, MAX_REASONING_CHARS) : '',
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

      const outputStr = truncate(safeStr(output), MAX_OUTPUT_CHARS);
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
      const errorStr = error instanceof Error ? error.message : safeStr(error);
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

  override handleLLMStart(_llm: Serialized, prompts: string[], runId: string): void {
    try {
      this.registerSpan(runId);
      const combined = prompts && prompts.length ? prompts.join('\n') : '';
      this.session.setReasoning(truncate(combined, MAX_REASONING_CHARS));
    } catch {
      /* swallow */
    }
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    try {
      this.releaseSpan(runId);
      const generations = output?.generations;
      if (generations && generations.length) {
        const firstGen = generations[0];
        if (firstGen && firstGen.length) {
          const text = firstGen[0]?.text ?? '';
          const current = this.session.consumeReasoning() ?? '';
          const combined = current ? `${current}\n---LLM OUTPUT---\n${text}` : text;
          this.session.setReasoning(truncate(combined, MAX_REASONING_CHARS));
        }
      }
    } catch {
      /* swallow */
    }
  }

  override handleChatModelStart(_llm: Serialized, messages: BaseMessage[][], runId: string): void {
    try {
      this.registerSpan(runId);
      const all: string[] = [];
      for (const msgList of messages) {
        for (const msg of msgList) {
          all.push(`[${messageType(msg)}] ${safeStr(msg.content)}`);
        }
      }
      this.session.setReasoning(truncate(all.join('\n'), MAX_REASONING_CHARS));
    } catch {
      /* swallow */
    }
  }

  // ── Agent callbacks ──────────────────────────────────────────────────

  override handleAgentAction(action: AgentAction, _runId: string): void {
    try {
      const parts: string[] = [];
      const current = this.session.consumeReasoning();
      if (current) parts.push(current);
      parts.push(
        `Agent decided to call tool '${action.tool}' with input: ` +
          `${truncate(action.toolInput, 500)}`,
      );
      if (action.log) parts.push(`Agent reasoning: ${truncate(action.log, 1000)}`);
      this.session.setReasoning(truncate(parts.join('\n'), MAX_REASONING_CHARS));
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
        output: truncate(action.returnValues, MAX_OUTPUT_CHARS),
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
          input: truncate(inputs, MAX_INPUT_CHARS),
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
          output: truncate(outputs, MAX_OUTPUT_CHARS),
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
          error: truncate(error instanceof Error ? error.message : error, MAX_OUTPUT_CHARS),
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
      reasoning: stepData.reasoning,
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
