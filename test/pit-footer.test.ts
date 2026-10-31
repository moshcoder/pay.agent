import { expect, it } from 'bun:test'
import { homePage } from '../src/html.ts'

it('the universal footer is the only footer on pay.agent pages', () => {
  const html = homePage({ user: null, origin: 'https://pay.agent', csrf: 'x' })
  expect(html.match(/<footer/g)?.length).toBe(1)
  expect(html).toContain('class="pfs-footer"')
  expect(html).not.toContain('data-pit-footer')
  expect(html).toMatch(/class="pfs-footer"[\s\S]*<\/footer>\s*<\/body>/)
})
