import { describe, expect, test } from 'bun:test'
import { COINS } from '@profullstack/coinpay-onboard'
import { PayAgent } from '../src/service.ts'

const all = COINS.map((c) => c.id)

describe('recheck message', () => {
  test('no change says so and names the coin a new wallet would add', () => {
    const have = all.filter((c) => c !== 'usdc_base')
    const m = PayAgent.recheckMessage(have, have)
    expect(m).toContain(`no change, your link still takes ${have.length} coins`)
    expect(m).toContain('To take USDC on Base too')
  })

  test('names what was added and dropped', () => {
    const m = PayAgent.recheckMessage(['btc', 'eth'], ['btc', 'sol'])
    expect(m).toContain('Added Solana.')
    expect(m).toContain('Dropped Ether')
  })

  test('every coin and no change: nothing to add', () => {
    expect(PayAgent.recheckMessage(all, all)).not.toContain('To take')
  })

  test('no wallets at all', () => {
    expect(PayAgent.recheckMessage([], [])).toContain('still no payout wallet')
  })
})
