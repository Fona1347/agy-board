/**
 * Bundles the Node runtime entrypoints (`sidecars/board/server.mjs`, `dist/mcp.mjs`,
 * `dist/hook.mjs`, `dist/cli.mjs`) into clean ESM single-file bundles with zero
 * runtime devDependencies required on disk when installed as an Antigravity plugin.
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })
mkdirSync('sidecars/board', { recursive: true })

// Step 1: Bundle the browser MCP App card (@modelcontextprotocol/ext-apps) into a
// single minified IIFE string so `dist/mcp.mjs` embeds it with zero runtime deps.
const cardAppBuild = await build({
  entryPoints: ['src/mcp-app/card-app.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: true,
  write: false,
})
const bundledCardJs = cardAppBuild.outputFiles?.[0]?.text ?? ''
if (!bundledCardJs) {
  throw new Error('Failed to build browser bundle for src/mcp-app/card-app.ts')
}

const inlineMcpAppCardPlugin = {
  name: 'inline-mcp-app-card-bundle',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /card-bundle\.ts$/ }, () => ({
      contents: `export function getMcpAppCardJs() { return ${JSON.stringify(bundledCardJs)}; }`,
      loader: 'js',
    }))
  },
}

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
    plugins: [inlineMcpAppCardPlugin],
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
