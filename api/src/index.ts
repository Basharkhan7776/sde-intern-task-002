import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { z } from 'zod'

type WorkerEnv = Env & {
  REDIS_REST_URL?: string
  REDIS_REST_TOKEN?: string
  RATE_LIMIT_DISABLED?: string
}

const app = new Hono<{ Bindings: WorkerEnv }>()

const API_TIMEOUT_MS = 10_000
const REDIS_TIMEOUT_MS = 2_000
const RATE_LIMIT = 100
const WINDOW_MS = 60_000

app.use('/api/*', async (c, next) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timedOut = await Promise.race([
      next(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), API_TIMEOUT_MS)
      }),
    ])
    if (timedOut === true) return c.json({ error: 'Request timed out' }, 504)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
})

app.use('/api/*', async (c, next) => {
  if (c.env.RATE_LIMIT_DISABLED === 'true') return next()
  const url = c.env.REDIS_REST_URL
  const token = c.env.REDIS_REST_TOKEN
  if (!url || !token) return c.json({ error: 'Rate limiter is unavailable' }, 503)

  const ip = c.req.header('CF-Connecting-IP')?.trim()
  if (!ip) return c.json({ error: 'Client IP is unavailable' }, 503)
  const key = `bill-splitter:rate:${ip}`
  const now = Date.now()
  const script =
    "local now=tonumber(ARGV[1]); local cutoff=now-tonumber(ARGV[2]); redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff); local count=redis.call('ZCARD', KEYS[1]); local limit=tonumber(ARGV[3]); if count >= limit then local oldest=redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES'); return {0, count, math.max(1, tonumber(oldest[2])+tonumber(ARGV[2])-now)}; end; redis.call('ZADD', KEYS[1], now, ARGV[4]); redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2])); return {1, count+1, 0}"
  let limitResult: number[]
  try {
    const redisResponse = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        'EVAL',
        script,
        '1',
        key,
        String(now),
        String(WINDOW_MS),
        String(RATE_LIMIT),
        `${now}:${crypto.randomUUID()}`,
      ]),
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    })
    if (!redisResponse.ok) throw new Error(`Redis returned ${redisResponse.status}`)
    const payload: unknown = await redisResponse.json()
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('result' in payload) ||
      !Array.isArray(payload.result) ||
      payload.result.length < 3 ||
      !payload.result.every((value) => typeof value === 'number')
    )
      throw new Error('Redis returned an invalid rate-limit result')
    limitResult = payload.result
  } catch (error) {
    console.error('Rate limiter request failed', error)
    return c.json({ error: 'Rate limiter is unavailable' }, 503)
  }
  if (limitResult[0] === 0) {
    const retryAfter = Math.max(1, Math.ceil((limitResult[2] ?? 1000) / 1000))
    return c.json({ error: 'Rate limit exceeded' }, 429, { 'Retry-After': String(retryAfter) })
  }
  return next()
})

app.get('/api/health', (c) => c.json({ status: 'ok' }))

const fail = (
  c: Context<{ Bindings: WorkerEnv }>,
  status: 400 | 404 | 409 | 422,
  message: string,
) => c.json({ error: message }, status)
const id = () => crypto.randomUUID()
type MemberRow = { id: string; home_id: string; name: string }
type ShareRow = {
  id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
}

const homeBodySchema = z.object({ name: z.string().trim().min(1) })
const memberBodySchema = z.object({ name: z.string().trim().min(1) })
const billBodySchema = z.object({
  title: z.string().trim().min(1),
  totalCents: z.number().int().safe().positive(),
})
const homeParamsSchema = z.object({ homeId: z.string().min(1) })
const payParamsSchema = z.object({ billId: z.string().min(1), shareId: z.string().min(1) })
const payHeadersSchema = z.object({ 'idempotency-key': z.string().trim().min(1) })

const invalidRequest = (message: string) => ({ error: message })

app.post(
  '/api/homes',
  zValidator('json', homeBodySchema, (result, c) => {
    if (!result.success) return c.json(invalidRequest('A home name is required'), 422)
  }),
  async (c) => {
    const body = c.req.valid('json')
    const home = { id: id(), name: body.name }
    await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
      .bind(home.id, home.name)
      .run()
    return c.json(home, 201)
  },
)

app.post(
  '/api/homes/:homeId/members',
  zValidator('param', homeParamsSchema, (result, c) => {
    if (!result.success) return c.json(invalidRequest('Invalid home ID'), 400)
  }),
  zValidator('json', memberBodySchema, (result, c) => {
    if (!result.success) return c.json(invalidRequest('A member name is required'), 422)
  }),
  async (c) => {
    const { homeId } = c.req.valid('param')
    if (!(await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()))
      return fail(c, 404, 'Home not found')
    const body = c.req.valid('json')
    const member = { id: id(), homeId, name: body.name }
    await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
      .bind(member.id, homeId, member.name)
      .run()
    return c.json(member, 201)
  },
)

app.post(
  '/api/homes/:homeId/bills',
  zValidator('param', homeParamsSchema, (result, c) => {
    if (!result.success) return c.json(invalidRequest('Invalid home ID'), 400)
  }),
  zValidator('json', billBodySchema, (result, c) => {
    if (!result.success)
      return c.json(invalidRequest('A title and positive whole-cent amount are required'), 422)
  }),
  async (c) => {
    const { homeId } = c.req.valid('param')
    if (!(await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()))
      return fail(c, 404, 'Home not found')
    const body = c.req.valid('json')
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
  },
)

app.post(
  '/api/bills/:billId/shares/:shareId/pay',
  zValidator('param', payParamsSchema, (result, c) => {
    if (!result.success) return c.json(invalidRequest('Invalid bill or share ID'), 400)
  }),
  zValidator('header', payHeadersSchema, (result, c) => {
    if (!result.success) return c.json(invalidRequest('Idempotency-Key header is required'), 400)
  }),
  async (c) => {
    const { 'idempotency-key': key } = c.req.valid('header')
    const { billId, shareId } = c.req.valid('param')
    const bill = await c.env.DB.prepare('SELECT id FROM bills WHERE id = ?').bind(billId).first()
    if (!bill) return fail(c, 404, 'Bill not found')
    const paidAt = new Date().toISOString()
    const updated = await c.env.DB.prepare(
      'UPDATE shares SET paid_at = ?1, idempotency_key = ?2 WHERE id = ?3 AND bill_id = ?4 AND paid_at IS NULL RETURNING id, member_id AS memberId, amount_cents AS amountCents, paid_at AS paidAt',
    )
      .bind(paidAt, key, shareId, billId)
      .first<{ id: string; memberId: string; amountCents: number; paidAt: string }>()
    if (updated) return c.json(updated)

    const current = await c.env.DB.prepare(
      'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
    )
      .bind(shareId, billId)
      .first<ShareRow>()
    if (!current) return fail(c, 404, 'Share not found')
    if (current.idempotency_key !== key) return fail(c, 409, 'Share was already paid')
    return c.json({
      id: current.id,
      memberId: current.member_id,
      amountCents: current.amount_cents,
      paidAt: current.paid_at,
    })
  },
)

app.get(
  '/api/homes/:homeId/balances',
  zValidator('param', homeParamsSchema, (result, c) => {
    if (!result.success) return c.json(invalidRequest('Invalid home ID'), 400)
  }),
  async (c) => {
    const { homeId } = c.req.valid('param')
    if (!(await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()))
      return fail(c, 404, 'Home not found')
    const result = await c.env.DB.prepare(
      'SELECT m.id AS memberId, m.name, COALESCE(SUM(CASE WHEN s.paid_at IS NULL THEN s.amount_cents ELSE 0 END), 0) AS outstandingCents FROM members m LEFT JOIN shares s ON s.member_id = m.id LEFT JOIN bills b ON b.id = s.bill_id AND b.home_id = m.home_id WHERE m.home_id = ? GROUP BY m.id ORDER BY m.sequence',
    )
      .bind(homeId)
      .all()
    return c.json({ balances: result.results })
  },
)

app.get(
  '/api/homes/:homeId/bills',
  zValidator('param', homeParamsSchema, (result, c) => {
    if (!result.success) return c.json(invalidRequest('Invalid home ID'), 400)
  }),
  async (c) => {
    const { homeId } = c.req.valid('param')
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
  },
)

app.onError((error, c) => {
  console.error(error)
  return c.json({ error: 'Internal server error' }, 500)
})
app.notFound((c) => c.json({ error: 'Not found' }, 404))

export default app
