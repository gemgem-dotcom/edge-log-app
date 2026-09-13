import { describe, it, expect, vi } from 'vitest'
import { activatable } from './activatable'

// A DOM-free stand-in for the event React would hand onKeyDown. `target`
// and `currentTarget` are distinct objects so the nested-control guard can
// be exercised either way.
function keyEvent(key, { nested = false } = {}) {
  const element = { name: 'the element' }
  return {
    key,
    target: nested ? { name: 'a nested input' } : element,
    currentTarget: element,
    preventDefault: vi.fn(),
  }
}

describe('activatable', () => {
  it('marks the element as a control and puts it in the tab order', () => {
    const props = activatable(() => {})
    expect(props.role).toBe('button')
    expect(props.tabIndex).toBe(0)
  })

  it('passes a click straight through, unchanged', () => {
    const onActivate = vi.fn()
    const event = { type: 'click' }
    activatable(onActivate).onClick(event)
    expect(onActivate).toHaveBeenCalledWith(event)
  })

  it.each(['Enter', ' ', 'Spacebar'])('activates on %s', (key) => {
    const onActivate = vi.fn()
    const event = keyEvent(key)
    activatable(onActivate).onKeyDown(event)
    expect(onActivate).toHaveBeenCalledTimes(1)
    // Space scrolls the page unless a control claims it, which is exactly
    // what a real <button> does.
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it.each(['a', 'Tab', 'Escape', 'ArrowDown', 'Shift'])('ignores %s', (key) => {
    const onActivate = vi.fn()
    const event = keyEvent(key)
    activatable(onActivate).onKeyDown(event)
    expect(onActivate).not.toHaveBeenCalled()
    // Tab especially: swallowing it would trap focus on the element.
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  // A clickable wrapper around a text field must not fire when the space
  // bar was aimed at the field.
  it('leaves a key press that started inside a nested control alone', () => {
    const onActivate = vi.fn()
    const event = keyEvent(' ', { nested: true })
    activatable(onActivate).onKeyDown(event)
    expect(onActivate).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  // The whole point of the rewrite: the previous attempt changed how
  // things looked. Nothing here may carry styling.
  it('contributes no className, style or anything else visual', () => {
    const props = activatable(() => {})
    expect(Object.keys(props).sort()).toEqual(['onClick', 'onKeyDown', 'role', 'tabIndex'])
  })
})
