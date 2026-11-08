'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { toast } from '@/lib/toast'
import { displayNameUpdate } from '@/lib/displayName'

export default function ProfileSection({ email, initialFullName }) {
  const [fullName, setFullName] = useState(initialFullName)

  async function handleNameBlur() {
    if (fullName.trim() === initialFullName) return
    // displayNameUpdate, not { full_name }. Google overwrites full_name
    // on every OAuth sign-in - see lib/displayName.js.
    const { error } = await supabase.auth.updateUser({ data: displayNameUpdate(fullName) })
    if (!error) toast.success('Name updated.')
  }

  return (
    <>
      <div className="section-heading">Profile</div>
      <div className="panel">
        <form onSubmit={(e) => e.preventDefault()}>
          <div className="field half">
            <label>Full name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              onBlur={handleNameBlur}
            />
          </div>
          <div className="field half">
            <label>Email</label>
            <input type="email" value={email} disabled />
          </div>
        </form>
      </div>
    </>
  )
}
