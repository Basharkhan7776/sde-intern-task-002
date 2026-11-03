import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'

export const Route = createFileRoute('/')({ component: Home })

type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }
type Bill = { id: string; title: string; totalCents: number; shares: Share[] }
type Member = { memberId: string; name: string }

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok)
    throw new Error(
      typeof body === 'object' && body !== null && 'error' in body
        ? String(body.error)
        : 'Request failed',
    )
  return body as T
}

function Home() {
  const [homeId, setHomeId] = useState('')
  const [input, setInput] = useState('')
  const [bills, setBills] = useState<Bill[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [paying, setPaying] = useState<string | null>(null)

  const load = useCallback(async (id: string) => {
    setLoading(true)
    setError('')
    try {
      const [billData, balanceData] = await Promise.all([
        getJson<{ bills: Bill[] }>(`/api/homes/${encodeURIComponent(id)}/bills`),
        getJson<{ balances: Member[] }>(`/api/homes/${encodeURIComponent(id)}/balances`),
      ])
      setBills(billData.bills)
      setNames(
        Object.fromEntries(balanceData.balances.map((member) => [member.memberId, member.name])),
      )
      setHomeId(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this home')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const saved = localStorage.getItem('bill-splitter-home')
    if (saved) {
      setInput(saved)
      void load(saved)
    }
  }, [load])

  async function pay(billId: string, shareId: string) {
    setPaying(shareId)
    setError('')
    try {
      const response = await fetch(`/api/bills/${billId}/shares/${shareId}/pay`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok)
        throw new Error(
          typeof body === 'object' && body !== null && 'error' in body
            ? String(body.error)
            : 'Payment failed',
        )
      await load(homeId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payment failed')
    } finally {
      setPaying(null)
    }
  }

  return (
    <main
      style={{
        maxWidth: 760,
        margin: '48px auto',
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        color: '#17232c',
      }}
    >
      <h1>Shared bills</h1>
      <p>Enter a home ID to see its bills and outstanding shares.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          localStorage.setItem('bill-splitter-home', input.trim())
          void load(input.trim())
        }}
        style={{ display: 'flex', gap: 8 }}
      >
        <input
          aria-label="Home ID"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Home ID"
          style={{ flex: 1, padding: 12 }}
        />
        <button type="submit" disabled={!input.trim() || loading} style={{ padding: '0 18px' }}>
          Open home
        </button>
      </form>
      {loading && <p role="status">Loading bills…</p>}
      {error && (
        <p role="alert" style={{ color: '#a32626' }}>
          {error}
        </p>
      )}
      {!loading && homeId && bills.length === 0 && !error && <p>No bills for this home yet.</p>}
      {!loading &&
        bills.map((bill) => (
          <section
            key={bill.id}
            style={{ border: '1px solid #d9e0e4', borderRadius: 12, padding: 20, marginTop: 20 }}
          >
            <h2>{bill.title}</h2>
            <p>Total: ${(bill.totalCents / 100).toFixed(2)}</p>
            <ul style={{ padding: 0, listStyle: 'none' }}>
              {bill.shares.map((share) => (
                <li
                  key={share.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '10px 0',
                    borderTop: '1px solid #edf0f2',
                  }}
                >
                  <span>
                    {names[share.memberId] ?? 'Member'} · ${(share.amountCents / 100).toFixed(2)}
                  </span>
                  {share.paidAt ? (
                    <span>Paid</span>
                  ) : (
                    <button
                      type="button"
                      disabled={paying !== null}
                      onClick={() => void pay(bill.id, share.id)}
                    >
                      {paying === share.id ? 'Paying…' : 'Pay share'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
    </main>
  )
}
