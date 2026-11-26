import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps'
import { createCardAppController, resolveCardLocale, type ToolResultLike } from './card-ui.ts'

function applyHostContext(
  ctx: McpUiHostContext | undefined,
  onLocale: (loc: 'zh' | 'en') => void,
): void {
  if (!ctx) return
  if (ctx.theme === 'light' || ctx.theme === 'dark') {
    applyDocumentTheme(ctx.theme)
    document.documentElement.dataset.theme = ctx.theme
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables)
  }
  if (typeof ctx.locale === 'string' && ctx.locale.trim()) {
    onLocale(resolveCardLocale(ctx.locale))
  }
}

async function bootMcpAppCard(): Promise<void> {
  const root = document.getElementById('app')
  if (!root) return

  const app = new App(
    { name: 'agy-board-card', version: '0.2.0' },
    {},
    { autoResize: true },
  )

  let serverToolsEnabled = true

  const controller = createCardAppController({
    root,
    locale: resolveCardLocale(),
    canCallTools: () => serverToolsEnabled,
    callTool: async (name, args): Promise<ToolResultLike> => {
      const res = await app.callServerTool({ name, arguments: args })
      return res as unknown as ToolResultLike
    },
  })

  // Register all notification handlers BEFORE app.connect() so no event is missed.
  app.ontoolinput = (params) => {
    const rawArgs = params?.arguments as Record<string, unknown> | undefined
    const hintTitle = typeof rawArgs?.title === 'string' ? rawArgs.title : undefined
    controller.showLoading(hintTitle)
  }

  app.ontoolresult = (result) => {
    controller.handleToolResult(result as unknown as ToolResultLike)
  }

  app.ontoolcancelled = () => {
    controller.showCancelled()
  }

  app.onhostcontextchanged = (ctx) => {
    applyHostContext(ctx, (loc) => controller.setLocale(loc))
  }

  try {
    await app.connect()
    const caps = app.getHostCapabilities()
    if (caps && caps.serverTools === undefined) {
      // Keep enabled unless explicitly disabled; Antigravity advertises serverTools on inline views
      serverToolsEnabled = true
    } else if (caps) {
      serverToolsEnabled = Boolean(caps.serverTools)
    }
    applyHostContext(app.getHostContext(), (loc) => controller.setLocale(loc))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    root.textContent = `Agy Board card failed to connect: ${msg}`
  }
}

void bootMcpAppCard()
