#!/usr/bin/env node
/**
 * Vorlo MCP server — debug your AI agent from inside your AI coding assistant.
 *
 * Exposes Vorlo's diagnosis API as MCP tools so Claude Code / Cursor / any MCP
 * client can ask "why did my last run fail?" and get the root cause + fix
 * without leaving the editor.
 *
 * Zero dependencies: a minimal, correct JSON-RPC 2.0 server over stdio
 * (newline-delimited JSON, per the MCP stdio transport).
 *
 * Usage:
 *   claude mcp add vorlo --env VORLO_API_KEY=vrlo_... -- npx -y -p vorlo-trace vorlo-mcp
 */

const SERVER_NAME = 'vorlo';
const SERVER_VERSION = '0.3.0';
const DEFAULT_SERVER_URL = 'https://vorlo-server-production.up.railway.app';

type Json = Record<string, unknown>;

// ── Vorlo API client ─────────────────────────────────────────────────────

function apiBase(): string {
  return (process.env.VORLO_SERVER_URL || DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

async function vorloGet(path: string): Promise<Json> {
  const apiKey = process.env.VORLO_API_KEY || '';
  if (!apiKey) {
    throw new Error(
      'VORLO_API_KEY is not set. Create a key at https://www.vorlo.dev/settings ' +
        'and add it to the MCP server env.'
    );
  }
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Vorlo API ${path} responded ${res.status}`);
  }
  return (await res.json()) as Json;
}

// ── Formatters (exported for tests) ──────────────────────────────────────

interface StepLike {
  step_number?: number;
  tool_name?: string;
  status?: string;
  latency_ms?: number;
  error_title?: string;
  error_plain_english?: string;
  error_root_cause?: string;
  error_fix_hint?: string;
  error_confidence?: string;
}

export function formatSessionDiagnosis(session: Json): string {
  const steps = (session.steps as StepLike[] | undefined) ?? [];
  const failed = steps.find((s) => s.status === 'failed');
  const lines: string[] = [
    `Session ${String(session.session_id ?? '')} — agent "${String(session.agent_name ?? 'unknown')}"`,
    `Status: ${String(session.status ?? (failed ? 'failed' : 'success'))} · ${steps.length} steps · ${Number(session.total_duration_ms ?? 0)}ms total`,
    '',
  ];

  if (failed) {
    lines.push(
      `FAILED at step ${failed.step_number ?? '?'} — tool: ${failed.tool_name ?? 'unknown'}`,
      `Title: ${failed.error_title || 'Step failed'}`
    );
    if (failed.error_plain_english) lines.push(`What happened: ${failed.error_plain_english}`);
    if (failed.error_root_cause) lines.push(`Root cause: ${failed.error_root_cause}`);
    if (failed.error_fix_hint) lines.push(`Fix: ${failed.error_fix_hint}`);
    if (failed.error_confidence) lines.push(`Confidence: ${failed.error_confidence}`);
    lines.push('');
  }

  lines.push('Steps:');
  for (const s of steps) {
    const mark = s.status === 'failed' ? '✗' : '✓';
    lines.push(
      `  ${mark} ${s.step_number ?? '?'}. ${s.tool_name ?? 'unknown'} (${s.latency_ms ?? 0}ms)`
    );
  }
  lines.push('', `Replay: https://www.vorlo.dev/sessions/${String(session.session_id ?? '')}`);
  return lines.join('\n');
}

export function formatSessionList(data: Json): string {
  const sessions = (data.sessions as Json[] | undefined) ?? [];
  if (sessions.length === 0) return 'No sessions found.';
  const lines = sessions.map((s) => {
    const status = String(s.status ?? (Number(s.fail_count ?? 0) > 0 ? 'failed' : 'success'));
    const failNote =
      status === 'failed' && s.last_error_title ? ` — ${String(s.last_error_title)}` : '';
    return `[${status}] ${String(s.session_id)} · ${String(s.agent_name ?? 'unknown')} · ${Number(
      s.total_steps ?? 0
    )} steps${failNote}`;
  });
  return [`${sessions.length} of ${Number(data.total ?? sessions.length)} sessions:`, ...lines].join('\n');
}

export function formatClusters(data: Json): string {
  const clusters = (data.clusters as Json[] | undefined) ?? [];
  if (clusters.length === 0) return 'No failure clusters in this window. Clean runs!';
  const lines = clusters.map((c, i) => {
    const parts = [
      `${i + 1}. ${String(c.title ?? c.cluster_key ?? 'cluster')} — ${Number(
        c.affected_sessions ?? 0
      )} sessions`,
    ];
    if (c.root_cause) parts.push(`   Root cause: ${String(c.root_cause)}`);
    if (c.fix_hint) parts.push(`   Fix: ${String(c.fix_hint)}`);
    return parts.join('\n');
  });
  return [
    `${clusters.length} failure clusters (${Number(data.total_failed_sessions ?? 0)} failed sessions):`,
    ...lines,
  ].join('\n');
}

// ── Tools ─────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'why_did_my_last_run_fail',
    description:
      "Get the diagnosis for the agent's most recent failed run: root cause, the exact fix, and the step where it broke. Start here when an agent is misbehaving.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_session_diagnosis',
    description:
      'Full diagnosis and step replay summary for one Vorlo session id (root cause, fix, confidence, every step with status and latency).',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'string', description: 'The Vorlo session id' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_recent_sessions',
    description:
      'List recent agent runs traced by Vorlo, optionally filtered by status (all | failed | success | running).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'failed', 'success', 'running'] },
        page: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_failure_clusters',
    description:
      'Failures grouped by root cause across recent sessions — fix the pattern, not the symptom. Optionally set the lookback window in days (1-30).',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 30 } },
      additionalProperties: false,
    },
  },
];

export async function callTool(name: string, args: Json): Promise<string> {
  switch (name) {
    case 'why_did_my_last_run_fail': {
      const list = await vorloGet('/v1/sessions?page=1&status=failed');
      const sessions = (list.sessions as Json[] | undefined) ?? [];
      const latest = sessions[0];
      if (!latest) return 'No failed runs found — the most recent sessions all succeeded.';
      const detail = await vorloGet(`/v1/sessions/${String(latest.session_id)}`);
      return formatSessionDiagnosis(detail);
    }
    case 'get_session_diagnosis': {
      const sessionId = String(args.session_id ?? '');
      if (!sessionId) throw new Error('session_id is required');
      const detail = await vorloGet(`/v1/sessions/${encodeURIComponent(sessionId)}`);
      return formatSessionDiagnosis(detail);
    }
    case 'list_recent_sessions': {
      const status = typeof args.status === 'string' ? args.status : 'all';
      const page = Number(args.page ?? 1) || 1;
      const list = await vorloGet(`/v1/sessions?page=${page}&status=${encodeURIComponent(status)}`);
      return formatSessionList(list);
    }
    case 'get_failure_clusters': {
      const days = Number(args.days ?? 7) || 7;
      const data = await vorloGet(`/v1/sessions/failure-clusters?days=${days}`);
      return formatClusters(data);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── JSON-RPC 2.0 over stdio (newline-delimited) ──────────────────────────

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Json;
}

function send(message: Json): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: number | string | null, result: Json): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

export async function handleMessage(msg: RpcRequest): Promise<void> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case 'initialize': {
      const requested = (msg.params?.protocolVersion as string) || '2024-11-05';
      reply(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments as Json) ?? {};
      try {
        const text = await callTool(name, args);
        reply(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        // Tool-level failures are results, not protocol errors
        reply(id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
      return;
    }
    default:
      if (!isNotification) replyError(id, -32601, `Method not found: ${msg.method}`);
  }
}

function main(): void {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          void handleMessage(JSON.parse(line) as RpcRequest);
        } catch {
          // Unparseable line — JSON-RPC says respond with parse error (no id)
          replyError(null, -32700, 'Parse error');
        }
      }
      newline = buffer.indexOf('\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// Only start the stdio loop when run as a bin, not when imported by tests.
if (process.argv[1] && /mcp\.(js|ts)$/.test(process.argv[1])) {
  main();
}
