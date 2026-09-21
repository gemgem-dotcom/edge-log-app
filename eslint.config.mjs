// Next.js's own flat-config export (core web vitals + React hooks rules,
// plus a TypeScript block this app never triggers since there are no .ts
// files) - systems-map audit finding #3: this repo previously had no
// ESLint config at all (see .github/workflows/run-command.yml's old
// comment, now removed). vitest.config.mjs/vitest.setup.js are test
// infra, not app source, but nothing about them needs excluding - Next's
// own ignores block above only covers build output.
// WHY ESLINT IS PINNED TO 9, and what has to change before 10.
//
// npm warns on install that 9.39.5 is "no longer supported". That is
// ESLint's support policy reacting to 10 being out, not a missed upgrade:
// 9.39.5 IS the newest 9.x, so there is nothing to move to inside v9.
//
// ESLint 10 was tried properly (Dependabot #203) and is blocked by two
// separate things, both upstream of this repo:
//
//   1. The PARSER. eslint-config-next parses .js with its Babel-based
//      parser, whose scope manager predates ESLint 10's
//      `scopeManager.addGlobals()` - so 10 throws
//      "addGlobals is not a function" on the first file. This one IS
//      fixable here, by parsing our own files with espree instead, and
//      that was verified to work.
//
//   2. eslint-plugin-react. With the parser fixed, the next failure is
//      `context.getFilename is not a function` from inside
//      eslint-plugin-react, which ESLint 10 removed. 7.37.5 is the LATEST
//      PUBLISHED version and its peer range ends at `^9.7`, so there is no
//      release to upgrade or override to. Nothing in this repo can fix it.
//
// So do not re-attempt the bump on the strength of (1) alone. The test for
// whether 10 has become possible is (2): check whether
// eslint-plugin-react has published a version accepting eslint ^10.
// Everything else follows from that.
//
// Also note an earlier diagnosis of this that was WRONG and should not be
// repeated: the first reading blamed @typescript-eslint pinned at v8 and
// said it needed v9. There is no typescript-eslint v9 - 8.x is current -
// and the TS parser is not even in play here, since this repo has no .ts
// files. The scope manager came from the Babel parser.

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
