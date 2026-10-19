import { expect, it } from 'bun:test'
import { homePage } from '../src/html.ts'
import { ringDescriptor } from '../src/ring-footer.ts'

it('Profullstack ring footer: server-rendered, one footer, before the pit.world footer', () => {
  const html = homePage({ user: null, origin: 'https://pay.agent', csrf: 'x' })
  const from = encodeURIComponent('https://pay.agent.pit.world/')
  expect(html).toContain(`https://rssamplifier.com/ring/profullstack/previous?from=${from}`)
  expect(html).toContain(`https://rssamplifier.com/ring/profullstack/next?from=${from}`)
  expect(html.match(/<footer/g)?.length).toBe(1)
  expect(html).toMatch(/class="pfs-footer"[\s\S]*<\/footer>\s*(<style|<nav class="pit-foot"|<\/body>)/)
})

it('openwebring descriptor names the ring', () => {
  const d = ringDescriptor()
  expect(d.site.url).toBe('https://pay.agent.pit.world/')
  expect(d.rings[0]!.ring).toBe('https://rssamplifier.com/ring/profullstack')
})
