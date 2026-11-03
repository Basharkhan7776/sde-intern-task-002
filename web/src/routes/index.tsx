import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'

export const Route = createFileRoute('/')({ component: Home })

type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }
type Bill = { id: string; title: string; totalCents: number; shares: Share[] }
type Member = { memberId: string; name: string }

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(
      typeof body === 'object' && body !== null && 'error' in body
        ? String(body.error)
        : `Request failed (${response.status})`,
    )
  }
  if (body === null || typeof body !== 'object')
    throw new Error('The server returned an invalid response')
  return body as T
}

function Home() {
  const [homeId, setHomeId] = useState('')
  const [homeInput, setHomeInput] = useState('')
  const [homeName, setHomeName] = useState('')
  const [memberName, setMemberName] = useState('')
  const [billTitle, setBillTitle] = useState('')
  const [billAmount, setBillAmount] = useState('')
  const [bills, setBills] = useState<Bill[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [paying, setPaying] = useState<string | null>(null)

  const load = useCallback(async (id: string) => {
    setLoading(true)
    setError('')
    try {
      const [billData, balanceData] = await Promise.all([
        requestJson<{ bills: Bill[] }>(`/api/homes/${encodeURIComponent(id)}/bills`),
        requestJson<{ balances: Member[] }>(`/api/homes/${encodeURIComponent(id)}/balances`),
      ])
      setBills(billData.bills)
      setNames(
        Object.fromEntries(balanceData.balances.map((member) => [member.memberId, member.name])),
      )
      setHomeId(id)
      setHomeInput(id)
      localStorage.setItem('bill-splitter-home', id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this home')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const saved = localStorage.getItem('bill-splitter-home')
    if (saved) {
      setHomeInput(saved)
      void load(saved)
    }
  }, [load])

  async function createHome(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const created = await requestJson<{ id: string; name: string }>('/api/homes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: homeName }),
      })
      setHomeName('')
      await load(created.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create home')
    } finally {
      setBusy(false)
    }
  }

  async function addMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!homeId) return
    setBusy(true)
    setError('')
    try {
      await requestJson(`/api/homes/${encodeURIComponent(homeId)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: memberName }),
      })
      setMemberName('')
      await load(homeId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add member')
    } finally {
      setBusy(false)
    }
  }

  async function createBill(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!homeId) return
    const cents = Math.round(Number(billAmount) * 100)
    if (!Number.isSafeInteger(cents) || cents <= 0) {
      setError('Enter a bill amount greater than zero.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await requestJson(`/api/homes/${encodeURIComponent(homeId)}/bills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: billTitle, totalCents: cents }),
      })
      setBillTitle('')
      setBillAmount('')
      await load(homeId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create bill')
    } finally {
      setBusy(false)
    }
  }

  async function pay(billId: string, shareId: string) {
    setPaying(shareId)
    setError('')
    try {
      await requestJson(`/api/bills/${billId}/shares/${shareId}/pay`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
      await load(homeId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payment failed')
    } finally {
      setPaying(null)
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-5 py-12 text-foreground">
      <div className="mb-8">
        <p className="mb-2 text-sm font-semibold uppercase tracking-widest text-primary">
          Shared home
        </p>
        <h1 className="text-4xl font-bold tracking-tight">Shared bills</h1>
        <p className="mt-3 text-muted-foreground">
          Create a home to get started, or reopen one you already use.
        </p>
      </div>

      {!homeId ? (
        <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold">Create a home</h2>
          <form onSubmit={createHome} className="flex flex-col gap-3 sm:flex-row">
            <input
              aria-label="Home name"
              required
              maxLength={100}
              value={homeName}
              onChange={(event) => setHomeName(event.target.value)}
              placeholder="e.g. Flat 4B"
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-3 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="submit"
              disabled={busy || !homeName.trim()}
              className="rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create home'}
            </button>
          </form>
        </section>
      ) : (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void load(homeInput.trim())
            }}
            className="flex gap-2"
          >
            <input
              aria-label="Home ID"
              value={homeInput}
              onChange={(event) => setHomeInput(event.target.value)}
              placeholder="Home ID"
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-3 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="submit"
              disabled={!homeInput.trim() || loading}
              className="rounded-md bg-secondary px-5 py-3 font-medium text-secondary-foreground transition hover:bg-accent disabled:opacity-50"
            >
              Open
            </button>
          </form>
          <p className="mt-2 break-all text-sm text-muted-foreground">
            Home ID:{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{homeId}</code>
          </p>

          <section className="mt-5 rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="mb-4 text-xl font-semibold">Add a member</h2>
            <form onSubmit={addMember} className="flex flex-col gap-3 sm:flex-row">
              <input
                aria-label="Member name"
                required
                maxLength={100}
                value={memberName}
                onChange={(event) => setMemberName(event.target.value)}
                placeholder="Member name"
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-3 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="submit"
                disabled={busy || !memberName.trim()}
                className="rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add member
              </button>
            </form>
            {Object.values(names).length > 0 && (
              <p className="mt-4 text-sm text-muted-foreground">
                Members: <span className="text-foreground">{Object.values(names).join(', ')}</span>
              </p>
            )}
          </section>

          <section className="mt-5 rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="mb-4 text-xl font-semibold">Add a bill</h2>
            <form
              onSubmit={createBill}
              className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_160px_auto]"
            >
              <input
                aria-label="Bill title"
                required
                maxLength={100}
                value={billTitle}
                onChange={(event) => setBillTitle(event.target.value)}
                placeholder="Bill title"
                className="min-w-0 rounded-md border border-input bg-background px-3 py-3 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <input
                aria-label="Amount in dollars"
                required
                type="number"
                min="0.01"
                step="0.01"
                value={billAmount}
                onChange={(event) => setBillAmount(event.target.value)}
                placeholder="Amount ($)"
                className="min-w-0 rounded-md border border-input bg-background px-3 py-3 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="submit"
                disabled={busy || !billTitle.trim() || !billAmount}
                className="rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add bill
              </button>
            </form>
          </section>
        </>
      )}

      {loading && (
        <p role="status" className="mt-5 rounded-md bg-muted p-4 text-muted-foreground">
          Loading home…
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-5 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-destructive"
        >
          {error}
        </p>
      )}
      {!loading && homeId && bills.length === 0 && !error && (
        <p className="mt-5 rounded-xl border border-dashed border-border bg-muted p-8 text-center text-muted-foreground">
          No bills yet. Add members, then create your first bill.
        </p>
      )}
      {!loading &&
        bills.map((bill) => (
          <section
            key={bill.id}
            className="mt-5 rounded-xl border border-border bg-card p-6 shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <h2 className="text-xl font-semibold">{bill.title}</h2>
              <p className="rounded-full bg-accent px-3 py-1 text-sm font-semibold text-accent-foreground">
                ${(bill.totalCents / 100).toFixed(2)}
              </p>
            </div>
            <ul className="mt-4 divide-y divide-border">
              {bill.shares.map((share) => (
                <li key={share.id} className="flex items-center justify-between gap-4 py-3">
                  <span className="font-medium">
                    {names[share.memberId] ?? 'Member'} · ${(share.amountCents / 100).toFixed(2)}
                  </span>
                  {share.paidAt ? (
                    <span className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground">
                      Paid
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={paying !== null}
                      onClick={() => void pay(bill.id, share.id)}
                      className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
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
