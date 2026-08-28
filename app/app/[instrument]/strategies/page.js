'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { invalidateStrategies } from '@/lib/referenceDataCache'
import { toast } from '@/lib/toast'
import { usePageTitle } from '@/lib/usePageTitle'
import StrategiesSkeleton from '@/components/StrategiesSkeleton'
import PageError from '@/components/PageError'
import EmptyState from '@/components/EmptyState'
import ErrorBanner from '@/components/ErrorBanner'

export default function StrategiesPage({ params }) {
  usePageTitle('Strategies')
  const symbol = params.instrument
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [formError, setFormError] = useState(null)
  const [instrumentId, setInstrumentId] = useState(null)
  const [strategies, setStrategies] = useState([])
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editName, setEditName] = useState('')

  useEffect(() => {
    loadStrategies()
  }, [symbol])

  async function loadStrategies() {
    setLoading(true)
    setError(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: instrument } = await supabase
        .from('instruments')
        .select('*')
        .eq('user_id', user.id)
        .eq('symbol', symbol)
        .eq('archived', false)
        .single()

      if (!instrument) {
        setLoading(false)
        return
      }
      setInstrumentId(instrument.id)

      const { data, error: stratError } = await supabase
        .from('strategies')
        .select('*')
        .eq('instrument_id', instrument.id)
        .order('archived', { ascending: true })
        .order('created_at', { ascending: true })
      if (stratError) throw stratError

      setStrategies(data || [])
    } catch (err) {
      setError(err.message || "Couldn't load your strategies — something went wrong.")
    } finally {
      setLoading(false)
    }
  }

  async function handleAdd(e) {
    e.preventDefault()
    if (!newName.trim()) return
    setFormError(null)
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase
      .from('strategies')
      .insert([{ user_id: user.id, instrument_id: instrumentId, name: newName.trim() }])
    if (!error) {
      invalidateStrategies(instrumentId)
      setNewName('')
      toast.success('Strategy created.')
      loadStrategies()
    } else {
      setFormError(error.message)
    }
  }

  async function handleRename(id) {
    if (!editName.trim()) return
    setFormError(null)
    const { error } = await supabase.from('strategies').update({ name: editName.trim() }).eq('id', id)
    if (!error) {
      invalidateStrategies(instrumentId)
      setEditingId(null)
      toast.success('Strategy renamed.')
      loadStrategies()
    } else {
      setFormError(error.message)
    }
  }

  async function toggleArchive(id, archived) {
    setFormError(null)
    const { error } = await supabase.from('strategies').update({ archived: !archived }).eq('id', id)
    if (error) {
      setFormError(error.message)
      return
    }
    invalidateStrategies(instrumentId)
    loadStrategies()
  }

  if (loading) return <StrategiesSkeleton />
  if (error) return <div className="page-container"><PageError message={`Couldn't load your strategies — ${error}`} onRetry={loadStrategies} /></div>

  // Active before archived (unchanged grouping), alphabetical by name
  // within each group instead of creation order.
  const sortedStrategies = strategies.slice().sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1
    return a.name.localeCompare(b.name)
  })

  return (
    <div className="page-container">
      <div className="strategy-header-row">
        <h1 className="page-title">Strategies</h1>
        <Link href={`/app/${symbol}/log/new`} className="new-trade-btn"><Plus size={16} /> Log new trade</Link>
      </div>

      <ErrorBanner message={formError} />

      <div className="panel">
        <div className="panel-title">Add a new strategy</div>
        <form onSubmit={handleAdd} className="inline-form">
          <input
            type="text"
            placeholder="e.g. London Sweep Reversal"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit">Add</button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-title">Your strategies for {symbol}</div>
        {strategies.length === 0 ? (
          <EmptyState
            title="No strategies yet"
            message={`You haven't created any strategies for ${symbol} yet. Add one above to start tracking trades against it.`}
          />
        ) : (
          <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Name</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {sortedStrategies.map((s) => (
                <tr key={s.id} style={{ opacity: s.archived ? 0.5 : 1 }}>
                  <td>
                    {editingId === s.id ? (
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        autoFocus
                      />
                    ) : (
                      s.name
                    )}
                  </td>
                  <td>{s.archived ? 'Archived' : 'Active'}</td>
                  <td style={{ display: 'flex', gap: '10px' }}>
                    {editingId === s.id ? (
                      <>
                        <span className="del" onClick={() => handleRename(s.id)}>save</span>
                        <span className="del" onClick={() => setEditingId(null)}>Cancel</span>
                      </>
                    ) : (
                      <>
                        <span className="del" onClick={() => { setEditingId(s.id); setEditName(s.name) }}>rename</span>
                        <span className="del" onClick={() => toggleArchive(s.id, s.archived)}>
                          {s.archived ? 'unarchive' : 'archive'}
                        </span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  )
}
