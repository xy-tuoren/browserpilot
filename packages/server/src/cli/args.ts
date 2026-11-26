import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BROWSERPILOT_VERSION } from '@browserpilot/protocol'

export type CliFlags = Record<string, string | boolean>

export function resolveServerEntryDir(metaUrl: string): string {
  const dir = path.dirname(fileURLToPath(metaUrl))
  const base = path.basename(dir)
  if (base === 'cli' || base === 'chunks') {
    return path.dirname(dir)
  }
  return dir
}

export async function getExtensionDistPath(metaUrl = import.meta.url): Promise<string> {
  const entryDir = resolveServerEntryDir(metaUrl)
  const bundled = path.resolve(entryDir, '..', 'extension')
  try {
    await fs.access(path.join(bundled, 'manifest.json'))
    return bundled
  } catch {
    return path.resolve(entryDir, '..', '..', 'extension', 'dist')
  }
}

export function parseFlags(argv: string[]): { positional: string[]; flags: CliFlags } {
  const positional: string[] = []
  const flags: CliFlags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      } else {
        const key = arg.slice(2)
        const next = argv[i + 1]
        if (next && !next.startsWith('-')) {
          flags[key] = next
          i++
        } else {
          flags[key] = true
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1)
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

export function parseRect(raw: unknown): { x: number; y: number; width: number; height: number } | undefined {
  if (typeof raw !== 'string') return undefined
  const nums = raw.split(',').map((s) => Number(s.trim()))
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
    throw new Error(`Expected x,y,width,height numeric tuple, got "${raw}"`)
  }
  return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] }
}

export function printToolOutput(res: {
  content: Array<{ type: string; text?: string; mimeType?: string }>
  isError?: boolean
}): void {
  for (const item of res.content) {
    if (item.type === 'text' && item.text) {
      if (res.isError) console.error(item.text)
      else console.log(item.text)
    } else if (item.type === 'image') {
      console.log(`[image ${item.mimeType}]`)
    }
  }
  if (res.isError) process.exitCode = 1
}

export function printHelp(): void {
  console.log(`BrowserPilot v${BROWSERPILOT_VERSION} — Zero-Click Pure-CDP Browser Control & DevTools CLI

Usage:
  browserpilot setup [--extension-id <id>] [--dry-run]   Sync extension, auto-install Native Messaging & print MCP config
  browserpilot doctor [--json]                           Diagnose extension, Native Messaging, Chrome, ffmpeg & daemon
  browserpilot daemon start | stop | restart | status | run  Manage local authenticated bridge daemon
  browserpilot mcp [--cdp <url>]                         Start MCP stdio server (for Claude/Cursor/Codex/Antigravity)
  browserpilot connect-cdp <url>                         Attach daemon directly to a --remote-debugging-port Chrome
  browserpilot browser start [--headless] [--cdp-port N] Launch Chrome/Chrome for Testing with BrowserPilot ready

Stateful Sessions, Codegen & Visual Trace:
  browserpilot session new [--tab-group <name>] [--tab-group-color <color>]
  browserpilot session list | update <id> [--tab-group <name>] [--tab-group-color <color>] | reset <id> | close <id>
  browserpilot exec -s <id> -e '<js>' | -f <script.js> [--timeout <ms>] [--trace <report.html>]
  browserpilot codegen [url] [--format playwright|browserpilot|skill|batch] [-o <file>] [--duration <sec>] [--tab <id>]
  browserpilot trace <start|stop|status|open> [path] [--title <str>] [--open] [--json] [--tab <id>]

Direct Quick Commands:
  browserpilot status
  browserpilot tabs | frames [--tab <id>]
  browserpilot open <url> [--tab-group <name>]
  browserpilot close <tabId>
  browserpilot navigate <url> [--tab <id>]
  browserpilot back | forward | reload [--ignore-cache] [--tab <id>]
  browserpilot snapshot [--tab <id>] [--search <regex>] [--scope <css>] [--frame <frame>] [--full]
  browserpilot markdown [--search <regex>] [--full] [--tab <id>]
  browserpilot html [--selector <css>] [--search <regex>] [--full] [--tab <id>]
  browserpilot click <ref|locator> [--force] [--double] [--button left|right|middle] [--modifiers Meta,Shift] [--tab <id>]
  browserpilot check | uncheck <ref|locator> [--force] [--tab <id>]
  browserpilot fill <ref|locator> <value> [--tab <id>]
  browserpilot fill-form '<json-fields>' [--tab <id>]
  browserpilot select <ref|locator> <val1> [val2...] [--tab <id>]
  browserpilot upload <ref|locator> <file1> [file2...] [--tab <id>]
  browserpilot key <combo> [--down|--up] [--repeat <N>] [--tab <id>]
  browserpilot hover <ref|locator> [--tab <id>]
  browserpilot drag <from> <to> [--steps <N>] | --points "x1,y1;x2,y2;..." [--tab <id>]
  browserpilot scroll [down|up|left|right] [--amount <px>] [--target <ref|sel>] [--tab <id>]
  browserpilot dialog <accept|dismiss> [--prompt <text>] [--auto] [--tab <id>]
  browserpilot wait [--selector <loc>] [--state visible|hidden|attached|detached] [--text <str>] [--gone] [--url <pat>] [--response <url>] [--fn <js>] [--popup] [--frame <f>] [--ms <N>] [--timeout <ms>]
  browserpilot handoff "<message>" [--timeout <ms>] [--tab <id>]
  browserpilot clipboard <read|write> [text] [--html <html>] [--tab <id>]
  browserpilot pdf [outputPath] [--landscape] [--scale <N>] [--pages <range>] [--tab <id>]
  browserpilot init-script <add|remove|list> [jsOrId] [--run-now] [--tab <id>]
  browserpilot permissions <grant|reset> [perm1,perm2...] [--origin <url>] [--tab <id>]
  browserpilot locator <ref|selector> [--tab <id>]
  browserpilot screenshot [outputPath] [--full-page] [--grid] [--zoom x,y,w,h] [--clip x,y,w,h] [--tab <id>]
  browserpilot labeled-screenshot [outputPath] [--tab <id>]
  browserpilot console [--level error] [--search <str>] [--since-last] [--tab <id>]
  browserpilot network [--failed] [--search <str>] [--request-id <id>] [--tab <id>]
  browserpilot styles <ref|selector> [--tab <id>]
  browserpilot react <ref|selector> [--tab <id>]
  browserpilot eval '<js>' [--frame <frame>] [--tab <id>]
  browserpilot perf [metrics|heap|trace_start|trace_stop|cpu_start|cpu_stop] [--tab <id>]
  browserpilot downloads [list|wait|clear] [--dir <path>] [--tab <id>]
  browserpilot record-actions [start|stop|status|clear|assert_next] [--format all|playwright|browserpilot|skill|batch] [-o <file>] [--tab <id>]
  browserpilot skill                                     Output complete AI agent skill documentation
`)
}
