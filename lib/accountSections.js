// The account page's sections, as data.
//
// The desktop stacks all of them on one page; mobile shows an index and
// drills into one at a time, keyed by `?section=<key>`. Keeping the list
// here rather than inside the page means the key set is one thing both
// branches read, and it can be tested - an index row pointing at a key
// the page cannot render is exactly the kind of dead link this work has
// already shipped once.
//
// `key` is what appears in the URL, so renaming one breaks anybody's
// bookmark; add rather than rename.
export const ACCOUNT_SECTIONS = [
  { key: 'profile', label: 'Profile', hint: 'Name and email' },
  { key: 'preferences', label: 'Preferences', hint: 'Theme and timezone' },
  { key: 'password', label: 'Password', hint: 'Change your password' },
  { key: 'twofactor', label: 'Two-factor', hint: 'Extra sign-in security' },
  { key: 'devices', label: 'Recent sign-ins', hint: 'Where your account has been used' },
  { key: 'export', label: 'Export data', hint: 'Download your journal' },
  { key: 'danger', label: 'Danger zone', hint: 'Delete your account', danger: true },
]

export function accountSectionFor(key) {
  return ACCOUNT_SECTIONS.find((s) => s.key === key) || null
}
