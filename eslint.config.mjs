// Next.js's own flat-config export (core web vitals + React hooks rules,
// plus a TypeScript block this app never triggers since there are no .ts
// files) - systems-map audit finding #3: this repo previously had no
// ESLint config at all (see .github/workflows/run-command.yml's old
// comment, now removed). vitest.config.mjs/vitest.setup.js are test
// infra, not app source, but nothing about them needs excluding - Next's
// own ignores block above only covers build output.
import nextConfig from 'eslint-config-next'

// react-hooks/set-state-in-effect, react-hooks/immutability, and
// react-hooks/refs are new, aggressive React-Compiler-readiness rules that
// flag several established, working patterns already in this codebase
// (syncing a ref during render, resetting pagination in response to a
// filter change, mutating a local accumulator inside .map) - real
// rewrites with real regression risk, not something to force through
// while just wiring up the linter itself. Downgraded to warn (visible,
// not blocking) rather than disabled outright - genuinely worth revisiting
// as its own dedicated cleanup pass, just not this one.
const config = [
  ...nextConfig,
  {
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
]

export default config
