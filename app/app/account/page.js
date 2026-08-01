'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../../lib/supabaseClient'

export default function AccountPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [instruments, setInstruments] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    const { data: { user } } = await supabase.auth.getUser()
    setEmail(user.email)
    const { data } = await supabase
      .from('instruments')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
    setInstruments(data || [])
    setLoading(false)
  }

  async function handleRemoveInstrument(id, symbol) {
    if (!confirm(`Remove ${symbol}? This deletes every strategy and trade logged under it. This cannot be undone.`)) return
    await supabase.from('instruments').delete().eq('id', id)
    loadData()
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) return <div className="page-loading">Loading…</div>

  return (
    <div className="page-container">
      <h1 className="page-title">Account</h1>

      <div className="panel">
        <div className="panel-title">Profile</div>
        <div className="detail-grid">
          <div><label>Email</label><div>{email}</div></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Instruments</div>
        {instruments.length === 0 ? (
          <div className="empty">No instruments yet.</div>
        ) : (
          <table>
            <thead><tr><th>Symbol</th><th></th></tr></thead>
            <tbody>
              {instruments.map((inst) => (
                <tr key={inst.id}>
                  <td>{inst.symbol}</td>
                  <td><span className="del" onClick={() => handleRemoveInstrument(inst.id, inst.symbol)}>remove</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="submit-row">
        <button onClick={handleSignOut}>Sign out</button>
      </div>
    </div>
  )
}
