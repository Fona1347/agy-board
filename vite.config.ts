import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Inlines the compiled CSS and classic IIFE JS bundle directly into `index.html`
 * so Antigravity's authenticated sidecar gateway serves the entire Web UI in a
 * single `GET /` response (zero `/assets/*` subresource requests, zero
 * `type="module"` / `crossorigin` CORS failures inside the Aux Pane iframe).
 */
function inlineSidecarBundle(): Plugin {
  return {
    name: 'agy-board-inline-sidecar-bundle',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlEntry = Object.values(bundle).find(
        (item) => item.type === 'asset' && item.fileName === 'index.html',
      )
      if (!htmlEntry || htmlEntry.type !== 'asset') return

      let cssCode = ''
      let jsCode = ''
      const toDelete: string[] = []

      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type === 'asset' && fileName.endsWith('.css')) {
          cssCode += (cssCode ? '\n' : '') + String(item.source)
          toDelete.push(fileName)
        } else if (item.type === 'chunk' && item.isEntry && fileName.endsWith('.js')) {
          jsCode += (jsCode ? '\n' : '') + item.code
          toDelete.push(fileName)
        }
      }

      if (!jsCode) return

      let html = String(htmlEntry.source)
      html = html.replace(/<script\b[^>]*\bsrc="\/?assets\/[^"]+\.js"[^>]*><\/script>\s*/gi, '')
      html = html.replace(/<link\b[^>]*\bhref="\/?assets\/[^"]+\.css"[^>]*>\s*/gi, '')
      html = html.replace(/<link\b[^>]*rel="modulepreload"[^>]*>\s*/gi, '')

      if (cssCode) {
        const safeCss = cssCode.replace(/<\/style/gi, '<\\/style')
        html = html.replace('</head>', () => `  <style>\n${safeCss}\n  </style>\n  </head>`)
      }

      const safeJs = jsCode.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
      html = html.replace('</body>', () => `  <script>\n${safeJs}\n  </script>\n  </body>`)

      htmlEntry.source = html
      for (const fileName of toDelete) {
        delete bundle[fileName]
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), inlineSidecarBundle()],
  build: {
    outDir: 'sidecars/board/public',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    port: 5179,
    proxy: {
      '/api': 'http://127.0.0.1:17910',
      '/preload.js': 'http://127.0.0.1:17910',
    },
  },
})
