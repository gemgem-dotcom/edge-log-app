import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// Mirrors jsconfig.json's @/* -> ./* alias so test files can import lib
// modules the same way the app itself does.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.js'],
  },
  resolve: {
    alias: {
      '@': rootDir,
    },
  },
})
