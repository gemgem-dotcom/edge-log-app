import { resolveBackLink } from '@/lib/policyBackLink'

export const metadata = {
  title: 'Terms of Service — EdgeLog',
}

export default function TermsOfServicePage({ searchParams }) {
  const backLink = resolveBackLink(searchParams?.from)
  return (
    <div className="simple-page-wrap">
      <div className="policy-header">
        <a href="/login" className="policy-logo">Edge<span>Log</span></a>
        <a href={backLink.href} className="policy-back-link">{backLink.label}</a>
      </div>

      <h1 className="page-title">Terms of service</h1>
      <p className="page-subtitle">Last updated: August 11, 2026</p>

      <div className="panel policy-content">
        <h2>Acceptance of terms</h2>
        <p>By creating an account and using EdgeLog, you agree to these terms.</p>

        <h2>Description of service</h2>
        <p>
          EdgeLog is a trading journal tool. It allows you to log trades, track performance
          statistics, and organize your trading strategies. EdgeLog does not execute trades, manage
          funds, or provide brokerage services.
        </p>

        <h2>Not financial advice</h2>
        <p>
          EdgeLog is a record-keeping and analytics tool only. Nothing in the app constitutes
          financial, investment, or trading advice. Any statistics, patterns, or indicators shown
          are derived solely from data you provide and historical market data, and do not guarantee
          future results. You are solely responsible for your own trading decisions. Trade at your
          own risk.
        </p>

        <h2>Your account</h2>
        <p>
          You are responsible for maintaining the security of your account and password. You must
          be at least 18 years old to use EdgeLog.
        </p>

        <h2>Your data</h2>
        <p>
          You retain ownership of all trading data, notes, and screenshots you upload. By using the
          service, you grant us the limited right to store and process this data solely to provide
          the service to you.
        </p>

        <h2>Acceptable use</h2>
        <p>
          You agree not to use EdgeLog for any unlawful purpose, or to attempt to disrupt or gain
          unauthorized access to the service.
        </p>

        <h2>Termination</h2>
        <p>
          You may delete your account at any time. We reserve the right to suspend or terminate
          accounts that violate these terms.
        </p>

        <h2>Limitation of liability</h2>
        <p>
          EdgeLog is provided &quot;as is&quot; without warranties of any kind. We are not liable
          for any trading losses, decisions made based on data logged in the app, or interruptions
          to the service.
        </p>

        <h2>Changes to these terms</h2>
        <p>
          We may update these terms from time to time. Continued use of the service after changes
          constitutes acceptance of the updated terms.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about these terms: <a href="mailto:support@edgelog-journal.com">support@edgelog-journal.com</a>
        </p>
      </div>

      <div className="policy-footer">
        <span className="copyright-line">© 2026 EdgeLog</span>
      </div>
    </div>
  )
}
