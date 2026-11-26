import fs from 'node:fs/promises'
import path from 'node:path'
import esbuild from 'esbuild'

const root = import.meta.dirname
const distDir = process.env.BROWSERPILOT_OUT_DIR
  ? path.resolve(process.env.BROWSERPILOT_OUT_DIR)
  : path.join(root, 'dist')
const sourcemap = process.env.BROWSERPILOT_NO_SOURCEMAP !== '1'

await fs.rm(distDir, { recursive: true, force: true })
await fs.mkdir(path.join(distDir, 'icons'), { recursive: true })

const define = {
  __BROWSERPILOT_DEFAULT_DAEMON_URL__: JSON.stringify(
    process.env.BROWSERPILOT_DAEMON_URL || 'ws://127.0.0.1:19888/extension',
  ),
  __BROWSERPILOT_DEFAULT_TOKEN__: JSON.stringify(process.env.BROWSERPILOT_AUTH_TOKEN || ''),
}

// Extension pages & MV3 Service Worker (ES modules)
await esbuild.build({
  entryPoints: {
    background: path.join(root, 'src/background.ts'),
    popup: path.join(root, 'src/popup.ts'),
    sidepanel: path.join(root, 'src/sidepanel.ts'),
  },
  outdir: distDir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap,
  define,
})

// Content script (classic script context + chrome.scripting.executeScript):
// bundle as a self-contained IIFE so top-level bindings never leak or collide.
await esbuild.build({
  entryPoints: {
    'content-script': path.join(root, 'src/content-script.ts'),
  },
  outdir: distDir,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap,
  define,
})

// Copy manifest, HTML pages, and icons
await fs.copyFile(path.join(root, 'manifest.json'), path.join(distDir, 'manifest.json'))
await fs.copyFile(path.join(root, 'src/popup.html'), path.join(distDir, 'popup.html'))
await fs.copyFile(path.join(root, 'src/sidepanel.html'), path.join(distDir, 'sidepanel.html'))

for (const size of [16, 32, 48, 128]) {
  await fs.copyFile(
    path.join(root, 'icons', `icon-${size}.png`),
    path.join(distDir, 'icons', `icon-${size}.png`),
  )
}

console.log('Built @browserpilot/extension ->', distDir)
