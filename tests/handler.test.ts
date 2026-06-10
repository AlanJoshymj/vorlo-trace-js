import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { VorloHandler } from '../src/handler.js';
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
