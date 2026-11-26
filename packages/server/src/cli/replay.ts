import fs from 'node:fs/promises'
import path from 'node:path'
import type { DaemonClient } from '../client.js'
import type { CliFlags } from './args.js'

export interface ReplayFlowStep {
  action: string
  url?: string
  target?: string
  value?: unknown
  key?: string
  text?: string
  selector?: string
  fromTarget?: string
  toTarget?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  untilTarget?: string
  maxScrolls?: number
  ms?: number
  fn?: string
  timeoutMs?: number
  mode?: 'auto' | 'pointer' | 'html5'
}

export interface ReplayFlowFile {
  name?: string
  title?: string
  steps: ReplayFlowStep[]
}

export function parseWorkflowPayload(rawJson: string): ReplayFlowFile {
  const parsed = JSON.parse(rawJson) as ReplayFlowFile | ReplayFlowStep[]
  if (Array.isArray(parsed)) {
    return { steps: parsed }
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.steps)) {
    return parsed
  }
  throw new Error('Workflow JSON must be an array of steps or an object containing a "steps" array.')
}

async function runSingleReplayStep(
  client: DaemonClient,
  step: ReplayFlowStep,
  base: { tabId?: number; sessionId?: string; clientId?: string },
): Promise<void> {
  const act = String(step.action || '').trim().toLowerCase()
  const call = async (tool: string, args: Record<string, unknown>) => {
    const res = await client.callTool(tool, { ...base, ...args })
    if (res.isError) {
      const errMsg = res.content.map((c) => c.text).filter(Boolean).join('\n') || `${tool} failed`
      throw new Error(errMsg)
    }
    return res
  }

  switch (act) {
    case 'navigate':
    case 'goto':
      await call('browser_navigate', { url: String(step.url ?? '') })
      return
    case 'click':
      await call('browser_click', { target: step.target, timeoutMs: step.timeoutMs })
      return
    case 'dblclick':
      await call('browser_click', { target: step.target, clickCount: 2, timeoutMs: step.timeoutMs })
      return
    case 'check':
      await call('browser_check', { target: step.target, checked: true })
      return
    case 'uncheck':
      await call('browser_check', { target: step.target, checked: false })
      return
    case 'fill':
      await call('browser_fill', { target: step.target, value: String(step.value ?? ''), timeoutMs: step.timeoutMs })
      return
    case 'type':
      await call('browser_type', { target: step.target, text: String(step.text ?? step.value ?? '') })
      return
    case 'select_option':
      await call('browser_select_option', {
        target: step.target,
        ...(Array.isArray(step.value) ? { values: step.value.map(String) } : { value: String(step.value ?? '') }),
      })
      return
    case 'press_key':
      await call('browser_press_key', { key: String(step.key ?? '') })
      return
    case 'hover':
      await call('browser_hover', { target: step.target })
      return
    case 'scroll':
      await call('browser_scroll', {
        target: step.target,
        untilTarget: step.untilTarget,
        maxScrolls: step.maxScrolls,
        direction: step.direction,
        amount: step.amount,
      })
      return
    case 'drag':
      await call('browser_drag', {
        fromTarget: step.fromTarget ?? step.target,
        toTarget: step.toTarget,
        mode: step.mode,
      })
      return
    case 'tap':
      await call('browser_touch', { action: 'tap', target: step.target })
      return
    case 'swipe':
      await call('browser_touch', {
        action: 'swipe',
        fromTarget: step.fromTarget ?? step.target,
        toTarget: step.toTarget,
      })
      return
    case 'wait':
      await call('browser_wait', {
        ms: step.ms,
        selector: step.selector ?? step.target,
        text: step.text,
        url: step.url,
        fn: step.fn,
        timeoutMs: step.timeoutMs,
      })
      return
    case 'assert_visible':
      await call('browser_wait', {
        selector: String(step.target ?? step.selector ?? ''),
        state: 'visible',
        timeoutMs: step.timeoutMs ?? 5_000,
      })
      return
    case 'assert_text': {
      const target = String(step.target ?? step.selector ?? '')
      const expected = String(step.value ?? step.text ?? '')
      await call('browser_wait', { selector: target, state: 'visible', timeoutMs: step.timeoutMs ?? 5_000 })
      const evalRes = await call('browser_evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(target)});
          return el ? ((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()) : null;
        })()`,
      })
      const actual = evalRes.content.map((c) => c.text ?? '').join('').trim()
      if (!actual.includes(expected)) {
        throw new Error(`Assertion failed (assert_text ${target}): expected to contain ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
      }
      return
    }
    case 'assert_value': {
      const target = String(step.target ?? step.selector ?? '')
      const expected = String(step.value ?? '')
      await call('browser_wait', { selector: target, state: 'visible', timeoutMs: step.timeoutMs ?? 5_000 })
      const evalRes = await call('browser_evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(target)});
          return el && 'value' in el ? String(el.value) : null;
        })()`,
      })
      const actual = evalRes.content.map((c) => c.text ?? '').join('').trim()
      if (actual !== expected) {
        throw new Error(`Assertion failed (assert_value ${target}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
      }
      return
    }
    default:
      throw new Error(`Unsupported workflow step action: "${step.action}"`)
  }
}

export async function runReplayCommand(
  client: DaemonClient,
  fileArg: string | undefined,
  flags: CliFlags,
  opts: { tabId?: number; sessionId?: string; clientId?: string },
): Promise<void> {
  if (!fileArg) {
    throw new Error('Usage: browserpilot run <flow.json> [--trace [report.html]] [--open] [--tab <id>]')
  }
  const resolvedPath = path.resolve(fileArg)
  const raw = await fs.readFile(resolvedPath, 'utf8')
  const flow = parseWorkflowPayload(raw)
  if (!flow.steps.length) {
    console.log('Workflow has 0 steps; nothing to execute.')
    return
  }

  const title = flow.title || flow.name || path.basename(resolvedPath)
  const tracePath =
    typeof flags.trace === 'string'
      ? flags.trace
      : flags.trace === true
        ? `./browserpilot-replay-${Date.now()}.html`
        : undefined

  let traceStarted = false
  if (tracePath) {
    const startRes = await client.callTool('browser_trace', { action: 'start', title, ...opts })
    traceStarted = !startRes.isError
  }

  const startedAt = Date.now()
  let passed = 0
  let failure: Error | null = null

  try {
    console.log(`Running workflow "${title}" (${flow.steps.length} step(s))…`)
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i]
      const stepStart = Date.now()
      const label = step.url || step.target || step.key || step.text || ''
      try {
        await runSingleReplayStep(client, step, opts)
        passed++
        console.log(`  ✓ [${i + 1}/${flow.steps.length}] ${step.action}${label ? ` ${label}` : ''} (${Date.now() - stepStart}ms)`)
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err))
        console.error(`  ✗ [${i + 1}/${flow.steps.length}] ${step.action}${label ? ` ${label}` : ''} — ${failure.message}`)
        break
      }
    }
  } finally {
    if (traceStarted && tracePath) {
      const stopRes = await client
        .callTool('browser_trace', {
          action: 'stop',
          path: tracePath,
          openViewer: Boolean(flags.open),
          ...opts,
        })
        .catch(() => null)
      if (stopRes && !stopRes.isError) {
        for (const item of stopRes.content) {
          if (item.text) console.log(item.text)
        }
      }
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)
  if (failure) {
    console.error(`Workflow failed after ${passed}/${flow.steps.length} step(s) in ${elapsed}s.`)
    process.exitCode = 1
    return
  }
  console.log(`Workflow passed: ${passed}/${flow.steps.length} step(s) in ${elapsed}s.`)
}
