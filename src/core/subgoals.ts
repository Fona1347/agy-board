/**
 * Lightweight subgoal rollup, dependency cycle validation, and close-gating.
 */
import type { SubgoalRecord, SubgoalRollup } from './types.ts'

export function computeSubgoalRollup(subgoals: readonly SubgoalRecord[]): SubgoalRollup {
  let done = 0
  let inProgress = 0
  let open = 0
  let skipped = 0
  let requiredTotal = 0
  let requiredDone = 0

  for (const sg of subgoals) {
    if (sg.status === 'done') done += 1
    else if (sg.status === 'in_progress') inProgress += 1
    else if (sg.status === 'skipped') skipped += 1
    else open += 1

    if (sg.required) {
      requiredTotal += 1
      if (sg.status === 'done') requiredDone += 1
    }
  }

  const requiredRemaining = Math.max(0, requiredTotal - requiredDone)
  const allRequiredDone = requiredRemaining === 0
  const readyForReview = requiredTotal > 0 && requiredRemaining === 0

  return {
    total: subgoals.length,
    done,
    inProgress,
    open,
    skipped,
    requiredTotal,
    requiredDone,
    requiredRemaining,
    allRequiredDone,
    readyForReview,
  }
}

export function canCloseTaskWithSubgoals(
  subgoals: readonly SubgoalRecord[],
  force = false,
): { allowed: true } | { allowed: false; reason: string; remainingRequiredIds: string[] } {
  if (force) return { allowed: true }
  const incompleteRequired = subgoals.filter((sg) => sg.required && sg.status !== 'done')
  if (incompleteRequired.length === 0) return { allowed: true }
  return {
    allowed: false,
    reason: `Cannot close task while ${incompleteRequired.length} required subgoal(s) remain incomplete.`,
    remainingRequiredIds: incompleteRequired.map((sg) => sg.id),
  }
}

export function checkSubgoalDependencies(
  subgoals: ReadonlyArray<{ id: string; dependencies: readonly string[] }>,
): { ok: true } | { ok: false; error: string } {
  const byId = new Map(subgoals.map((s) => [s.id, s]))
  for (const sg of subgoals) {
    for (const dep of sg.dependencies) {
      if (dep === sg.id) {
        return { ok: false, error: `Subgoal '${sg.id}' cannot depend on itself.` }
      }
      if (!byId.has(dep)) {
        return { ok: false, error: `Subgoal '${sg.id}' references unknown dependency '${dep}'.` }
      }
    }
  }

  // DFS cycle detection
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function dfs(id: string): boolean {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const node = byId.get(id)
    if (node) {
      for (const dep of node.dependencies) {
        if (dfs(dep)) return true
      }
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }

  for (const sg of subgoals) {
    if (dfs(sg.id)) {
      return { ok: false, error: `Subgoal dependency cycle detected involving '${sg.id}'.` }
    }
  }
  return { ok: true }
}

export function unblockedSubgoals(subgoals: readonly SubgoalRecord[]): SubgoalRecord[] {
  const doneIds = new Set(subgoals.filter((sg) => sg.status === 'done' || sg.status === 'skipped').map((sg) => sg.id))
  return subgoals.filter(
    (sg) =>
      (sg.status === 'open' || sg.status === 'in_progress') &&
      sg.dependencies.every((depId) => doneIds.has(depId)),
  )
}
