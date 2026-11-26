import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { ExtensionBridgeTransport, SessionManager, type ExtensionChannel } from '@browserpilot/core'
import type { BridgeMessage, BridgeRequest } from '@browserpilot/protocol'
import {
  BROWSERPILOT_SKILL_DOC,
  CORE_MCP_TOOL_NAMES,
  executeTool,
  getNativeMessagingHostDirs,
  installNativeHost,
  resolveMcpToolDefinitions,
  TOOL_DEFINITIONS,
  validateAndNormalizeToolArgs,
  type ToolRuntimeContext,
} from '../src/index.js'

const execFileAsync = promisify(execFile)
const serverRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(serverRoot, '..', '..')

function createMockExtensionChannel() {
  const msgHandlers = new Set<(m: BridgeMessage) => void>()
  const closeHandlers = new Set<() => void>()

  const channel: ExtensionChannel = {
    send(msg: BridgeMessage) {
      if (msg.type === 'request') {
        const req = msg as BridgeRequest
        queueMicrotask(() => {
          let result: unknown = {}
          if (req.method === 'tabs.attach') {
            const tabId = Number(req.params?.tabId ?? 1)
            result = {
              tabId,
              url: `https://example.com/tab-${tabId}`,
              title: `Tab ${tabId}`,
              active: true,
              attached: true,
            }
          } else if (req.method === 'tabs.list') {
            result = {
              tabs: [
                { tabId: 101, url: 'https://example.com/101', title: '101', active: true, attached: true },
                { tabId: 102, url: 'https://example.com/102', title: '102', active: false, attached: true },
                { tabId: 103, url: 'https://example.com/103', title: '103', active: false, attached: true },
              ],
            }
          } else if (req.method === 'cdp.send') {
            const cdpMethod = String(req.params?.method ?? '')
            if (cdpMethod === 'Runtime.evaluate') {
              result = { result: { value: { url: 'https://example.com', title: 'Example' } } }
            }
          } else if (req.method === 'extension.reload') {
            result = { reloaded: true }
          }
          for (const h of msgHandlers) {
            h({ type: 'response', id: req.id, ok: true, result })
          }
        })
      }
    },
    onMessage(handler) {
      msgHandlers.add(handler)
      return () => msgHandlers.delete(handler)
    },
    onClose(handler) {
      closeHandlers.add(handler)
      return () => closeHandlers.delete(handler)
    },
    close() {
      for (const h of closeHandlers) h()
    },
  }

  return {
    channel,
    emitBridgeEvent(event: string, params: Record<string, unknown>) {
      for (const h of msgHandlers) {
        h({ type: 'event', event, params })
      }
    },
  }
}

describe('v1.7 Architecture, Schema Validation, Lifecycle GC, Windows Host & TypeScript SDK', () => {
  it('coerces stringified numeric/boolean tool args safely and rejects invalid types, enums, and missing required fields', async () => {
    const clickTool = TOOL_DEFINITIONS.find((t) => t.name === 'browser_click')!
    const coerced = validateAndNormalizeToolArgs(clickTool, {
      target: '#save',
      tabId: '42',
      clickCount: '2',
      force: 'true',
      strict: 'false',
      button: 'left',
      sessionId: 7,
      extraUndefined: undefined,
    })
    expect(coerced).toEqual({
      target: '#save',
      tabId: 42,
      clickCount: 2,
      force: true,
      strict: false,
      button: 'left',
      sessionId: '7',
    })

    // Empty string value on browser_fill MUST be accepted (clearing an input)
    const fillTool = TOOL_DEFINITIONS.find((t) => t.name === 'browser_fill')!
    expect(validateAndNormalizeToolArgs(fillTool, { target: '#email', value: '' })).toEqual({
      target: '#email',
      value: '',
    })

    // Uncoercible tabId MUST fail loudly in executeTool BEFORE touching any active browser tab!
    let managerTouched = false
    const dummyCtx: ToolRuntimeContext = {
      getManager: () => {
        managerTouched = true
        throw new Error('Should never reach manager on invalid schema!')
      },
      listClients: () => [],
    }

    const badTabRes = await executeTool(dummyCtx, 'browser_click', {
      target: '#danger-delete',
      tabId: 'not-a-tab-number',
    })
    expect(badTabRes.isError).toBe(true)
    expect(badTabRes.content[0].text).toContain('Invalid parameter "tabId"')
    expect(managerTouched).toBe(false)

    const missingReqRes = await executeTool(dummyCtx, 'browser_navigate', {})
    expect(missingReqRes.isError).toBe(true)
    expect(missingReqRes.content[0].text).toContain('Missing required parameter "url"')
    expect(managerTouched).toBe(false)

    const badEnumRes = await executeTool(dummyCtx, 'browser_history', { action: 'teleport' })
    expect(badEnumRes.isError).toBe(true)
    expect(badEnumRes.content[0].text).toContain('expected one of [reload, back, forward]')
    expect(managerTouched).toBe(false)

    const unknownRes = await executeTool(dummyCtx, 'browser_nonexistent_tool', {})
    expect(unknownRes.isError).toBe(true)
    expect(unknownRes.content[0].text).toContain('Unknown tool: browser_nonexistent_tool')
  })

  it('disposes closed tabs on target_closed / tab.removed while preserving temporarily detached tabs and bounding idle sessions', async () => {
    const mock = createMockExtensionChannel()
    const transport = new ExtensionBridgeTransport(mock.channel)
    const manager = new SessionManager(transport)

    await manager.getOrAttachTab(101)
    await manager.getOrAttachTab(102)
    await manager.getOrAttachTab(103)
    const s1 = manager.createSession({ id: 'work-1' })
    expect(s1.id).toBe('work-1')
    await manager.resolveActiveTab({ tabId: 101, sessionId: 'work-1' })
    expect(manager.getAttachedTabCount()).toBe(3)

    // 1. Temporary debugger detach (user cancelled banner) keeps tab state alive for re-attach
    mock.emitBridgeEvent('tab.detached', { tabId: 103, reason: 'canceled_by_user' })
    expect(manager.getAttachedTabCount()).toBe(3)

    // 2. Permanent target_closed & tab.removed events MUST dispose and evict BrowserPilotTab from memory
    mock.emitBridgeEvent('tab.detached', { tabId: 101, reason: 'target_closed' })
    expect(manager.getAttachedTabCount()).toBe(2)
    expect(manager.listSessions().find((s) => s.id === 'work-1')?.activeTabId).toBeUndefined()

    mock.emitBridgeEvent('tab.removed', { tabId: 102 })
    expect(manager.getAttachedTabCount()).toBe(1)

    // 3. Bounded LRU session eviction preserves 'default' and caps non-default sessions at <= 50
    manager.createSession({ id: 'default' })
    for (let i = 0; i < 65; i++) {
      manager.createSession({ id: `ephemeral-${i}` })
    }
    const remainingIds = manager.listSessions().map((s) => s.id)
    expect(remainingIds).toContain('default')
    expect(remainingIds).toContain('ephemeral-64')
    expect(remainingIds.length).toBeLessThanOrEqual(50)

    // 4. Playwright misuse guards inside exec sandbox return actionable BrowserPilot guidance without blocking local `const page`
    const badGoto = await manager.exec('guard-1', `await page.goto("https://example.com")`)
    expect(badGoto.error).toContain('Playwright "page.goto()" is not used')
    expect(badGoto.error).toContain('tabs.open(url)')

    const badRole = await manager.exec('guard-1', `await page.getByRole("button").click()`)
    expect(badRole.error).toContain('Playwright "page.getByRole()" is not used')
    expect(badRole.error).toContain("role=button")

    const badRequire = await manager.exec('guard-1', `const pw = require("playwright")`)
    expect(badRequire.error).toContain('100% pure CDP')

    const shadowedLocal = await manager.exec('guard-1', `const page = { customVal: 99 }; return page.customVal`)
    expect(shadowedLocal.error).toBeUndefined()
    expect(shadowedLocal.returnValue).toBe(99)

    // 5. Extension idle reload RPC works cleanly over ExtensionBridgeTransport
    const reloadRes = await transport.reloadExtension({ force: false })
    expect(reloadRes.reloaded).toBe(true)

    manager.dispose()
    await transport.close()
  })

  it('reduces upfront MCP schema payload by >65% in default core mode while supporting --caps and --full', () => {
    const coreTools = resolveMcpToolDefinitions()
    const fullTools = resolveMcpToolDefinitions({ full: true })
    const customCaps = resolveMcpToolDefinitions({ capabilities: 'devtools,media' })

    expect(coreTools.length).toBe(CORE_MCP_TOOL_NAMES.size)
    expect(coreTools.length).toBe(19)
    expect(fullTools.length).toBe(52)
    expect(customCaps.some((t) => t.name === 'browser_debugger')).toBe(true)
    expect(customCaps.some((t) => t.name === 'browser_trace')).toBe(true)
    expect(customCaps.some((t) => t.name === 'browser_cookies')).toBe(false)

    const coreBytes = Buffer.byteLength(JSON.stringify(coreTools), 'utf8')
    const fullBytes = Buffer.byteLength(JSON.stringify(fullTools), 'utf8')
    expect(coreBytes).toBeLessThan(fullBytes * 0.4)
  })

  it('generates Windows (win32) Native Messaging .cmd wrapper and HKCU registry host manifests cleanly', async () => {
    const winTargets = getNativeMessagingHostDirs('win32')
    expect(winTargets.length).toBeGreaterThanOrEqual(4)
    expect(winTargets.map((t) => t.name)).toContain('Google Chrome')
    expect(winTargets.map((t) => t.name)).toContain('Microsoft Edge')
    expect(winTargets[0].registryKey).toContain('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.browserpilot.bridge')

    const dry = await installNativeHost({
      extensionIds: ['jgfmchhmcnkfiogeenjckefcllkajdod'],
      platform: 'win32',
      dryRun: true,
    })
    expect(dry.wrapperPath.endsWith('browserpilot-native-host.cmd')).toBe(true)
    expect(dry.manifestJson.allowed_origins).toEqual([
      'chrome-extension://jgfmchhmcnkfiogeenjckefcllkajdod/',
    ])
    expect(dry.installedManifests.some((m) => Boolean(m.registryKey))).toBe(true)
  })

  it('ships a classic-IIFE idempotent content-script, synchronized versions/skill doc, and self-contained TypeScript .d.ts SDK', async () => {
    // 1. Version sync check across all 7 manifests/packages/constants
    const { stdout: verOut } = await execFileAsync(process.execPath, [
      path.join(repoRoot, 'scripts', 'sync-version.mjs'),
      '--check',
    ])
    expect(verOut).toContain('packages/server/package.json')

    // 2. Single-source skill doc includes all 52 tools + codegen + trace
    expect(TOOL_DEFINITIONS.length).toBe(52)
    expect(BROWSERPILOT_SKILL_DOC).toContain('52 MCP tools')
    expect(BROWSERPILOT_SKILL_DOC).toContain('browserpilot codegen')
    expect(BROWSERPILOT_SKILL_DOC).toContain('browserpilot trace')

    // 3. Extension content-script.js is bundled as an IIFE with idempotent __browserpilotContentBooted guard
    const contentJs = await fs.readFile(
      path.join(repoRoot, 'packages', 'extension', 'dist', 'content-script.js'),
      'utf8',
    )
    expect(contentJs.trimStart()).toMatch(/^("use strict";\s*)?\(\(\) => \{/)
    expect(contentJs).toContain('__browserpilotContentBooted')
    expect(contentJs).not.toMatch(/^\s*(import|export)\s/m)

    // 4. External TypeScript SDK consumer compiles against browserpilot-cdp .d.ts with ZERO workspace leaks
    const tmpConsumer = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-sdk-consumer-'))
    try {
      await fs.mkdir(path.join(tmpConsumer, 'node_modules'), { recursive: true })
      await fs.symlink(serverRoot, path.join(tmpConsumer, 'node_modules', 'browserpilot-cdp'), 'dir')
      await fs.symlink(
        path.join(serverRoot, 'node_modules', '@types'),
        path.join(tmpConsumer, 'node_modules', '@types'),
        'dir',
      )

      await fs.writeFile(
        path.join(tmpConsumer, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            skipLibCheck: false,
            noEmit: true,
          },
          include: ['consumer.ts'],
        }),
      )

      await fs.writeFile(
        path.join(tmpConsumer, 'consumer.ts'),
        `import {
          BROWSERPILOT_VERSION,
          BrowserPilotDaemon,
          DaemonClient,
          DirectCDPTransport,
          SessionManager,
          computeStableDomSelector,
          validateAndNormalizeToolArgs,
          type Locator,
          type PageController,
          type TraceData,
        } from 'browserpilot-cdp'

        export function verifyTypes(page: PageController): Locator {
          const v: string = BROWSERPILOT_VERSION
          void v
          void BrowserPilotDaemon
          void DaemonClient
          void DirectCDPTransport
          void SessionManager
          void computeStableDomSelector
          void validateAndNormalizeToolArgs
          const trace: Partial<TraceData> = {}
          void trace
          return page.locator('role=button[name="Save"]')
        }
        `,
      )

      const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
      await execFileAsync(process.execPath, [tscBin, '-p', path.join(tmpConsumer, 'tsconfig.json')])
    } finally {
      await fs.rm(tmpConsumer, { recursive: true, force: true }).catch(() => {})
    }
  }, 30_000)
})
