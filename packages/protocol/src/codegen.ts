import type { ActionRecordingResult, CodegenFormat, RecordedStep } from './types.js'

/**
 * Splits a BrowserPilot chained locator on top-level `>>` operators (ignoring `>>` inside quotes).
 */
export function splitChainedSegments(locator: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < locator.length; i++) {
    const ch = locator[i]
    if (quote) {
      current += ch
      if (ch === quote && locator[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '>' && locator[i + 1] === '>') {
      const trimmed = current.trim()
      if (trimmed) parts.push(trimmed)
      current = ''
      i++
      continue
    }
    current += ch
  }
  const tail = current.trim()
  if (tail) parts.push(tail)
  return parts.length ? parts : [locator.trim()]
}

function renderPlaywrightSegment(rootExpr: string, seg: string, hasFollowingSegment: boolean): string {
  if (seg === 'first') return `${rootExpr}.first()`
  if (seg === 'last') return `${rootExpr}.last()`
  const nthMatch = /^nth=(-?\d+)$/i.exec(seg)
  if (nthMatch) return `${rootExpr}.nth(${Number(nthMatch[1])})`

  if (seg.startsWith('testid=')) {
    return `${rootExpr}.getByTestId(${JSON.stringify(seg.slice('testid='.length))})`
  }
  const testIdMatch = /^\[data-testid=["'](.+)["']\]$/.exec(seg)
  if (testIdMatch) {
    return `${rootExpr}.getByTestId(${JSON.stringify(testIdMatch[1].replace(/\\"/g, '"'))})`
  }
  if (seg.startsWith('placeholder=')) {
    return `${rootExpr}.getByPlaceholder(${JSON.stringify(seg.slice('placeholder='.length))})`
  }
  if (seg.startsWith('label=')) {
    return `${rootExpr}.getByLabel(${JSON.stringify(seg.slice('label='.length))})`
  }
  if (seg.startsWith('text=')) {
    return `${rootExpr}.getByText(${JSON.stringify(seg.slice('text='.length))})`
  }
  const roleWithName = /^role=([a-zA-Z0-9_-]+)\[name=["']([\s\S]*)["']\]$/.exec(seg)
  if (roleWithName) {
    const role = roleWithName[1]
    const name = roleWithName[2].replace(/\\"/g, '"')
    return `${rootExpr}.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)} })`
  }
  const bareRole = /^role=([a-zA-Z0-9_-]+)$/.exec(seg)
  if (bareRole) {
    return `${rootExpr}.getByRole(${JSON.stringify(bareRole[1])})`
  }

  const loc = `${rootExpr}.locator(${JSON.stringify(seg)})`
  if (hasFollowingSegment && /^iframe\b/i.test(seg)) {
    return `${loc}.contentFrame()`
  }
  return loc
}

/**
 * Translates a BrowserPilot locator string into idiomatic `@playwright/test` Locator syntax.
 */
export function translateLocatorToPlaywright(locator: string, rootVar = 'page'): string {
  const segments = splitChainedSegments(locator || 'body')
  let expr = rootVar
  for (let i = 0; i < segments.length; i++) {
    expr = renderPlaywrightSegment(expr, segments[i], i < segments.length - 1)
  }
  return expr
}

/**
 * Compresses raw recorded user events into clean, minimal replayable steps:
 * - Collapses consecutive `fill` events on the same input
 * - Drops redundant `click` right before `fill` / `select_option` / `check` / `uncheck` on the same element
 * - Collapses two rapid `click`s followed by `dblclick` on the same target into a single `dblclick`
 * - Deduplicates consecutive identical `navigate` events
 */
export function compressRecordedSteps(rawSteps: RecordedStep[]): RecordedStep[] {
  const steps: RecordedStep[] = []
  for (const s of rawSteps) {
    const prev = steps[steps.length - 1]

    if (s.action === 'fill' && prev?.action === 'fill' && prev.target === s.target) {
      prev.value = s.value
      prev.timestamp = s.timestamp
      continue
    }

    if (
      (s.action === 'fill' || s.action === 'select_option' || s.action === 'check' || s.action === 'uncheck') &&
      prev?.action === 'click' &&
      prev.target === s.target
    ) {
      steps.pop()
    }

    if (s.action === 'dblclick') {
      while (
        steps.length > 0 &&
        steps[steps.length - 1].action === 'click' &&
        steps[steps.length - 1].target === s.target &&
        s.timestamp - steps[steps.length - 1].timestamp < 600
      ) {
        steps.pop()
      }
    }

    if (s.action === 'navigate' && prev?.action === 'navigate' && prev.url === s.url) {
      continue
    }

    steps.push({ ...s })
  }
  return steps
}

export function buildBatchSteps(steps: RecordedStep[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const s of steps) {
    switch (s.action) {
      case 'navigate':
        out.push({ action: 'navigate', url: s.url })
        break
      case 'click':
      case 'dblclick':
      case 'check':
      case 'uncheck':
        out.push({ action: 'click', target: s.target })
        break
      case 'fill':
        out.push({ action: 'fill', target: s.target, value: s.value ?? '' })
        break
      case 'select_option':
        out.push({ action: 'select_option', target: s.target, value: s.value ?? '' })
        break
      case 'press_key':
        out.push({ action: 'press_key', key: s.key ?? 'Enter' })
        break
      case 'scroll': {
        const dy = Number(s.value ?? 400)
        out.push({ action: 'scroll', direction: dy >= 0 ? 'down' : 'up', amount: Math.abs(dy) })
        break
      }
      case 'assert_visible':
        out.push({ action: 'wait', selector: s.target })
        break
      case 'assert_text':
        out.push({ action: 'wait', text: s.value ?? s.text ?? '' })
        break
      case 'assert_value':
        out.push({ action: 'wait', selector: s.target })
        break
    }
  }
  return out
}

export function generateBrowserPilotScript(steps: RecordedStep[]): string {
  const lines: string[] = [
    '// Generated by BrowserPilot Codegen',
    'const t = await tabs.current();',
  ]
  for (const s of steps) {
    const target = JSON.stringify(s.target ?? '')
    switch (s.action) {
      case 'navigate':
        lines.push(`await t.page.navigate(${JSON.stringify(s.url)});`)
        break
      case 'click':
        lines.push(`await t.page.click(${target});`)
        break
      case 'dblclick':
        lines.push(`await t.page.dblclick(${target});`)
        break
      case 'check':
        lines.push(`await t.page.check(${target});`)
        break
      case 'uncheck':
        lines.push(`await t.page.uncheck(${target});`)
        break
      case 'fill':
        lines.push(`await t.page.fill(${target}, ${JSON.stringify(s.value ?? '')});`)
        break
      case 'select_option':
        lines.push(`await t.page.selectOption(${target}, ${JSON.stringify(s.value ?? '')});`)
        break
      case 'press_key':
        lines.push(`await t.page.pressKey(${JSON.stringify(s.key ?? 'Enter')});`)
        break
      case 'scroll': {
        const dy = Number(s.value ?? 400)
        lines.push(`await t.page.scroll({ deltaY: ${dy} });`)
        break
      }
      case 'assert_visible':
        lines.push(`await waitForSelector(${target}, { state: 'visible', tab: t });`)
        break
      case 'assert_text':
        lines.push(`await waitForText(${JSON.stringify(s.value ?? s.text ?? '')}, { tab: t });`)
        break
      case 'assert_value':
        lines.push(
          `if ((await t.locator(${target}).inputValue()) !== ${JSON.stringify(s.value ?? '')}) throw new Error('Expected input value ${String(s.value ?? '').replace(/'/g, "\\'")}');`,
        )
        break
    }
  }
  return lines.join('\n')
}

export function generatePlaywrightScript(steps: RecordedStep[], testName = 'recorded browser flow'): string {
  const lines: string[] = [
    "import { test, expect } from '@playwright/test';",
    '',
    `test(${JSON.stringify(testName)}, async ({ page }) => {`,
  ]
  for (const s of steps) {
    const loc = s.target ? translateLocatorToPlaywright(s.target, 'page') : 'page.locator("body")'
    switch (s.action) {
      case 'navigate':
        lines.push(`  await page.goto(${JSON.stringify(s.url)});`)
        break
      case 'click':
        lines.push(`  await ${loc}.click();`)
        break
      case 'dblclick':
        lines.push(`  await ${loc}.dblclick();`)
        break
      case 'check':
        lines.push(`  await ${loc}.check();`)
        break
      case 'uncheck':
        lines.push(`  await ${loc}.uncheck();`)
        break
      case 'fill':
        lines.push(`  await ${loc}.fill(${JSON.stringify(s.value ?? '')});`)
        break
      case 'select_option':
        lines.push(`  await ${loc}.selectOption(${JSON.stringify(s.value ?? '')});`)
        break
      case 'press_key':
        lines.push(`  await page.keyboard.press(${JSON.stringify(s.key ?? 'Enter')});`)
        break
      case 'scroll': {
        const dy = Number(s.value ?? 400)
        lines.push(`  await page.mouse.wheel(0, ${dy});`)
        break
      }
      case 'assert_visible':
        lines.push(`  await expect(${loc}).toBeVisible();`)
        break
      case 'assert_text':
        lines.push(`  await expect(${loc}).toContainText(${JSON.stringify(s.value ?? s.text ?? '')});`)
        break
      case 'assert_value':
        lines.push(`  await expect(${loc}).toHaveValue(${JSON.stringify(s.value ?? '')});`)
        break
    }
  }
  lines.push('});')
  return lines.join('\n')
}

export function describeRecordedStep(s: RecordedStep): string {
  switch (s.action) {
    case 'navigate':
      return `Navigate to \`${s.url}\``
    case 'click':
      return `Click \`${s.target}\`${s.text ? ` ("${s.text}")` : ''}`
    case 'dblclick':
      return `Double-click \`${s.target}\`${s.text ? ` ("${s.text}")` : ''}`
    case 'check':
      return `Check \`${s.target}\``
    case 'uncheck':
      return `Uncheck \`${s.target}\``
    case 'fill':
      return `Fill \`${s.target}\` with \`${s.value ?? ''}\``
    case 'select_option':
      return `Select \`${s.value ?? ''}\` in \`${s.target}\``
    case 'press_key':
      return `Press key \`${s.key}\``
    case 'scroll':
      return `Scroll ${Number(s.value ?? 0) >= 0 ? 'down' : 'up'} ${Math.abs(Number(s.value ?? 0))}px`
    case 'assert_visible':
      return `Assert \`${s.target}\` is visible`
    case 'assert_text':
      return `Assert \`${s.target}\` contains text \`${s.value ?? s.text ?? ''}\``
    case 'assert_value':
      return `Assert \`${s.target}\` has value \`${s.value ?? ''}\``
  }
}

export function compileRecordingArtifacts(
  rawSteps: RecordedStep[],
  durationMs: number,
  extras?: {
    apiCalls?: Array<{ timestamp: number; method: string; url: string; status?: number }>
    errors?: Array<{ timestamp: number; kind: 'console' | 'exception' | 'dialog'; text: string }>
  },
): ActionRecordingResult {
  const steps = compressRecordedSteps(rawSteps)
  const batchSteps = buildBatchSteps(steps)
  const execScript = generateBrowserPilotScript(steps)
  const playwrightScript = generatePlaywrightScript(steps)

  const mdLines: string[] = [
    '# Recorded BrowserPilot Workflow',
    '',
    `Recorded ${steps.length} step(s) in ${(durationMs / 1000).toFixed(1)}s.`,
    '',
    '## Steps',
    ...steps.map((s, idx) => `${idx + 1}. ${describeRecordedStep(s)}`),
  ]
  if (extras?.apiCalls?.length) {
    mdLines.push('', '## Observed API Calls')
    for (const c of extras.apiCalls.slice(0, 20)) {
      mdLines.push(`- \`${c.method} ${c.status ?? '?'}\` ${c.url}`)
    }
  }
  if (extras?.errors?.length) {
    mdLines.push('', '## Observed Errors / Dialogs')
    for (const e of extras.errors.slice(0, 15)) {
      mdLines.push(`- [${e.kind}] ${e.text}`)
    }
  }
  mdLines.push(
    '',
    '## Replay Script (`browserpilot exec`)',
    '```js',
    execScript,
    '```',
    '',
    '## Playwright Test (`@playwright/test`)',
    '```ts',
    playwrightScript,
    '```',
  )

  return {
    durationMs,
    steps,
    ...(extras?.apiCalls?.length ? { apiCalls: extras.apiCalls } : {}),
    ...(extras?.errors?.length ? { errors: extras.errors } : {}),
    batchSteps,
    execScript,
    playwrightScript,
    skillMarkdown: mdLines.join('\n'),
  }
}

export function formatStepsAsCode(steps: RecordedStep[], format: CodegenFormat, durationMs = 0): string {
  const artifacts = compileRecordingArtifacts(steps, durationMs)
  switch (format) {
    case 'playwright':
      return artifacts.playwrightScript
    case 'browserpilot':
      return artifacts.execScript
    case 'batch':
      return JSON.stringify(artifacts.batchSteps, null, 2)
    case 'skill':
      return artifacts.skillMarkdown
  }
}
