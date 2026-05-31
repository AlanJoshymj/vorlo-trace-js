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
  private currentReasoning: string | null = null;

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

  setReasoning(reasoning: string): void {
    this.currentReasoning = reasoning;
  }

  /** Return and clear the stored reasoning. Called once per tool call. */
  consumeReasoning(): string | null {
    const reasoning = this.currentReasoning;
    this.currentReasoning = null;
    return reasoning;
  }

  get duration_ms(): number {
    return Date.now() - this.start_time;
  }
}
