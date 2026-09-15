'use client'

import Link from 'next/link'
import { ChevronRight, LogOut } from 'lucide-react'
import { ACCOUNT_SECTIONS } from '@/lib/accountSections'

// The mobile account screen's index: one row per section, each drilling
// into it.
//
// The desktop stacks every section on one page, which at 390px is a
// ~2,000px scroll through seven unrelated concerns to reach the one you
// came for. This is the phone answer - a list you scan, then one screen
// that does one thing.
//
// Drill-down is a QUERY PARAM rather than component state, so the phone's
// own back gesture returns to this index. With state it would have left
// the account page entirely, which is the single most common way a
// hand-rolled mobile drill-down goes wrong.
export default function MobileAccountIndex({ email, onLogout }) {
  return (
    <>
      <div className="panel m-account-index">
        {ACCOUNT_SECTIONS.map((s) => (
          <Link
            key={s.key}
            href={`/app/account?section=${s.key}`}
            className={`m-account-row${s.danger ? ' is-danger' : ''}`}
          >
            <span className="m-account-row-body">
              <span className="m-account-row-label">{s.label}</span>
              <span className="m-account-row-hint">{s.hint}</span>
            </span>
            <ChevronRight size={16} className="m-account-row-chevron" />
          </Link>
        ))}
      </div>

      {/* Log out lives here on mobile because the bespoke account topbar
          that carries it on desktop is hidden - see the mobile stylesheet.
          Without this the only way to sign out on a phone would be to
          clear the browser's storage. */}
      <button type="button" className="m-logout" onClick={onLogout}>
        <LogOut size={15} aria-hidden="true" /> Log out
      </button>

      {email ? <p className="m-account-email">Signed in as {email}</p> : null}
    </>
  )
}
