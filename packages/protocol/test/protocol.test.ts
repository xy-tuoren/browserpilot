import { describe, expect, it } from 'vitest'
import {
  encodeNativeMessage,
  NativeMessageDecoder,
  isBlockedProfileWideCommand,
  isRestrictedUrl,
  isUrlAllowedByDomainRules,
  matchesDomainPattern,
} from '../src/index.js'

describe('@devpilot/protocol', () => {
  describe('Native Messaging framing', () => {
    it('encodes and decodes single and multiple JSON messages including UTF-8 CJK', () => {
      const msg1 = { type: 'ping', ts: 12345, note: '你好 DevPilot 🚀' }
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
      expect(isRestrictedUrl('https://github.com/xy-tuoren/devpilot')).toBe(false)
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
})
