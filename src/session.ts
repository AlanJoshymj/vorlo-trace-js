/**
 * Vorlo Session — manages state for a single agent execution session.
 *
 * Tracks session ID, step counter, timing, and a rolling window of
 * previous step summaries for cross-step root cause analysis.
 */
import { randomUUID } from 'node:crypto';

import type { PreviousStep } from './errorTranslator.js';

// Maximum number of previous step summaries to retain for cross-step context
const MAX_PREVIOUS_STEPS = 5;

function uuidHex(): string {
  return randomUUID().replace(/-/g, '');
}

interface StepSummary {
  step_number: number;
  tool_name: string;
  tool_type: string;
  status: string;
  output_preview: string;
  error_code?: string;
}

function summaryToDict(s: StepSummary): PreviousStep {
  const d: PreviousStep = {
    step_number: s.step_number,
    tool_name: s.tool_name,
    tool_type: s.tool_type,
    status: s.status,
    output_preview: s.output_preview,
  };
  if (s.error_code) d.error_code = s.error_code;
  return d;
}

export class VorloSession {
  readonly session_id: string;
  readonly trace_id: string;
  readonly agent_name: string;
  readonly start_time: number;
  step_count = 0;

  private previousSteps: StepSummary[] = [];
  // Pending reasoning / token usage keyed by scope (the parent run id).
  // The LLM call that decides a tool call and the tool call itself share a
  // parent run, so scoping prevents parallel tool calls from stealing each
  // other's reasoning. '' is the global scope for flat runs.
  private reasoningByScope = new Map<string, string>();
  private tokensByScope = new Map<string, number>();
  total_tokens = 0;

  // Hard cap so chains that never call tools cannot leak pending state.
  private static readonly MAX_PENDING_SCOPES = 200;

  constructor(agentName = 'default') {
    this.session_id = uuidHex();
    this.trace_id = uuidHex();
    this.agent_name = agentName;
    this.start_time = Date.now();
  }

  nextStep(): number {
    this.step_count += 1;
    return this.step_count;
  }

  generateSpanId(): string {
    return uuidHex().slice(0, 16);
  }

  addCompletedStep(args: {
    step_number: number;
    tool_name: string;
    tool_type: string;
    status: string;
    output_preview: string;
    error_code?: string;
  }): void {
    this.previousSteps.push({
      step_number: args.step_number,
      tool_name: args.tool_name,
      tool_type: args.tool_type,
      status: args.status,
      output_preview: args.output_preview.slice(0, 200),
      error_code: args.error_code,
    });
    if (this.previousSteps.length > MAX_PREVIOUS_STEPS) {
      this.previousSteps.shift();
    }
  }

  getPreviousSteps(): PreviousStep[] {
    return this.previousSteps.map(summaryToDict);
  }

  setReasoning(reasoning: string, scope = ''): void {
    if (this.reasoningByScope.size >= VorloSession.MAX_PENDING_SCOPES) {
      this.reasoningByScope.clear();
    }
    this.reasoningByScope.set(scope, reasoning);
  }

  /**
   * Return and clear the stored reasoning for a scope. Falls back to the
   * global scope, then to a sole pending entry — nested runnable chains can
   * put the LLM under a different parent than the tool, and with only one
   * agent running that single entry is unambiguous.
   */
  consumeReasoning(scope = ''): string | null {
    let reasoning = this.takeFrom(this.reasoningByScope, scope);
    if (reasoning === null && scope !== '') reasoning = this.takeFrom(this.reasoningByScope, '');
    if (reasoning === null && this.reasoningByScope.size === 1) {
      const [k, v] = this.reasoningByScope.entries().next().value as [string, string];
      this.reasoningByScope.delete(k);
      reasoning = v;
    }
    return reasoning;
  }

  /** Accumulate token usage from LLM calls since the last tool start. */
  addTokens(count: number, scope = ''): void {
    if (count > 0) {
      if (this.tokensByScope.size >= VorloSession.MAX_PENDING_SCOPES) {
        this.tokensByScope.clear();
      }
      this.tokensByScope.set(scope, (this.tokensByScope.get(scope) ?? 0) + count);
      this.total_tokens += count;
    }
  }

  /** Return and reset the pending token count for a scope (same fallbacks as reasoning). */
  consumeTokens(scope = ''): number {
    let tokens = this.takeFrom(this.tokensByScope, scope) ?? 0;
    if (tokens === 0 && scope !== '') tokens = this.takeFrom(this.tokensByScope, '') ?? 0;
    if (tokens === 0 && this.tokensByScope.size === 1) {
      const [k, v] = this.tokensByScope.entries().next().value as [string, number];
      this.tokensByScope.delete(k);
      tokens = v;
    }
    return tokens;
  }

  private takeFrom<T>(map: Map<string, T>, key: string): T | null {
    if (!map.has(key)) return null;
    const value = map.get(key) as T;
    map.delete(key);
    return value;
  }

  get duration_ms(): number {
    return Date.now() - this.start_time;
  }
}
