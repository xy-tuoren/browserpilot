#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')

const JSON_VERSION_FILES = [
  'package.json',
  'packages/protocol/package.json',
  'packages/core/package.json',
  'packages/extension/package.json',
  'packages/server/package.json',
  'packages/extension/manifest.json',
]

const CONSTANTS_FILE = 'packages/protocol/src/constants.ts'

async function readAllVersions() {
  const entries = []
  for (const rel of JSON_VERSION_FILES) {
    const abs = path.join(repoRoot, rel)
    const parsed = JSON.parse(await fs.readFile(abs, 'utf8'))
    entries.push({ file: rel, version: String(parsed.version ?? '') })
  }
  const constantsRaw = await fs.readFile(path.join(repoRoot, CONSTANTS_FILE), 'utf8')
  const match = /export const BROWSERPILOT_VERSION = ['"]([^'"]+)['"]/.exec(constantsRaw)
  entries.push({ file: CONSTANTS_FILE, version: match ? match[1] : '' })
  return entries
}

const arg = process.argv[2]

if (!arg || arg === '--check') {
  const entries = await readAllVersions()
  const unique = new Set(entries.map((e) => e.version))
  for (const e of entries) {
    console.log(`${e.version.padEnd(10)} ${e.file}`)
  }
  if (unique.size !== 1) {
    console.error(`\nVersion mismatch across ${entries.length} files: ${Array.from(unique).join(', ')}`)
    process.exit(1)
  }
  process.exit(0)
}

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(arg)) {
  console.error(`Invalid semver "${arg}". Usage: node scripts/sync-version.mjs <X.Y.Z> | --check`)
  process.exit(1)
}

const manifestNumericVersion = arg.split('-')[0]

for (const rel of JSON_VERSION_FILES) {
  const abs = path.join(repoRoot, rel)
  const parsed = JSON.parse(await fs.readFile(abs, 'utf8'))
  parsed.version = rel.endsWith('manifest.json') ? manifestNumericVersion : arg
  await fs.writeFile(abs, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
}

const constantsAbs = path.join(repoRoot, CONSTANTS_FILE)
const constantsRaw = await fs.readFile(constantsAbs, 'utf8')
const updatedConstants = constantsRaw.replace(
  /export const BROWSERPILOT_VERSION = ['"][^'"]+['"]/,
  `export const BROWSERPILOT_VERSION = '${arg}'`,
)
await fs.writeFile(constantsAbs, updatedConstants, 'utf8')

console.log(`Synced BrowserPilot version -> ${arg} across ${JSON_VERSION_FILES.length + 1} files.`)
