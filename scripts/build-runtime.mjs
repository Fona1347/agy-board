/**
 * Bundles the Node runtime entrypoints (`sidecars/board/server.mjs`, `dist/mcp.mjs`,
 * `dist/hook.mjs`, `dist/cli.mjs`) into clean ESM single-file bundles with zero
 * runtime devDependencies required on disk when installed as an Antigravity plugin.
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })
mkdirSync('sidecars/board', { recursive: true })

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  external: ['sidecar_sdk', 'node:*'],
  banner: {
    js: `import { createRequire as __agyCreateRequire } from 'node:module'; const require = __agyCreateRequire(import.meta.url);`,
  },
}

await Promise.all([
  build({
    ...shared,
    entryPoints: ['src/entry/sidecar.ts'],
    outfile: 'sidecars/board/server.mjs',
  }),
  build({
    ...shared,
    entryPoints: ['src/entry/mcp.ts'],
    outfile: 'dist/mcp.mjs',
  }),
  build({
    ...shared,
    entryPoints: ['src/entry/hook.ts'],
    outfile: 'dist/hook.mjs',
  }),
  build({
    ...shared,
    entryPoints: ['src/entry/cli.ts'],
    outfile: 'dist/cli.mjs',
  }),
])

console.log('Built runtime bundles: sidecars/board/server.mjs, dist/mcp.mjs, dist/hook.mjs, dist/cli.mjs')
