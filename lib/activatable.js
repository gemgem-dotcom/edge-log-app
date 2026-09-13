// Spreads the props that make a clickable non-button element reachable by
// keyboard, without changing how it looks.
//
// This app has a lot of controls built as <div> or <span> because they
// carry layout a <button> would fight - the long/short direction pair, the
// "+ add exit" links, the date picker's own nav arrows. Every one of them
// was mouse-only: no tab stop, no Enter, no Space.
//
// An earlier attempt at this fixed it by turning them into real <button>
// elements, which pulled the global button rules onto everything at once -
// a 100px border-radius, a box-shadow, a hover lift - and visibly broke
// pages that had nothing to do with accessibility. So this does the
// opposite: the element stays exactly the element it was, and only gains
// the three things a keyboard needs.
//
//   role="button"   tells a screen reader what it already behaves like
//   tabIndex={0}    puts it in the tab order
//   onKeyDown       makes Enter and Space do what a click does
//
// Nothing here touches className or style, and no CSS ships with it. The
// focus ring is the one app/globals.css already defines for
// `[tabindex]:focus-visible`, and :focus-visible deliberately does not
// fire for a mouse click - so a mouse user sees no difference at all, and
// a keyboard user gets the same accent ring every native control has.
//
// Usage:
//   <div className="dir-btn" {...activatable(() => setDirection('long'))}>
//
// Space is prevented from its default (scrolling the page) the way a real
// button does. A key press that started inside a nested control - a text
// input inside a clickable row, say - is left alone: typing a space in a
// field must not activate the thing wrapping it.
export function activatable(onActivate) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (event) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
      if (event.target !== event.currentTarget) return
      event.preventDefault()
      onActivate(event)
    },
  }
}
