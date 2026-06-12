import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  callTool,
  formatSessionDiagnosis,
  formatSessionList,
  formatClusters,
  handleMessage,
} from '../src/mcp.js';

// Mock the Vorlo API + capture stdout frames
const realFetch = globalThis.fetch;
const realWrite = process.stdout.write.bind(process.stdout);
let apiResponses: Record<string, unknown> = {};
let frames: any[] = [];

beforeEach(() => {
  process.env.VORLO_API_KEY = 'vrlo_test';
  apiResponses = {};
  frames = [];
  globalThis.fetch = (async (url: string) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const match = Object.entries(apiResponses).find(([key]) => path.startsWith(key));
    if (!match) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(match[1]), { status: 200 });
  }) as typeof fetch;
  process.stdout.write = ((chunk: string) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) frames.push(JSON.parse(line));
    }
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.stdout.write = realWrite;
});

const FAILED_SESSION = {
  session_id: 'sess_1',
  agent_name: 'order-agent',
  status: 'failed',
  total_duration_ms: 812,
  steps: [
    { step_number: 1, tool_name: 'get_order', status: 'success', latency_ms: 100 },
    {
      step_number: 2,
      tool_name: 'charge_card',
      status: 'failed',
      latency_ms: 400,
      error_title: 'Stripe authentication failed',
      error_root_cause: 'The API key expired.',
      error_fix_hint: 'Rotate the Stripe key.',
      error_confidence: 'verified',
    },
  ],
};

describe('MCP protocol', () => {
  it('answers initialize with capabilities and serverInfo', async () => {
    await handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].result.protocolVersion, '2025-03-26');
    assert.equal(frames[0].result.serverInfo.name, 'vorlo');
    assert.ok(frames[0].result.capabilities.tools);
  });

  it('lists the four tools', async () => {
    await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = frames[0].result.tools.map((t: any) => t.name);
    assert.deepEqual(names, [
      'why_did_my_last_run_fail',
      'get_session_diagnosis',
      'list_recent_sessions',
      'get_failure_clusters',
    ]);
  });

  it('returns method-not-found for unknown requests but stays silent on notifications', async () => {
    await handleMessage({ jsonrpc: '2.0', id: 3, method: 'bogus/method' });
    assert.equal(frames[0].error.code, -32601);
    frames = [];
    await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(frames.length, 0);
  });

  it('wraps tool failures as isError results, not protocol errors', async () => {
    delete process.env.VORLO_API_KEY;
    await handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_recent_sessions', arguments: {} },
    });
    assert.equal(frames[0].result.isError, true);
    assert.match(frames[0].result.content[0].text, /VORLO_API_KEY/);
  });
});

describe('MCP tools', () => {
  it('why_did_my_last_run_fail chains list → detail and formats the diagnosis', async () => {
    apiResponses['/v1/sessions?page=1&status=failed'] = {
      sessions: [{ session_id: 'sess_1' }],
      total: 1,
    };
    apiResponses['/v1/sessions/sess_1'] = FAILED_SESSION;

    const text = await callTool('why_did_my_last_run_fail', {});
    assert.match(text, /order-agent/);
    assert.match(text, /FAILED at step 2/);
    assert.match(text, /Root cause: The API key expired\./);
    assert.match(text, /Fix: Rotate the Stripe key\./);
    assert.match(text, /vorlo\.dev\/sessions\/sess_1/);
  });

  it('why_did_my_last_run_fail reports clean runs', async () => {
    apiResponses['/v1/sessions?page=1&status=failed'] = { sessions: [], total: 0 };
    const text = await callTool('why_did_my_last_run_fail', {});
    assert.match(text, /No failed runs/);
  });

  it('list_recent_sessions formats statuses and error titles', async () => {
    apiResponses['/v1/sessions?page=1&status=failed'] = {
      total: 1,
      sessions: [
        {
          session_id: 'sess_9',
          agent_name: 'mail-agent',
          status: 'failed',
          total_steps: 4,
          last_error_title: 'Gmail rate limit',
        },
      ],
    };
    const text = await callTool('list_recent_sessions', { status: 'failed' });
    assert.match(text, /\[failed\] sess_9 · mail-agent · 4 steps — Gmail rate limit/);
  });

  it('get_failure_clusters formats root causes', async () => {
    apiResponses['/v1/sessions/failure-clusters?days=14'] = {
      total_failed_sessions: 6,
      clusters: [
        {
          title: 'OAuth/authentication failures',
          affected_sessions: 5,
          root_cause: 'Tokens expiring',
          fix_hint: 'Reconnect the account',
        },
      ],
    };
    const text = await callTool('get_failure_clusters', { days: 14 });
    assert.match(text, /OAuth\/authentication failures — 5 sessions/);
    assert.match(text, /Fix: Reconnect the account/);
  });
});

describe('formatters', () => {
  it('formatSessionDiagnosis marks steps and includes the replay link', () => {
    const text = formatSessionDiagnosis(FAILED_SESSION as any);
    assert.match(text, /✓ 1\. get_order \(100ms\)/);
    assert.match(text, /✗ 2\. charge_card \(400ms\)/);
    assert.match(text, /Confidence: verified/);
  });

  it('formatSessionList and formatClusters handle empty data', () => {
    assert.match(formatSessionList({ sessions: [] } as any), /No sessions/);
    assert.match(formatClusters({ clusters: [] } as any), /No failure clusters/);
  });
});
