import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/server.ts'
import { Sealer, Store } from '../src/db.ts'

const store = new Store(':memory:', new Sealer('test-key-0123456789abcdef'))
const app = createApp({ store, key: 'test-key-0123456789abcdef', secureCookies: false, config: { coinpayBase: 'https://cp.test', clientId: 'cp_client', webhookOrigin: 'https://pay.agent.pit.world' } })

describe('crawler files', () => {
  test('through the pit.world relay they name pay.agent.pit.world', async () => {
    const headers = { host: 'pay.agent', 'x-forwarded-proto': 'https', 'x-moshpit-name': 'pay.agent' }
    const robots = await app.request('/robots.txt', { headers })
    expect(robots.status).toBe(200)
    expect(robots.headers.get('content-type')).toContain('text/plain')
    expect(await robots.text()).toContain('Sitemap: https://pay.agent.pit.world/sitemap.xml')
    const map = await app.request('/sitemap.xml', { headers })
    expect(map.status).toBe(200)
    expect(map.headers.get('content-type')).toContain('application/xml')
    const xml = await map.text()
    expect(xml).toContain('<loc>https://pay.agent.pit.world/</loc>')
    expect(xml).not.toMatch(/<loc>(?!https:\/\/pay\.agent\.pit\.world\/)/)
  })

  test('on Moshpit itself they name pay.agent', async () => {
    const headers = { host: 'pay.agent', 'x-forwarded-proto': 'https' }
    expect(await (await app.request('/robots.txt', { headers })).text()).toContain('Sitemap: https://pay.agent/sitemap.xml')
    const xml = await (await app.request('/sitemap.xml', { headers })).text()
    expect(xml).toContain('<loc>https://pay.agent/</loc>')
    expect(xml).not.toContain('.pit.world')
  })
})
