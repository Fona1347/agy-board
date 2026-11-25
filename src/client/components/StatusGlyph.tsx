import { CheckCircle2, Circle, Clock, Loader2, ShieldAlert, XCircle } from 'lucide-react'
import type { TaskPhase, TaskSubPhase } from '../../core/types.ts'

export function StatusGlyph({
  phase,
  subPhase,
  size = 15,
  animate = true,
}: {
  phase: TaskPhase
  subPhase?: TaskSubPhase
  size?: number
  animate?: boolean
}) {
  if (phase === 'needs_you') {
    if (subPhase === 'review') {
      return (
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: size,
            height: size,
            borderRadius: '999px',
            border: '1.5px solid var(--agy-ok-fg)',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: Math.max(4, Math.round(size * 0.34)),
              height: Math.max(4, Math.round(size * 0.34)),
              borderRadius: '999px',
              background: 'var(--agy-ok-fg)',
            }}
          />
        </span>
      )
    }
    if (subPhase === 'blocked') {
      return <XCircle size={size} style={{ color: 'var(--agy-danger-fg)', flexShrink: 0 }} />
    }
    if (subPhase === 'permission_pending') {
      return <ShieldAlert size={size} style={{ color: 'var(--agy-warn-fg)', flexShrink: 0 }} />
    }
    return <Clock size={size} style={{ color: 'var(--agy-warn-fg)', flexShrink: 0 }} />
  }
  if (phase === 'active') {
    return (
      <Loader2
        size={size}
        style={{ color: 'var(--agy-active-fg)', flexShrink: 0 }}
        className={animate ? 'agy-spin' : undefined}
      />
    )
  }
  if (phase === 'on_hold') {
    return <XCircle size={size} style={{ color: 'var(--agy-danger-fg)', flexShrink: 0 }} />
  }
  if (phase === 'closed') {
    return <CheckCircle2 size={size} style={{ color: 'var(--agy-ok-fg)', flexShrink: 0 }} />
  }
  return <Circle size={size} style={{ color: 'var(--agy-muted-fg)', flexShrink: 0 }} />
}
