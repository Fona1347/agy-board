/**
 * Runtime loader for the browser-bundled MCP App client script (`card-app.ts`).
 *
 * - During production bundling (`scripts/build-runtime.mjs`), an esbuild plugin
 *   replaces this module with the pre-minified single-file IIFE string so
 *   `dist/mcp.mjs` has zero runtime dependency on `esbuild` or `node_modules`.
 * - During direct TypeScript execution (e.g. Vitest), this lazily compiles
 *   `src/mcp-app/card-app.ts` in memory once and caches the result.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cachedBundle: string | null = null

export function getMcpAppCardJs(): string {
  if (cachedBundle !== null) return cachedBundle
  const here = dirname(fileURLToPath(import.meta.url))
  const entry = join(here, 'card-app.ts')
  const req = createRequire(import.meta.url)
  const esbuild = req('esbuild') as typeof import('esbuild')
  const result = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
    write: false,
  })
  const output = result.outputFiles?.[0]?.text ?? ''
  cachedBundle = output
  return cachedBundle
}
