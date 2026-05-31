/**
 * End-to-end check for vorlo-trace against a LIVE Vorlo server.
 *
 * This does NOT mock callbacks — it drives real @langchain/core primitives so
 * the framework itself dispatches handleToolStart/End/Error and handleChain*.
 * That is the only way to prove our callback signatures match LangChain.js at
 * runtime (the unit tests call the methods directly with assumed arguments).
 *
 * A parent RunnableLambda invokes child tools with the inherited config so
 * parent_run_id is real — this is what exercises parent_span_id linkage.
 *
 * Usage:
 *   VORLO_API_KEY=vrlo_... \
 *   VORLO_SERVER_URL=https://vorlo-server-production.up.railway.app \
 *   VORLO_DEBUG=1 \
 *     node --import tsx examples/run_real_agents.ts
 */
import { RunnableLambda } from '@langchain/core/runnables';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import * as vorlo from '../src/index.js';

async function main(): Promise<void> {
  if (!process.env.VORLO_API_KEY) {
    console.error('VORLO_API_KEY not set — nothing to run.');
    process.exit(2);
  }

  // ── Tools (sensors + actuators, one of which fails) ──────────────────
  const getBalance = tool(async () => 'balance: $4,210.00', {
    name: 'get_account_balance',
    description: 'Read the current account balance',
    schema: z.object({ account: z.string().optional() }),
  });

  const searchInvoices = tool(async () => '[{"id":"inv_1","amount":120}]', {
    name: 'search_invoices',
    description: 'Search invoices',
    schema: z.object({ query: z.string().optional() }),
  });

  const chargeCard = tool(
    async () => {
      // Simulate a real upstream auth failure with an HTTP status in the message.
      throw new Error('StripeError: HTTP 401 Invalid API key provided — authentication failed');
    },
    {
      name: 'charge_card',
      description: 'Charge a customer card',
      schema: z.object({ amount: z.number().optional() }),
    },
  );

  // Long-tail failure the static registry can NOT match → should land as
  // unknown_error and (once the server LLM fallback is live) get enriched.
  const qdrantUpsert = tool(
    async () => {
      throw new Error(
        "QdrantException: Wrong vector dimension: collection 'embeddings' expects " +
          'vectors of size 768 but got 512. Reindex or pad the embeddings.',
      );
    },
    {
      name: 'qdrant_upsert',
      description: 'Upsert vectors into a Qdrant collection',
      schema: z.object({ collection: z.string().optional() }),
    },
  );

  // Parent "agent": calls children with the inherited config so parent_run_id
  // is propagated → parent_span_id linkage is exercised end-to-end.
  const agent = RunnableLambda.from(async (_input: unknown, config) => {
    await getBalance.invoke({ account: 'acct_1' }, config);
    await searchInvoices.invoke({ query: 'unpaid' }, config);
    try {
      await chargeCard.invoke({ amount: 120 }, config);
    } catch {
      /* expected — registry-matched 401 diagnosis */
    }
    try {
      await qdrantUpsert.invoke({ collection: 'embeddings' }, config);
    } catch {
      /* expected — long-tail unknown_error → server LLM path */
    }
    return 'done';
  });

  const handler = vorlo.init({ agentName: 'ts-e2e-payment-agent' });
  console.log('session_id:', handler.sessionId, 'agent:', handler.agentName);

  await agent.invoke({ input: 'reconcile and charge' }, { callbacks: [handler] });
  await handler.flush();

  console.log('Done. Check the dashboard for session', handler.sessionId);
}

main().catch((e) => {
  console.error('runner error', e);
  process.exit(1);
});
