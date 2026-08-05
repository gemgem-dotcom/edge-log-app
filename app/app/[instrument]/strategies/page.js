'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import PageLoading from '@/components/PageLoading'

export default function StrategiesPage({ params }) {
  const symbol = params.instrument
  const [loading, setLoading] = useState(true)
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
    const { data: { user } } = await supabase.auth.getUser()
    const { data: instrument } = await supabase
      .from('instruments')
      .select('*')
      .eq('user_id', user.id)
      .eq('symbol', symbol)
      .single()

    if (!instrument) {
      setLoading(false)
      return
    }
    setInstrumentId(instrument.id)

    const { data } = await supabase
      .from('strategies')
      .select('*')
      .eq('instrument_id', instrument.id)
      .order('archived', { ascending: true })
      .order('created_at', { ascending: true })

    setStrategies(data || [])
    setLoading(false)
  }

  async function handleAdd(e) {
    e.preventDefault()
    if (!newName.trim()) return
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase
      .from('strategies')
      .insert([{ user_id: user.id, instrument_id: instrumentId, name: newName.trim() }])
    if (!error) {
      setNewName('')
      loadStrategies()
    } else {
      alert(error.message)
    }
  }

  async function handleRename(id) {
    if (!editName.trim()) return
    const { error } = await supabase.from('strategies').update({ name: editName.trim() }).eq('id', id)
    if (!error) {
      setEditingId(null)
      loadStrategies()
    } else {
      alert(error.message)
    }
  }

  async function toggleArchive(id, archived) {
    await supabase.from('strategies').update({ archived: !archived }).eq('id', id)
    loadStrategies()
  }

  if (loading) return <PageLoading />

  return (
    <div className="page-container">
      <h1 className="page-title">{symbol} — Strategies</h1>

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
          <div className="empty">No strategies yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {strategies.map((s) => (
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
        )}
      </div>
    </div>
  )
}
