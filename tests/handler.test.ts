import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { VorloHandler, extractHttpStatus, extractTotalTokens } from '../src/handler.js';
import type { Serialized } from '@langchain/core/load/serializable';

// Capture outgoing payloads (with their endpoint) by stubbing global fetch.
const realFetch = globalThis.fetch;
let captured: any[] = [];
let capturedUrls: string[] = [];

beforeEach(() => {
  captured = [];
  capturedUrls = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    capturedUrls.push(String(url));
    if (init?.body) captured.push(JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function tool(name: string): Serialized {
  return { name } as unknown as Serialized;
}

describe('VorloHandler', () => {
  it('classifies tools as sensor/actuator by name prefix', async () => {
    const h = new VorloHandler({ serverUrl: 'http://localhost:9', apiKey: 'k' });
    h.handleToolStart(tool('get_balance'), '{}', 'run-1');
    h.handleToolEnd('100', 'run-1');
    h.handleToolStart(tool('charge_card'), '{}', 'run-2');
    h.handleToolEnd('ok', 'run-2');
    await h.flush();

    assert.equal(captured.length, 2);
    assert.equal(captured[0].step.tool_type, 'SENSOR');
    assert.equal(captured[1].step.tool_type, 'ACTUATOR');
  });

  it('prefers the runName arg over the serialized class name for the tool name', async () => {
    const h = new VorloHandler({ serverUrl: 'http://localhost:9', apiKey: 'k' });
    // LangChain.js passes the class as serialized.name and the real name as runName.
    const classSerialized = { name: 'DynamicStructuredTool' } as unknown as Serialized;
    h.handleToolStart(classSerialized, '{}', 'run-rn', undefined, undefined, undefined, 'get_balance');
    h.handleToolEnd('100', 'run-rn');
    await h.flush();

    assert.equal(captured[0].step.tool_name, 'get_balance');
    assert.equal(captured[0].step.tool_type, 'SENSOR');
  });

  it('links child tool spans to their parent run via parent_span_id', async () => {
    const h = new VorloHandler({ serverUrl: 'http://localhost:9', apiKey: 'k' });
    // Parent chain establishes a span for 'parent'
    h.handleChainStart(tool('agent'), { input: 'x' }, 'parent');
    h.handleToolStart(tool('search_web'), '{}', 'child', 'parent');
    h.handleToolEnd('result', 'child');
    await h.flush();

    const step = captured.find((c) => c.step?.tool_name === 'search_web');
    assert.ok(step, 'expected a step for search_web');
    assert.notEqual(step.step.parent_span_id, '');
    assert.notEqual(step.step.span_id, step.step.parent_span_id);
  });

  it('attaches a diagnosis on tool error', async () => {
    const h = new VorloHandler({ serverUrl: 'http://localhost:9', apiKey: 'k' });
    h.handleToolStart(tool('stripe_charge'), '{}', 'run-err');
    const err = new Error('Invalid API key — HTTP 401 authentication failed');
    h.handleToolError(err, 'run-err');
    await h.flush();

    assert.equal(captured.length, 1);
    const step = captured[0].step;
    assert.equal(step.status, 'failed');
    assert.equal(step.error_diagnosis.code, 'stripe_auth_error');
    assert.equal(step.error, step.error_diagnosis.plain_english);
  });

  it('passes prior-step reasoning into the next step', async () => {
    const h = new VorloHandler({ serverUrl: 'http://localhost:9', apiKey: 'k' });
    h.handleLLMStart(tool('gpt'), ['Decide what to do next'], 'llm-1');
    h.handleLLMEnd({ generations: [[{ text: 'call search_web' }]] } as any, 'llm-1');
    h.handleToolStart(tool('search_web'), '{}', 'run-3');
    h.handleToolEnd('done', 'run-3');
    await h.flush();

    assert.match(captured[0].step.reasoning, /Decide what to do next/);
    assert.match(captured[0].step.reasoning, /call search_web/);
  });

  it('sends session lifecycle events to /v1/session, never /v1/trace', async () => {
    const h = new VorloHandler({ serverUrl: 'http://localhost:9', apiKey: 'k' });
    h.handleChainStart(tool('agent'), { input: 'x' }, 'root');
    h.handleChainEnd({ output: 'y' }, 'root');
    await h.flush();

    assert.equal(captured.length, 2);
    assert.ok(capturedUrls.every((u) => u.endsWith('/v1/session')));
    assert.equal(captured[0].event_type, 'session_start');
    assert.equal(captured[1].event_type, 'session_complete');
    assert.equal(captured[1].status, 'success');
  });
});

describe('reasoning scoping under concurrency', () => {
  it('parallel agents do not swap reasoning', async () => {
    const h = new VorloHandler({ serverUrl: 'http://localhost:9', apiKey: 'k' });
    h.handleLLMStart(tool('gpt'), ['plan for agent A'], 'llm-a', 'parent-a');
    h.handleLLMStart(tool('gpt'), ['plan for agent B'], 'llm-b', 'parent-b');

    // Agent B's tool starts FIRST — under the old single-slot model it would
    // have stolen whichever reasoning was written last.
    h.handleToolStart(tool('tool_b'), '{}', 'run-b', 'parent-b');
    h.handleToolEnd('ok', 'run-b');
    h.handleToolStart(tool('tool_a'), '{}', 'run-a', 'parent-a');
    h.handleToolEnd('ok', 'run-a');
    await h.flush();

    const stepB = captured.find((c) => c.step?.tool_name === 'tool_b');
    const stepA = captured.find((c) => c.step?.tool_name === 'tool_a');
    assert.match(stepB.step.reasoning, /agent B/);
    assert.match(stepA.step.reasoning, /agent A/);
  });

  it('a sole pending entry still attaches when parents mismatch', async () => {
    const h = new VorloHandler({ serverUrl: 'http://localhost:9', apiKey: 'k' });
    h.handleLLMStart(tool('gpt'), ['the only plan'], 'llm-1', 'inner-chain');
    h.handleToolStart(tool('tool_x'), '{}', 'run-1', 'different-parent');
    h.handleToolEnd('ok', 'run-1');
    await h.flush();

    assert.match(captured[0].step.reasoning, /the only plan/);
  });
});

describe('token usage capture', () => {
  it('attaches LLM token usage to the next step, then resets', async () => {
    const h = new VorloHandler({ serverUrl: 'http://localhost:9', apiKey: 'k' });
    h.handleLLMStart(tool('gpt'), ['decide'], 'llm-1');
    h.handleLLMEnd(
      {
        generations: [[{ text: 'call search_web' }]],
        llmOutput: { tokenUsage: { promptTokens: 100, completionTokens: 23, totalTokens: 123 } },
      } as any,
      'llm-1',
    );
    h.handleToolStart(tool('search_web'), '{}', 'run-1');
    h.handleToolEnd('done', 'run-1');
    h.handleToolStart(tool('get_more'), '{}', 'run-2');
    h.handleToolEnd('done', 'run-2');
    await h.flush();

    assert.equal(captured[0].step.cost_tokens, 123);
    assert.equal(captured[1].step.cost_tokens, 0);
  });

  it('reads Anthropic-style usage and per-message usage_metadata', () => {
    assert.equal(
      extractTotalTokens({
        generations: [],
        llmOutput: { usage: { input_tokens: 40, output_tokens: 2 } },
      } as any),
      42,
    );
    assert.equal(
      extractTotalTokens({
        generations: [[{ text: 'x', message: { usage_metadata: { input_tokens: 10, output_tokens: 5 } } }]],
      } as any),
      15,
    );
    assert.equal(extractTotalTokens({ generations: [[{ text: 'x' }]] } as any), 0);
  });
});

describe('extractHttpStatus', () => {
  it('extracts codes from HTTP-shaped contexts', () => {
    assert.equal(extractHttpStatus('HTTP 403 Forbidden'), 403);
    assert.equal(extractHttpStatus('Error: 500 Internal Server Error'), 500);
    assert.equal(extractHttpStatus('Rate limited: 429'), 429);
    assert.equal(extractHttpStatus('ToolError: 403 (charge_card)'), 403);
    assert.equal(extractHttpStatus('Request req_8a2Xj returned 403'), 403);
    assert.equal(extractHttpStatus('server responded with 502'), 502);
    assert.equal(extractHttpStatus('status_code=404'), 404);
    assert.equal(extractHttpStatus('got a 429 Too Many Requests'), 429);
    assert.equal(extractHttpStatus('HTTP/1.1 503 Service Unavailable'), 503);
  });

  it('never treats bare numbers as status codes', () => {
    // A wrong diagnosis is worse than none.
    assert.equal(extractHttpStatus('Connection refused'), null);
    assert.equal(extractHttpStatus("KeyError: 'name'"), null);
    assert.equal(extractHttpStatus('KeyError at line 403 of utils.py'), null);
    assert.equal(extractHttpStatus('Processed 404 items in batch'), null);
    assert.equal(extractHttpStatus('customer id 503 not found in table'), null);
    assert.equal(extractHttpStatus('retried after 500 ms'), null);
    assert.equal(extractHttpStatus('port 443 connection reset'), null);
  });
});
