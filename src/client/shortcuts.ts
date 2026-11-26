/**
 * Keyboard shortcut helpers and input-focus guards for Agy Board review flows.
 */

export type ReviewShortcutAction = 'approve_draft' | 'toggle_focus' | 'snooze' | 'dispatch'

/**
 * Returns true when an event target or active element is an editable control
 * (`input`, `textarea`, `select`, or `contenteditable`), so single-key shortcuts
 * never hijack user typing.
 */
export function isEditableElement(node: EventTarget | null | undefined): boolean {
  if (!node || typeof node !== 'object') return false
  const el = node as HTMLElement
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  if (typeof el.getAttribute === 'function') {
    const attr = el.getAttribute('contenteditable')
    if (attr !== null && attr.toLowerCase() !== 'false') return true
  }
  if (typeof el.closest === 'function') {
    if (el.closest('[contenteditable="true"], [contenteditable=""]')) return true
  }
  return false
}

export interface ShortcutKeyEventLike {
  key: string
  target?: EventTarget | null
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  keyCode?: number
}

/**
 * Guards against modifier chords (`Ctrl`/`Meta`/`Alt`), IME composition, and
 * active/targeted editable elements.
 */
export function shouldIgnoreBoardShortcut(e: ShortcutKeyEventLike, doc?: Document | null): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true
  if (e.isComposing || e.keyCode === 229) return true
  if (isEditableElement(e.target)) return true
  if (doc && isEditableElement(doc.activeElement)) return true
  return false
}

/**
 * Maps a single-letter review key (`A` / `F` / `S` / `D`) to its semantic action.
 */
export function resolveReviewShortcut(key: string): ReviewShortcutAction | null {
  switch (key.toLowerCase()) {
    case 'a':
      return 'approve_draft'
    case 'f':
      return 'toggle_focus'
    case 's':
      return 'snooze'
    case 'd':
      return 'dispatch'
    default:
      return null
  }
}
