import fs from 'node:fs/promises'
import path from 'node:path'
import esbuild from 'esbuild'

const serverRoot = import.meta.dirname
const repoRoot = path.resolve(serverRoot, '..', '..')
const distDir = path.join(serverRoot, 'dist')
const bundledExtDir = path.join(serverRoot, 'extension')
const sourceExtDist = path.join(repoRoot, 'packages', 'extension', 'dist')

await fs.rm(distDir, { recursive: true, force: true })
await fs.rm(bundledExtDir, { recursive: true, force: true })

// Bundle CLI, Native Messaging host, and SDK entrypoints with @browserpilot/core & @browserpilot/protocol inlined,
// keeping only real published npm runtime dependencies external so `browserpilot` publishes as a clean single package.
await esbuild.build({
  entryPoints: {
    cli: path.join(serverRoot, 'src', 'cli.ts'),
    'native-host': path.join(serverRoot, 'src', 'native-host.ts'),
    index: path.join(serverRoot, 'src', 'index.ts'),
  },
  outdir: distDir,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
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

// Embed prebuilt Chrome MV3 extension inside the publishable npm package
try {
  await fs.access(path.join(sourceExtDist, 'manifest.json'))
  await fs.cp(sourceExtDist, bundledExtDir, { recursive: true })
} catch {
  throw new Error(
    `Missing built Chrome extension at ${sourceExtDist}. Run "pnpm --filter @browserpilot/extension build" first.`,
  )
}

// Copy README & LICENSE for npmjs package page
await fs.copyFile(path.join(repoRoot, 'README.md'), path.join(serverRoot, 'README.md'))
await fs.copyFile(path.join(repoRoot, 'LICENSE'), path.join(serverRoot, 'LICENSE'))

console.log('Built standalone npm package browserpilot ->', distDir, '+ extension/')
