import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toTracePayload, type TraceEvent } from '../src/sender.js';

describe('toTracePayload', () => {
  it('returns null for non-step events', () => {
    assert.equal(toTracePayload({ event_type: 'session_start' }), null);
    assert.equal(toTracePayload({ event_type: 'session_complete' }), null);
  });

  it('wraps a step event in the server /v1/trace contract', () => {
    const event: TraceEvent = {
      event_type: 'step',
      session_id: 'sess1',
      agent_name: 'agent1',
      api_key: 'vrlo_x',
      step_number: 3,
      tool_name: 'stripe_charge',
      tool_type: 'actuator',
      input: '{"amount":100}',
      output: 'ok',
      status: 'success',
      latency_ms: 42,
      trace_id: 't1',
      span_id: 's1',
      parent_span_id: 'p1',
    };
    const payload = toTracePayload(event)!;
    assert.equal(payload.session_id, 'sess1');
    assert.equal(payload.agent_name, 'agent1');
    assert.equal(payload.api_key, 'vrlo_x');
    assert.equal(payload.step.step_number, 3);
    assert.equal(payload.step.tool_name, 'stripe_charge');
    assert.equal(payload.step.parent_span_id, 'p1');
  });

  it('uppercases and validates tool_type, defaulting unknowns to ACTUATOR', () => {
    assert.equal(toTracePayload({ event_type: 'step', tool_type: 'sensor' })!.step.tool_type, 'SENSOR');
    assert.equal(toTracePayload({ event_type: 'step', tool_type: 'actuator' })!.step.tool_type, 'ACTUATOR');
    assert.equal(toTracePayload({ event_type: 'step', tool_type: 'weird' })!.step.tool_type, 'ACTUATOR');
    assert.equal(toTracePayload({ event_type: 'step' })!.step.tool_type, 'SENSOR');
  });

  it('fills sensible defaults and a created_at timestamp', () => {
    const payload = toTracePayload({ event_type: 'step' })!;
    assert.equal(payload.step.status, 'success');
    assert.equal(payload.step.latency_ms, 0);
    assert.deepEqual(payload.step.previous_step_context, []);
    assert.equal(payload.step.error_diagnosis, null);
    assert.match(String(payload.step.created_at), /\d{4}-\d{2}-\d{2}T/);
  });
});
