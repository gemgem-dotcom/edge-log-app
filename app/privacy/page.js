import { resolveBackLink } from '@/lib/policyBackLink'

export const metadata = {
  title: 'Privacy Policy — EdgeLog',
}

export default function PrivacyPolicyPage({ searchParams }) {
  const backLink = resolveBackLink(searchParams?.from)
  return (
    <div className="simple-page-wrap">
      <div className="policy-header">
        <a href="/login" className="policy-logo">Edge<span>Log</span></a>
        <a href={backLink.href} className="policy-back-link">{backLink.label}</a>
      </div>

      <h1 className="page-title">Privacy policy</h1>
      <p className="page-subtitle">Last updated: August 11, 2026</p>

      <div className="panel policy-content">
        <p>
          EdgeLog (&quot;we&quot;, &quot;us&quot;) provides a trading journal application. This policy
          explains what data we collect and how we use it.
        </p>

        <h2>Information we collect</h2>
        <ul>
          <li><strong>Account information:</strong> your email address, and optionally your name, provided when you sign up.</li>
          <li><strong>Trading data you log:</strong> instrument, strategy, entry/exit details, notes, and any screenshots you upload.</li>
          <li><strong>Usage data:</strong> sign-in history and device/session information, shown to you in Account Settings.</li>
        </ul>

        <h2>How we use your information</h2>
        <p>
          We use your data solely to provide the journaling service to you: storing your trades,
          calculating your statistics, and securing your account. We do not sell your data, and we
          do not share your trading data with any third party for marketing purposes.
        </p>

        <h2>Third-party services</h2>
        <p>
          We use Supabase for authentication and database storage, and Vercel for application
          hosting. These providers process data on our behalf under their own security and privacy
          commitments. If you sign in with Google, we receive only the basic profile information
          Google provides for authentication.
        </p>

        <h2>Data retention and deletion</h2>
        <p>
          You can export your data at any time from Account Settings. You can permanently delete
          your account and all associated data at any time from Account Settings — this action is
          immediate and cannot be undone.
        </p>

        <h2>Cookies</h2>
        <p>
          We use only the essential cookies required to keep you signed in. We do not use tracking
          or advertising cookies.
        </p>

        <h2>Your rights</h2>
        <p>
          You have the right to access, correct, export, or delete your personal data at any time.
          Contact us at <a href="mailto:support@edgelog-journal.com">support@edgelog-journal.com</a> with
          any questions or requests.
        </p>

        <h2>Changes to this policy</h2>
        <p>
          We may update this policy from time to time. Material changes will be communicated via
          email or an in-app notice.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about this policy: <a href="mailto:support@edgelog-journal.com">support@edgelog-journal.com</a>
        </p>
      </div>

      <div className="policy-footer">
        <span className="copyright-line">© 2026 EdgeLog</span>
      </div>
    </div>
  )
}
