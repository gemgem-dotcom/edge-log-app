// Privacy/Terms are linked from three different pages, each wanting its own
// "Back to X" label rather than one generic default - the linking page
// passes ?from=<source> and this maps it back to where + what to show.
const SOURCES = {
  signup: { href: '/signup', label: 'Back to sign up' },
  login: { href: '/login', label: 'Back to login' },
  account: { href: '/app/account', label: 'Back to account settings' },
}

export function resolveBackLink(from) {
  return SOURCES[from] || SOURCES.login
}
