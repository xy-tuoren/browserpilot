import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  BridgeChunkReassembler,
  compileRecordingArtifacts,
  compressRecordedSteps,
  computeStableDomSelector,
  encodeNativeMessage,
  encodeNativeMessageFrames,
  NATIVE_INCOMING_MAX_BYTES,
  NATIVE_MESSAGE_MAX_BYTES,
  NativeMessageDecoder,
  isBlockedProfileWideCommand,
  isRestrictedUrl,
  isUrlAllowedByDomainRules,
  matchesDomainPattern,
  translateLocatorToPlaywright,
  type BridgeChunkMessage,
} from '../src/index.js'

describe('@browserpilot/protocol', () => {
  describe('Native Messaging framing', () => {
    it('encodes and decodes single and multiple JSON messages including UTF-8 CJK', () => {
      const msg1 = { type: 'ping', ts: 12345, note: '你好 BrowserPilot 🚀' }
      const msg2 = { type: 'request', id: 'req-1', method: 'tabs.list', params: { active: true } }

      const frame1 = encodeNativeMessage(msg1)
      const frame2 = encodeNativeMessage(msg2)

      expect(frame1.readUInt32LE(0)).toBe(frame1.length - 4)

      const decoder = new NativeMessageDecoder()
      // Split across awkward arbitrary byte boundaries
      const combined = Buffer.concat([frame1, frame2])
      const out: unknown[] = []
      for (let i = 0; i < combined.length; i += 3) {
        out.push(...decoder.push(combined.subarray(i, i + 3)))
      }

      expect(out).toEqual([msg1, msg2])
    })

    it('rejects oversized outgoing and incoming native messages', () => {
      const huge = { data: 'x'.repeat(1024 * 1024 + 10) }
      expect(() => encodeNativeMessage(huge)).toThrow(/exceeds Chrome 1MB limit/)

      const decoder = new NativeMessageDecoder(64)
      const badHeader = Buffer.alloc(8)
      badHeader.writeUInt32LE(128, 0)
      expect(() => decoder.push(badHeader)).toThrow(/exceeds limit/)
    })

    it('supports >1MB incoming extension->host messages (up to 64MB) and chunks large outgoing frames', () => {
      // Simulate a 1.5MB CDP response (e.g. GitHub CSS/AXTree/Retina screenshot) from Chrome -> Native Host
      const bigIncoming = { type: 'response', id: 'big1', ok: true, result: { blob: 'A'.repeat(1_500_000) } }
      const rawJson = Buffer.from(JSON.stringify(bigIncoming), 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32LE(rawJson.length, 0)
      const decoder = new NativeMessageDecoder(NATIVE_INCOMING_MAX_BYTES)
      const decoded = decoder.push(Buffer.concat([header, rawJson]))
      expect(decoded).toEqual([bigIncoming])

      // Outgoing host -> extension chunking under Chrome's 1MB cap
      const bigOutgoing = { type: 'request', id: 'req-big', method: 'cdp.send', params: { code: 'B'.repeat(1_200_000) } }
      const frames = encodeNativeMessageFrames(bigOutgoing)
      expect(frames.length).toBeGreaterThan(1)
      const frameDecoder = new NativeMessageDecoder()
      const reassembler = new BridgeChunkReassembler()
      let assembled: unknown = null
      for (const f of frames) {
        for (const msg of frameDecoder.push(f) as BridgeChunkMessage[]) {
          expect(msg.type).toBe('chunk')
          assembled = reassembler.push(msg)
        }
      }
      expect(assembled).toEqual(bigOutgoing)
    })

    it('streams 12MB+ multi-byte CJK, emoji & heavily JSON-escaped payloads strictly under Chrome 1MB per frame', () => {
      // Mix of 3-byte CJK, 4-byte emoji surrogate pairs, and quotes/backslashes/control chars
      // that expand significantly on double JSON-escaping inside chunk envelopes.
      const unit = '你好BrowserPilot🚀\\"\\\\\u0007\n'
      const hugePayload = {
        type: 'request' as const,
        id: 'req-12mb-stress',
        method: 'cdp.send',
        params: {
          blobA: unit.repeat(260_000), // > 6MB raw UTF-8, > 10MB after escaping
          blobB: '中'.repeat(1_500_000), // 4.5MB UTF-8 CJK
        },
      }
      const rawBytes = Buffer.byteLength(JSON.stringify(hugePayload), 'utf8')
      expect(rawBytes).toBeGreaterThan(10 * 1024 * 1024)

      const frames = encodeNativeMessageFrames(hugePayload)
      expect(frames.length).toBeGreaterThan(10)

      // Every single encoded frame MUST obey Chrome's strict 1MB host->extension limit
      for (const frame of frames) {
        const bodyLen = frame.readUInt32LE(0)
        expect(bodyLen).toBe(frame.length - 4)
        expect(bodyLen).toBeLessThanOrEqual(NATIVE_MESSAGE_MAX_BYTES)
      }

      // Stream all frames through NativeMessageDecoder in irregular slice sizes and reassemble
      const combined = Buffer.concat(frames)
      const decoder = new NativeMessageDecoder()
      const reassembler = new BridgeChunkReassembler()
      let assembled: unknown = null
      for (let off = 0; off < combined.length; off += 65_537) {
        const msgs = decoder.push(combined.subarray(off, off + 65_537)) as BridgeChunkMessage[]
        for (const msg of msgs) {
          expect(msg.type).toBe('chunk')
          // Verify no chunk ends with a dangling UTF-16 high surrogate
          const lastCode = msg.data.charCodeAt(msg.data.length - 1)
          expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false)
          assembled = reassembler.push(msg)
        }
      }

      expect(reassembler.pendingCount).toBe(0)
      expect(assembled).toEqual(hugePayload)
    })

    it('reassembles interleaved out-of-order concurrent chunk streams, ignores duplicates, and evicts stale chunks', async () => {
      const msgA = { type: 'request' as const, id: 'stream-a', method: 'eval', params: { data: 'A'.repeat(1_300_000) } }
      const msgB = { type: 'request' as const, id: 'stream-b', method: 'eval', params: { data: 'B'.repeat(1_300_000) } }
      const msgC = { type: 'request' as const, id: 'stream-c', method: 'eval', params: { data: '汉'.repeat(450_000) } }

      const decodeChunks = (m: unknown): BridgeChunkMessage[] => {
        const dec = new NativeMessageDecoder()
        return encodeNativeMessageFrames(m).flatMap((f) => dec.push(f) as BridgeChunkMessage[])
      }

      const chunksA = decodeChunks(msgA)
      const chunksB = decodeChunks(msgB).reverse() // reverse arrival order!
      const chunksC = decodeChunks(msgC)

      // Interleave chunks from all 3 concurrent streams + duplicate chunk A[0]
      const interleaved: BridgeChunkMessage[] = [chunksA[0]]
      const maxLen = Math.max(chunksA.length, chunksB.length, chunksC.length)
      for (let i = 0; i < maxLen; i++) {
        if (chunksA[i]) interleaved.push(chunksA[i])
        if (chunksB[i]) interleaved.push(chunksB[i])
        if (chunksC[i]) interleaved.push(chunksC[i])
      }

      const reassembler = new BridgeChunkReassembler(50)
      const completed: unknown[] = []
      for (const ch of interleaved) {
        const res = reassembler.push(ch)
        if (res) completed.push(res)
      }

      expect(completed).toHaveLength(3)
      expect(completed).toContainEqual(msgA)
      expect(completed).toContainEqual(msgB)
      expect(completed).toContainEqual(msgC)
      expect(reassembler.pendingCount).toBe(0)

      // Verify stale incomplete chunk streams are evicted cleanly after TTL
      expect(
        reassembler.push({ type: 'chunk', chunkId: 'stale-1', index: 0, total: 3, data: '{"partial":' }),
      ).toBeNull()
      expect(reassembler.pendingCount).toBe(1)

      await new Promise((r) => setTimeout(r, 70))
      // Pushing any new chunk triggers TTL cleanup of stale-1
      const fresh = reassembler.push({ type: 'chunk', chunkId: 'fresh-1', index: 0, total: 1, data: '{"type":"ping","ts":1}' })
      expect(fresh).toEqual({ type: 'ping', ts: 1 })
      expect(reassembler.pendingCount).toBe(0)

      // Invalid chunk bounds must fail loudly rather than corrupting memory
      expect(() =>
        reassembler.push({ type: 'chunk', chunkId: 'bad-1', index: 5, total: 2, data: 'x' }),
      ).toThrow(/Invalid bridge chunk bounds/)
    })
  })

  describe('Security & domain rules', () => {
    it('blocks profile-wide destructive CDP commands', () => {
      expect(isBlockedProfileWideCommand('Network.clearBrowserCookies')).toBe(true)
      expect(isBlockedProfileWideCommand('Network.clearBrowserCache')).toBe(true)
      expect(isBlockedProfileWideCommand('Network.deleteCookies')).toBe(false)
      expect(isBlockedProfileWideCommand('Page.navigate')).toBe(false)
    })

    it('detects Chrome restricted URLs', () => {
      expect(isRestrictedUrl('chrome://extensions')).toBe(true)
      expect(isRestrictedUrl('chrome-extension://abcdef/popup.html')).toBe(true)
      expect(isRestrictedUrl('https://chromewebstore.google.com/detail/xyz')).toBe(true)
      expect(isRestrictedUrl('https://github.com/xy-tuoren/browserpilot')).toBe(false)
      expect(isRestrictedUrl('http://localhost:3000')).toBe(false)
    })

    it('evaluates exact and wildcard domain patterns', () => {
      expect(matchesDomainPattern('https://sub.bank.com/login', '*.bank.com')).toBe(true)
      expect(matchesDomainPattern('https://bank.com/', '*.bank.com')).toBe(true)
      expect(matchesDomainPattern('https://notbank.com/', '*.bank.com')).toBe(false)
      expect(matchesDomainPattern('https://localhost:5173/app', 'localhost')).toBe(true)

      expect(
        isUrlAllowedByDomainRules('https://app.bank.com', {
          blockedDomains: ['*.bank.com'],
          allowedDomains: [],
        }),
      ).toBe(false)

      expect(
        isUrlAllowedByDomainRules('https://localhost:3000', {
          blockedDomains: ['*.bank.com'],
          allowedDomains: ['localhost', '*.myapp.dev'],
        }),
      ).toBe(true)

      expect(
        isUrlAllowedByDomainRules('https://evil.com', {
          blockedDomains: [],
          allowedDomains: ['localhost'],
        }),
      ).toBe(false)
    })
  })

  describe('Codegen locator & artifact compiler', () => {
    it('translates BrowserPilot semantic, Shadow DOM & iframe locators into idiomatic Playwright TS', () => {
      expect(translateLocatorToPlaywright('[data-testid="login-btn"]')).toBe('page.getByTestId("login-btn")')
      expect(translateLocatorToPlaywright('testid=login-btn')).toBe('page.getByTestId("login-btn")')
      expect(translateLocatorToPlaywright('placeholder=Search docs')).toBe('page.getByPlaceholder("Search docs")')
      expect(translateLocatorToPlaywright('label=Email address')).toBe('page.getByLabel("Email address")')
      expect(translateLocatorToPlaywright('role=button[name="Save Changes"] >> nth=1')).toBe(
        'page.getByRole("button", { name: "Save Changes" }).nth(1)',
      )
      expect(translateLocatorToPlaywright('iframe#checkout >> [data-testid="pay-now"]')).toBe(
        'page.locator("iframe#checkout").contentFrame().getByTestId("pay-now")',
      )
      expect(translateLocatorToPlaywright('iframe#checkout >> testid=pay-now')).toBe(
        'page.locator("iframe#checkout").contentFrame().getByTestId("pay-now")',
      )
    })

    it('executes computeStableDomSelector identically directly AND via isolated VM .toString() across Shadow DOM & foreign iframe realms', () => {
      // Compile serialized function inside a brand-new empty V8 VM realm to prove ZERO external module closures!
      const vmFn = vm.runInNewContext(`(${computeStableDomSelector.toString()})`) as typeof computeStableDomSelector

      const topDoc: Record<string, unknown> = {
        defaultView: null as unknown,
        querySelector: () => null,
        querySelectorAll: (sel: string) => {
          if (sel === 'iframe#pay-frame') return [iframeEl]
          if (sel === '#shadow-card') return [shadowHost]
          return []
        },
      }
      const topWin = { parent: null as unknown }
      topWin.parent = topWin
      topDoc.defaultView = topWin

      const iframeEl = {
        nodeType: 1,
        tagName: 'IFRAME',
        id: 'pay-frame',
        ownerDocument: topDoc,
        getAttribute: (n: string) => (n === 'id' ? 'pay-frame' : null),
        getRootNode: () => topDoc,
      }

      const frameDoc: Record<string, unknown> = {
        defaultView: { parent: topWin, frameElement: iframeEl },
        querySelector: () => null,
        querySelectorAll: (sel: string) => {
          if (sel.includes('data-testid')) return [dupTestId0, dupTestId1]
          return []
        },
      }

      const dupTestId0 = {
        nodeType: 1,
        tagName: 'BUTTON',
        id: ':r0:', // dynamic React ID — must be ignored
        ownerDocument: frameDoc,
        getAttribute: (n: string) => (n === 'data-testid' ? 'buy-btn' : null),
        getRootNode: () => frameDoc,
      }
      const dupTestId1 = {
        nodeType: 1,
        tagName: 'BUTTON',
        id: 'radix-123', // dynamic Radix ID — must be ignored
        ownerDocument: frameDoc,
        getAttribute: (n: string) => (n === 'data-testid' ? 'buy-btn' : null),
        getRootNode: () => frameDoc,
      }

      expect(computeStableDomSelector(dupTestId1)).toBe('iframe#pay-frame >> testid=buy-btn >> nth=1')
      expect(vmFn(dupTestId1)).toBe('iframe#pay-frame >> testid=buy-btn >> nth=1')
      // Also verify `this`-bound invocation used by CDP Runtime.callFunctionOn
      expect(vmFn.call(dupTestId1)).toBe('iframe#pay-frame >> testid=buy-btn >> nth=1')

      // Shadow DOM chain
      const shadowHost = {
        nodeType: 1,
        tagName: 'DIV',
        id: 'shadow-card',
        ownerDocument: topDoc,
        getAttribute: (n: string) => (n === 'id' ? 'shadow-card' : null),
        getRootNode: () => topDoc,
      }
      const shadowRoot = {
        host: shadowHost,
        querySelectorAll: () => [shadowBtn],
      }
      const shadowBtn: Record<string, unknown> = {
        nodeType: 1,
        tagName: 'BUTTON',
        id: '550e8400-e29b-41d4-a716-446655440000', // UUID — must be ignored
        innerText: 'Confirm Order',
        ownerDocument: topDoc,
        getAttribute: () => null,
        getRootNode: () => shadowRoot,
      }

      expect(vmFn(shadowBtn)).toBe('#shadow-card >> role=button[name="Confirm Order"]')
    })

    it('compresses noisy click/fill/dblclick events and compiles Playwright, BrowserPilot, Batch & Skill outputs', () => {
      const t0 = 1_000_000
      const compressed = compressRecordedSteps([
        { timestamp: t0, action: 'navigate', url: 'https://app.example.com' },
        { timestamp: t0 + 10, action: 'navigate', url: 'https://app.example.com' },
        { timestamp: t0 + 50, action: 'click', url: 'https://app.example.com', target: 'placeholder=Email' },
        { timestamp: t0 + 90, action: 'fill', url: 'https://app.example.com', target: 'placeholder=Email', value: 'a@b' },
        { timestamp: t0 + 140, action: 'fill', url: 'https://app.example.com', target: 'placeholder=Email', value: 'a@b.com' },
        { timestamp: t0 + 200, action: 'click', url: 'https://app.example.com', target: '#agree' },
        { timestamp: t0 + 210, action: 'check', url: 'https://app.example.com', target: '#agree' },
        { timestamp: t0 + 300, action: 'click', url: 'https://app.example.com', target: '#row-1' },
        { timestamp: t0 + 340, action: 'click', url: 'https://app.example.com', target: '#row-1' },
        { timestamp: t0 + 350, action: 'dblclick', url: 'https://app.example.com', target: '#row-1' },
        { timestamp: t0 + 400, action: 'assert_text', url: 'https://app.example.com', target: '#status', value: 'Saved' },
      ])

      expect(compressed.map((s) => s.action)).toEqual(['navigate', 'fill', 'check', 'dblclick', 'assert_text'])
      expect(compressed[1].value).toBe('a@b.com')

      const compiled = compileRecordingArtifacts(compressed, 450)
      expect(compiled.playwrightScript).toContain('await page.getByPlaceholder("Email").fill("a@b.com");')
      expect(compiled.playwrightScript).toContain('await page.locator("#agree").check();')
      expect(compiled.playwrightScript).toContain('await page.locator("#row-1").dblclick();')
      expect(compiled.playwrightScript).toContain('await expect(page.locator("#status")).toContainText("Saved");')
      expect(compiled.execScript).toContain('await t.page.check("#agree");')
      expect(compiled.execScript).toContain('await waitForText("Saved", { tab: t });')
      expect(compiled.skillMarkdown).toContain('## Playwright Test')
    })
  })
})
