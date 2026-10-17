// pay.agent: copy buttons, and a payment page that follows its own status.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]')
  if (!b) return
  navigator.clipboard?.writeText(b.dataset.copy).then(() => {
    const was = b.textContent
    b.textContent = 'Copied'
    setTimeout(() => { b.textContent = was }, 1500)
  })
})
const status = document.getElementById('status')
if (status && status.dataset.payment) {
  const PAID = ['confirmed', 'forwarded', 'completed']
  const DONE = PAID.concat(['expired', 'failed', 'refunded'])
  const tick = async () => {
    try {
      const r = await fetch('/api/v1/payments/' + encodeURIComponent(status.dataset.payment), { cache: 'no-store' })
      if (r.ok) {
        const p = await r.json()
        const paid = PAID.includes(p.status)
        status.className = 'status ' + p.status
        status.textContent = paid ? 'paid' : p.status
        document.getElementById('pay-box').hidden = paid
        document.getElementById('paid-box').hidden = !paid
        if (DONE.includes(p.status)) return
      }
    } catch {}
    setTimeout(tick, 5000)
  }
  setTimeout(tick, 3000)
}
