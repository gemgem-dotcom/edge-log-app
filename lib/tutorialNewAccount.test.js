import { describe, it, expect, vi } from 'vitest'
import { markTutorialPendingIfNewAccount } from './tutorialNewAccount'

function userAt({ createdAt, lastSignInAt, tutorialStatus }) {
  return {
    created_at: createdAt,
    last_sign_in_at: lastSignInAt,
    user_metadata: tutorialStatus ? { tutorial_status: tutorialStatus } : {},
  }
}

describe('markTutorialPendingIfNewAccount', () => {
  it('sets tutorial_status when created_at and last_sign_in_at are within the new-account window', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    const user = userAt({ createdAt: now.toISOString(), lastSignInAt: new Date(now.getTime() + 5000).toISOString() })
    const updateUser = vi.fn().mockResolvedValue({})
    await markTutorialPendingIfNewAccount({ auth: { updateUser } }, user)
    expect(updateUser).toHaveBeenCalledWith({ data: { tutorial_status: 'pending' } })
  })

  it('does nothing for a returning user whose account long predates this sign-in', async () => {
    const user = userAt({ createdAt: '2020-01-01T00:00:00.000Z', lastSignInAt: new Date().toISOString() })
    const updateUser = vi.fn()
    await markTutorialPendingIfNewAccount({ auth: { updateUser } }, user)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('does nothing when tutorial_status is already set, even within the new-account window', async () => {
    const now = new Date()
    const user = userAt({ createdAt: now.toISOString(), lastSignInAt: now.toISOString(), tutorialStatus: 'done' })
    const updateUser = vi.fn()
    await markTutorialPendingIfNewAccount({ auth: { updateUser } }, user)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('does nothing for a missing user', async () => {
    const updateUser = vi.fn()
    await markTutorialPendingIfNewAccount({ auth: { updateUser } }, null)
    expect(updateUser).not.toHaveBeenCalled()
  })
})
