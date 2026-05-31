import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { VorloSession } from '../src/session.js';

describe('VorloSession', () => {
  it('generates 32-char hex session/trace ids and 16-char span ids', () => {
    const s = new VorloSession('agent');
    assert.match(s.session_id, /^[0-9a-f]{32}$/);
    assert.match(s.trace_id, /^[0-9a-f]{32}$/);
    assert.match(s.generateSpanId(), /^[0-9a-f]{16}$/);
    assert.notEqual(s.session_id, s.trace_id);
  });

  it('increments step numbers monotonically', () => {
    const s = new VorloSession();
    assert.equal(s.nextStep(), 1);
    assert.equal(s.nextStep(), 2);
    assert.equal(s.step_count, 2);
  });

  it('consumeReasoning returns once then clears', () => {
    const s = new VorloSession();
    s.setReasoning('because');
    assert.equal(s.consumeReasoning(), 'because');
    assert.equal(s.consumeReasoning(), null);
  });

  it('keeps only the last 5 completed steps for context', () => {
    const s = new VorloSession();
    for (let i = 1; i <= 7; i++) {
      s.addCompletedStep({
        step_number: i,
        tool_name: `tool_${i}`,
        tool_type: 'sensor',
        status: 'success',
        output_preview: 'ok',
      });
    }
    const prev = s.getPreviousSteps();
    assert.equal(prev.length, 5);
    assert.equal(prev[0]!.tool_name, 'tool_3');
    assert.equal(prev[4]!.tool_name, 'tool_7');
  });

  it('omits error_code when not present, includes it when set', () => {
    const s = new VorloSession();
    s.addCompletedStep({
      step_number: 1, tool_name: 't', tool_type: 'sensor', status: 'success', output_preview: 'o',
    });
    s.addCompletedStep({
      step_number: 2, tool_name: 'u', tool_type: 'actuator', status: 'failed',
      output_preview: 'e', error_code: 'auth_unauthorized',
    });
    const prev = s.getPreviousSteps();
    assert.equal('error_code' in prev[0]!, false);
    assert.equal(prev[1]!.error_code, 'auth_unauthorized');
  });
});
