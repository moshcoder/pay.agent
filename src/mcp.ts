/**
 * `payagent mcp`: pay.agent for an agent, on stdio.
 *
 *   claude mcp add payagent -- bunx @profullstack/payagent mcp
 *
 * Paying needs no key: ask for a payment, send the exact amount to the address,
 * then check it. PAYAGENT_KEY (pa_…) adds `my_payments`, `send_invoice` and `my_invoices`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { PayAgentClient } from './client.js'
import { VERSION } from './version.js'

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] })
const handle = z.string().min(2).max(31).describe('A pay.agent handle, e.g. alice (pay.agent/alice)')

export function createMcpServer(client = new PayAgentClient()): McpServer {
  const server: any = new McpServer({ name: 'pay.agent', version: VERSION })
  server.tool('lookup', 'Who a pay.agent handle belongs to and which coins they take.', { handle }, async ({ handle }: { handle: string }) => {
    try { return text(await client.user(handle)) } catch (e) { return failure(e) }
  })
  server.tool(
    'request_payment',
    'Start paying a pay.agent handle: returns the address and the EXACT crypto amount to send, valid for an hour. Send it from a wallet you control, then call payment_status.',
    { handle, amount_usd: z.number().min(0.5).max(10000), coin: z.string().optional().describe('e.g. usdc_sol, usdc_base, btc, eth; default: their first'), note: z.string().max(140).optional() },
    async ({ handle, amount_usd, coin, note }: { handle: string; amount_usd: number; coin?: string; note?: string }) => {
      try { return text(await client.pay(handle, amount_usd, coin, note)) } catch (e) { return failure(e) }
    },
  )
  server.tool('payment_status', 'A payment\'s status: pending, detected, confirmed, forwarded (paid), expired or failed.', { payment_id: z.string().min(1) }, async ({ payment_id }: { payment_id: string }) => {
    try { return text(await client.payment(payment_id)) } catch (e) { return failure(e) }
  })
  server.tool('my_payments', 'Your own pay.agent link and the payments made to it (needs PAYAGENT_KEY).', {}, async () => {
    try { return text(await client.me()) } catch (e) { return failure(e) }
  })
  server.tool(
    'send_invoice',
    'Send an invoice from your pay.agent link (needs PAYAGENT_KEY). CoinPay emails the payer a link to pay the exact amount in crypto; recurrence makes CoinPay send the next ones itself.',
    {
      to_email: z.string().email(),
      to_name: z.string().max(80).optional(),
      description: z.string().min(1).max(500),
      amount_usd: z.number().min(0.5).max(10000),
      coin: z.string().optional().describe('e.g. usdc_sol; default: your first'),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      recurrence: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']).optional(),
      email: z.boolean().optional().describe('false: make the pay link without emailing it'),
    },
    async (input: any) => {
      try { return text(await client.invoice(input)) } catch (e) { return failure(e) }
    },
  )
  server.tool('invoice_status', 'An invoice\'s status (sent, paid, overdue) and, while open, the address and exact amount.', { invoice_id: z.string().min(1) }, async ({ invoice_id }: { invoice_id: string }) => {
    try { return text(await client.invoiceStatus(invoice_id)) } catch (e) { return failure(e) }
  })
  server.tool('my_invoices', 'Invoices you sent from your pay.agent link (needs PAYAGENT_KEY).', {}, async () => {
    try { return text(await client.invoices()) } catch (e) { return failure(e) }
  })
  return server
}

export async function runMcp(client = new PayAgentClient()): Promise<void> {
  await createMcpServer(client).connect(new StdioServerTransport())
}
