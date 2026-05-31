# vorlo-trace

> "LangSmith tells you what your agent did. Langfuse shows you where it happened.
> **Vorlo tells you exactly WHY it failed and what to fix — in 30 seconds.**"

AI agent observability SDK for **LangChain.js / Node / Next.js**. Add 2 lines of code to see exactly which step of your agent failed, the plain-English root cause, and a specific fix hint.

This is the TypeScript counterpart to the Python [`vorlo-trace`](https://pypi.org/project/vorlo-trace/) package — same ingest contract, same dashboard.

## Quick Start

```bash
npm install vorlo-trace
```

```ts
import * as vorlo from 'vorlo-trace';
import { AgentExecutor } from 'langchain/agents';

// 1. Initialize Vorlo (or set VORLO_API_KEY env var)
vorlo.init({ apiKey: 'vrlo_your_key_here', agentName: 'my-agent' });

// 2. Add the handler to your agent
const result = await agentExecutor.invoke(
  { input: 'Check my latest emails' },
  { callbacks: [vorlo.getHandler()] },
);
```

That's it. Open [vorlo.dev](https://vorlo.dev) to see every step your agent took, with:

- **Step Replay** — chronological view of every tool call
- **Root Cause** — plain English explanation, not raw HTTP errors
- **Fix Hints** — specific, actionable steps to resolve the issue
- **LLM Reasoning** — why the agent made each decision

## What You See

**Without Vorlo:**
```
ToolError: 403
```

**With Vorlo:**
```
Stripe authentication failed.
The credentials used for 'stripe_charge' were rejected by the upstream service.
Fix: Check your Stripe API key in Settings → Integrations.
```

## How It Works

Vorlo implements LangChain.js's `BaseCallbackHandler`. It captures:

1. Every tool call (input, output, latency)
2. Every LLM reasoning step (chain of thought)
3. Every error (translated to plain English with fix hints)
4. Cross-step context (what data flowed between steps)

All sends are **fire-and-forget** — Vorlo never slows or crashes your agent, even if the Vorlo server is unreachable.

## Features

- **2-line integration** — works with any LangChain.js agent
- **Sensor/Actuator classification** — reads vs writes, clearly labeled
- **Cross-step root cause** — understands data flow between steps
- **OTel-compatible** — `trace_id`, `span_id`, `parent_span_id` for enterprise export
- **Zero impact** — async `fetch`, bounded in-flight queue, silent failures

## Convenience wrapper

```ts
import * as vorlo from 'vorlo-trace';

vorlo.init({ apiKey: 'vrlo_...' });
const out = await vorlo.trace(agentExecutor, { input: 'Check my latest emails' });
```

## Configuration

```ts
vorlo.init({
  apiKey: 'vrlo_...',          // or set VORLO_API_KEY env var
  serverUrl: 'https://...',    // or set VORLO_SERVER_URL env var
  agentName: 'order-processor' // shown in dashboard
});
```

## Environment Variables

| Variable | Description |
|---|---|
| `VORLO_API_KEY` | Your Vorlo API key |
| `VORLO_SERVER_URL` | Custom server URL (default: production) |
| `VORLO_DEBUG` | Set to `1` for debug logging to stderr |

## Requirements

- Node.js >= 18 (uses the global `fetch`)
- `@langchain/core` >= 0.1.0 (peer dependency)
- ESM only

## License

MIT — see [LICENSE](LICENSE)
