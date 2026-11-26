import fs from 'node:fs/promises'
import path from 'node:path'
import { matchesDomainPattern } from '@browserpilot/protocol'
import { ensureBrowserPilotHome, getBrowserPilotHomeDir } from './config.js'
import type { ReplayFlowStep } from './cli/replay.js'

// ============================================================================
// Saved Workflow Shortcuts (~/.browserpilot/shortcuts/*.json)
// ============================================================================

export interface SavedShortcut {
  name: string
  description?: string
  steps?: ReplayFlowStep[]
  code?: string
  createdAt: number
  updatedAt: number
}

export function sanitizeShortcutName(raw: string): string {
  const clean = raw
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!clean) throw new Error(`Invalid shortcut name: "${raw}"`)
  return clean
}

function getShortcutsDir(): string {
  return path.join(getBrowserPilotHomeDir(), 'shortcuts')
}

export async function listShortcuts(): Promise<SavedShortcut[]> {
  const dir = getShortcutsDir()
  let files: string[] = []
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: SavedShortcut[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf8')
      const parsed = JSON.parse(raw) as SavedShortcut
      if (parsed && typeof parsed.name === 'string') out.push(parsed)
    } catch {}
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export async function getShortcut(name: string): Promise<SavedShortcut | null> {
  const slug = sanitizeShortcutName(name)
  try {
    const raw = await fs.readFile(path.join(getShortcutsDir(), `${slug}.json`), 'utf8')
    return JSON.parse(raw) as SavedShortcut
  } catch {
    return null
  }
}

export async function saveShortcut(input: {
  name: string
  description?: string
  steps?: ReplayFlowStep[]
  code?: string
}): Promise<SavedShortcut> {
  const slug = sanitizeShortcutName(input.name)
  if ((!input.steps || !input.steps.length) && !input.code?.trim()) {
    throw new Error('Shortcut must include either a non-empty "steps" workflow array or a "code" script.')
  }
  await ensureBrowserPilotHome()
  const dir = getShortcutsDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const existing = await getShortcut(slug)
  const now = Date.now()
  const entry: SavedShortcut = {
    name: slug,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.steps?.length ? { steps: input.steps } : {}),
    ...(input.code?.trim() ? { code: input.code.trim() } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 })
  return entry
}

export async function deleteShortcut(name: string): Promise<boolean> {
  const slug = sanitizeShortcutName(name)
  try {
    await fs.unlink(path.join(getShortcutsDir(), `${slug}.json`))
    return true
  } catch {
    return false
  }
}

// ============================================================================
// Local-First Per-Site Browser Memory (~/.browserpilot/memory.json)
// ============================================================================

export interface SiteMemoryItem {
  value: string
  note?: string
  updatedAt: number
}

export type SiteMemoryStore = Record<string, Record<string, SiteMemoryItem>>

function getMemoryPath(): string {
  return path.join(getBrowserPilotHomeDir(), 'memory.json')
}

export function normalizeMemoryDomain(domainOrUrl: string): string {
  const raw = domainOrUrl.trim().toLowerCase()
  if (!raw) throw new Error('Domain or URL cannot be empty')
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).hostname.toLowerCase()
    } catch {}
  }
  return raw.replace(/^https?:\/\//, '').split('/')[0].split(':')[0]
}

async function readMemoryStore(): Promise<SiteMemoryStore> {
  try {
    const raw = await fs.readFile(getMemoryPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as SiteMemoryStore) : {}
  } catch {
    return {}
  }
}

async function writeMemoryStore(store: SiteMemoryStore): Promise<void> {
  await ensureBrowserPilotHome()
  await fs.writeFile(getMemoryPath(), JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
}

export async function listSiteMemories(): Promise<SiteMemoryStore> {
  return await readMemoryStore()
}

export async function getSiteMemory(domainOrUrl: string): Promise<Record<string, SiteMemoryItem>> {
  const domain = normalizeMemoryDomain(domainOrUrl)
  const store = await readMemoryStore()
  return store[domain] ?? {}
}

export async function setSiteMemory(
  domainOrUrl: string,
  key: string,
  value: string,
  note?: string,
): Promise<{ domain: string; key: string; item: SiteMemoryItem }> {
  const domain = normalizeMemoryDomain(domainOrUrl)
  const cleanKey = key.trim()
  if (!cleanKey) throw new Error('Memory key cannot be empty')
  const store = await readMemoryStore()
  if (!store[domain]) store[domain] = {}
  const item: SiteMemoryItem = {
    value,
    ...(note?.trim() ? { note: note.trim() } : {}),
    updatedAt: Date.now(),
  }
  store[domain][cleanKey] = item
  await writeMemoryStore(store)
  return { domain, key: cleanKey, item }
}

export async function deleteSiteMemory(domainOrUrl: string, key?: string): Promise<boolean> {
  const domain = normalizeMemoryDomain(domainOrUrl)
  const store = await readMemoryStore()
  if (!store[domain]) return false
  if (key?.trim()) {
    const k = key.trim()
    if (!(k in store[domain])) return false
    delete store[domain][k]
    if (Object.keys(store[domain]).length === 0) delete store[domain]
  } else {
    delete store[domain]
  }
  await writeMemoryStore(store)
  return true
}

export async function clearSiteMemories(): Promise<void> {
  await writeMemoryStore({})
}

// ============================================================================
// Per-Site Trusted Approval Domains (~/.browserpilot/trusted-domains.json)
// ============================================================================

function getTrustedDomainsPath(): string {
  return path.join(getBrowserPilotHomeDir(), 'trusted-domains.json')
}

export async function listTrustedDomains(): Promise<string[]> {
  try {
    const raw = await fs.readFile(getTrustedDomainsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
  } catch {
    return []
  }
}

export async function addTrustedDomain(domainOrUrl: string): Promise<string[]> {
  const domain = normalizeMemoryDomain(domainOrUrl)
  const list = await listTrustedDomains()
  if (!list.includes(domain)) {
    list.push(domain)
    await ensureBrowserPilotHome()
    await fs.writeFile(getTrustedDomainsPath(), JSON.stringify(list, null, 2) + '\n', { mode: 0o600 })
  }
  return list
}

export async function removeTrustedDomain(domainOrUrl: string): Promise<string[]> {
  const domain = normalizeMemoryDomain(domainOrUrl)
  const list = (await listTrustedDomains()).filter((d) => d !== domain)
  await ensureBrowserPilotHome()
  await fs.writeFile(getTrustedDomainsPath(), JSON.stringify(list, null, 2) + '\n', { mode: 0o600 })
  return list
}

export async function isUrlTrustedForApproval(url: string, extraTrusted: string[] = []): Promise<boolean> {
  if (!url || !/^https?:\/\//i.test(url)) return false
  const stored = await listTrustedDomains()
  const combined = new Set([...stored, ...extraTrusted])
  for (const pattern of combined) {
    if (matchesDomainPattern(url, pattern)) return true
  }
  return false
}
