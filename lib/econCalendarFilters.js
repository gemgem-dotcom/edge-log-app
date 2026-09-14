import { IMPACT_LEVELS, EVENT_TYPES, CURRENCIES } from '@/lib/econCalendarEvents.mjs'

// One filter setting for "the economic calendar", shared by every instance
// of the card rather than one per page it appears on. Versioned in the key
// name because the stored shape changed from a bare array of impacts to an
// object covering all three sections - an older value under the old key is
// simply ignored rather than needing a migration path.
export const FILTER_STORAGE_KEY = 'econCalendarFilters.v2'

export const ALL_IMPACTS = IMPACT_LEVELS.map((i) => i.value)

// What the card opens to before the trader has ever touched the filter
// panel. Impact and event type start at everything, so the first view
// hides nothing within the currency it shows - including the grey
// non-economic level, which is bank holidays and other "nothing is
// released here" entries. A thin session is worth seeing rather than
// silently omitting.
//
// Currencies default to USD alone, matching what this app is for: every
// instrument in lib/instrumentCatalog.js is a US futures contract, so a
// default of all nine would bury the releases that actually move them
// under eight other countries' calendars. Every currency is one checkbox
// away for anyone trading the correlations.
//
// This is only the starting point. Whatever the trader sets replaces it
// and is restored on every later visit.
export const DEFAULT_FILTERS = {
  impacts: ALL_IMPACTS,
  types: EVENT_TYPES,
  currencies: ['USD'],
}

// Field by field, not a wholesale replace: a stored value written by an
// older version of the card (or hand-edited) shouldn't be able to leave a
// section undefined and crash every .includes() at the filter site.
export function normaliseFilters(parsed) {
  return {
    impacts: Array.isArray(parsed?.impacts) ? parsed.impacts : DEFAULT_FILTERS.impacts,
    types: Array.isArray(parsed?.types) ? parsed.types : DEFAULT_FILTERS.types,
    currencies: Array.isArray(parsed?.currencies) ? parsed.currencies : DEFAULT_FILTERS.currencies,
  }
}

// Reading and writing are both wrapped, because localStorage is not the
// always-available thing it looks like: access throws outright when a
// browser blocks site data, and setItem throws on quota. An unguarded
// write would mean a trader in a private window couldn't change a filter
// at all - the failure being "the setting doesn't persist", never a
// broken card.
export function readStoredFilters(storage = safeStorage()) {
  if (!storage) return DEFAULT_FILTERS
  try {
    const saved = storage.getItem(FILTER_STORAGE_KEY)
    if (!saved) return DEFAULT_FILTERS
    return normaliseFilters(JSON.parse(saved))
  } catch {
    return DEFAULT_FILTERS
  }
}

export function writeStoredFilters(filters, storage = safeStorage()) {
  if (!storage) return false
  try {
    storage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters))
    return true
  } catch {
    return false
  }
}

function safeStorage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

// Whether the currency filter lets a row through.
//
// A currency with its own checkbox is simply ticked or not.
//
// Everything else rides along with whatever IS ticked. That covers two
// kinds of row: FF's GLOBAL_CURRENCY ("ALL" - OPEC meetings, G20 summits),
// which isn't any one country's news and shouldn't vanish because you
// unticked EUR, and a code with no checkbox at all, a tenth currency FF
// adds or a feed record with the field missing.
//
// "Rides along" rather than "always shows", which is the distinction that
// matters when the trader unticks every currency: they have asked to see
// nothing, and a list still holding every OPEC meeting would read as a
// broken filter. So these rows appear whenever at least one currency is
// selected, and disappear when none is. Filtering them by a checkbox that
// doesn't exist was the other failure - it made them permanently invisible
// with nothing on screen to say so.
export function currencyAllows(selected, currency) {
  if (CURRENCIES.includes(currency)) return selected.includes(currency)
  return selected.length > 0
}

// Membership, not length. A stored value whose arrays are the right SIZE
// but hold names that aren't options any more - an older version's event
// types, a hand-edited key - counted as "nothing narrowed", so the button
// read a bare "Filter" while the card below it said "No events match these
// filters". Asking whether every option is actually selected can't be
// fooled that way.
export function isNarrowed(selected, allOptions) {
  return !allOptions.every((option) => selected.includes(option))
}

// How many of the three sections are hiding something. The Filter button
// carries that count beside its label - the "show that a filter is on
// without spelling out all of it" job, since naming every selected value
// doesn't survive three sections and nine currencies.
//
// Counts against the FULL option list, not against DEFAULT_FILTERS, so a
// fresh install opens showing 1 - impact and type start at everything, and
// only currencies are narrowed, to USD. That is the truth the badge is
// for: one section really is hiding events, and the trader has no other
// way to know it before opening the panel.
export function activeSectionCount(filters) {
  let n = 0
  if (isNarrowed(filters.impacts, ALL_IMPACTS)) n++
  if (isNarrowed(filters.types, EVENT_TYPES)) n++
  if (isNarrowed(filters.currencies, CURRENCIES)) n++
  return n
}
