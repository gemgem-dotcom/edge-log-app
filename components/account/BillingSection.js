'use client'

import EmptyState from '@/components/EmptyState'

// No billing backend is wired up yet - this is layout scaffolding only,
// matching the row shape a real plan and payment method will drop into
// later. Deliberately shows no invented plan name, price, or card details;
// the action buttons are disabled since there's nothing yet for them to do.
export default function BillingSection() {
  return (
    <>
      <div className="section-heading" style={{ marginTop: '8px' }}>Billing</div>
      <div className="panel">
        <div className="billing-row">
          <div>
            <div className="billing-row-title">Plan</div>
            <div className="billing-row-note">No active plan</div>
          </div>
          <button type="button" className="btn-accent-outline" disabled title="Coming soon">Change plan</button>
        </div>
        <div className="panel-divider" />
        <div className="billing-row">
          <div>
            <div className="billing-row-title">Payment method</div>
            <div className="billing-row-note">No payment method on file</div>
          </div>
          <button type="button" className="btn-accent-outline" disabled title="Coming soon">Add</button>
        </div>
        <div className="panel-divider" />
        <div className="billing-row-title">Billing history</div>
        <EmptyState message="Invoices will appear here once billing is set up." />
      </div>
    </>
  )
}
