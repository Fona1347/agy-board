/**
 * Session reuse resolution and sanitized dispatch/rework prompt assembly.
 */
import type { ExecutionRecord, SubgoalRecord, TaskRecord } from './types.ts'

/**
 * Decide which existing conversationId a task run may automatically continue in,
 * or undefined to open a fresh conversation.
 *
 * Fail-closed when `idleSessionIds === undefined` (roster unknown -> mint fresh).
 */
export function reusableSessionId(
  task: Pick<TaskRecord, 'reuseSession' | 'executions' | 'conversations'>,
  idleSessionIds: ReadonlySet<string> | undefined,
  options: { force?: boolean; subgoalId?: string } = {},
): string | undefined {
  if (options.force !== true && task.reuseSession !== true) return undefined
  if (idleSessionIds === undefined) return undefined

  // 1. Check subgoal-specific conversation link first if scoped to a subgoal
  if (options.subgoalId) {
    const subLinks = task.conversations.filter((c) => c.subgoalId === options.subgoalId)
    for (let i = subLinks.length - 1; i >= 0; i -= 1) {
      if (idleSessionIds.has(subLinks[i].conversationId)) {
        return subLinks[i].conversationId
      }
    }
  }

  // 2. Check newest settled execution carrying a conversationId
  let lastSettled: ExecutionRecord | undefined
  for (let index = task.executions.length - 1; index >= 0; index -= 1) {
    const candidate = task.executions[index]
    if (
      candidate.conversationId !== undefined &&
      candidate.endedAt !== undefined &&
      (!options.subgoalId || candidate.subgoalId === options.subgoalId)
    ) {
      lastSettled = candidate
      break
    }
  }
  if (lastSettled?.conversationId && idleSessionIds.has(lastSettled.conversationId)) {
    return lastSettled.conversationId
  }

  // 3. Check primary bound conversation if force rework or reuseSession
  const primary = task.conversations.find((c) => c.role === 'primary') ?? task.conversations[0]
  if (primary && idleSessionIds.has(primary.conversationId)) {
    return primary.conversationId
  }
  return undefined
}

export function buildDispatchPrompt(
  task: TaskRecord,
  options: { subgoal?: SubgoalRecord; extraInstruction?: string } = {},
): string {
  const sections: string[] = []

  // Tag prompt prefixes
  const tagPrefixes = task.tags
    .map((tag) => tag.promptPrefix?.trim())
    .filter((v): v is string => Boolean(v))
  if (tagPrefixes.length > 0) {
    sections.push(tagPrefixes.join('\n'))
  }

  const headerParts = [`# Task: ${task.title}`, `Task ID: ${task.id}`]
  if (task.workspacePath) headerParts.push(`Workspace: ${task.workspacePath}`)
  if (options.subgoal) {
    headerParts.push(`Scoped Subgoal (${options.subgoal.id}): ${options.subgoal.title}`)
  }
  sections.push(headerParts.join('\n'))

  if (task.description.trim()) {
    sections.push(`## Description\n${task.description.trim()}`)
  }

  // Provenance from the conversation that spawned this card.
  const provenance: string[] = []
  if (task.originSummary?.trim()) provenance.push(`Why captured: ${task.originSummary.trim()}`)
  if (task.originConversationId) provenance.push(`Origin conversation: ${task.originConversationId}`)
  if (task.discoveredFromTaskId) provenance.push(`Discovered from task: ${task.discoveredFromTaskId}`)
  if (provenance.length > 0) {
    sections.push(`## Origin / Discovered From\n${provenance.join('\n')}`)
  }

  // ★ conversations explicitly promoted into the handoff capsule.
  const handoffConvs = task.conversations.filter((c) => c.includeInHandoff && c.summary?.trim())
  if (handoffConvs.length > 0) {
    const lines = handoffConvs.map((c) => `- (${c.role}) ${c.conversationId}: ${c.summary!.trim()}`)
    sections.push(`## Handoff Conclusions (★ included)\n${lines.join('\n')}`)
  }

  const bodyPrompt = options.subgoal
    ? options.subgoal.detail.trim() || options.subgoal.title
    : task.prompt.trim() || task.title
  sections.push(`## Execution Instruction\n${bodyPrompt}`)

  if (task.nextAction?.trim()) {
    sections.push(`## Next Action\n${task.nextAction.trim()}`)
  }

  if (task.blockedReason?.trim()) {
    sections.push(`## Blocked / Status Note\n${task.blockedReason.trim()}`)
  }

  if (task.freeze) {
    sections.push(
      [
        '## Context Freeze Snapshot',
        `Goal: ${task.freeze.goal}`,
        `Progress: ${task.freeze.progress}`,
        `Next: ${task.freeze.next}`,
      ].join('\n'),
    )
  }

  if (task.subgoals.length > 0) {
    const lines = task.subgoals.map((sg) => {
      const mark =
        sg.status === 'done'
          ? 'x'
          : sg.status === 'in_progress'
            ? '~'
            : sg.status === 'skipped'
              ? '-'
              : ' '
      const req = sg.required ? ' [required]' : ' [optional]'
      return `- [${mark}] (${sg.id}) ${sg.title}${req}`
    })
    sections.push(`## Subgoals\n${lines.join('\n')}`)
  }

  const settledHistory = task.executions
    .filter((e) => e.endedAt !== undefined && (e.summary?.trim() || e.error?.trim() || e.reworkInstructions?.trim()))
    .slice(-5)
  if (settledHistory.length > 0) {
    const histLines = settledHistory.map((e, index) => {
      const parts = [`#${index + 1} (${e.result ?? 'settled'})`]
      if (e.reworkInstructions?.trim()) parts.push(`Rework: ${e.reworkInstructions.trim()}`)
      if (e.summary?.trim()) parts.push(`Summary: ${e.summary.trim()}`)
      if (e.error?.trim()) parts.push(`Error: ${e.error.trim()}`)
      return `- ${parts.join(' | ')}`
    })
    sections.push(`## Prior Executions\n${histLines.join('\n')}`)
  }

  if (task.comments && task.comments.length > 0) {
    const recentComments = task.comments.slice(-5)
    const commentLines = recentComments.map((c) => `- [${c.author}] ${c.bodyMd.trim()}`)
    sections.push(`## Comments\n${commentLines.join('\n')}`)
  }

  const refLines: string[] = []
  for (const ref of task.refs) {
    refLines.push(`- [${ref.kind}] ${ref.target}${ref.label ? ` (${ref.label})` : ''}`)
  }
  for (const href of task.handover?.references ?? []) {
    if (!task.refs.some((r) => r.target === href)) {
      refLines.push(`- [handover] ${href}`)
    }
  }
  if (refLines.length > 0) {
    sections.push(`## Registered TaskSpace References\n${refLines.join('\n')}`)
  }

  if (options.extraInstruction?.trim()) {
    sections.push(`## Additional Instructions\n${options.extraInstruction.trim()}`)
  }

  return sections.join('\n\n')
}

export function buildReworkPrompt(
  task: TaskRecord,
  instructions: string,
  subgoal?: SubgoalRecord,
): string {
  const lines = [
    `[Rework Request for Task ${task.id}: ${task.title}]`,
    ...(task.worktreePath
      ? [
          `Worktree: ${task.worktreePath}${task.worktreeBranch ? ` (branch: ${task.worktreeBranch})` : ''}`,
        ]
      : []),
    ...(subgoal ? [`Subgoal (${subgoal.id}): ${subgoal.title}`] : []),
    '',
    instructions.trim(),
  ]
  if (task.refs.length > 0) {
    lines.push('', 'Registered references:')
    for (const ref of task.refs.slice(0, 12)) {
      lines.push(`- [${ref.kind}] ${ref.target}`)
    }
  }
  return lines.join('\n')
}
