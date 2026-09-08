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
  // scripts/ are plain CommonJS run by `node scripts/...`, never bundled,
  // and Next's config leaves no-undef off (it assumes TypeScript catches
  // this). That gap let a rewrite of scan-rejection-conditions.js ship a
  // reference to a variable it had just deleted: `node -c` passes, lint
  // passed, and the error only surfaced as a ReferenceError inside the
  // per-day try/catch of a 20-minute Actions job, which swallowed it into
  // "285 days failed" and zero events. no-undef here is the cheapest
  // possible guard against that whole class of mistake.
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', process: 'readonly',
        console: 'readonly', Buffer: 'readonly', fetch: 'readonly',
        URL: 'readonly', __dirname: 'readonly', setTimeout: 'readonly',
      },
    },
    rules: { 'no-undef': 'error' },
  },
  {
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
]

export default config
