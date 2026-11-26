import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import esbuild from 'esbuild'

const execFileAsync = promisify(execFile)

const serverRoot = import.meta.dirname
const repoRoot = path.resolve(serverRoot, '..', '..')
const distDir = path.join(serverRoot, 'dist')
const typesDir = path.join(distDir, 'types')
const bundledExtDir = path.join(serverRoot, 'extension')
const sourceExtDist = path.join(repoRoot, 'packages', 'extension', 'dist')
const skillMdPath = path.join(repoRoot, 'skills', 'browserpilot', 'SKILL.md')

await fs.rm(distDir, { recursive: true, force: true })
await fs.rm(bundledExtDir, { recursive: true, force: true })

const skillMdRaw = await fs.readFile(skillMdPath, 'utf8')

// Bundle CLI, Native Messaging host, and SDK entrypoints with ESM code-splitting enabled so
// @browserpilot/core & @browserpilot/protocol are shared once in dist/chunk-*.js instead of duplicated.
await esbuild.build({
  entryPoints: {
    cli: path.join(serverRoot, 'src', 'cli.ts'),
    'native-host': path.join(serverRoot, 'src', 'native-host.ts'),
    index: path.join(serverRoot, 'src', 'index.ts'),
  },
  outdir: distDir,
  bundle: true,
  splitting: true,
  chunkNames: 'chunk-[hash]',
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: process.env.BROWSERPILOT_SOURCEMAP === '1',
  define: {
    __BROWSERPILOT_SKILL_MD__: JSON.stringify(skillMdRaw),
  },
  external: [
    '@modelcontextprotocol/sdk',
    '@modelcontextprotocol/sdk/*',
    'diff',
    'ws',
    'node:*',
  ],
})

await fs.chmod(path.join(distDir, 'cli.js'), 0o755)
await fs.chmod(path.join(distDir, 'native-host.js'), 0o755)

// Generate self-contained TypeScript declarations (.d.ts) with workspace imports rewritten to relative paths
async function copyDtsOnly(srcRoot, destRoot) {
  const entries = await fs.readdir(srcRoot, { withFileTypes: true })
  await fs.mkdir(destRoot, { recursive: true })
  for (const entry of entries) {
    const srcPath = path.join(srcRoot, entry.name)
    const destPath = path.join(destRoot, entry.name)
    if (entry.isDirectory()) {
      await copyDtsOnly(srcPath, destPath)
    } else if (entry.name.endsWith('.d.ts')) {
      await fs.copyFile(srcPath, destPath)
    }
  }
}

async function rewriteWorkspaceDtsSpecifiers(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await rewriteWorkspaceDtsSpecifiers(full)
      continue
    }
    if (!entry.name.endsWith('.d.ts')) continue
    const raw = await fs.readFile(full, 'utf8')
    const relToProtocol = path
      .relative(path.dirname(full), path.join(typesDir, 'protocol', 'index.js'))
      .split(path.sep)
      .join('/')
    const relToCore = path
      .relative(path.dirname(full), path.join(typesDir, 'core', 'index.js'))
      .split(path.sep)
      .join('/')
    const protocolSpec = relToProtocol.startsWith('.') ? relToProtocol : `./${relToProtocol}`
    const coreSpec = relToCore.startsWith('.') ? relToCore : `./${relToCore}`
    const rewritten = raw
      .replace(/(['"])@browserpilot\/protocol\1/g, `$1${protocolSpec}$1`)
      .replace(/(['"])@browserpilot\/core\1/g, `$1${coreSpec}$1`)
    if (rewritten !== raw) {
      await fs.writeFile(full, rewritten, 'utf8')
    }
  }
}

const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
await execFileAsync(process.execPath, [
  tscBin,
  '-p',
  path.join(serverRoot, 'tsconfig.json'),
  '--emitDeclarationOnly',
  '--declarationMap',
  'false',
  '--outDir',
  path.join(typesDir, 'server'),
])
await copyDtsOnly(path.join(repoRoot, 'packages', 'protocol', 'dist'), path.join(typesDir, 'protocol'))
await copyDtsOnly(path.join(repoRoot, 'packages', 'core', 'dist'), path.join(typesDir, 'core'))
await rewriteWorkspaceDtsSpecifiers(typesDir)

// Embed prebuilt Chrome MV3 extension inside the publishable npm package (stripping .map bloat)
async function stripSourcemaps(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await stripSourcemaps(full)
    } else if (entry.name.endsWith('.map')) {
      await fs.rm(full, { force: true })
    }
  }
}

try {
  await fs.access(path.join(sourceExtDist, 'manifest.json'))
  await fs.cp(sourceExtDist, bundledExtDir, { recursive: true })
  await stripSourcemaps(bundledExtDir)
} catch {
  throw new Error(
    `Missing built Chrome extension at ${sourceExtDist}. Run "pnpm --filter @browserpilot/extension build" first.`,
  )
}

// Copy README & LICENSE for npmjs package page
await fs.copyFile(path.join(repoRoot, 'README.md'), path.join(serverRoot, 'README.md'))
await fs.copyFile(path.join(repoRoot, 'LICENSE'), path.join(serverRoot, 'LICENSE'))

console.log('Built standalone npm package browserpilot ->', distDir, '(+ types & extension/)')
