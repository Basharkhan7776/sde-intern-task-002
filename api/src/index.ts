import { type Context, Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ status: 'ok' }))

const fail = (c: Context<{ Bindings: Env }>, status: 400 | 404 | 409 | 422, message: string) =>
  c.json({ error: message }, status)
const id = () => crypto.randomUUID()
type MemberRow = { id: string; home_id: string; name: string }
type ShareRow = {
  id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
}

app.post('/api/homes', async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch((): { name?: unknown } => ({}))
  if (typeof body.name !== 'string' || !body.name.trim())
    return fail(c, 422, 'A home name is required')
  const home = { id: id(), name: body.name.trim() }
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
    .bind(home.id, home.name)
    .run()
  return c.json(home, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()))
    return fail(c, 404, 'Home not found')
  const body = await c.req.json<{ name?: unknown }>().catch((): { name?: unknown } => ({}))
  if (typeof body.name !== 'string' || !body.name.trim())
    return fail(c, 422, 'A member name is required')
  const member = { id: id(), homeId, name: body.name.trim() }
  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(member.id, homeId, member.name)
    .run()
  return c.json(member, 201)
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()))
    return fail(c, 404, 'Home not found')
  const body = await c.req
    .json<{ title?: unknown; totalCents?: unknown }>()
    .catch((): { title?: unknown; totalCents?: unknown } => ({}))
  if (
    typeof body.title !== 'string' ||
    !body.title.trim() ||
    typeof body.totalCents !== 'number' ||
    !Number.isSafeInteger(body.totalCents) ||
    body.totalCents <= 0
  )
    return fail(c, 422, 'A title and positive whole-cent amount are required')
  const members = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY sequence',
  )
    .bind(homeId)
    .all<MemberRow>()
  if (!members.results.length) return fail(c, 422, 'The home has no members')
  const billId = id()
  const title = body.title.trim()
  const base = Math.floor(body.totalCents / members.results.length)
  const extra = body.totalCents % members.results.length
  const shares = members.results.map((member, index) => ({
    id: id(),
    memberId: member.id,
    amountCents: base + (index < extra ? 1 : 0),
    paidAt: null,
  }))
  const statements = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, title, body.totalCents),
    ...shares.map((share) =>
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(share.id, billId, share.memberId, share.amountCents),
    ),
  ]
  await c.env.DB.batch(statements)
  return c.json({ id: billId, homeId, title, totalCents: body.totalCents, shares }, 201)
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const key = c.req.header('Idempotency-Key')
  if (!key?.trim()) return fail(c, 400, 'Idempotency-Key header is required')
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const bill = await c.env.DB.prepare('SELECT id FROM bills WHERE id = ?').bind(billId).first()
  if (!bill) return fail(c, 404, 'Bill not found')
  const share = await c.env.DB.prepare(
    'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
  )
    .bind(shareId, billId)
    .first<ShareRow>()
  if (!share) return fail(c, 404, 'Share not found')
  if (share.paid_at) {
    if (share.idempotency_key === key)
      return c.json({
        id: share.id,
        memberId: share.member_id,
        amountCents: share.amount_cents,
        paidAt: share.paid_at,
      })
    return fail(c, 409, 'Share was already paid')
  }
  const paidAt = new Date().toISOString()
  const result = await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND paid_at IS NULL',
  )
    .bind(paidAt, key, shareId)
    .run()
  const current = await c.env.DB.prepare(
    'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ?',
  )
    .bind(shareId)
    .first<ShareRow>()
  if (!current) return fail(c, 404, 'Share not found')
  if (result.meta.changes === 0 && current.idempotency_key !== key)
    return fail(c, 409, 'Share was already paid')
  return c.json({
    id: current.id,
    memberId: current.member_id,
    amountCents: current.amount_cents,
    paidAt: current.paid_at,
  })
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()))
    return fail(c, 404, 'Home not found')
  const result = await c.env.DB.prepare(
    'SELECT m.id AS memberId, m.name, COALESCE(SUM(CASE WHEN s.paid_at IS NULL THEN s.amount_cents ELSE 0 END), 0) AS outstandingCents FROM members m LEFT JOIN shares s ON s.member_id = m.id LEFT JOIN bills b ON b.id = s.bill_id AND b.home_id = m.home_id WHERE m.home_id = ? GROUP BY m.id ORDER BY m.sequence',
  )
    .bind(homeId)
    .all()
  return c.json({ balances: result.results })
})

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()))
    return fail(c, 404, 'Home not found')
  const bills = await c.env.DB.prepare(
    'SELECT id, home_id, title, total_cents FROM bills WHERE home_id = ? ORDER BY rowid DESC',
  )
    .bind(homeId)
    .all<{ id: string; home_id: string; title: string; total_cents: number }>()
  const items = await Promise.all(
    bills.results.map(async (bill) => {
      const shares = await c.env.DB.prepare(
        'SELECT id, member_id AS memberId, amount_cents AS amountCents, paid_at AS paidAt FROM shares WHERE bill_id = ? ORDER BY rowid',
      )
        .bind(bill.id)
        .all()
      return {
        id: bill.id,
        homeId: bill.home_id,
        title: bill.title,
        totalCents: bill.total_cents,
        shares: shares.results,
      }
    }),
  )
  return c.json({ bills: items })
})

app.onError((error, c) => {
  console.error(error)
  return c.json({ error: 'Internal server error' }, 500)
})
app.notFound((c) => c.json({ error: 'Not found' }, 404))

export default app
