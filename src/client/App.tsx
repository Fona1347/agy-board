import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Clock,
  Columns3,
  FlaskConical,
  FolderGit2,
  FolderPlus,
  Languages,
  Layers,
  List,
  LogOut,
  Maximize2,
  Monitor,
  Moon,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Tag,
  Target,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import type {
  BoardFocusRequest,
  BoardSnapshot,
  DiscoveredConversation,
  TaskPhase,
  TaskRecord,
  WorkspaceRecord,
} from '../core/types.ts'
import { fileUriToPath, isPathEqualOrInside, matchWorkspaceForPath, normalizeFsPath, pathComparisonKey } from '../core/workspace.ts'
import { boardApi, getSidecar, setBoardApiSandbox, type ConversationGovernanceConfig } from './api.ts'
import { createDemoSandboxController, type DemoSandboxController } from './demoSandbox.ts'
import { FocusView } from './components/FocusView.tsx'
import { KanbanView, type BoardLayoutTier } from './components/KanbanView.tsx'
import { ListView, type ListGroupBy } from './components/ListView.tsx'
import { NewTaskModal } from './components/NewTaskModal.tsx'
import {
  hasAnyScheduleOrReminder,
  isMissedSchedule,
  ScheduleAlertBanner,
} from './components/ScheduleComposer.tsx'
import { TaskDetailDrawer } from './components/TaskDetailDrawer.tsx'
import { tr, type Locale } from './i18n.ts'
import {
  collectWorkspaceFolders,
  detectColorLuminanceTheme,
  isInsideSidecarIframe,
  matchesWorkspaceFilter,
  parseWorkspaceFilter,
  pathBasename,
} from './utils.ts'

export type BoardViewMode = 'focus' | 'kanban' | 'list'

function readInitialLocale(): Locale {
  try {
    const saved = globalThis.localStorage?.getItem('agy-board:locale')
    if (saved === 'zh' || saved === 'en') return saved
  } catch {
    // ignore
  }
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function readInitialTheme(): 'dark' | 'light' | 'system' {
  try {
    const saved = globalThis.localStorage?.getItem('agy-board:theme')
    if (saved === 'dark' || saved === 'light' || saved === 'system') return saved
  } catch {
    // ignore
  }
  return 'system'
}

function readInitialAutoOpen(): boolean {
  try {
    const saved = globalThis.localStorage?.getItem('agy-board:autoOpenSession')
    if (saved === 'true') return true
    if (saved === 'false') return false
  } catch {
    // ignore
  }
  return isInsideSidecarIframe()
}

function readInitialView(): BoardViewMode {
  try {
    const saved = globalThis.localStorage?.getItem('agy-board:viewMode')
    if (saved === 'focus' || saved === 'kanban' || saved === 'list') return saved
  } catch {
    // ignore
  }
  return 'focus'
}

function readInitialListGroupBy(): ListGroupBy {
  try {
    const saved = globalThis.localStorage?.getItem('agy-board:listGroupBy')
    if (saved === 'workspace' || saved === 'status' || saved === 'schedule' || saved === 'tag') return saved
  } catch {
    // ignore
  }
  return 'workspace'
}

function readRootBackgroundTheme(): 'dark' | 'light' | null {
  if (typeof document === 'undefined') return null
  const inlineVal = document.documentElement.style.getPropertyValue('--background').trim()
  if (inlineVal) {
    const detected = detectColorLuminanceTheme(inlineVal)
    if (detected) return detected
  }
  try {
    const computedVal = getComputedStyle(document.documentElement).getPropertyValue('--background').trim()
    if (computedVal) return detectColorLuminanceTheme(computedVal)
  } catch {
    // ignore
  }
  return null
}

function readMediaTheme(): 'dark' | 'light' {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    }
  } catch {
    // ignore
  }
  return 'dark'
}

export function matchesBoardSearch(task: TaskRecord, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return true
  const needle = q.startsWith('#') ? q.slice(1) : q
  const parts = [
    task.title,
    task.description,
    task.prompt,
    task.workspaceLabel ?? '',
    task.workspacePath ?? '',
    task.nextAction ?? '',
    task.blockedReason ?? '',
    task.freeze?.goal ?? '',
    task.freeze?.progress ?? '',
    task.freeze?.next ?? '',
    ...task.tags.map((t) => t.name),
    ...task.refs.map((r) => r.target),
    ...task.subgoals.map((s) => s.title),
  ]
  return parts.some((p) => p.toLowerCase().includes(needle))
}

const DEFAULT_GOVERNANCE_CONFIG: ConversationGovernanceConfig = {
  autoRename: true,
  titlePrefix: '[Board]',
  autoTag: true,
  autoGroup: true,
  conversationGroupId: 'agy-board',
  autoArchiveOnFinish: true,
}

const FOCUS_REQUEST_TTL_MS = 30_000
const FOCUS_NONCE_STORAGE_KEY = 'agy-board:lastHandledFocusNonce'

function readInitialUrlTaskId(): string | null {
  try {
    if (typeof window === 'undefined' || !window.location?.search) return null
    const id = new URLSearchParams(window.location.search).get('taskId')?.trim()
    return id || null
  } catch {
    return null
  }
}

function readLastHandledFocusNonce(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(FOCUS_NONCE_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

function saveLastHandledFocusNonce(nonce: string): void {
  try {
    globalThis.sessionStorage?.setItem(FOCUS_NONCE_STORAGE_KEY, nonce)
  } catch {
    // ignore
  }
}

export function App({ initialSnapshot }: { initialSnapshot?: BoardSnapshot }) {
  const shellRef = useRef<HTMLDivElement>(null)
  const revisionRef = useRef<number>(initialSnapshot?.revision ?? 0)
  const snapshotRef = useRef<BoardSnapshot | null>(initialSnapshot ?? null)
  const lastHandledFocusNonceRef = useRef<string | null>(readLastHandledFocusNonce())

  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(initialSnapshot ?? null)
  const [pendingFocusTaskId, setPendingFocusTaskId] = useState<string | null>(readInitialUrlTaskId)
  const [containerWidth, setContainerWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1024,
  )
  const [activeWorkspaceUris, setActiveWorkspaceUris] = useState<string[]>([])
  const [workspaceFilter, setWorkspaceFilter] = useState<string>('')
  const [onlyThisWorkspace, setOnlyThisWorkspace] = useState(false)
  const [search, setSearch] = useState('')
  const [showNarrowSearch, setShowNarrowSearch] = useState(false)
  const [selectedTag, setSelectedTag] = useState('')
  const [onlyScheduled, setOnlyScheduled] = useState(false)
  const [viewMode, setViewModeState] = useState<BoardViewMode>(readInitialView)
  const [listGroupBy, setListGroupByState] = useState<ListGroupBy>(readInitialListGroupBy)
  const [showArchived, setShowArchived] = useState(false)
  const [locale, setLocale] = useState<Locale>(readInitialLocale)
  const [themePref, setThemePref] = useState<'dark' | 'light' | 'system'>(readInitialTheme)
  const [polledHostTheme, setPolledHostTheme] = useState<'dark' | 'light' | 'system' | null>(
    () => initialSnapshot?.hostTheme ?? null,
  )
  const [rootBgTheme, setRootBgTheme] = useState<'dark' | 'light' | null>(readRootBackgroundTheme)
  const [mediaTheme, setMediaTheme] = useState<'dark' | 'light'>(readMediaTheme)
  const [autoOpenSession, setAutoOpenSession] = useState<boolean>(readInitialAutoOpen)
  const [governance, setGovernance] = useState<ConversationGovernanceConfig>(DEFAULT_GOVERNANCE_CONFIG)
  const [cleaningConversations, setCleaningConversations] = useState(false)

  const [showFilterPopover, setShowFilterPopover] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [showNewModal, setShowNewModal] = useState(false)
  const [newTaskDefaults, setNewTaskDefaults] = useState<{
    workspaceId?: string
    workspacePath?: string
    title?: string
    conversationId?: string
  }>({})
  const [showAddWorkspace, setShowAddWorkspace] = useState(false)
  const [newWsPath, setNewWsPath] = useState('')
  const [newWsName, setNewWsName] = useState('')
  const [renamingWsId, setRenamingWsId] = useState<string | null>(null)
  const [renameWsDraft, setRenameWsDraft] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [demoMode, setDemoMode] = useState(false)
  const demoControllerRef = useRef<DemoSandboxController | null>(null)
  const preSandboxStateRef = useRef<{
    snapshot: BoardSnapshot | null
    workspaceFilter: string
    onlyThisWorkspace: boolean
    selectedTag: string
    onlyScheduled: boolean
    showArchived: boolean
    search: string
  } | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
  }, [])

  useEffect(() => {
    return () => {
      setBoardApiSandbox(null)
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    snapshotRef.current = snapshot
    if (snapshot?.revision !== undefined) {
      revisionRef.current = snapshot.revision
    }
  }, [snapshot])

  useEffect(() => {
    if (!pendingFocusTaskId || !snapshot) return
    const target = snapshot.tasks.find((t) => t.id === pendingFocusTaskId)
    if (!target) return
    if (target.archivedAt !== undefined) {
      setShowArchived(true)
    }
    setSelectedTaskId(target.id)
    setPendingFocusTaskId(null)
  }, [pendingFocusTaskId, snapshot])

  useEffect(() => {
    if (!showFilterPopover) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowFilterPopover(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showFilterPopover])

  // Track container width dynamically for narrow Aux Pane ergonomics (never overrides user's view choice)
  useEffect(() => {
    const el = shellRef.current
    const measure = () => {
      const elW = el?.getBoundingClientRect?.().width ?? 0
      const winW = typeof window !== 'undefined' ? window.innerWidth : 0
      const candidates = [elW, winW].filter((w) => w > 0)
      if (candidates.length > 0) {
        setContainerWidth(Math.min(...candidates))
      }
    }
    measure()
    let ro: ResizeObserver | undefined
    if (el && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure())
      ro.observe(el)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', measure)
    }
    return () => {
      ro?.disconnect()
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', measure)
      }
    }
  }, [])

  // Observe :root mutations and host theme-change postMessage events
  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      window.parent === window &&
      window.location?.pathname?.startsWith('/c/') &&
      typeof window.history?.replaceState === 'function'
    ) {
      try {
        window.history.replaceState(null, '', '/')
      } catch {
        // ignore
      }
    }
    if (typeof document === 'undefined') return
    setRootBgTheme(readRootBackgroundTheme())
    let observer: MutationObserver | undefined
    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(() => {
        setRootBgTheme(readRootBackgroundTheme())
      })
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'class', 'data-theme'],
      })
    }
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'theme-change') {
        const bgVar = event.data?.payload?.cssVariables?.['--background']
        if (typeof bgVar === 'string') {
          const detected = detectColorLuminanceTheme(bgVar)
          if (detected) {
            setRootBgTheme(detected)
            return
          }
        }
        queueMicrotask(() => setRootBgTheme(readRootBackgroundTheme()))
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('message', handleMessage)
    }
    let mql: MediaQueryList | undefined
    const handleMedia = () => setMediaTheme(readMediaTheme())
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      mql = window.matchMedia('(prefers-color-scheme: light)')
      mql.addEventListener?.('change', handleMedia)
    }
    return () => {
      observer?.disconnect()
      if (typeof window !== 'undefined') {
        window.removeEventListener('message', handleMessage)
      }
      mql?.removeEventListener?.('change', handleMedia)
    }
  }, [])

  const layoutTier: BoardLayoutTier =
    containerWidth <= 640 ? 'narrow' : containerWidth > 860 ? 'wide' : 'medium'

  const setViewMode = (next: BoardViewMode) => {
    if (viewMode === 'list' && next !== 'list') {
      setSelectedTaskId(null)
    }
    setViewModeState(next)
    try {
      globalThis.localStorage?.setItem('agy-board:viewMode', next)
    } catch {
      // ignore
    }
  }

  const setListGroupBy = (next: ListGroupBy) => {
    setListGroupByState(next)
    try {
      globalThis.localStorage?.setItem('agy-board:listGroupBy', next)
    } catch {
      // ignore
    }
  }

  const activeWorkspacePaths = useMemo(
    () => activeWorkspaceUris.map((u) => fileUriToPath(u)).filter(Boolean),
    [activeWorkspaceUris],
  )

  const fetchSnapshot = useCallback(async () => {
    try {
      const next = await boardApi.getSnapshot(activeWorkspacePaths)
      setSnapshot(next)
      if (next.hostTheme) setPolledHostTheme(next.hostTheme)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }, [activeWorkspacePaths])

  useEffect(() => {
    const sidecar = getSidecar()
    if (!sidecar) return
    void sidecar.getWorkspaceUris().then((uris) => {
      if (Array.isArray(uris) && uris.length > 0) setActiveWorkspaceUris(uris)
    })
    return sidecar.onWorkspaceChange((uris) => {
      setActiveWorkspaceUris(uris)
    })
  }, [])

  useEffect(() => {
    if (!initialSnapshot && !demoMode) void fetchSnapshot()
  }, [fetchSnapshot, initialSnapshot, demoMode])

  useEffect(() => {
    if (initialSnapshot && !demoMode) return
    if (!showFilterPopover) return
    let cancelled = false
    void boardApi
      .getConversationGovernance()
      .then((res) => {
        if (!cancelled && res?.config) setGovernance(res.config)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [showFilterPopover, initialSnapshot, demoMode])

  useEffect(() => {
    if (initialSnapshot || demoMode) return
    const sidecar = getSidecar()
    const applyFocusSignal = (focus: BoardFocusRequest | null | undefined, serverTime?: number) => {
      if (!focus?.taskId || !focus.nonce) return
      if (focus.nonce === lastHandledFocusNonceRef.current) return
      const nowRef = typeof serverTime === 'number' && Number.isFinite(serverTime) ? serverTime : Date.now()
      lastHandledFocusNonceRef.current = focus.nonce
      saveLastHandledFocusNonce(focus.nonce)
      if (nowRef - focus.ts > FOCUS_REQUEST_TTL_MS) return
      setPendingFocusTaskId(focus.taskId)
      const currentTasks = snapshotRef.current?.tasks ?? []
      const existing = currentTasks.find((t) => t.id === focus.taskId)
      if (existing) {
        if (existing.archivedAt !== undefined) setShowArchived(true)
        setSelectedTaskId(existing.id)
        setPendingFocusTaskId(null)
        showToast(locale === 'zh' ? `已定位到任务：${existing.title}` : `Focused task: ${existing.title}`)
      } else {
        void fetchSnapshot()
      }
    }
    const checkRevisionAndHostTheme = () => {
      void boardApi
        .getRevision()
        .then(({ revision, serverTime, hostTheme, focus }) => {
          if (hostTheme) setPolledHostTheme(hostTheme)
          if (revision !== revisionRef.current) {
            revisionRef.current = revision
            void fetchSnapshot()
          }
          if (focus) {
            applyFocusSignal(focus, serverTime)
          }
        })
        .catch(() => {})
    }
    checkRevisionAndHostTheme()
    if (!sidecar && typeof EventSource !== 'undefined') {
      const es = new EventSource('/api/events')
      es.addEventListener('revision', () => {
        void fetchSnapshot()
      })
      es.addEventListener('focus', (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent).data) as BoardFocusRequest
          applyFocusSignal(parsed)
        } catch {
          // ignore malformed focus event
        }
      })
      const themePoll = setInterval(checkRevisionAndHostTheme, 2000)
      const onVisible = () => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          checkRevisionAndHostTheme()
        }
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('focus', onVisible)
      }
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisible)
      }
      return () => {
        es.close()
        clearInterval(themePoll)
        if (typeof window !== 'undefined') {
          window.removeEventListener('focus', onVisible)
        }
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisible)
        }
      }
    }
    const poll = setInterval(checkRevisionAndHostTheme, 1500)
    return () => clearInterval(poll)
  }, [fetchSnapshot, initialSnapshot, demoMode, locale, showToast])

  const activeHostMode = polledHostTheme ?? snapshot?.hostTheme ?? null
  const pinnedHostTheme =
    activeHostMode === 'dark' || activeHostMode === 'light' ? activeHostMode : null
  const effectiveTheme: 'dark' | 'light' =
    themePref === 'dark' || themePref === 'light'
      ? themePref
      : (rootBgTheme ?? pinnedHostTheme ?? mediaTheme)

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.theme = effectiveTheme
    document.documentElement.dataset.themeSource = themePref === 'system' ? 'host' : 'user'
  }, [effectiveTheme, themePref])

  const toggleLocale = () => {
    const next: Locale = locale === 'en' ? 'zh' : 'en'
    setLocale(next)
    try {
      globalThis.localStorage?.setItem('agy-board:locale', next)
    } catch {
      // ignore
    }
  }

  const selectTheme = (next: 'system' | 'light' | 'dark') => {
    setThemePref(next)
    try {
      if (next === 'system') {
        globalThis.localStorage?.removeItem('agy-board:theme')
      } else {
        globalThis.localStorage?.setItem('agy-board:theme', next)
      }
    } catch {
      // ignore
    }
  }

  const toggleAutoOpenSession = () => {
    const next = !autoOpenSession
    setAutoOpenSession(next)
    try {
      globalThis.localStorage?.setItem('agy-board:autoOpenSession', String(next))
    } catch {
      // ignore
    }
  }

  const handleToggleGovernance = async (
    key: 'autoRename' | 'autoTag' | 'autoGroup' | 'autoArchiveOnFinish',
  ) => {
    const nextVal = !governance[key]
    setGovernance((prev) => ({ ...prev, [key]: nextVal }))
    try {
      const res = await boardApi.updateConversationGovernance({ [key]: nextVal })
      if (res?.config) setGovernance(res.config)
    } catch (err) {
      setGovernance((prev) => ({ ...prev, [key]: !nextVal }))
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCleanupFinishedConversations = async () => {
    if (cleaningConversations) return
    setCleaningConversations(true)
    try {
      const res = await boardApi.cleanupFinishedConversations()
      if (!res.available) {
        showToast(
          locale === 'zh'
            ? '当前环境不支持 Antigravity 2.35+ 会话归档接口'
            : 'Antigravity 2.35+ archive API is unavailable',
        )
      } else if (res.candidateCount === 0) {
        showToast(
          locale === 'zh'
            ? '没有需要清理的已完结会话'
            : 'No finished conversations to archive',
        )
      } else if (res.failedIds.length > 0) {
        showToast(
          locale === 'zh'
            ? `已归档 ${res.archivedIds.length} 个已完结会话（${res.failedIds.length} 个失败）`
            : `Archived ${res.archivedIds.length} finished chat(s) (${res.failedIds.length} failed)`,
        )
      } else {
        showToast(
          demoMode
            ? locale === 'zh'
              ? `演示沙箱：已模拟归档 ${res.archivedIds.length} 个已完结会话`
              : `Demo Sandbox: simulated archiving ${res.archivedIds.length} finished chat(s)`
            : locale === 'zh'
              ? `已归档 ${res.archivedIds.length} 个已完结会话`
              : `Archived ${res.archivedIds.length} finished chat(s)`,
        )
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    } finally {
      setCleaningConversations(false)
    }
  }

  const allTasks = snapshot?.tasks ?? []
  const workspaces = snapshot?.workspaces ?? []

  const sortedWorkspaces = useMemo(() => {
    return [...workspaces].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [workspaces])

  const workspaceSelectOptionValues = useMemo(() => {
    const values = new Set<string>([''])
    for (const ws of sortedWorkspaces) {
      values.add(ws.id)
      const folders = collectWorkspaceFolders(ws)
      const hasMulti =
        folders.length > 1 ||
        (folders.length === 1 && pathComparisonKey(folders[0]) !== pathComparisonKey(ws.rootPath))
      if (hasMulti) {
        for (const fp of folders) {
          values.add(`path:${fp}`)
        }
      }
    }
    return values
  }, [sortedWorkspaces])

  const normalizeCardWorkspaceFilter = useCallback(
    (rawKey: string): string => {
      if (!rawKey.startsWith('path:')) return rawKey
      const targetKey = pathComparisonKey(rawKey.slice(5))
      if (!targetKey) return rawKey
      for (const ws of sortedWorkspaces) {
        const folders = collectWorkspaceFolders(ws)
        const hasMulti =
          folders.length > 1 ||
          (folders.length === 1 && pathComparisonKey(folders[0]) !== pathComparisonKey(ws.rootPath))
        if (!hasMulti && folders.length === 1 && pathComparisonKey(folders[0]) === targetKey) {
          return ws.id
        }
        if (hasMulti) {
          const exactFolder = folders.find((fp) => pathComparisonKey(fp) === targetKey)
          if (exactFolder) return `path:${exactFolder}`
        }
      }
      return rawKey
    },
    [sortedWorkspaces],
  )

  const resolvedSelectFilterValue = useMemo(() => {
    if (!workspaceFilter) return ''
    if (workspaceFilter === '__unbound__') return '__unbound__'
    if (workspaceSelectOptionValues.has(workspaceFilter)) return workspaceFilter
    if (workspaceFilter.startsWith('ws:') && workspaceSelectOptionValues.has(workspaceFilter.slice(3))) {
      return workspaceFilter.slice(3)
    }
    const normalized = normalizeCardWorkspaceFilter(workspaceFilter)
    if (workspaceSelectOptionValues.has(normalized)) return normalized
    return ''
  }, [workspaceFilter, workspaceSelectOptionValues, normalizeCardWorkspaceFilter])

  const knownTags = useMemo(() => {
    const set = new Set<string>()
    for (const t of allTasks) {
      for (const tag of t.tags) set.add(tag.name)
    }
    return [...set].sort()
  }, [allTasks])

  const filteredTasks = useMemo(() => {
    return allTasks.filter((task) => {
      if (showArchived ? task.archivedAt === undefined : task.archivedAt !== undefined) return false

      if (onlyThisWorkspace && activeWorkspacePaths.length > 0) {
        if (!task.workspacePath) return false
        const matchesActive = activeWorkspacePaths.some(
          (ap) => isPathEqualOrInside(task.workspacePath!, ap) || isPathEqualOrInside(ap, task.workspacePath!),
        )
        if (!matchesActive) return false
      } else if (workspaceFilter) {
        if (!matchesWorkspaceFilter(task, workspaceFilter, workspaces)) return false
      }

      if (selectedTag && !task.tags.some((t) => t.name === selectedTag)) return false
      if (onlyScheduled && !hasAnyScheduleOrReminder(task)) return false
      if (!matchesBoardSearch(task, search)) return false
      return true
    })
  }, [allTasks, showArchived, onlyThisWorkspace, activeWorkspacePaths, workspaceFilter, workspaces, selectedTag, onlyScheduled, search])

  const hasNonSearchFilter = Boolean(workspaceFilter || onlyThisWorkspace || selectedTag || showArchived || onlyScheduled)

  const scheduledTaskCount = useMemo(
    () => allTasks.filter((t) => (showArchived ? t.archivedAt !== undefined : t.archivedAt === undefined) && hasAnyScheduleOrReminder(t)).length,
    [allTasks, showArchived],
  )

  const finishedConversationCount = useMemo(() => {
    const openConvIds = new Set<string>()
    for (const t of allTasks) {
      if (t.archivedAt === undefined && t.phase !== 'closed') {
        for (const c of t.conversations) openConvIds.add(c.conversationId)
      }
    }
    const candidates = new Set<string>()
    for (const t of allTasks) {
      if (t.phase !== 'closed' && t.archivedAt === undefined) continue
      for (const c of t.conversations) {
        if (c.role === 'origin' || c.role === 'reference') continue
        if (!openConvIds.has(c.conversationId)) candidates.add(c.conversationId)
      }
      for (const ex of t.executions) {
        if (ex.conversationId && ex.endedAt !== undefined && !openConvIds.has(ex.conversationId)) {
          candidates.add(ex.conversationId)
        }
      }
    }
    return candidates.size
  }, [allTasks])

  const activeWorkspaceLabel = useMemo(() => {
    if (!workspaceFilter) return ''
    if (workspaceFilter === '__unbound__') return tr(locale, 'unboundBadge')
    if (workspaceFilter.startsWith('path:')) return pathBasename(workspaceFilter.slice(5)) || normalizeFsPath(workspaceFilter.slice(5))
    const ws = workspaces.find((w) => w.id === workspaceFilter || `ws:${w.id}` === workspaceFilter)
    return ws?.name ?? workspaceFilter
  }, [workspaceFilter, workspaces, locale])

  const workspaceScopeLabel = onlyThisWorkspace
    ? tr(locale, 'thisWorkspace')
    : workspaceFilter
      ? activeWorkspaceLabel || normalizeFsPath(workspaceFilter.replace(/^path:/, ''))
      : tr(locale, 'allWorkspaces')

  const now = snapshot?.serverTime ?? Date.now()
  const dueReminderTasks = useMemo(
    () =>
      allTasks.filter(
        (t) =>
          t.archivedAt === undefined &&
          t.phase !== 'closed' &&
          t.userMarks?.ignoredAt === undefined &&
          ((t.reminderAt !== undefined &&
            t.reminderAt <= now &&
            (t.remindedAt === undefined || t.remindedAt < t.reminderAt)) ||
            (t.phase === 'needs_you' && t.subPhase === 'reminder_due')),
      ),
    [allTasks, now],
  )

  const missedScheduleTasks = useMemo(
    () =>
      allTasks.filter(
        (t) =>
          t.archivedAt === undefined &&
          t.phase !== 'closed' &&
          t.userMarks?.ignoredAt === undefined &&
          isMissedSchedule(t.schedule),
      ),
    [allTasks],
  )

  const selectedTask = selectedTaskId ? allTasks.find((t) => t.id === selectedTaskId) ?? null : null

  const enterDemoSandbox = useCallback(() => {
    preSandboxStateRef.current = {
      snapshot,
      workspaceFilter,
      onlyThisWorkspace,
      selectedTag,
      onlyScheduled,
      showArchived,
      search,
    }
    const ctrl = createDemoSandboxController({ locale })
    demoControllerRef.current = ctrl
    setBoardApiSandbox(ctrl.api)
    setDemoMode(true)
    setSelectedTaskId(null)
    setWorkspaceFilter('')
    setOnlyThisWorkspace(false)
    setSelectedTag('')
    setOnlyScheduled(false)
    setShowArchived(false)
    setSearch('')
    setLoadError(null)
    setSnapshot(ctrl.getSnapshot())
    setShowFilterPopover(false)
    showToast(tr(locale, 'demoSandboxEntered'))
  }, [locale, onlyScheduled, onlyThisWorkspace, search, selectedTag, showArchived, showToast, snapshot, workspaceFilter])

  const resetDemoSandbox = useCallback(() => {
    if (!demoControllerRef.current) return
    const next = demoControllerRef.current.reset(Date.now(), locale)
    setSnapshot(next)
    setSelectedTaskId(null)
    setWorkspaceFilter('')
    setOnlyThisWorkspace(false)
    setSelectedTag('')
    setOnlyScheduled(false)
    setShowArchived(false)
    setSearch('')
    showToast(tr(locale, 'demoSandboxResetToast'))
  }, [locale, showToast])

  const exitDemoSandbox = useCallback(() => {
    setBoardApiSandbox(null)
    demoControllerRef.current = null
    setDemoMode(false)
    setSelectedTaskId(null)
    setShowFilterPopover(false)
    const saved = preSandboxStateRef.current
    preSandboxStateRef.current = null
    if (saved) {
      setWorkspaceFilter(saved.workspaceFilter)
      setOnlyThisWorkspace(saved.onlyThisWorkspace)
      setSelectedTag(saved.selectedTag)
      setOnlyScheduled(saved.onlyScheduled)
      setShowArchived(saved.showArchived)
      setSearch(saved.search)
      if (saved.snapshot) {
        setSnapshot(saved.snapshot)
      }
    }
    showToast(tr(locale, 'demoSandboxExited'))
  }, [showToast])

  const handleJump = async (conversationId: string, options?: { split?: 'right' }) => {
    try {
      const res = await boardApi.jumpToConversation(conversationId, options)
      showToast(res.message)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleConfirmPermission = async (taskId: string) => {
    try {
      await boardApi.confirmPermission(taskId)
      showToast(locale === 'zh' ? '权限已确认' : 'Permission confirmed')
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleApproveAndClose = async (taskId: string) => {
    try {
      await boardApi.transitionTask(taskId, 'closed', { subPhase: 'done' })
      showToast(locale === 'zh' ? '已验收通过' : 'Approved & completed')
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleAcceptScheduleCycle = async (taskId: string) => {
    try {
      const { task: updated } = await boardApi.completeScheduleCycle(taskId)
      const nextAt = updated.schedule?.nextRunAt
      const nextText = nextAt
        ? new Date(nextAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : ''
      showToast(
        locale === 'zh'
          ? `已验收本轮${nextText ? ` · 下次：${nextText}` : ''}`
          : `Accepted round${nextText ? ` · Next: ${nextText}` : ''}`,
      )
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCatchUpRun = async (taskId: string) => {
    try {
      await boardApi.catchUpSchedule(taskId, 'run')
      showToast(locale === 'zh' ? '已立即补跑' : 'Caught up schedule')
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCatchUpSkip = async (taskId: string) => {
    try {
      await boardApi.catchUpSchedule(taskId, 'skip')
      showToast(locale === 'zh' ? '已跳过本次补跑' : 'Skipped missed slot')
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleAlertStartSession = async (task: TaskRecord) => {
    if (!task.workspacePath && !task.workspaceId) {
      setSelectedTaskId(task.id)
      return
    }
    try {
      const res = await boardApi.dispatch(task.id, { mode: 'auto' })
      if (autoOpenSession && res.conversationId) {
        void boardApi.jumpToConversation(res.conversationId)
      }
      showToast(
        demoMode
          ? locale === 'zh'
            ? `演示沙箱：已模拟拉起会话 ${res.conversationId.slice(0, 8)}`
            : `Demo Sandbox: simulated session ${res.conversationId.slice(0, 8)}`
          : locale === 'zh'
            ? `已拉起会话 ${res.conversationId.slice(0, 8)}`
            : `Started session ${res.conversationId.slice(0, 8)}`,
      )
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSnoozeReminder = async (task: TaskRecord) => {
    try {
      await boardApi.setReminder(task.id, Date.now() + 60 * 60_000)
      if (task.phase === 'needs_you' && task.subPhase === 'reminder_due') {
        await boardApi.transitionTask(task.id, 'todo', { subPhase: 'ready', blockedReason: null })
      }
      showToast(locale === 'zh' ? '已延后 1 小时提醒' : 'Snoozed 1h')
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleAckReminder = async (task: TaskRecord) => {
    try {
      if (task.reminderAt !== undefined) {
        await boardApi.setReminder(task.id, null)
      }
      if (task.phase === 'needs_you' && task.subPhase === 'reminder_due') {
        await boardApi.transitionTask(task.id, 'todo', { subPhase: 'ready', blockedReason: null })
      }
      showToast(locale === 'zh' ? '已确认提醒' : 'Reminder acknowledged')
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleToggleManualComplete = async (task: TaskRecord) => {
    try {
      if (task.phase === 'closed') {
        await boardApi.transitionTask(task.id, 'todo', { subPhase: 'ready' })
      } else {
        await boardApi.transitionTask(task.id, 'closed', { subPhase: 'done' })
      }
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleToggleIgnore = async (taskId: string, ignore: boolean) => {
    try {
      await boardApi.setMarks(taskId, { ignore })
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleTogglePin = async (taskId: string, pin: boolean) => {
    try {
      await boardApi.setMarks(taskId, { pin })
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSnoozeTask = async (taskId: string, snoozeUntil: number | null) => {
    try {
      await boardApi.setMarks(taskId, { snoozeUntil })
      showToast(
        snoozeUntil === null
          ? locale === 'zh'
            ? '已解除延后'
            : 'Unsnoozed'
          : locale === 'zh'
            ? '已延后提醒'
            : 'Snoozed',
      )
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleToggleTodoSubPhase = async (task: TaskRecord) => {
    try {
      // Draft → Ready is the human approval gate; Ready/Backlog keep toggling.
      const nextSub =
        task.subPhase === 'backlog' ? 'ready' : task.subPhase === 'draft' ? 'ready' : 'backlog'
      await boardApi.transitionTask(task.id, 'todo', { subPhase: nextSub })
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleMovePhase = async (taskId: string, targetPhase: TaskPhase, sortOrder?: number) => {
    if (targetPhase === 'on_hold') return
    try {
      await boardApi.transitionTask(
        taskId,
        targetPhase,
        targetPhase === 'active' ? { subPhase: 'working' } : {},
      )
      if (sortOrder !== undefined) {
        const list = allTasks
          .filter((t) => t.archivedAt === undefined && t.phase === targetPhase && t.id !== taskId)
          .map((t) => t.id)
        const boundedIdx = Math.min(Math.max(0, sortOrder), list.length)
        list.splice(boundedIdx, 0, taskId)
        await boardApi.reorderTasks(targetPhase, list)
      }
      if (demoMode) {
        showToast(locale === 'zh' ? '演示沙箱：已模拟更新状态（仅内存）' : 'Demo Sandbox: simulated move (in-memory only)')
      }
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleKanbanDispatch = async (taskId: string) => {
    try {
      const res = await boardApi.dispatch(taskId, { mode: 'auto' })
      showToast(
        demoMode
          ? locale === 'zh'
            ? '演示沙箱：已模拟转入运行中'
            : 'Demo Sandbox: simulated active run'
          : locale === 'zh'
            ? '已启动 AI 会话'
            : 'AI session started',
      )
      if (autoOpenSession && res.conversationId) {
        void boardApi.jumpToConversation(res.conversationId).catch(() => {})
      }
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleKanbanConfirmAndDispatch = async (taskId: string) => {
    try {
      await boardApi.confirmPermission(taskId)
      const res = await boardApi.dispatch(taskId, { mode: 'auto' })
      showToast(
        demoMode
          ? locale === 'zh'
            ? '演示沙箱：已模拟确认权限并运行'
            : 'Demo Sandbox: permission confirmed & simulated run'
          : locale === 'zh'
            ? '已确认权限并启动 AI 会话'
            : 'Permission confirmed & AI started',
      )
      if (autoOpenSession && res.conversationId) {
        void boardApi.jumpToConversation(res.conversationId).catch(() => {})
      }
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleReorderPhase = async (phase: TaskPhase, orderedIds: string[]) => {
    try {
      await boardApi.reorderTasks(phase, orderedIds)
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRegisterWorkspace = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newWsPath.trim()) return
    try {
      const { workspace } = await boardApi.registerWorkspace({
        name: newWsName.trim() || undefined,
        rootPath: newWsPath.trim(),
        pinned: true,
      })
      setShowAddWorkspace(false)
      setNewWsPath('')
      setNewWsName('')
      setWorkspaceFilter(workspace.id)
      showToast(`Added workspace ${workspace.name}`)
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleToggleWorkspacePin = async (ws: WorkspaceRecord) => {
    try {
      await boardApi.updateWorkspace({ workspaceId: ws.id, pinned: !ws.pinned })
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRenameWorkspace = async (wsId: string) => {
    const nextName = renameWsDraft.trim()
    if (!nextName) return
    try {
      await boardApi.updateWorkspace({ workspaceId: wsId, name: nextName })
      setRenamingWsId(null)
      setRenameWsDraft('')
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDeleteWorkspace = async (ws: WorkspaceRecord) => {
    try {
      await boardApi.deleteWorkspace(ws.id)
      const parsed = parseWorkspaceFilter(workspaceFilter, workspaces)
      if (
        (parsed.kind === 'workspace' && parsed.id === ws.id) ||
        (parsed.kind === 'path' &&
          collectWorkspaceFolders(ws).some((fp) => pathComparisonKey(fp) === pathComparisonKey(parsed.path)))
      ) {
        setWorkspaceFilter('')
      }
      await fetchSnapshot()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const resolveNewTaskDefaultsFromFilter = (): { workspaceId?: string; workspacePath?: string } => {
    if (onlyThisWorkspace && activeWorkspacePaths.length > 0) {
      const matched = matchWorkspaceForPath(activeWorkspacePaths[0], workspaces)
      return {
        workspaceId: matched?.id ?? snapshot?.activeProjectId,
        workspacePath: activeWorkspacePaths[0],
      }
    }
    if (workspaceFilter) {
      const parsed = parseWorkspaceFilter(workspaceFilter, workspaces)
      if (parsed.kind === 'unbound') {
        return {}
      }
      if (parsed.kind === 'path') {
        const matched = matchWorkspaceForPath(parsed.path, workspaces)
        return {
          workspaceId: matched?.id,
          workspacePath: parsed.path,
        }
      }
      if (parsed.kind === 'workspace') {
        const ws = workspaces.find((w) => w.id === parsed.id || w.antigravityProjectId === parsed.id)
        const folders = ws ? collectWorkspaceFolders(ws) : []
        return {
          workspaceId: ws?.id ?? parsed.id,
          workspacePath: folders[0] ?? ws?.rootPath,
        }
      }
    }
    if (activeWorkspacePaths.length > 0) {
      const matched = matchWorkspaceForPath(activeWorkspacePaths[0], workspaces)
      return {
        workspaceId: matched?.id ?? snapshot?.activeProjectId,
        workspacePath: activeWorkspacePaths[0],
      }
    }
    const fallbackWs = workspaces.find((w) => w.id === snapshot?.activeProjectId)
    return {
      workspaceId: fallbackWs?.id ?? snapshot?.activeProjectId,
      workspacePath: fallbackWs?.folderPaths[0] ?? fallbackWs?.rootPath,
    }
  }

  const handleOpenFullScreen = () => {
    if (typeof window === 'undefined') return
    const url = window.location.href
    let win: Window | null = null
    try {
      win = window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      win = null
    }
    if (!win) {
      void navigator.clipboard?.writeText(url).catch(() => {})
      showToast(`Open in browser: ${url}`)
    }
  }

  const sessionDefaultPermission = snapshot?.sessionDefaultPermission ?? 'read-only'

  return (
    <div
      ref={shellRef}
      className={`board-shell is-${layoutTier}`}
      data-layout={layoutTier}
      data-ag-no-i18n="true"
    >
      {/* Single-Row Hong-Style Header */}
      <header className="board-header">
        <div className="header-left">
          <span className="brand-title">{tr(locale, 'todosTitle')}</span>
          <div className="view-tabs" role="tablist" aria-label="View mode">
            <button
              type="button"
              className={`view-tab-btn${viewMode === 'focus' ? ' is-active' : ''}`}
              onClick={() => setViewMode('focus')}
            >
              <Target size={13} />
              <span>{tr(locale, 'focus')}</span>
            </button>
            <button
              type="button"
              className={`view-tab-btn${viewMode === 'kanban' ? ' is-active' : ''}`}
              onClick={() => setViewMode('kanban')}
            >
              <Columns3 size={13} />
              <span>{tr(locale, 'kanban')}</span>
            </button>
            <button
              type="button"
              className={`view-tab-btn${viewMode === 'list' ? ' is-active' : ''}`}
              onClick={() => setViewMode('list')}
            >
              <List size={13} />
              <span>{tr(locale, 'list')}</span>
            </button>
          </div>
        </div>

        <div className="header-right">
          {layoutTier !== 'narrow' && (
            <button
              type="button"
              className={`ws-scope-pill${onlyThisWorkspace || workspaceFilter ? ' is-filtered' : ''}`}
              onClick={() => setShowFilterPopover((v) => !v)}
              title={workspaceScopeLabel}
              data-testid="workspace-scope-pill"
            >
              <FolderGit2 size={12} />
              <span>{workspaceScopeLabel}</span>
            </button>
          )}
          {layoutTier !== 'narrow' ? (
            <div className="header-search-wrap">
              <Search size={13} className="header-search-icon" />
              <input
                className="header-search-input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={tr(locale, 'searchPlaceholder')}
                aria-label={tr(locale, 'searchPlaceholder')}
              />
              {search && (
                <button
                  type="button"
                  className="header-search-clear"
                  onClick={() => setSearch('')}
                  aria-label={tr(locale, 'clear')}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              className={`icon-btn${showNarrowSearch || search ? ' is-active' : ''}`}
              onClick={() => setShowNarrowSearch((v) => !v)}
              aria-label={tr(locale, 'searchPlaceholder')}
              title={tr(locale, 'searchPlaceholder')}
            >
              <Search size={14} />
            </button>
          )}

          <button
            type="button"
            className={`icon-btn${showFilterPopover || hasNonSearchFilter ? ' is-active' : ''}`}
            onClick={() => setShowFilterPopover((v) => !v)}
            aria-label={tr(locale, 'filterAndSettings')}
            title={tr(locale, 'filterAndSettings')}
          >
            <SlidersHorizontal size={14} />
            {hasNonSearchFilter && <span className="filter-active-dot" />}
          </button>

          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setNewTaskDefaults(resolveNewTaskDefaultsFromFilter())
              setShowNewModal(true)
            }}
          >
            <Plus size={13} />
            <span>{layoutTier === 'narrow' ? tr(locale, 'quickTask').replace(/^\+\s*/, '') : tr(locale, 'newTask')}</span>
          </button>
        </div>
      </header>

      {/* Expandable Search Bar on Narrow Aux Pane */}
      {layoutTier === 'narrow' && showNarrowSearch && (
        <div className="header-narrow-search">
          <Search size={13} style={{ color: 'var(--agy-muted-fg)', flexShrink: 0 }} />
          <input
            className="search-input"
            style={{ flex: 1 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tr(locale, 'searchPlaceholder')}
            aria-label={tr(locale, 'searchPlaceholder')}
            autoFocus
          />
          {search && (
            <button type="button" className="btn btn-xs btn-ghost" onClick={() => setSearch('')}>
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {/* Filter & Settings Popover */}
      {showFilterPopover && (
        <>
          <div className="popover-backdrop" onClick={() => setShowFilterPopover(false)} />
          <div className="filter-popover" role="dialog" aria-label={tr(locale, 'filterAndSettings')} data-testid="filter-popover">
            <div className="popover-head">
              <span>{tr(locale, 'filterAndSettings')}</span>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setShowFilterPopover(false)} aria-label={tr(locale, 'close')}>
                <X size={13} />
              </button>
            </div>

            <div className="popover-section">
              <span className="popover-label">{tr(locale, 'workspace')}</span>
              <select
                className="select-field"
                aria-label={tr(locale, 'workspace')}
                value={resolvedSelectFilterValue}
                onChange={(e) => {
                  setWorkspaceFilter(e.target.value)
                  setOnlyThisWorkspace(false)
                }}
              >
                <option value="">{tr(locale, 'allWorkspaces')}</option>
                {workspaceFilter === '__unbound__' && (
                  <option value="__unbound__">{tr(locale, 'unboundBadge')}</option>
                )}
                {sortedWorkspaces.map((ws) => {
                  const folders = collectWorkspaceFolders(ws)
                  const hasMulti =
                    folders.length > 1 ||
                    (folders.length === 1 && pathComparisonKey(folders[0]) !== pathComparisonKey(ws.rootPath))
                  return [
                    <option key={ws.id} value={ws.id}>
                      {ws.pinned ? '★ ' : ''}
                      {ws.name}
                      {ws.rootPath ? ` (${ws.rootPath})` : ''}
                    </option>,
                    ...(hasMulti
                      ? folders.map((fp) => (
                          <option key={`${ws.id}:path:${fp}`} value={`path:${fp}`}>
                            {'  '}↳ {ws.name} / {pathBasename(fp)} ({fp})
                          </option>
                        ))
                      : []),
                  ]
                })}
              </select>

              <div className="row-wrap">
                {activeWorkspacePaths.length > 0 && (
                  <button
                    type="button"
                    className={`btn btn-xs btn-pill${onlyThisWorkspace ? ' is-active' : ''}`}
                    onClick={() => {
                      setOnlyThisWorkspace((v) => !v)
                      setWorkspaceFilter('')
                    }}
                    title={activeWorkspacePaths.join(', ')}
                  >
                    {tr(locale, 'thisWorkspace')}
                  </button>
                )}
                <button
                  type="button"
                  className={`btn btn-xs${showAddWorkspace ? ' is-active' : ''}`}
                  onClick={() => setShowAddWorkspace((v) => !v)}
                >
                  <FolderPlus size={12} />
                  <span>{tr(locale, 'manageWorkspaces')}</span>
                </button>
              </div>
            </div>

            {showAddWorkspace && (
              <div className="popover-section" style={{ borderTop: '1px solid var(--agy-border)', paddingTop: 8 }}>
                <form className="row-wrap" onSubmit={(e) => void handleRegisterWorkspace(e)}>
                  <input
                    className="input-field"
                    style={{ flex: '1 1 160px', fontSize: 11.5 }}
                    value={newWsPath}
                    onChange={(e) => setNewWsPath(e.target.value)}
                    placeholder="/path/to/my-repo"
                  />
                  <input
                    className="input-field"
                    style={{ width: 95, fontSize: 11.5 }}
                    value={newWsName}
                    onChange={(e) => setNewWsName(e.target.value)}
                    placeholder="Label"
                  />
                  <button type="submit" className="btn btn-xs btn-primary">
                    {tr(locale, 'save')}
                  </button>
                </form>

                {sortedWorkspaces.length > 0 && (
                  <div className="ws-manager-list" style={{ maxHeight: 160, overflowY: 'auto' }}>
                    {sortedWorkspaces.map((ws) => {
                      const folders = collectWorkspaceFolders(ws)
                      const isRenaming = renamingWsId === ws.id
                      return (
                        <div key={ws.id} className="ws-manager-item">
                          <div className="row-wrap" style={{ flex: 1, minWidth: 0 }}>
                            {isRenaming ? (
                              <>
                                <input
                                  className="input-field"
                                  style={{ width: 120, fontSize: 11.5 }}
                                  value={renameWsDraft}
                                  onChange={(e) => setRenameWsDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault()
                                      void handleRenameWorkspace(ws.id)
                                    }
                                    if (e.key === 'Escape') setRenamingWsId(null)
                                  }}
                                  autoFocus
                                />
                                <button
                                  type="button"
                                  className="btn btn-xs btn-primary"
                                  onClick={() => void handleRenameWorkspace(ws.id)}
                                >
                                  {tr(locale, 'save')}
                                </button>
                              </>
                            ) : (
                              <>
                                <strong style={{ fontSize: 11.5 }}>{ws.name}</strong>
                                {folders.map((fp) => (
                                  <button
                                    key={fp}
                                    type="button"
                                    className="ws-micro-tag"
                                    title={fp}
                                    onClick={() => {
                                      setOnlyThisWorkspace(false)
                                      setWorkspaceFilter(`path:${fp}`)
                                    }}
                                  >
                                    {pathBasename(fp) || fp}
                                  </button>
                                ))}
                              </>
                            )}
                          </div>
                          <div className="row-wrap">
                            <button
                              type="button"
                              className={`btn btn-xs${ws.pinned ? ' is-active' : ''}`}
                              onClick={() => void handleToggleWorkspacePin(ws)}
                              title={ws.pinned ? tr(locale, 'unpin') : tr(locale, 'pin')}
                            >
                              {ws.pinned ? <PinOff size={10} /> : <Pin size={10} />}
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs"
                              onClick={() => {
                                setRenamingWsId(ws.id)
                                setRenameWsDraft(ws.name)
                              }}
                              title={tr(locale, 'rename')}
                            >
                              <Pencil size={10} />
                            </button>
                            {ws.source === 'custom' && (
                              <button
                                type="button"
                                className="btn btn-xs btn-danger"
                                onClick={() => void handleDeleteWorkspace(ws)}
                                title={tr(locale, 'delete')}
                              >
                                <Trash2 size={10} />
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {knownTags.length > 0 && (
              <div className="popover-section">
                <span className="popover-label">{tr(locale, 'allTags')}</span>
                <div className="row-wrap">
                  <button
                    type="button"
                    className={`btn btn-xs btn-pill${selectedTag === '' ? ' is-active' : ''}`}
                    onClick={() => setSelectedTag('')}
                  >
                    {tr(locale, 'allTags')}
                  </button>
                  {knownTags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className={`btn btn-xs btn-pill${selectedTag === tag ? ' is-active' : ''}`}
                      onClick={() => setSelectedTag((cur) => (cur === tag ? '' : tag))}
                    >
                      #{tag}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="popover-section">
              <span className="popover-label">{tr(locale, 'viewLabel')}</span>
              <div className="popover-grid-2">
                <button
                  type="button"
                  className={`btn btn-xs${listGroupBy === 'workspace' ? ' is-active' : ''}`}
                  onClick={() => setListGroupBy('workspace')}
                >
                  {tr(locale, 'groupByWorkspace')}
                </button>
                <button
                  type="button"
                  className={`btn btn-xs${listGroupBy === 'status' ? ' is-active' : ''}`}
                  onClick={() => setListGroupBy('status')}
                >
                  {tr(locale, 'groupByStatus')}
                </button>
                <button
                  type="button"
                  className={`btn btn-xs${listGroupBy === 'schedule' ? ' is-active' : ''}`}
                  onClick={() => setListGroupBy('schedule')}
                >
                  {tr(locale, 'groupBySchedule')}
                </button>
                <button
                  type="button"
                  className={`btn btn-xs${listGroupBy === 'tag' ? ' is-active' : ''}`}
                  onClick={() => setListGroupBy('tag')}
                >
                  {tr(locale, 'groupByTag')}
                </button>
              </div>
            </div>

            <div className="popover-section">
              <span className="popover-label">{tr(locale, 'themeLabel')}</span>
              <div className="popover-grid-3" role="group" aria-label={tr(locale, 'themeLabel')}>
                <button
                  type="button"
                  className={`btn btn-xs${themePref === 'system' ? ' is-active' : ''}`}
                  onClick={() => selectTheme('system')}
                >
                  <Monitor size={11} />
                  <span>{tr(locale, 'followHostTheme')}</span>
                </button>
                <button
                  type="button"
                  className={`btn btn-xs${themePref === 'light' ? ' is-active' : ''}`}
                  onClick={() => selectTheme('light')}
                >
                  <Sun size={11} />
                  <span>{tr(locale, 'lightTheme')}</span>
                </button>
                <button
                  type="button"
                  className={`btn btn-xs${themePref === 'dark' ? ' is-active' : ''}`}
                  onClick={() => selectTheme('dark')}
                >
                  <Moon size={11} />
                  <span>{tr(locale, 'darkTheme')}</span>
                </button>
              </div>
            </div>

            <div className="popover-section" style={{ borderTop: '1px solid var(--agy-border)', paddingTop: 10 }}>
              <div className="popover-grid-2">
                <button
                  type="button"
                  className={`btn btn-xs${onlyScheduled ? ' is-active' : ''}`}
                  onClick={() => setOnlyScheduled((v) => !v)}
                  data-testid="filter-only-scheduled"
                >
                  <Clock size={11} />
                  <span>
                    {tr(locale, 'onlyScheduled')} ({scheduledTaskCount})
                  </span>
                </button>
                <button
                  type="button"
                  className={`btn btn-xs${showArchived ? ' is-active' : ''}`}
                  onClick={() => setShowArchived((v) => !v)}
                >
                  <Archive size={11} />
                  <span>{tr(locale, 'archived')}</span>
                </button>
                <button
                  type="button"
                  className={`btn btn-xs${autoOpenSession ? ' is-active' : ''}`}
                  onClick={toggleAutoOpenSession}
                >
                  <Zap size={11} />
                  <span>{tr(locale, 'autoOpenSession')}</span>
                </button>
                <button type="button" className="btn btn-xs" onClick={toggleLocale}>
                  <Languages size={11} />
                  <span>{locale === 'en' ? '中文' : 'English'}</span>
                </button>
                <button type="button" className="btn btn-xs" onClick={() => void fetchSnapshot()}>
                  <RefreshCw size={11} />
                  <span>{tr(locale, 'refresh')}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-xs"
                  style={{ gridColumn: '1 / -1' }}
                  onClick={handleOpenFullScreen}
                >
                  <Maximize2 size={11} />
                  <span>{tr(locale, 'openFullScreen')}</span>
                </button>
              </div>
            </div>

            <div className="popover-section" style={{ borderTop: '1px solid var(--agy-border)', paddingTop: 10 }}>
              <span className="popover-label">
                {locale === 'zh' ? '会话侧栏治理 (agy 2.35+)' : 'Sidebar Governance (agy 2.35+)'}
              </span>
              <div className="popover-grid-2">
                <button
                  type="button"
                  className={`btn btn-xs${governance.autoRename ? ' is-active' : ''}`}
                  aria-pressed={governance.autoRename}
                  data-testid="gov-toggle-rename"
                  onClick={() => void handleToggleGovernance('autoRename')}
                >
                  <Pencil size={11} />
                  <span>{locale === 'zh' ? `自动改名 ${governance.titlePrefix}` : `Rename ${governance.titlePrefix}`}</span>
                </button>
                <button
                  type="button"
                  className={`btn btn-xs${governance.autoTag ? ' is-active' : ''}`}
                  aria-pressed={governance.autoTag}
                  data-testid="gov-toggle-tag"
                  onClick={() => void handleToggleGovernance('autoTag')}
                >
                  <Tag size={11} />
                  <span>{locale === 'zh' ? '打标 agy-board' : 'Tag agy-board'}</span>
                </button>
                <button
                  type="button"
                  className={`btn btn-xs${governance.autoGroup ? ' is-active' : ''}`}
                  aria-pressed={governance.autoGroup}
                  data-testid="gov-toggle-group"
                  onClick={() => void handleToggleGovernance('autoGroup')}
                >
                  <Layers size={11} />
                  <span>{locale === 'zh' ? '归组折叠' : 'Group sidebar'}</span>
                </button>
                <button
                  type="button"
                  className={`btn btn-xs${governance.autoArchiveOnFinish ? ' is-active' : ''}`}
                  aria-pressed={governance.autoArchiveOnFinish}
                  data-testid="gov-toggle-archive"
                  onClick={() => void handleToggleGovernance('autoArchiveOnFinish')}
                >
                  <Archive size={11} />
                  <span>{locale === 'zh' ? '完结同步归档' : 'Auto-archive done'}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-xs"
                  style={{ gridColumn: '1 / -1' }}
                  disabled={cleaningConversations}
                  data-testid="gov-cleanup-finished"
                  onClick={() => void handleCleanupFinishedConversations()}
                >
                  <Sparkles size={11} />
                  <span>
                    {cleaningConversations
                      ? locale === 'zh'
                        ? '正在清理已完结会话...'
                        : 'Archiving finished chats...'
                      : locale === 'zh'
                        ? `一键清理已完结会话 (${finishedConversationCount})`
                        : `Archive Finished Chats (${finishedConversationCount})`}
                  </span>
                </button>
              </div>
            </div>

            <div className="popover-section" style={{ borderTop: '1px solid var(--agy-border)', paddingTop: 10 }}>
              <button
                type="button"
                className={`demo-sandbox-toggle-btn${demoMode ? ' is-active' : ''}`}
                aria-pressed={demoMode}
                data-testid="demo-sandbox-toggle"
                onClick={() => (demoMode ? exitDemoSandbox() : enterDemoSandbox())}
              >
                <span className="demo-sandbox-toggle-main">
                  <FlaskConical size={14} style={{ flexShrink: 0 }} />
                  <span className="demo-sandbox-toggle-text">
                    <span className="demo-sandbox-toggle-title">{tr(locale, 'demoSandbox')}</span>
                    <span className="demo-sandbox-toggle-sub">{tr(locale, 'demoSandboxHint')}</span>
                  </span>
                </span>
                <span className="demo-sandbox-state-pill">
                  {demoMode ? tr(locale, 'demoSandboxOn') : tr(locale, 'demoSandboxOff')}
                </span>
              </button>
            </div>
          </div>
        </>
      )}

      {demoMode && (
        <div className="demo-sandbox-banner" role="status" data-testid="demo-sandbox-banner">
          <span className="demo-sandbox-banner-label">
            <FlaskConical size={13} style={{ flexShrink: 0 }} />
            <span>{tr(locale, 'demoSandboxBanner')}</span>
          </span>
          <div className="demo-sandbox-banner-actions">
            <button
              type="button"
              className="btn btn-xs"
              data-testid="demo-sandbox-reset"
              onClick={resetDemoSandbox}
            >
              <RotateCcw size={11} />
              <span>{tr(locale, 'demoSandboxReset')}</span>
            </button>
            <button
              type="button"
              className="btn btn-xs btn-primary"
              data-testid="demo-sandbox-exit"
              onClick={exitDemoSandbox}
            >
              <LogOut size={11} />
              <span>{tr(locale, 'demoSandboxExit')}</span>
            </button>
          </div>
        </div>
      )}

      {/* Active Filter Chips Bar (only shown when filtered) */}
      {hasNonSearchFilter && (
        <div className="active-filter-bar">
          {onlyThisWorkspace && (
            <button
              type="button"
              className="btn btn-xs btn-pill is-active"
              onClick={() => setOnlyThisWorkspace(false)}
            >
              <span>{tr(locale, 'thisWorkspace')}</span>
              <X size={10} />
            </button>
          )}
          {workspaceFilter && (
            <button
              type="button"
              className="btn btn-xs btn-pill is-active"
              onClick={() => setWorkspaceFilter('')}
            >
              <span>{activeWorkspaceLabel || normalizeFsPath(workspaceFilter.replace(/^path:/, ''))}</span>
              <X size={10} />
            </button>
          )}
          {selectedTag && (
            <button
              type="button"
              className="btn btn-xs btn-pill is-active"
              onClick={() => setSelectedTag('')}
            >
              <span>#{selectedTag}</span>
              <X size={10} />
            </button>
          )}
          {onlyScheduled && (
            <button
              type="button"
              className="btn btn-xs btn-pill is-active"
              onClick={() => setOnlyScheduled(false)}
            >
              <span>⏰ {tr(locale, 'onlyScheduled')}</span>
              <X size={10} />
            </button>
          )}
          {showArchived && (
            <button
              type="button"
              className="btn btn-xs btn-pill is-active"
              onClick={() => setShowArchived(false)}
            >
              <span>{tr(locale, 'archived')}</span>
              <X size={10} />
            </button>
          )}
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            onClick={() => {
              setWorkspaceFilter('')
              setOnlyThisWorkspace(false)
              setSelectedTag('')
              setShowArchived(false)
              setOnlyScheduled(false)
            }}
          >
            {tr(locale, 'clearFilter')}
          </button>
        </div>
      )}

      <ScheduleAlertBanner
        locale={locale}
        now={now}
        dueReminders={dueReminderTasks}
        missedSchedules={missedScheduleTasks}
        onOpenTask={setSelectedTaskId}
        onStartSession={(t) => void handleAlertStartSession(t)}
        onSnoozeReminder={(t) => void handleSnoozeReminder(t)}
        onAckReminder={(t) => void handleAckReminder(t)}
        onCatchUpRun={(id) => void handleCatchUpRun(id)}
        onCatchUpSkip={(id) => void handleCatchUpSkip(id)}
      />

      {loadError && (
        <div className="banner-strip banner-danger">
          <span>{loadError}</span>
        </div>
      )}

      <main className={`board-main${viewMode === 'list' ? ' is-list-mode' : ''}`}>
        {viewMode === 'focus' && (
          <FocusView
            tasks={filteredTasks}
            locale={locale}
            sessionDefaultPermission={sessionDefaultPermission}
            now={now}
            showWorkspaceTag
            onOpenTask={setSelectedTaskId}
            onFilterWorkspace={(key) => {
              const normalized = normalizeCardWorkspaceFilter(key)
              setOnlyThisWorkspace(false)
              setWorkspaceFilter((cur) => (normalizeCardWorkspaceFilter(cur) === normalized ? '' : normalized))
            }}
            onToggleManualComplete={(t) => void handleToggleManualComplete(t)}
            onToggleIgnore={(id, ignore) => void handleToggleIgnore(id, ignore)}
            onTogglePin={(id, pin) => void handleTogglePin(id, pin)}
            onSnoozeTask={(id, until) => void handleSnoozeTask(id, until)}
            onJump={(cid, opts) => void handleJump(cid, opts)}
            onConfirmPermission={(id) => void handleConfirmPermission(id)}
            onApproveAndClose={(id) => void handleApproveAndClose(id)}
            onAcceptScheduleCycle={(id) => void handleAcceptScheduleCycle(id)}
          />
        )}

        {viewMode === 'kanban' && (
          <KanbanView
            tasks={filteredTasks}
            locale={locale}
            layoutTier={layoutTier}
            sessionDefaultPermission={sessionDefaultPermission}
            maxConcurrentLaunches={snapshot?.maxConcurrentLaunches ?? 3}
            now={now}
            showWorkspaceTag
            onOpenTask={setSelectedTaskId}
            onFilterWorkspace={(key) => {
              const normalized = normalizeCardWorkspaceFilter(key)
              setOnlyThisWorkspace(false)
              setWorkspaceFilter((cur) => (normalizeCardWorkspaceFilter(cur) === normalized ? '' : normalized))
            }}
            onToggleManualComplete={(t) => void handleToggleManualComplete(t)}
            onJump={(cid, opts) => void handleJump(cid, opts)}
            onConfirmPermission={(id) => void handleConfirmPermission(id)}
            onApproveAndClose={(id) => void handleApproveAndClose(id)}
            onAcceptScheduleCycle={(id) => void handleAcceptScheduleCycle(id)}
            onMovePhase={(id, phase, order) => void handleMovePhase(id, phase, order)}
            onReorderPhase={(phase, ids) => void handleReorderPhase(phase, ids)}
            onDispatchTask={handleKanbanDispatch}
            onConfirmAndDispatch={handleKanbanConfirmAndDispatch}
            onSwitchToList={(nextGroupBy) => {
              if (nextGroupBy) setListGroupBy(nextGroupBy)
              setViewMode('list')
            }}
          />
        )}

        {viewMode === 'list' && (
          <ListView
            tasks={filteredTasks}
            workspaces={sortedWorkspaces}
            recentConversations={snapshot?.recentConversations ?? []}
            activeWorkspacePaths={activeWorkspacePaths}
            hasActiveFilter={Boolean(search.trim() || selectedTag || workspaceFilter || onlyThisWorkspace || showArchived || onlyScheduled)}
            locale={locale}
            now={now}
            groupBy={listGroupBy}
            isNarrow={containerWidth < 740}
            selectedTask={selectedTask}
            sessionDefaultPermission={sessionDefaultPermission}
            autoOpenSession={autoOpenSession}
            defaultTimeZone={snapshot?.timeZone}
            onChangeGroupBy={setListGroupBy}
            onSelectTask={setSelectedTaskId}
            onCreateInWorkspace={(wsPath, wsId, conv?: DiscoveredConversation) => {
              setNewTaskDefaults({
                workspacePath: wsPath,
                workspaceId: wsId,
                title: conv?.title,
                conversationId: conv?.conversationId,
              })
              setShowNewModal(true)
            }}
            onToggleManualComplete={(t) => void handleToggleManualComplete(t)}
            onTogglePin={(id, pin) => void handleTogglePin(id, pin)}
            onToggleTodoSubPhase={(t) => void handleToggleTodoSubPhase(t)}
            onTaskUpdated={fetchSnapshot}
            onToast={showToast}
          />
        )}
      </main>

      {showNewModal && (
        <NewTaskModal
          locale={locale}
          workspaces={sortedWorkspaces}
          recentConversations={snapshot?.recentConversations ?? []}
          defaultWorkspaceId={newTaskDefaults.workspaceId}
          defaultWorkspacePath={newTaskDefaults.workspacePath}
          defaultTitle={newTaskDefaults.title}
          defaultConversationId={newTaskDefaults.conversationId}
          defaultPinToFocus={viewMode === 'focus'}
          onClose={() => setShowNewModal(false)}
          onCreate={async (input, linkConversationId) => {
            const { task } = await boardApi.createTask(input)
            if (linkConversationId) {
              try {
                await boardApi.linkConversation(task.id, {
                  conversationId: linkConversationId,
                  role: 'primary',
                })
              } catch (err) {
                showToast(`Task created, link failed: ${err instanceof Error ? err.message : String(err)}`)
                await fetchSnapshot()
                return
              }
            }
            showToast(locale === 'zh' ? '已新建待办' : 'Todo created')
            await fetchSnapshot()
          }}
        />
      )}

      {selectedTask && viewMode !== 'list' && (
        <TaskDetailDrawer
          key={selectedTask.id}
          task={selectedTask}
          locale={locale}
          workspaces={sortedWorkspaces}
          recentConversations={snapshot?.recentConversations ?? []}
          sessionDefaultPermission={sessionDefaultPermission}
          autoOpenSession={autoOpenSession}
          defaultTimeZone={snapshot?.timeZone}
          onClose={() => setSelectedTaskId(null)}
          onTaskUpdated={fetchSnapshot}
          onToast={showToast}
        />
      )}

      {toast && <div className="toast-bar">{toast}</div>}
    </div>
  )
}
