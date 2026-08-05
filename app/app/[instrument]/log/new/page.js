'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { uploadScreenshots } from '@/lib/screenshots'
import TradeForm from '@/components/TradeForm'

export default function NewTradePage({ params }) {
  const symbol = params.instrument
  const router = useRouter()

  const [instrumentId, setInstrumentId] = useState(null)
  const [strategies, setStrategies] = useState([])

  useEffect(() => {
    loadStrategies()
  }, [symbol])

  async function loadStrategies() {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: instrument } = await supabase
      .from('instruments')
      .select('*')
      .eq('user_id', user.id)
      .eq('symbol', symbol)
      .single()
    if (!instrument) return
    setInstrumentId(instrument.id)

    const { data } = await supabase
      .from('strategies')
      .select('*')
      .eq('instrument_id', instrument.id)
      .eq('archived', false)
      .order('created_at', { ascending: true })
    setStrategies(data || [])
  }

  async function handleSubmit({ values, screenshots }) {
    const { data: { user } } = await supabase.auth.getUser()

    let screenshot_urls = []
    try {
      screenshot_urls = await uploadScreenshots(screenshots)
    } catch (uploadError) {
      alert(uploadError.message?.includes('Bucket not found')
        ? 'Screenshot upload failed: the "screenshots" storage bucket doesn\'t exist yet in Supabase. Run the storage setup SQL (storage-setup.sql) or create it manually under Storage → New bucket → "screenshots" → Public.'
        : 'Screenshot upload failed: ' + uploadError.message)
      return false
    }

    const { error } = await supabase.from('trades').insert([{
      ...values,
      user_id: user.id,
      instrument_id: instrumentId,
      screenshot_urls,
      screenshot_url: screenshot_urls[0] || null,
    }])

    if (error) {
      alert('Could not save trade: ' + error.message)
      return false
    }

    router.push(`/app/${symbol}/log`)
  }

  return (
    <div className="page-container">
      <h1 className="page-title">{symbol} — Log New Trade</h1>

      <TradeForm
        symbol={symbol}
        instrumentId={instrumentId}
        strategies={strategies}
        onStrategyAdded={loadStrategies}
        autoSelectFirstStrategy
        showEmptyStrategyMessage
        submitLabel="Log trade"
        onSubmit={handleSubmit}
      />
    </div>
  )
}
