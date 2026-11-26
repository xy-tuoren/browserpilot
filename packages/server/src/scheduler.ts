import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DirectCDPTransport, SessionManager } from '@browserpilot/core'
import { ensureBrowserPilotHome, getBrowserPilotHomeDir } from './config.js'
import { launchManagedBrowser } from './cli/launch.js'
import { parseWorkflowPayload, runSingleReplayStep, type ReplayFlowStep, type ReplayToolCaller } from './cli/replay.js'
import { getShortcut } from './shortcuts-memory.js'
import { executeTool, type ToolRuntimeContext } from './tools.js'

export interface ScheduledTask {
  id: string
  name: string
  every: string
  intervalMs: number
  flowPath?: string
  shortcut?: string
  code?: string
  headless: boolean
  enabled: boolean
  createdAt: number
  nextRunAt: number
  lastRunAt?: number
  lastStatus?: 'ok' | 'error'
  lastError?: string
  lastDurationMs?: number
  runCount: number
}

export interface ScheduleRunReport {
  id: string
  name: string
  ok: boolean
  durationMs: number
  error?: string
  output?: string
}

function getSchedulesPath(): string {
  return path.join(getBrowserPilotHomeDir(), 'schedules.json')
}

export function parseIntervalMs(raw: string | number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw < 1_000) throw new Error('Schedule interval must be at least 1s (1000ms)')
    return Math.round(raw)
  }
  const s = String(raw).trim().toLowerCase()
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/.exec(s)
  if (!m) {
    throw new Error(`Invalid interval "${raw}". Use formats like "30s", "15m", "1h", or "24h".`)
  }
  const n = Number(m[1])
  const unit = m[2]
  let ms = n
  if (unit === 's' || unit === 'sec' || unit === 'secs') ms = n * 1_000
  else if (unit === 'm' || unit === 'min' || unit === 'mins') ms = n * 60_000
  else if (unit === 'h' || unit === 'hr' || unit === 'hrs') ms = n * 3_600_000
  else if (unit === 'd' || unit === 'day' || unit === 'days') ms = n * 86_400_000
  if (ms < 1_000) throw new Error('Schedule interval must be at least 1s')
  return Math.round(ms)
}

export async function listSchedules(): Promise<ScheduledTask[]> {
  try {
    const raw = await fs.readFile(getSchedulesPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ScheduledTask[]) : []
  } catch {
    return []
  }
}

async function writeSchedules(tasks: ScheduledTask[]): Promise<void> {
  await ensureBrowserPilotHome()
  await fs.writeFile(getSchedulesPath(), JSON.stringify(tasks, null, 2) + '\n', { mode: 0o600 })
}

export async function addSchedule(input: {
  name: string
  every: string | number
  flowPath?: string
  shortcut?: string
  code?: string
  headless?: boolean
}): Promise<ScheduledTask> {
  const name = input.name.trim()
  if (!name) throw new Error('Schedule name is required')
  if (!input.flowPath && !input.shortcut && !input.code) {
    throw new Error('Provide one of flowPath, shortcut, or code for the scheduled task')
  }
  const intervalMs = parseIntervalMs(input.every)
  const everyLabel = typeof input.every === 'string' ? input.every.trim() : `${Math.round(intervalMs / 1000)}s`
  const now = Date.now()
  const tasks = await listSchedules()
  const existingIdx = tasks.findIndex((t) => t.name.toLowerCase() === name.toLowerCase())

  const task: ScheduledTask = {
    id: existingIdx >= 0 ? tasks[existingIdx].id : `sched_${crypto.randomBytes(4).toString('hex')}`,
    name,
    every: everyLabel,
    intervalMs,
    ...(input.flowPath ? { flowPath: path.resolve(input.flowPath) } : {}),
    ...(input.shortcut ? { shortcut: input.shortcut.trim().replace(/^\/+/, '') } : {}),
    ...(input.code ? { code: input.code } : {}),
    headless: input.headless !== false,
    enabled: true,
    createdAt: existingIdx >= 0 ? tasks[existingIdx].createdAt : now,
    nextRunAt: now + intervalMs,
    runCount: existingIdx >= 0 ? tasks[existingIdx].runCount : 0,
  }

  if (existingIdx >= 0) tasks[existingIdx] = task
  else tasks.push(task)
  await writeSchedules(tasks)
  return task
}

export async function removeSchedule(idOrName: string): Promise<boolean> {
  const needle = idOrName.trim().toLowerCase()
  const tasks = await listSchedules()
  const filtered = tasks.filter((t) => t.id.toLowerCase() !== needle && t.name.toLowerCase() !== needle)
  if (filtered.length === tasks.length) return false
  await writeSchedules(filtered)
  return true
}

export async function executeScheduledTask(
  task: ScheduledTask,
  daemonToolContext?: () => ToolRuntimeContext,
): Promise<ScheduleRunReport> {
  const startedAt = Date.now()
  let launched: Awaited<ReturnType<typeof launchManagedBrowser>> | null = null
  let transport: DirectCDPTransport | null = null
  let manager: SessionManager | null = null

  try {
    let caller: ReplayToolCaller
    if (task.headless || !daemonToolContext) {
      launched = await launchManagedBrowser({ headless: true, ephemeral: true })
      transport = await DirectCDPTransport.connect(launched.endpoint)
      manager = new SessionManager(transport)
      const runtimeCtx: ToolRuntimeContext = {
        getManager: () => manager!,
        listClients: () => [
          {
            clientId: `sched-${task.id}`,
            transport: 'direct-cdp',
            browser: `Chromium (${launched!.endpoint})`,
            connectedAt: Date.now(),
            lastSeenAt: Date.now(),
            attachedTabCount: manager!.getAttachedTabCount(),
          },
        ],
      }
      caller = { callTool: (tool, args) => executeTool(runtimeCtx, tool, args) }
    } else {
      const ctx = daemonToolContext()
      caller = { callTool: (tool, args) => executeTool(ctx, tool, args) }
    }

    let steps: ReplayFlowStep[] | undefined
    let code = task.code

    if (task.flowPath) {
      const raw = await fs.readFile(task.flowPath, 'utf8')
      steps = parseWorkflowPayload(raw).steps
    } else if (task.shortcut) {
      const sc = await getShortcut(task.shortcut)
      if (!sc) throw new Error(`Shortcut "${task.shortcut}" not found`)
      steps = sc.steps
      if (!steps?.length && sc.code) code = sc.code
    }

    let output = ''
    if (steps?.length) {
      for (const step of steps) {
        await runSingleReplayStep(caller, step, {})
      }
      output = `Completed ${steps.length} step(s)`
    } else if (code) {
      const res = await caller.callTool('browser_exec', { code, sessionId: `sched-${task.id}` })
      output = res.content.map((c) => c.text ?? '').join('\n')
      if (res.isError) throw new Error(output || 'Scheduled script failed')
    } else {
      throw new Error('Scheduled task has no executable flow, shortcut, or code')
    }

    const durationMs = Date.now() - startedAt
    await recordScheduleOutcome(task.id, 'ok', durationMs)
    return { id: task.id, name: task.name, ok: true, durationMs, output }
  } catch (err) {
    const durationMs = Date.now() - startedAt
    const msg = err instanceof Error ? err.message : String(err)
    await recordScheduleOutcome(task.id, 'error', durationMs, msg)
    return { id: task.id, name: task.name, ok: false, durationMs, error: msg }
  } finally {
    manager?.dispose()
    await transport?.close().catch(() => {})
    await launched?.close().catch(() => {})
  }
}

async function recordScheduleOutcome(
  id: string,
  status: 'ok' | 'error',
  durationMs: number,
  error?: string,
): Promise<void> {
  const tasks = await listSchedules()
  const found = tasks.find((t) => t.id === id)
  if (!found) return
  const now = Date.now()
  found.lastRunAt = now
  found.nextRunAt = now + found.intervalMs
  found.lastStatus = status
  found.lastError = error
  found.lastDurationMs = durationMs
  found.runCount = (found.runCount ?? 0) + 1
  await writeSchedules(tasks)
}

/**
 * Lightweight background recurring task runner hosted by BrowserPilotDaemon.
 */
export class DaemonScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = new Set<string>()
  private readonly getToolContext: () => ToolRuntimeContext

  constructor(getToolContext: () => ToolRuntimeContext) {
    this.getToolContext = getToolContext
  }

  start(pollIntervalMs = 15_000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, pollIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<void> {
    const tasks = await listSchedules()
    const now = Date.now()
    for (const task of tasks) {
      if (!task.enabled || task.nextRunAt > now || this.running.has(task.id)) continue
      this.running.add(task.id)
      void executeScheduledTask(task, this.getToolContext).finally(() => {
        this.running.delete(task.id)
      })
    }
  }

  async runNow(idOrName: string): Promise<ScheduleRunReport> {
    const needle = idOrName.trim().toLowerCase()
    const tasks = await listSchedules()
    const task = tasks.find((t) => t.id.toLowerCase() === needle || t.name.toLowerCase() === needle)
    if (!task) throw new Error(`Scheduled task "${idOrName}" not found`)
    if (this.running.has(task.id)) throw new Error(`Scheduled task "${task.name}" is already running`)
    this.running.add(task.id)
    try {
      return await executeScheduledTask(task, this.getToolContext)
    } finally {
      this.running.delete(task.id)
    }
  }
}
