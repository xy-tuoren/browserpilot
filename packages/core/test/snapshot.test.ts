import { describe, expect, it } from 'vitest'
import {
  computeDiffIfShorter,
  filterSnapshotLines,
  formatAXTree,
  isIgnoredAnalyticsUrl,
  type RawAXNode,
} from '../src/index.js'

describe('Snapshot & Wait helpers', () => {
  it('compresses AXTree nodes into compact ref-addressed hierarchy', () => {
    const nodes: RawAXNode[] = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'App' }, childIds: ['2', '3'] },
      { nodeId: '2', role: { value: 'generic' }, childIds: ['4', '5'] },
      { nodeId: '3', role: { value: 'ignored' }, ignored: true, childIds: ['6'] },
      { nodeId: '4', role: { value: 'heading' }, name: { value: 'Dashboard' }, properties: [{ name: 'level', value: { value: 1 } }] },
      { nodeId: '5', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 101 },
      { nodeId: '6', role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'a@b.com' }, backendDOMNodeId: 102 },
    ]

    const result = formatAXTree(nodes)
    expect(result.lines).toEqual([
      '- heading "Dashboard" (level=1)',
      '- [e1] button "Submit"',
      '- [e2] textbox "Email" (value="a@b.com")',
    ])
    expect(result.refs.e1.backendDOMNodeId).toBe(101)
    expect(result.refs.e2.backendDOMNodeId).toBe(102)
  })

  it('filters snapshot lines by regex with context', () => {
    const text = [
      'URL: https://example.com',
      '',
      '- heading "Title"',
      '- [e1] link "Home"',
      '- [e2] button "Checkout"',
      '- text: "Total: $10"',
    ].join('\n')

    const filtered = filterSnapshotLines(text, /checkout/i)
    expect(filtered).toContain('URL: https://example.com')
    expect(filtered).toContain('[e2] button "Checkout"')
    expect(filtered).not.toContain('heading "Title"')
  })

  it('returns concise diff or "No changes" when snapshots match', () => {
    const header = 'URL: https://example.com'
    const a = `${header}\n\n` + Array.from({ length: 30 }, (_, i) => `- [e${i + 1}] button "Item ${i + 1}"`).join('\n')
    const b = a.replace('Item 15', 'Item 15 (Updated)')

    const same = computeDiffIfShorter(a, a, header)
    expect(same.isDiff).toBe(true)
    expect(same.text).toContain('No changes since last snapshot')

    const diff = computeDiffIfShorter(a, b, header)
    expect(diff.isDiff).toBe(true)
    expect(diff.text.length).toBeLessThan(b.length)
    expect(diff.text).toContain('- [e15] button "Item 15 (Updated)"')
  })

  it('identifies ignored analytics/ad URLs for smart waitForPageLoad', () => {
    expect(isIgnoredAnalyticsUrl('https://www.google-analytics.com/g/collect?v=2')).toBe(true)
    expect(isIgnoredAnalyticsUrl('https://cdn.sentry.io/api/1/envelope')).toBe(true)
    expect(isIgnoredAnalyticsUrl('https://api.myapp.com/v1/users')).toBe(false)
  })
})
