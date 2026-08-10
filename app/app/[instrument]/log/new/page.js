'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { uploadScreenshots } from '@/lib/screenshots'
import TradeForm from '@/components/TradeForm'
import ErrorBanner from '@/components/ErrorBanner'

export default function NewTradePage({ params }) {
  const symbol = params.instrument
  const router = useRouter()

  const [instrumentId, setInstrumentId] = useState(null)
  const [strategies, setStrategies] = useState([])
  const [strategiesError, setStrategiesError] = useState(null)

  useEffect(() => {
    loadStrategies()
  }, [symbol])

  async function loadStrategies() {
    setStrategiesError(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: instrument } = await supabase
        .from('instruments')
        .select('*')
        .eq('user_id', user.id)
        .eq('symbol', symbol)
        .single()
      if (!instrument) return
      setInstrumentId(instrument.id)

      const { data, error } = await supabase
        .from('strategies')
        .select('*')
        .eq('instrument_id', instrument.id)
        .eq('archived', false)
        .order('created_at', { ascending: true })
      if (error) throw error
      setStrategies(data || [])
    } catch (err) {
      setStrategiesError(`Couldn't load your strategies — ${err.message || 'something went wrong'}. You can still log the trade and assign a strategy later.`)
    }
  }

  async function handleSubmit({ values, screenshots }) {
    const { data: { user } } = await supabase.auth.getUser()

    let screenshot_urls = []
    try {
      screenshot_urls = await uploadScreenshots(screenshots)
    } catch (uploadError) {
      return uploadError.message?.includes('Bucket not found')
        ? 'Screenshot upload failed: the "screenshots" storage bucket doesn\'t exist yet in Supabase. Run the storage setup SQL (storage-setup.sql) or create it manually under Storage → New bucket → "screenshots" → Public.'
        : 'Screenshot upload failed: ' + uploadError.message
    }

    const { error } = await supabase.from('trades').insert([{
      ...values,
      user_id: user.id,
      instrument_id: instrumentId,
      screenshot_urls,
      screenshot_url: screenshot_urls[0] || null,
    }])

    if (error) {
      return 'Could not save trade: ' + error.message
    }

    router.push(`/app/${symbol}/log`)
  }

  return (
    <div className="page-container">
      <h1 className="page-title"><span className="page-title-symbol">{symbol}</span> LOG NEW TRADE</h1>

      <ErrorBanner message={strategiesError} />

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
