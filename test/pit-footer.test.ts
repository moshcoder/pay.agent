import { expect, it } from 'bun:test'
import { pitFooter, setPitFooter, startPitFooterRefresh } from "../src/pit-footer.ts"
import { homePage } from "../src/html.ts"

it('pit.world footer: nothing until read, then the last thing in <body>, kept on failure', async () => {
  expect(setPitFooter('<p>not the footer</p>')).toBe(false)
  expect(pitFooter()).toBe('')
  const frag = '<style>.pit-foot{}</style><nav class="pit-foot" data-pit-footer>x</nav>'
  const stop = startPitFooterRefresh('pay.agent', (async (url: string) => {
    expect(url).toBe('https://pit.world/snippets/footer.html?site=pay.agent')
    return new Response(frag)
  }) as unknown as typeof fetch)
  await new Promise((r) => setTimeout(r, 10))
  stop()
  const html = homePage({ user: null, origin: 'https://pay.agent', csrf: 'x' })
  expect(html.match(/data-pit-footer/g)?.length).toBe(1)
  expect(html).toMatch(/<\/footer>[\s\S]*data-pit-footer[\s\S]*<\/nav>\s*<\/body>/)
  const stop2 = startPitFooterRefresh('pay.agent', (async () => { throw new Error('down') }) as unknown as typeof fetch)
  await new Promise((r) => setTimeout(r, 10))
  stop2()
  expect(pitFooter()).toContain('data-pit-footer')
})
