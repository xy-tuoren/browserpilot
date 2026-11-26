import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DirectCDPTransport, SessionManager } from '../src/index.js'

const CHROME_CANDIDATES = [
  process.env.BROWSERPILOT_CHROME_BIN,
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean) as string[]

async function findChrome(): Promise<string | null> {
  for (const bin of CHROME_CANDIDATES) {
    try {
      await fs.access(bin)
      return bin
    } catch {}
  }
  return null
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else reject(new Error('port error'))
    })
  })
}

function buildMainAppHtml(oopifOrigin: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>BrowserPilot v1.5 Real-World Stress Lab</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #f8fafc; color: #0f172a; }
    #sticky-nav {
      position: fixed; top: 0; left: 0; right: 0; height: 70px;
      background: #0f172a; color: #f8fafc; z-index: 900;
      display: flex; align-items: center; padding: 0 20px; font-weight: 700;
    }
    .content { padding: 90px 24px 40px; }
    #loading-backdrop {
      position: fixed; inset: 0; background: rgba(15, 23, 42, 0.72); color: white;
      z-index: 1000; display: none; align-items: center; justify-content: center; font-size: 20px;
    }
    #sliding-wrap { position: relative; height: 48px; margin: 12px 0; }
    #sliding-btn { position: absolute; left: 0; top: 0; padding: 8px 14px; }
    #ce-empty {
      border: 1px solid #94a3b8; border-radius: 6px; padding: 8px 12px;
      min-height: 28px; background: white; max-width: 420px;
    }
    .row { margin: 14px 0; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    button { padding: 7px 12px; cursor: pointer; }
  </style>
</head>
<body>
  <header id="sticky-nav">Sticky Top Header (70px)</header>
  <div id="loading-backdrop">Loading overlay...</div>

  <div class="content">
    <!-- 1. React/Vue rapid remount stress -->
    <section class="row" id="flaky-zone">
      <button id="flaky-btn">Flaky Remount Action</button>
      <input id="flaky-input" placeholder="Remounts on focus" value="old" />
      <span id="flaky-result">idle</span>
    </section>

    <!-- 2. Transient disabled + loading overlay + sliding animation -->
    <section class="row">
      <button id="transient-btn">Transient Ready</button>
      <span id="transient-result">idle</span>
    </section>
    <div id="sliding-wrap">
      <button id="sliding-btn">Sliding Target</button>
      <span id="sliding-result" style="margin-left: 340px;">idle</span>
    </div>

    <!-- 3. Strict mode duplicate buttons -->
    <section class="row">
      <button class="dup-action" data-idx="0">Duplicate A</button>
      <button class="dup-action" data-idx="1">Duplicate B</button>
      <span id="dup-result">none</span>
    </section>

    <!-- 4. Rich text (ProseMirror/Notion/Feishu style empty-block Backspace detector + iframe CE + readonly) -->
    <section class="row" style="flex-direction: column; align-items: flex-start;">
      <div id="ce-empty" contenteditable="true" role="textbox" aria-label="Rich block"></div>
      <div id="ce-bug-flag">ok</div>
      <input id="ro-input" readonly value="locked" />
      <iframe id="rich-frame" src="/rich-frame" width="380" height="72" style="border:1px solid #cbd5e1;"></iframe>
    </section>

    <!-- 5. Dynamic off-DOM file chooser (ZERO <input type="file"> in DOM!) -->
    <section class="row">
      <button id="dropzone-btn" type="button">Upload Attachment (Dynamic)</button>
      <div id="upload-result">none</div>
    </section>

    <!-- 6. Shadow DOM nested card -->
    <section class="row">
      <div id="shadow-host"></div>
      <span id="shadow-result">none</span>
    </section>

    <!-- 7. Sticky header test button + tall spacer + below-the-fold Cross-Origin OOPIF -->
    <div style="height: 240px;"></div>
    <button id="under-sticky">Under Sticky Target</button>
    <span id="sticky-result">none</span>

    <div style="height: 1500px; background: linear-gradient(#f8fafc, #e2e8f0); margin: 20px 0;">
      Tall page spacer before below-the-fold OOPIF iframe
    </div>

    <iframe
      id="deep-oopif"
      src="${oopifOrigin}/oopif"
      width="420"
      height="130"
      style="border: 2px solid #06b6d4; display: block;"
    ></iframe>
  </div>

  <script>
    // Track flaky button clicks across remounts
    let flakyCount = 0;
    function bindFlakyBtn(btn) {
      btn.addEventListener('click', () => {
        flakyCount++;
        document.getElementById('flaky-result').textContent = 'clicked:' + flakyCount;
      });
    }
    bindFlakyBtn(document.getElementById('flaky-btn'));

    window.startFlakyRemounts = () => {
      let ticks = 0;
      const timer = setInterval(() => {
        ticks++;
        const old = document.getElementById('flaky-btn');
        if (old) {
          const fresh = document.createElement('button');
          fresh.id = 'flaky-btn';
          fresh.textContent = 'Flaky Remount Action #' + ticks;
          bindFlakyBtn(fresh);
          old.replaceWith(fresh);
        }
        if (ticks >= 5) clearInterval(timer);
      }, 65);
    };

    // Input that remounts itself once when first focused (Notion/Jira inline edit pattern)
    let remountedOnce = false;
    function bindFlakyInput(inp) {
      inp.addEventListener('focus', () => {
        if (remountedOnce) return;
        remountedOnce = true;
        const fresh = document.createElement('input');
        fresh.id = 'flaky-input';
        fresh.placeholder = 'Remounts on focus';
        fresh.value = inp.value;
        inp.replaceWith(fresh);
      });
    }
    bindFlakyInput(document.getElementById('flaky-input'));

    // Transient overlay + disabled recovery helper
    document.getElementById('transient-btn').addEventListener('click', () => {
      document.getElementById('transient-result').textContent = 'transient-clicked';
    });
    window.triggerTransientBlock = () => {
      const overlay = document.getElementById('loading-backdrop');
      const btn = document.getElementById('transient-btn');
      overlay.style.display = 'flex';
      btn.disabled = true;
      setTimeout(() => { overlay.style.display = 'none'; }, 240);
      setTimeout(() => { btn.disabled = false; }, 420);
    };

    // Sliding animation helper
    document.getElementById('sliding-btn').addEventListener('click', () => {
      document.getElementById('sliding-result').textContent = 'sliding-clicked';
    });
    window.startSlideAnimation = () => {
      const btn = document.getElementById('sliding-btn');
      const start = performance.now();
      function step(now) {
        const t = Math.min(1, (now - start) / 280);
        btn.style.left = Math.round(t * 220) + 'px';
        if (t < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    };

    // Duplicate buttons for strict mode test
    for (const b of document.querySelectorAll('.dup-action')) {
      b.addEventListener('click', () => {
        document.getElementById('dup-result').textContent = 'idx:' + b.dataset.idx;
      });
    }

    // ProseMirror / Notion empty-block Backspace detector
    const ce = document.getElementById('ce-empty');
    ce.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && (ce.innerText || '').trim().length === 0) {
        document.getElementById('ce-bug-flag').textContent = 'BUG_EMPTY_BACKSPACE';
      }
    });

    // Off-DOM dynamic file chooser button (never attached to document!)
    document.getElementById('dropzone-btn').addEventListener('click', () => {
      const detachedInput = document.createElement('input');
      detachedInput.type = 'file';
      detachedInput.multiple = true;
      detachedInput.addEventListener('change', async () => {
        const files = Array.from(detachedInput.files || []);
        const details = [];
        for (const f of files) {
          const content = await f.text();
          details.push(f.name + '=' + content.trim());
        }
        document.getElementById('upload-result').textContent = details.join('|');
      });
      detachedInput.click();
    });

    // Open Shadow DOM nested card
    const host = document.getElementById('shadow-host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="inner-card"><span>Shadow Widget</span> <button class="confirm-btn">Confirm Shadow</button></div>';
    root.querySelector('.confirm-btn').addEventListener('click', () => {
      document.getElementById('shadow-result').textContent = 'shadow-confirmed';
    });

    // Under-sticky target
    document.getElementById('under-sticky').addEventListener('click', () => {
      document.getElementById('sticky-result').textContent = 'sticky-cleared-clicked';
    });
  </script>
</body>
</html>`
}

const RICH_FRAME_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:8px;font-family:sans-serif;">
  <div id="frame-ce" contenteditable="true" style="border:1px solid #64748b;padding:6px;">Stale iframe text</div>
  <div id="iframe-shadow-host" style="margin-top:6px;"></div>
  <div id="iframe-shadow-result">none</div>
  <script>
    const sh = document.getElementById('iframe-shadow-host').attachShadow({ mode: 'open' });
    sh.innerHTML = '<button class="deep-btn">Deep Shadow In Iframe</button>';
    sh.querySelector('.deep-btn').addEventListener('click', () => {
      document.getElementById('iframe-shadow-result').textContent = 'deep-shadow-clicked';
    });
  </script>
</body>
</html>`

const UI_TRAPS_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Real-World UI Library Traps (AntD / Radix / Tailwind / Controlled Inputs)</title>
  <style>
    body { margin: 0; padding: 24px; font-family: system-ui, sans-serif; height: 2200px; }
    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
    }
    .switch-label { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 999px; }
    .switch-track { width: 32px; height: 18px; background: #94a3b8; border-radius: 999px; display: inline-block; }
    #portal-listbox {
      position: fixed; left: 24px; top: 110px; width: 220px; background: white;
      border: 1px solid #cbd5e1; border-radius: 8px; box-shadow: 0 8px 20px rgba(0,0,0,0.12);
      display: none; z-index: 500;
    }
    #portal-listbox [role="option"] { padding: 8px 12px; cursor: pointer; }
    #inner-list {
      width: 260px; height: 140px; overflow-y: auto; border: 1px solid #94a3b8; margin-top: 16px;
    }
    .list-item { height: 34px; display: flex; align-items: center; padding: 0 10px; border-bottom: 1px solid #e2e8f0; cursor: pointer; }
  </style>
</head>
<body>
  <!-- 1. Scroll-sensitive Portal Dropdown (AntD / Radix / Feishu pattern: closes on window scroll!) -->
  <button id="dropdown-trigger" type="button" role="combobox" aria-expanded="false">Choose Plan</button>
  <span id="dropdown-value">none</span>
  <span id="scroll-closed-flag">ok</span>

  <!-- 2. Tailwind / AntD sr-only custom toggle switch -->
  <div style="margin-top: 16px;">
    <label class="switch-label">
      <input id="dark-switch" type="checkbox" class="sr-only" />
      <span class="switch-track"></span>
      <span>Enable Dark Mode</span>
    </label>
    <span id="switch-result">off</span>
  </div>

  <!-- 3. SVG icon-only button -->
  <div style="margin-top: 16px;">
    <button id="svg-btn" aria-label="Star Item" style="padding: 8px;">
      <svg width="24" height="24" viewBox="0 0 24 24"><path d="M12 2L15 9L22 9L16 14L18 21L12 17L6 21L8 14L2 9L9 9Z" fill="#06b6d4"/></svg>
    </button>
    <span id="svg-result">none</span>
  </div>

  <!-- 4. Inner scrollable sidebar/list (clipped by ancestor overflow-y: auto, NOT window!) -->
  <div id="inner-list"></div>
  <div id="list-result">none</div>

  <!-- 5. Special input types + controlled uppercase input -->
  <div style="margin-top: 16px; display: flex; gap: 10px; flex-wrap: wrap;">
    <input id="date-inp" type="date" />
    <input id="num-inp" type="number" />
    <input id="upper-inp" placeholder="Uppercase controlled" />
  </div>

  <!-- Portal listbox attached at bottom of body -->
  <div id="portal-listbox" role="listbox">
    <div role="option" data-val="starter">Starter Plan</div>
    <div role="option" data-val="enterprise">Enterprise Plan</div>
  </div>

  <script>
    const trigger = document.getElementById('dropdown-trigger');
    const menu = document.getElementById('portal-listbox');
    let menuOpen = false;
    trigger.addEventListener('click', () => {
      menuOpen = true;
      menu.style.display = 'block';
      trigger.setAttribute('aria-expanded', 'true');
    });
    // Classic AntD / Element / Feishu behavior: any window scroll dismisses the open popover!
    window.addEventListener('scroll', () => {
      if (menuOpen) {
        menuOpen = false;
        menu.style.display = 'none';
        document.getElementById('scroll-closed-flag').textContent = 'CLOSED_BY_SCROLL';
      }
    });
    for (const opt of menu.querySelectorAll('[role="option"]')) {
      opt.addEventListener('click', () => {
        document.getElementById('dropdown-value').textContent = opt.dataset.val;
        menuOpen = false;
        menu.style.display = 'none';
      });
    }

    document.getElementById('dark-switch').addEventListener('change', (e) => {
      document.getElementById('switch-result').textContent = e.target.checked ? 'on' : 'off';
    });

    document.getElementById('svg-btn').addEventListener('click', () => {
      document.getElementById('svg-result').textContent = 'starred';
    });

    const listEl = document.getElementById('inner-list');
    for (let i = 1; i <= 20; i++) {
      const item = document.createElement('button');
      item.className = 'list-item';
      item.id = 'row-' + i;
      item.textContent = 'Sidebar Row #' + i;
      item.addEventListener('click', () => {
        document.getElementById('list-result').textContent = 'selected-row-' + i;
      });
      listEl.appendChild(item);
    }

    const upper = document.getElementById('upper-inp');
    upper.addEventListener('input', () => {
      upper.value = upper.value.toUpperCase();
    });
  </script>
</body>
</html>`

const OOPIF_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:12px;font-family:sans-serif;background:#ecfeff;">
  <button id="oopif-submit" style="padding:10px 18px;font-weight:700;">Pay In Cross-Origin Frame</button>
  <span id="oopif-status">waiting</span>
  <script>
    document.getElementById('oopif-submit').addEventListener('click', (e) => {
      document.getElementById('oopif-status').textContent = 'paid:' + e.isTrusted;
    });
  </script>
</body>
</html>`

describe('@browserpilot/core v1.5 real-world complex SPA stress tests (real Chromium)', () => {
  let mainServer: http.Server
  let oopifServer: http.Server
  let baseUrl = ''
  let oopifOrigin = ''
  let chromeProc: ChildProcess | null = null
  let userDataDir = ''
  let tmpFilesDir = ''
  let fileA = ''
  let fileB = ''
  let transport: DirectCDPTransport | null = null
  let manager: SessionManager | null = null

  beforeAll(async () => {
    const chromeBin = await findChrome()
    if (!chromeBin) return

    tmpFilesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-v15-files-'))
    fileA = path.join(tmpFilesDir, 'alpha.txt')
    fileB = path.join(tmpFilesDir, 'beta.txt')
    await fs.writeFile(fileA, 'alpha-payload', 'utf8')
    await fs.writeFile(fileB, 'beta-payload', 'utf8')

    // Start cross-origin OOPIF server on localhost (distinct origin from 127.0.0.1!)
    const oopifPort = await getFreePort()
    oopifServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(OOPIF_HTML)
    })
    await new Promise<void>((r) => oopifServer.listen(oopifPort, '127.0.0.1', r))
    oopifOrigin = `http://localhost:${oopifPort}`

    // Start main app + API server on 127.0.0.1
    const mainPort = await getFreePort()
    mainServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${mainPort}`)
      if (url.pathname === '/rich-frame') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(RICH_FRAME_HTML)
        return
      }
      if (url.pathname === '/ui-traps') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(UI_TRAPS_HTML)
        return
      }
      if (url.pathname === '/api/post-echo') {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8')
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ method: req.method, received: JSON.parse(bodyText || '{}') }))
        })
        return
      }
      if (url.pathname === '/api/server-500') {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'boom' }))
        return
      }
      if (url.pathname === '/api/profile') {
        const cookie = req.headers.cookie || ''
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ user: cookie.includes('session_user=alice') ? 'alice' : 'guest', plan: 'free', cookie }))
        return
      }
      if (url.pathname === '/api/feed') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ items: ['real-1', 'real-2'] }))
        return
      }
      if (url.pathname === '/api/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ customAuth: req.headers['x-custom-auth'] ?? null }))
        return
      }
      if (url.pathname === '/api/blocked-telemetry') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(buildMainAppHtml(oopifOrigin))
    })
    await new Promise<void>((r) => mainServer.listen(mainPort, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${mainPort}`

    const cdpPort = await getFreePort()
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-v15-chrome-'))
    chromeProc = spawn(
      chromeBin,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,800',
        ...(process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    )

    const endpoint = `http://127.0.0.1:${cdpPort}`
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${endpoint}/json/version`)).ok) break
      } catch {}
      await new Promise((r) => setTimeout(r, 150))
    }

    transport = await DirectCDPTransport.connect(endpoint)
    manager = new SessionManager(transport)
  }, 30_000)

  afterAll(async () => {
    manager?.dispose()
    await transport?.close()
    if (chromeProc) chromeProc.kill('SIGTERM')
    if (mainServer) await new Promise<void>((r) => mainServer.close(() => r()))
    if (oopifServer) await new Promise<void>((r) => oopifServer.close(() => r()))
    if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    if (tmpFilesDir) await fs.rm(tmpFilesDir, { recursive: true, force: true }).catch(() => {})
  })

  it('survives rapid React/Vue remounts, transient overlays/disabled/animations, strict mode, rich-text editors, sticky headers & deep OOPIF', async () => {
    if (!manager) return
    const tab = await manager.openTab({ url: baseUrl })
    await tab.page.navigate(baseUrl, { waitUntil: 'load' })

    // 1. Rapid DOM remounts mid-click & mid-fill (React/Vue/Notion inline edit pattern)
    await tab.page.evaluate('window.startFlakyRemounts()')
    await tab.page.click('#flaky-btn', { timeoutMs: 3_000 })
    expect(await tab.page.evaluate<string>('document.getElementById("flaky-result").textContent')).toMatch(/^clicked:\d+/)

    await tab.page.fill('#flaky-input', 'survived-focus-remount', { timeoutMs: 3_000 })
    expect(await tab.page.evaluate<string>('document.getElementById("flaky-input").value')).toBe('survived-focus-remount')

    // 2. Transient loading backdrop + transient disabled button + sliding animation auto-waiting!
    await tab.page.evaluate('window.triggerTransientBlock()')
    await tab.page.click('#transient-btn', { timeoutMs: 3_000 })
    expect(await tab.page.evaluate<string>('document.getElementById("transient-result").textContent')).toBe('transient-clicked')

    await tab.page.evaluate('window.startSlideAnimation()')
    await tab.page.click('#sliding-btn', { timeoutMs: 3_000 })
    expect(await tab.page.evaluate<string>('document.getElementById("sliding-result").textContent')).toBe('sliding-clicked')

    // 3. Strict mode catches ambiguous locators immediately & succeeds when narrowed
    await expect(tab.page.click('.dup-action', { strict: true })).rejects.toThrow(/strict mode violation.*2 elements/i)
    await tab.page.click('.dup-action >> nth=1', { strict: true })
    expect(await tab.page.evaluate<string>('document.getElementById("dup-result").textContent')).toBe('idx:1')

    // 4. Rich-text contenteditable: empty block NEVER receives Backspace (ProseMirror/Notion/Feishu safe!),
    //    non-empty replacement works cleanly, same-origin iframe contenteditable works, readonly input rejects cleanly
    await tab.page.fill('#ce-empty', 'Hello Notion & Feishu!')
    expect(await tab.page.evaluate<string>('document.getElementById("ce-bug-flag").textContent')).toBe('ok')
    expect(await tab.page.evaluate<string>('document.getElementById("ce-empty").innerText.trim()')).toBe('Hello Notion & Feishu!')

    await tab.page.fill('#ce-empty', 'Replaced Rich Block')
    expect(await tab.page.evaluate<string>('document.getElementById("ce-empty").innerText.trim()')).toBe('Replaced Rich Block')

    await tab.page.fill('iframe#rich-frame >> #frame-ce', 'Iframe Editor Updated')
    expect(await tab.page.evaluate<string>('document.getElementById("frame-ce").innerText.trim()', { frame: 'rich-frame' })).toBe(
      'Iframe Editor Updated',
    )

    // Shadow DOM nested inside a same-origin iframe!
    await tab.page.click('iframe#rich-frame >> #iframe-shadow-host >> button:has-text("Deep Shadow In Iframe")')
    expect(await tab.page.evaluate<string>('document.getElementById("iframe-shadow-result").textContent', { frame: 'rich-frame' })).toBe(
      'deep-shadow-clicked',
    )

    await expect(tab.page.fill('#ro-input', 'nope', { timeoutMs: 300 })).rejects.toThrow(/read-only/i)

    // 5. Shadow DOM nested card
    await tab.page.click('#shadow-host >> .inner-card >> button:has-text("Confirm Shadow")')
    expect(await tab.page.evaluate<string>('document.getElementById("shadow-result").textContent')).toBe('shadow-confirmed')

    // 6. Sticky header occlusion recovery: scroll target right under 70px sticky header, then click
    await tab.page.evaluate(`(() => {
      const btn = document.getElementById('under-sticky');
      window.scrollTo(0, btn.offsetTop - 20);
    })()`)
    await tab.page.click('#under-sticky', { timeoutMs: 2_500 })
    expect(await tab.page.evaluate<string>('document.getElementById("sticky-result").textContent')).toBe('sticky-cleared-clicked')

    // 7. Below-the-fold Cross-Origin OOPIF iframe (1500px+ down page) — scrolls parent & refreshes frameOffset!
    await tab.page.evaluate('window.scrollTo(0, 0)')
    await tab.page.click('iframe#deep-oopif >> #oopif-submit', { timeoutMs: 4_000 })
    expect(await tab.page.evaluate<string>('document.getElementById("oopif-status").textContent', { frame: 'oopif' })).toBe(
      'paid:true',
    )
  }, 45_000)

  it('supports dynamic code-level route() + route.fetch() + Response-stage mutation + off-DOM filechooser + sandbox exec parity', async () => {
    if (!manager) return
    const tab = await manager.openTab({ url: baseUrl })
    await tab.page.navigate(baseUrl, { waitUntil: 'load' })

    // Set real browser cookie so we can verify route.fetch() forwards cookies!
    await tab.page.setCookie({ name: 'session_user', value: 'alice', url: baseUrl })

    // 1. Request-stage route + route.fetch() + live JSON mutation + custom response header
    const profileRouteId = await tab.network.route('**/api/profile*', async (r) => {
      const upstream = await r.fetch()
      const data = await upstream.json<{ user: string; plan: string; patched?: boolean }>()
      data.plan = 'enterprise'
      data.patched = true
      await r.fulfill({ status: upstream.status, json: data, headers: { 'x-bp-patched': 'yes' } })
    })

    const profileRes = await tab.page.evaluate<{ data: { user: string; plan: string; patched: boolean }; hdr: string | null }>(
      `(async () => { const r = await fetch('/api/profile'); return { data: await r.json(), hdr: r.headers.get('x-bp-patched') }; })()`,
    )
    expect(profileRes.data.user).toBe('alice')
    expect(profileRes.data.plan).toBe('enterprise')
    expect(profileRes.data.patched).toBe(true)
    expect(profileRes.hdr).toBe('yes')

    // 2. Response-stage route (paused inside Chromium network stack via Fetch.getResponseBody)
    await tab.network.route(
      /\/api\/feed/,
      async (r) => {
        const resp = await r.fetch()
        const json = await resp.json<{ items: string[] }>()
        json.items.push('injected-in-response-stage')
        await r.fulfill({ status: resp.status, json })
      },
      { stage: 'Response' },
    )
    const feedRes = await tab.page.evaluate<{ items: string[] }>(`(async () => (await fetch('/api/feed')).json())()`)
    expect(feedRes.items).toEqual(['real-1', 'real-2', 'injected-in-response-stage'])

    // 3. route.continue({ headers }) with times: 1 auto-expiration
    await tab.network.route(
      '**/api/echo',
      async (r) => {
        await r.continue({ headers: { 'x-custom-auth': 'bp-token-99' } })
      },
      { times: 1 },
    )
    const echo1 = await tab.page.evaluate<{ customAuth: string | null }>(`(async () => (await fetch('/api/echo')).json())()`)
    const echo2 = await tab.page.evaluate<{ customAuth: string | null }>(`(async () => (await fetch('/api/echo')).json())()`)
    expect(echo1.customAuth).toBe('bp-token-99')
    expect(echo2.customAuth).toBeNull()

    // 4. route.abort() blocks tracking endpoint
    await tab.network.route('**/api/blocked-telemetry', async (r) => {
      await r.abort('BlockedByClient')
    })
    const aborted = await tab.page.evaluate<boolean>(
      `(async () => { try { await fetch('/api/blocked-telemetry'); return false; } catch { return true; } })()`,
    )
    expect(aborted).toBe(true)

    // 5. unroute() restores normal traffic
    await tab.network.unroute(profileRouteId)
    const unpatchedProfile = await tab.page.evaluate<{ user: string; plan: string }>(
      `(async () => (await fetch('/api/profile')).json())()`,
    )
    expect(unpatchedProfile.user).toBe('alice')
    expect(unpatchedProfile.plan).toBe('free')
    await tab.network.clearRoutes()

    // 6. Dynamic off-DOM filechooser upload: explicit waitForFileChooser() with multiple files
    expect(await tab.page.evaluate<number>('document.querySelectorAll("input[type=file]").length')).toBe(0)
    const chooser = await tab.page.waitForFileChooser({
      action: () => tab.page.click('#dropzone-btn'),
    })
    expect(chooser.isMultiple).toBe(true)
    await chooser.setFiles([fileA, fileB])
    await expect
      .poll(() => tab.page.evaluate<string>('document.getElementById("upload-result").textContent'), { timeout: 5000 })
      .toBe('alpha.txt=alpha-payload|beta.txt=beta-payload')

    // 7. Smart automatic uploadFiles() targeting the trigger button directly (zero <input type="file"> in DOM!)
    await tab.page.uploadFiles('#dropzone-btn', [fileA])
    await expect
      .poll(() => tab.page.evaluate<string>('document.getElementById("upload-result").textContent'), { timeout: 5000 })
      .toBe('alpha.txt=alpha-payload')

    // 8. Sandbox exec() integration for route(), unroute(), and waitForFileChooser()
    const execRes = await manager.exec(
      'v15-stress-exec',
      `
      const id = await route('**/api/echo', async (r) => {
        await r.fulfill({ json: { customAuth: 'from-sandbox-route' } })
      })
      const echoed = await evaluate("(async () => (await fetch('/api/echo')).json())()")
      await unroute(id)
      await waitForFileChooser({
        action: () => click('#dropzone-btn'),
        files: [${JSON.stringify(fileB)}],
      })
      await waitForText('beta.txt=beta-payload', { timeoutMs: 5000 })
      const uploaded = await evaluate("document.getElementById('upload-result').textContent")
      return { echoed, uploaded }
      `,
      { tabId: tab.tabId },
    )
    expect(execRes.error).toBeUndefined()
    expect(execRes.returnValue).toEqual({
      echoed: { customAuth: 'from-sandbox-route' },
      uploaded: 'beta.txt=beta-payload',
    })
  }, 45_000)

  it('handles real-world UI library traps: scroll-sensitive portal dropdowns, sr-only switches, SVG buttons, inner-clipped lists, POST route patching & chooser cancel', async () => {
    if (!manager) return
    const tab = await manager.openTab({ url: `${baseUrl}/ui-traps` })
    await tab.page.navigate(`${baseUrl}/ui-traps`, { waitUntil: 'load' })

    // 1. Scroll-sensitive Portal Dropdown (AntD / Radix / Feishu): clicking visible option MUST NOT scroll window!
    await tab.page.click('#dropdown-trigger')
    await tab.page.click('role=option[name="Enterprise Plan"]')
    expect(await tab.page.evaluate<string>('document.getElementById("scroll-closed-flag").textContent')).toBe('ok')
    expect(await tab.page.evaluate<string>('document.getElementById("dropdown-value").textContent')).toBe('enterprise')

    // 2. Tailwind / AntD sr-only 1px checkbox wrapped inside <label>
    expect(await tab.page.check('label=Enable Dark Mode')).toBe(true)
    expect(await tab.page.evaluate<string>('document.getElementById("switch-result").textContent')).toBe('on')
    expect(await tab.page.check('label=Enable Dark Mode')).toBe(false) // idempotent!
    expect(await tab.page.uncheck('label=Enable Dark Mode')).toBe(true)
    expect(await tab.page.evaluate<string>('document.getElementById("switch-result").textContent')).toBe('off')

    // 3. SVG icon-only button
    await tab.page.click('role=button[name="Star Item"]')
    expect(await tab.page.evaluate<string>('document.getElementById("svg-result").textContent')).toBe('starred')

    // 4. Inner scrollable container (clipped by ancestor overflow-y: auto even while within window.innerHeight!)
    await tab.page.click('#row-19')
    expect(await tab.page.evaluate<string>('document.getElementById("list-result").textContent')).toBe('selected-row-19')
    expect(await tab.page.evaluate<number>('document.getElementById("inner-list").scrollTop')).toBeGreaterThan(200)

    // 5. Special input types (<input type="date">, <input type="number">) + uppercase controlled input
    await tab.page.fill('#date-inp', '2026-11-25')
    await tab.page.fill('#num-inp', '42.5')
    await tab.page.fill('#upper-inp', 'mixedCase')
    expect(
      await tab.page.evaluate(`({
        d: document.getElementById('date-inp').value,
        n: document.getElementById('num-inp').value,
        u: document.getElementById('upper-inp').value,
      })`),
    ).toEqual({ d: '2026-11-25', n: '42.5', u: 'MIXEDCASE' })

    // 6. POST body modification via route.continue({ postData }) AND turning real 500 error into 200 OK at Response stage
    await tab.network.route('**/api/post-echo', async (r) => {
      const parsed = JSON.parse(r.request.postData || '{}') as Record<string, unknown>
      parsed.injected = 'by-route-continue'
      await r.continue({ postData: JSON.stringify(parsed) })
    })
    const postRes = await tab.page.evaluate<{ received: { msg: string; injected: string } }>(
      `(async () => (await fetch('/api/post-echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg: 'hi' }) })).json())()`,
    )
    expect(postRes.received).toEqual({ msg: 'hi', injected: 'by-route-continue' })

    await tab.network.route(
      '**/api/server-500',
      async (r) => {
        expect(r.responseStatusCode).toBe(500)
        await r.fulfill({ status: 200, json: { recovered: true, wasStatus: r.responseStatusCode } })
      },
      { stage: 'Response' },
    )
    const recovered = await tab.page.evaluate<{ status: number; body: { recovered: boolean; wasStatus: number } }>(
      `(async () => { const r = await fetch('/api/server-500'); return { status: r.status, body: await r.json() }; })()`,
    )
    expect(recovered).toEqual({ status: 200, body: { recovered: true, wasStatus: 500 } })
    await tab.network.clearRoutes()

    // 7. FileChooser cancel() cleanly disables interception so future operations stay unblocked
    await tab.page.navigate(baseUrl, { waitUntil: 'load' })
    const cancelled = await tab.page.waitForFileChooser({ action: () => tab.page.click('#dropzone-btn') })
    await cancelled.cancel()
    await tab.page.uploadFiles('#dropzone-btn', [fileA])
    await expect
      .poll(() => tab.page.evaluate<string>('document.getElementById("upload-result").textContent'), { timeout: 5000 })
      .toBe('alpha.txt=alpha-payload')
  }, 45_000)
})
