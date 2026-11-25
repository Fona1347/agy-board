/**
 * Runtime path resolution for agy-board.
 * Supports explicit overrides (for tests & embedded deployments) and Antigravity plugin env vars.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export interface HostPaths {
  dbPath: string
  boardDir: string
  geminiConfigDir: string
  antigravityDataDir: string
  brainDir: string
  daemonDir: string
  projectsDir: string
  conversationSummariesDb: string
  summariesDbPath: string
  devToolsActivePortFile: string
  pluginDataDir?: string
}

export interface HostPathOverrides {
  dbPath?: string
  geminiConfigDir?: string
  antigravityDataDir?: string
  devToolsActivePortFile?: string
}

function deriveAppDataDirFromEnv(envVar: string | undefined, expectedAncestor: string): string | undefined {
  if (!envVar || envVar.includes('${')) return undefined
  let cur = resolve(envVar)
  for (let i = 0; i < 6; i += 1) {
    const parent = dirname(cur)
    if (basename(cur) === expectedAncestor) {
      return parent
    }
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

export function resolveDevToolsPortFileCandidates(home = homedir()): string[] {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    return [
      join(appData, 'Antigravity', 'DevToolsActivePort'),
      join(appData, 'antigravity', 'DevToolsActivePort'),
      join(appData, 'Antigravity IDE', 'DevToolsActivePort'),
    ]
  }
  if (process.platform === 'darwin') {
    const appSupport = join(home, 'Library', 'Application Support')
    return [
      join(appSupport, 'Antigravity', 'DevToolsActivePort'),
      join(appSupport, 'antigravity', 'DevToolsActivePort'),
      join(appSupport, 'Antigravity IDE', 'DevToolsActivePort'),
    ]
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, '.config')
  return [
    join(xdgConfig, 'antigravity', 'DevToolsActivePort'),
    join(xdgConfig, 'Antigravity', 'DevToolsActivePort'),
    join(xdgConfig, 'Antigravity IDE', 'DevToolsActivePort'),
  ]
}

export function resolveHostPaths(overrides: HostPathOverrides = {}): HostPaths {
  const home = homedir()
  const geminiConfigDir = resolve(
    overrides.geminiConfigDir ??
      process.env.AGY_BOARD_GEMINI_CONFIG_DIR ??
      process.env.ANTIGRAVITY_CONFIG_DIR ??
      join(home, '.gemini', 'config'),
  )

  const rawPluginData = [process.env.PLUGIN_DATA, process.env.AGY_BOARD_PLUGIN_DATA].find(
    (v) => typeof v === 'string' && v.trim() !== '' && !v.includes('${'),
  )

  let antigravityDataDir = overrides.antigravityDataDir ?? process.env.AGY_BOARD_ANTIGRAVITY_DATA_DIR
  if (!antigravityDataDir) {
    antigravityDataDir = deriveAppDataDirFromEnv(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, 'sidecar_data')
  }
  if (!antigravityDataDir && rawPluginData) {
    const candidate = deriveAppDataDirFromEnv(rawPluginData, 'plugin_data')
    if (candidate && (existsSync(join(candidate, 'brain')) || existsSync(join(candidate, 'conversation_summaries.db')))) {
      antigravityDataDir = candidate
    }
  }
  if (!antigravityDataDir) {
    const defaultCandidates = ['antigravity', 'antigravity-ide', 'antigravity-cli'].map((p) =>
      join(home, '.gemini', p),
    )
    antigravityDataDir =
      defaultCandidates.find(
        (c) => existsSync(join(c, 'conversation_summaries.db')) || existsSync(join(c, 'brain')),
      ) ?? defaultCandidates[0]
  }
  antigravityDataDir = resolve(antigravityDataDir)

  const explicitDataDir = process.env.AGY_BOARD_DATA_DIR
  const dbPath = resolve(
    overrides.dbPath ??
      process.env.AGY_BOARD_DB_PATH ??
      (explicitDataDir ? join(explicitDataDir, 'board.db') : join(antigravityDataDir, 'agy-board', 'board.db')),
  )

  const devToolsCandidates = resolveDevToolsPortFileCandidates(home)
  const detectedPortFile = devToolsCandidates.find((p) => existsSync(p)) ?? devToolsCandidates[0]
  const devToolsActivePortFile = resolve(
    overrides.devToolsActivePortFile ?? process.env.AGY_BOARD_DEVTOOLS_PORT_FILE ?? detectedPortFile,
  )

  const summariesDbPath = join(antigravityDataDir, 'conversation_summaries.db')

  return {
    dbPath,
    boardDir: dirname(dbPath),
    geminiConfigDir,
    antigravityDataDir,
    brainDir: join(antigravityDataDir, 'brain'),
    daemonDir: join(antigravityDataDir, 'daemon'),
    projectsDir: join(geminiConfigDir, 'projects'),
    conversationSummariesDb: summariesDbPath,
    summariesDbPath,
    devToolsActivePortFile,
    ...(rawPluginData ? { pluginDataDir: resolve(rawPluginData) } : {}),
  }
}

export function readHostThemeMode(geminiConfigDir: string): 'dark' | 'light' | 'system' | undefined {
  try {
    const cfgFile = join(geminiConfigDir, 'config.json')
    if (!existsSync(cfgFile)) return undefined
    const raw = readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')
    if (raw.length > 1024 * 1024) return undefined
    const parsed = JSON.parse(raw) as { userSettings?: { themeMode?: string } }
    const mode = parsed?.userSettings?.themeMode
    if (mode === 'THEME_MODE_LIGHT' || mode === 'light') return 'light'
    if (mode === 'THEME_MODE_DARK' || mode === 'dark') return 'dark'
    if (
      mode === 'THEME_MODE_SYSTEM' ||
      mode === 'THEME_MODE_INHERIT' ||
      mode === 'THEME_MODE_UNSPECIFIED' ||
      mode === 'system' ||
      mode === 'inherit'
    ) {
      return 'system'
    }
  } catch {
    // ignore invalid/unreadable config.json
  }
  return undefined
}
