/**
 * `payagent mcp`: pay.agent for an agent, on stdio.
 *
 *   claude mcp add payagent -- bunx @profullstack/payagent mcp
 *
 * Paying needs no key: ask for a payment, pay it at the CoinPay checkout URL it
 * returns, then check it. PAYAGENT_KEY (pa_…) adds `my_payments`, `send_invoice`, `my_invoices`
 * and the webhook tools (`list_webhooks`, `create_webhook`, ...).
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
    'Start paying a pay.agent handle: returns checkout_url, a CoinPay hosted checkout open for an hour where the payer picks any coin the payee takes (or PayPal) and gets the exact amount and address. Pay it there, then call payment_status.',
    { handle, amount_usd: z.number().min(0.5).max(10000), payer_email: z.string().email().describe('The payer\'s email: CoinPay sends the receipt there'), note: z.string().max(140).optional() },
    async ({ handle, amount_usd, payer_email, note }: { handle: string; amount_usd: number; payer_email: string; note?: string }) => {
      try { return text(await client.pay(handle, amount_usd, payer_email, note)) } catch (e) { return failure(e) }
    },
  )
  server.tool('payment_status', 'A payment\'s status: pending, confirmed, forwarded or completed (paid), expired or failed.', { payment_id: z.string().min(1) }, async ({ payment_id }: { payment_id: string }) => {
    try { return text(await client.payment(payment_id)) } catch (e) { return failure(e) }
  })
  server.tool(
    'claim',
    'Claim your own pay.agent link with no browser, or get a new API key for the one you have. Signs in to CoinPay with COINPAY_TOKEN or COINPAY_EMAIL + COINPAY_PASSWORD from the environment and approves pay.agent as you (it can never move your funds). Returns the link and a pa_ key: set it as PAYAGENT_KEY.',
    { handle: handle.optional().describe('The handle to claim; leave out to get a new key for the one you have'), business_id: z.string().optional().describe('Take payments into this CoinPay business of yours instead of a new pay.agent one') },
    async ({ handle, business_id }: { handle?: string; business_id?: string }) => {
      try { return text(await client.claim({ ...(handle ? { handle } : {}), ...(business_id ? { mode: 'business' as const, businessId: business_id } : {}) })) } catch (e) { return failure(e) }
    },
  )
  server.tool(
    'my_coins',
    'What your pay.agent link takes (needs PAYAGENT_KEY): coins payers can use, card (PayPal and cards on the checkout), payable (coins with a CoinPay wallet) and accepts (your pick). Set coins (ids like usdc_base, usdc_sol, sol, or paypal, or "all") to choose; add_stablecoins adds USDC on Base, Polygon and Solana at addresses you already have.',
    { coins: z.union([z.array(z.string()), z.literal('all')]).optional(), add_stablecoins: z.boolean().optional(), recheck: z.boolean().optional() },
    async ({ coins, add_stablecoins, recheck }: { coins?: string[] | 'all'; add_stablecoins?: boolean; recheck?: boolean }) => {
      try {
        return text(coins || add_stablecoins || recheck ? await client.setCoins({ ...(coins ? { coins } : {}), ...(add_stablecoins ? { addStablecoins: true } : {}), ...(recheck ? { recheck: true } : {}) }) : await client.coins())
      } catch (e) { return failure(e) }
    },
  )
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
  server.tool('list_webhooks', 'Your webhook endpoints and the event types pay.agent sends (needs PAYAGENT_KEY).', {}, async () => {
    try { return text(await client.webhooks()) } catch (e) { return failure(e) }
  })
  server.tool(
    'create_webhook',
    'Have pay.agent POST your link\'s events (payment.created, payment.paid, payment.expired, payment.failed, invoice.created, invoice.paid, invoice.overdue, invoice.cancelled) to a URL as signed CloudEvents (Standard Webhooks). Returns the signing secret. events: patterns like "payment.*"; omit for all. Needs PAYAGENT_KEY.',
    { url: z.string().url(), events: z.array(z.string()).optional(), description: z.string().max(200).optional() },
    async ({ url, events, description }: { url: string; events?: string[]; description?: string }) => {
      try { return text(await client.addWebhook(url, events, description ?? '')) } catch (e) { return failure(e) }
    },
  )
  server.tool('test_webhook', 'Send a webhook.test event to one of your endpoints now.', { id: z.string().min(1) }, async ({ id }: { id: string }) => {
    try { return text(await client.testWebhook(id)) } catch (e) { return failure(e) }
  })
  server.tool('rotate_webhook_secret', 'Replace an endpoint\'s signing secret; the old one stops working.', { id: z.string().min(1) }, async ({ id }: { id: string }) => {
    try { return text(await client.rotateWebhook(id)) } catch (e) { return failure(e) }
  })
  server.tool('delete_webhook', 'Remove a webhook endpoint.', { id: z.string().min(1) }, async ({ id }: { id: string }) => {
    try { return text(await client.removeWebhook(id)) } catch (e) { return failure(e) }
  })
  server.tool('webhook_deliveries', 'Recent webhook deliveries, optionally for one endpoint.', { id: z.string().optional() }, async ({ id }: { id?: string }) => {
    try { return text(await client.webhookLog(id)) } catch (e) { return failure(e) }
  })
  return server
}

export async function runMcp(client = new PayAgentClient()): Promise<void> {
  await createMcpServer(client).connect(new StdioServerTransport())
}
