'use client'

import { useState } from 'react'
import { Download } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'

const CSV_HEADERS = [
  'instrument', 'data_symbol', 'strategy', 'trade_date', 'trade_time', 'direction', 'entry', 'stop',
  'stop_distance', 'target', 'target_distance', 'exit_price', 'exit_time', 'r_multiple',
  'contracts', 'pnl', 'reasoning',
]

export default function DataExportSection() {
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  async function handleDownloadCsv() {
    setExportError('')
    setExporting(true)
    const { data: { user } } = await supabase.auth.getUser()

    const { data: trades, error } = await supabase
      .from('trades')
      .select('*, instruments(symbol, data_symbol), strategies(name)')
      .eq('user_id', user.id)
      .order('trade_date', { ascending: true })

    setExporting(false)
    if (error) {
      setExportError('Couldn\'t prepare your export. Please try again or contact support if this keeps happening.')
      return
    }
    if (!trades || trades.length === 0) {
      setExportError('No trades logged yet - nothing to export.')
      return
    }

    const rows = trades.map((t) => [
      t.instruments?.symbol || '', t.instruments?.data_symbol || '', t.strategies?.name || 'Unassigned', t.trade_date, t.trade_time,
      t.direction, t.entry, t.stop, t.stop_distance ?? '', t.target ?? '', t.target_distance ?? '',
      t.exit_price ?? '', t.exit_time ?? '',
      t.r_multiple ?? '', t.contracts ?? '', t.pnl ?? '',
      (t.reasoning || '').replace(/"/g, '""'),
    ])
    const csv = [CSV_HEADERS.join(','), ...rows.map((r) => r.map((v) => `"${v}"`).join(','))].join('\n')

    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `edgelog-journal-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <div className="section-heading" style={{ marginTop: '8px' }}>Data</div>
      <div className="panel">
        <div className="danger-row">
          <div>
            <div className="danger-row-title">Download my journal</div>
            <div className="danger-row-note">Every trade you&apos;ve logged, across every instrument and strategy, as a CSV file.</div>
          </div>
          <button onClick={handleDownloadCsv} disabled={exporting}>
            <Download size={14} style={{ marginRight: '6px', verticalAlign: '-2px' }} />{exporting ? 'Preparing...' : 'Download CSV'}
          </button>
        </div>
        {exportError && <div className="account-msg account-msg-error" style={{ marginTop: '14px' }}>{exportError}</div>}
      </div>
    </>
  )
}
