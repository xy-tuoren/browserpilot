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
  for (const c of CHROME_CANDIDATES) {
    try {
      await fs.access(c)
      return c
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
      } else reject(new Error('No port'))
    })
  })
}

const ENTERPRISE_ADMIN_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Enterprise Admin Console (10k+ DOM Nodes)</title>
  <style>
    * { box-sizing: border-box; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 16px; }
    .toolbar { display: flex; gap: 10px; align-items: center; padding: 10px; background: #f8fafc; border: 1px solid #cbd5e1; margin-bottom: 12px; position: sticky; top: 0; z-index: 20; }
    .table-wrap { width: 100%; overflow-x: auto; border: 1px solid #cbd5e1; }
    table { border-collapse: collapse; width: 1600px; }
    th, td { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; font-size: 13px; white-space: nowrap; }
    thead th { position: sticky; top: 52px; background: #f1f5f9; z-index: 10; }
    .portal-menu { position: fixed; background: #fff; border: 1px solid #94a3b8; border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.16); z-index: 900; padding: 4px; width: 220px; }
    .portal-opt { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 6px 8px; cursor: pointer; }
    .portal-opt:hover { background: #e2e8f0; }
    .overlay { position: fixed; inset: 0; background: rgba(15,23,42,0.45); display: none; align-items: center; justify-content: center; }
    .modal-box { background: #fff; border-radius: 10px; padding: 18px; width: 420px; }
    .drawer-box { position: fixed; right: 0; top: 0; bottom: 0; width: 320px; background: #fff; padding: 18px; box-shadow: -8px 0 24px rgba(0,0,0,0.2); }
  </style>
</head>
<body>
  <header id="filter-bar" class="toolbar" role="region" aria-label="Order Filters">
    <select id="country" aria-label="Country">
      <option value="">Select Country</option>
      <option value="us">United States</option>
      <option value="cn">China</option>
    </select>
    <select id="region" aria-label="Region" disabled>
      <option value="">Select Region</option>
    </select>
    <input id="owner-combo" role="combobox" aria-label="Account Owner" placeholder="Search owner..." autocomplete="off" />
    <button id="open-modal">Bulk Action</button>
    <span id="admin-status">idle</span>
  </header>

  <main class="table-wrap">
    <table aria-label="Enterprise Orders">
      <thead>
        <tr>
          <th>Order ID</th><th>Actions</th><th>Customer</th><th>Region</th><th>Owner</th><th>Tier</th><th>Status</th>
          <th>Amount</th><th>Currency</th><th>Created</th><th>Updated</th><th>Tag</th>
        </tr>
      </thead>
      <tbody id="order-rows"></tbody>
    </table>
  </main>

  <div id="modal-overlay" class="overlay" style="z-index:500" role="dialog" aria-label="Bulk Update Modal">
    <div class="modal-box">
      <h3>Bulk Update Orders</h3>
      <input id="modal-note" placeholder="Audit reason" />
      <button id="open-drawer">Open Policy Drawer</button>
      <button id="modal-close">Close Modal</button>
    </div>
  </div>

  <div id="drawer-overlay" class="overlay" style="z-index:700" role="dialog" aria-label="Policy Drawer">
    <div class="drawer-box">
      <h4>Approval Policy</h4>
      <label><input id="policy-ack" type="checkbox" /> Confirm SLA impact</label>
      <button id="drawer-apply" disabled>Apply Policy</button>
    </div>
  </div>

  <script>
    // Generate 380 rows x 12 columns with nested spans/badges (~11,000+ DOM nodes)
    const tbody = document.getElementById('order-rows');
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= 380; i++) {
      const tr = document.createElement('tr');
      tr.dataset.orderId = 'ORD-' + i;
      tr.innerHTML =
        '<td><span><b>ORD-' + i + '</b></span></td>' +
        '<td><button class="row-inspect" data-row="' + i + '">Inspect #' + i + '</button></td>' +
        '<td><div><span>Acme Corp #' + i + '</span><small> (B2B)</small></div></td>' +
        '<td><span>US-West</span></td>' +
        '<td><span>Owner ' + (i % 10) + '</span></td>' +
        '<td><span class="tier">Enterprise</span></td>' +
        '<td><span class="badge"><i>Active</i></span></td>' +
        '<td><span>$' + (i * 125) + '</span></td>' +
        '<td><span>USD</span></td>' +
        '<td><span>2026-11-01</span></td>' +
        '<td><span>2026-11-26</span></td>' +
        '<td><span>priority-' + (i % 4) + '</span></td>';
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    tbody.addEventListener('click', (e) => {
      const btn = e.target.closest('.row-inspect');
      if (btn) document.getElementById('admin-status').textContent = 'inspected:' + btn.dataset.row;
    });

    // Cascading async dropdown (Country -> /api/regions)
    document.getElementById('country').addEventListener('change', async (e) => {
      const regionSel = document.getElementById('region');
      regionSel.disabled = true;
      regionSel.innerHTML = '<option value="">Loading...</option>';
      const res = await fetch('/api/regions?country=' + encodeURIComponent(e.target.value));
      const data = await res.json();
      regionSel.innerHTML = '<option value="">Select Region</option>' +
        data.regions.map((r) => '<option value="' + r.id + '">' + r.label + '</option>').join('');
      regionSel.disabled = false;
    });
    document.getElementById('region').addEventListener('change', (e) => {
      document.getElementById('admin-status').textContent = 'region:' + e.target.value;
    });

    // Debounced Portal autocomplete combobox mounted on document.body
    let comboTimer = null;
    let portalEl = null;
    const owners = ['Alice Chen', 'Bob Martinez', 'Charlie Wu', 'Diana Patel'];
    const combo = document.getElementById('owner-combo');
    combo.addEventListener('input', () => {
      clearTimeout(comboTimer);
      comboTimer = setTimeout(() => {
        if (portalEl) portalEl.remove();
        const q = combo.value.trim().toLowerCase();
        const hits = owners.filter((o) => o.toLowerCase().includes(q));
        if (!hits.length) return;
        const rect = combo.getBoundingClientRect();
        portalEl = document.createElement('div');
        portalEl.className = 'portal-menu';
        portalEl.setAttribute('role', 'listbox');
        portalEl.style.left = rect.left + 'px';
        portalEl.style.top = (rect.bottom + 4) + 'px';
        for (const h of hits) {
          const opt = document.createElement('button');
          opt.type = 'button';
          opt.className = 'portal-opt';
          opt.setAttribute('role', 'option');
          opt.textContent = h;
          opt.addEventListener('click', () => {
            combo.value = h;
            document.getElementById('admin-status').textContent = 'owner:' + h;
            portalEl.remove();
            portalEl = null;
          });
          portalEl.appendChild(opt);
        }
        document.body.appendChild(portalEl);
      }, 60);
    });

    // Stacked Modal + Drawer + Escape top-layer close
    const modal = document.getElementById('modal-overlay');
    const drawer = document.getElementById('drawer-overlay');
    document.getElementById('open-modal').addEventListener('click', () => { modal.style.display = 'flex'; });
    document.getElementById('modal-close').addEventListener('click', () => { modal.style.display = 'none'; });
    document.getElementById('open-drawer').addEventListener('click', () => { drawer.style.display = 'block'; });
    document.getElementById('policy-ack').addEventListener('change', (e) => {
      document.getElementById('drawer-apply').disabled = !e.target.checked;
    });
    document.getElementById('drawer-apply').addEventListener('click', () => {
      document.getElementById('admin-status').textContent = 'policy-applied:' + document.getElementById('modal-note').value;
      drawer.style.display = 'none';
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (drawer.style.display === 'block') drawer.style.display = 'none';
        else if (modal.style.display === 'flex') modal.style.display = 'none';
      }
    });
  </script>
</body>
</html>`

const COLLAB_DOC_EDITOR_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Collaborative Doc & Code Editor</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 20px; max-width: 760px; }
    #doc-editor { border: 1px solid #94a3b8; border-radius: 8px; padding: 14px; min-height: 140px; outline: none; }
    .popover { position: fixed; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 6px; box-shadow: 0 8px 20px rgba(0,0,0,0.12); display: none; z-index: 400; }
    .popover button { display: block; width: 100%; text-align: left; padding: 6px 10px; border: 0; background: transparent; cursor: pointer; }
    .mention { background: #dbeafe; color: #1d4ed8; padding: 1px 5px; border-radius: 4px; }
    .callout { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 8px 10px; margin: 6px 0; }
    .code-shell { position: relative; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 12px; margin-top: 18px; min-height: 90px; cursor: text; }
    .code-input { position: absolute; opacity: 0.01; left: 0; top: 0; width: 100%; height: 100%; }
    pre#code-view { margin: 0; font: 13px/1.5 ui-monospace, monospace; pointer-events: none; }
  </style>
</head>
<body>
  <h1>Team Spec Document</h1>
  <div id="doc-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Document Editor">
    <p id="p-first">Initial draft line</p>
  </div>
  <div id="slash-menu" class="popover" role="menu" aria-label="Slash Commands">
    <button id="cmd-callout" role="menuitem">Callout Block</button>
    <button id="cmd-todo" role="menuitem">Checklist Item</button>
  </div>
  <div id="mention-menu" class="popover" role="listbox" aria-label="Mention Users">
    <button id="mention-alice" role="option">@Alice</button>
    <button id="mention-bob" role="option">@Bob</button>
  </div>

  <div id="code-shell" class="code-shell">
    <textarea id="code-hidden-ta" class="code-input" aria-label="Code Editor"></textarea>
    <pre id="code-view">// click to edit code</pre>
  </div>
  <div id="doc-meta">ready</div>

  <script>
    const ed = document.getElementById('doc-editor');
    const slashMenu = document.getElementById('slash-menu');
    const mentionMenu = document.getElementById('mention-menu');
    ed.addEventListener('input', () => {
      const txt = ed.innerText;
      const r = ed.getBoundingClientRect();
      if (txt.trimEnd().endsWith('/')) {
        slashMenu.style.left = (r.left + 20) + 'px';
        slashMenu.style.top = (r.bottom + 4) + 'px';
        slashMenu.style.display = 'block';
      } else {
        slashMenu.style.display = 'none';
      }
      if (/@ali$/i.test(txt.trimEnd())) {
        mentionMenu.style.left = (r.left + 20) + 'px';
        mentionMenu.style.top = (r.bottom + 4) + 'px';
        mentionMenu.style.display = 'block';
      } else {
        mentionMenu.style.display = 'none';
      }
    });
    ed.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        document.getElementById('doc-meta').textContent = 'bold-shortcut-fired';
      }
      if (mentionMenu.style.display === 'block' && e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('mention-alice').click();
      }
    });
    document.getElementById('cmd-callout').addEventListener('click', () => {
      slashMenu.style.display = 'none';
      const box = document.createElement('div');
      box.className = 'callout';
      box.textContent = 'Important Callout';
      ed.appendChild(box);
      document.getElementById('doc-meta').textContent = 'callout-inserted';
    });
    document.getElementById('mention-alice').addEventListener('click', () => {
      mentionMenu.style.display = 'none';
      const chip = document.createElement('span');
      chip.className = 'mention';
      chip.contentEditable = 'false';
      chip.textContent = '@Alice';
      ed.appendChild(chip);
      document.getElementById('doc-meta').textContent = 'mentioned-alice';
    });

    // CodeMirror / Monaco-style hidden textarea + visible overlay
    const codeTa = document.getElementById('code-hidden-ta');
    const codeView = document.getElementById('code-view');
    document.getElementById('code-shell').addEventListener('click', () => codeTa.focus());
    codeTa.addEventListener('input', () => {
      codeView.textContent = codeTa.value;
    });
  </script>
</body>
</html>`

const DEEP_SHADOW_COMPONENTS_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>3-Level Nested Shadow DOM Web Components</title>
</head>
<body>
  <h1>Web Components Workspace</h1>
  <app-shell id="app-shell">
    <button id="slotted-publish" slot="footer-actions">Publish Component</button>
  </app-shell>
  <div id="wc-status">initial</div>

  <script>
    class CustomInput extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<label><span>Workspace Name</span> <input id="deep-name" placeholder="Enter workspace" /></label>';
      }
      get value() { return this.shadowRoot.getElementById('deep-name').value; }
    }
    class CustomToggle extends HTMLElement {
      constructor() {
        super();
        this._checked = false;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<button id="deep-switch" role="switch" aria-checked="false" aria-label="Auto Deploy">Auto Deploy: OFF</button>';
        const btn = root.getElementById('deep-switch');
        btn.addEventListener('click', () => {
          this._checked = !this._checked;
          btn.setAttribute('aria-checked', String(this._checked));
          btn.textContent = 'Auto Deploy: ' + (this._checked ? 'ON' : 'OFF');
        });
      }
      get checked() { return this._checked; }
    }
    class SettingsPanel extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML =
          '<section id="settings-card" style="padding:12px;border:1px solid #cbd5e1">' +
          '  <h2>Deep Settings</h2>' +
          '  <custom-input id="custom-input"></custom-input>' +
          '  <custom-toggle id="custom-toggle"></custom-toggle>' +
          '  <button id="save-deep">Save Deep Settings</button>' +
          '</section>';
        root.getElementById('save-deep').addEventListener('click', () => {
          const name = root.getElementById('custom-input').value;
          const auto = root.getElementById('custom-toggle').checked;
          document.getElementById('wc-status').textContent = 'saved:' + name + ':auto=' + auto;
        });
      }
    }
    class AppShell extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML =
          '<div class="shell">' +
          '  <settings-panel id="settings-panel"></settings-panel>' +
          '  <footer><slot name="footer-actions"></slot></footer>' +
          '</div>';
      }
    }
    customElements.define('custom-input', CustomInput);
    customElements.define('custom-toggle', CustomToggle);
    customElements.define('settings-panel', SettingsPanel);
    customElements.define('app-shell', AppShell);

    document.getElementById('slotted-publish').addEventListener('click', () => {
      document.getElementById('wc-status').textContent += '|published';
    });
  </script>
</body>
</html>`

describe('@browserpilot/core Complex Page Archetypes A: Enterprise 10k-DOM Admin, Collab Editors & 3-Level Shadow DOM', () => {
  let httpServer: http.Server
  let chromeProc: ChildProcess | null = null
  let userDataDir = ''
  let baseUrl = ''
  let transport: DirectCDPTransport | null = null
  let manager: SessionManager | null = null
  let chromeBin: string | null = null

  beforeAll(async () => {
    chromeBin = await findChrome()
    if (!chromeBin) return

    const httpPort = await getFreePort()
    httpServer = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      if (u.pathname === '/api/regions') {
        const c = u.searchParams.get('country')
        const regions =
          c === 'cn'
            ? [
                { id: 'sh', label: 'Shanghai' },
                { id: 'bj', label: 'Beijing' },
              ]
            : [
                { id: 'ca', label: 'California' },
                { id: 'ny', label: 'New York' },
              ]
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ regions }))
        return
      }
      if (u.pathname === '/editor') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(COLLAB_DOC_EDITOR_HTML)
        return
      }
      if (u.pathname === '/shadow') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(DEEP_SHADOW_COMPONENTS_HTML)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(ENTERPRISE_ADMIN_HTML)
    })
    await new Promise<void>((r) => httpServer.listen(httpPort, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${httpPort}`

    const debugPort = await getFreePort()
    userDataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bp-complex-a-')))
    chromeProc = spawn(
      chromeBin,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,800',
        ...(process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${userDataDir}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    )
    const endpoint = `http://127.0.0.1:${debugPort}`
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
    chromeProc?.kill('SIGTERM')
    if (httpServer) await new Promise<void>((r) => httpServer.close(() => r()))
    if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('Archetype 1: budgets 10,000+ DOM node enterprise admin table with viewportOnly/maxChars/scope and drives async cascading selects, Portal combobox & stacked Modal+Drawer', async () => {
    if (!chromeBin || !manager) return
    const tab = await manager.openTab({ url: `${baseUrl}/admin` })
    await tab.page.waitForLocator('button[data-row="380"]', { state: 'attached', timeoutMs: 10_000 })

    // Verify we really have >10,000 DOM nodes
    const domCount = await tab.page.evaluate<number>('document.querySelectorAll("*").length')
    expect(domCount).toBeGreaterThan(10_000)

    // 1. Full snapshot vs viewportOnly+interactiveOnly vs maxChars budget vs subtree scope
    const fullSnap = await tab.snapshots.capture(tab.session, { showDiffSinceLastCall: false })
    const vpSnap = await tab.snapshots.capture(tab.session, {
      viewportOnly: true,
      interactiveOnly: true,
      showDiffSinceLastCall: false,
    })
    const budgetedSnap = await tab.snapshots.capture(tab.session, {
      maxChars: 3500,
      showDiffSinceLastCall: false,
    })
    const scopedSnap = await tab.snapshots.capture(tab.session, {
      scope: '#filter-bar',
      showDiffSinceLastCall: false,
    })

    // Viewport-only + interactive should slash snapshot payload dramatically (>80% smaller than full 300-row table!)
    expect(vpSnap.text.length).toBeLessThan(fullSnap.text.length * 0.2)
    expect(vpSnap.text).toContain('Mode: interactive,viewport')
    expect(vpSnap.text).toContain('Inspect #1')
    expect(vpSnap.text).not.toContain('Inspect #290')

    // Soft character budget truncates cleanly with actionable guidance footer
    expect(budgetedSnap.truncated).toBe(true)
    expect(budgetedSnap.omittedLines).toBeGreaterThan(50)
    expect(budgetedSnap.text.length).toBeLessThanOrEqual(3800)
    expect(budgetedSnap.text).toContain('[Truncated:')

    // Scoped snapshot isolates just the filter bar
    expect(scopedSnap.text).toContain('Bulk Action')
    expect(scopedSnap.text).not.toContain('ORD-250')

    // Ref returned inside viewportOnly snapshot works directly for clicking!
    const vpInspect1 = Object.values(vpSnap.refs).find((r) => r.name === 'Inspect #1')?.ref
    expect(vpInspect1).toBeTruthy()
    // Re-capture vpSnap so refMap holds vpInspect1 cleanly (scopedSnap ran after vpSnap)
    const vpSnapActive = await tab.snapshots.capture(tab.session, {
      viewportOnly: true,
      interactiveOnly: true,
      showDiffSinceLastCall: false,
    })
    const ref1 = Object.values(vpSnapActive.refs).find((r) => r.name === 'Inspect #1')!.ref
    await tab.page.click(ref1)
    expect(await tab.page.evaluate<string>('document.getElementById("admin-status").textContent')).toBe('inspected:1')

    // 2. Cascading async dropdown (Country -> fetches /api/regions -> enables Region)
    await tab.page.selectOption('#country', 'cn')
    await expect
      .poll(() => tab.page.evaluate<boolean>('!document.getElementById("region").disabled'), { timeout: 5000 })
      .toBe(true)
    await tab.page.selectOption('#region', 'Shanghai')
    expect(await tab.page.evaluate<string>('document.getElementById("admin-status").textContent')).toBe('region:sh')

    // 3. Debounced Portal autocomplete combobox rendered on document.body
    await tab.page.fill('#owner-combo', 'bob')
    await tab.page.click('role=option[name="Bob Martinez"]')
    expect(await tab.page.evaluate<string>('document.getElementById("admin-status").textContent')).toBe('owner:Bob Martinez')

    // 4. Stacked Modal -> Drawer -> disabled-until-checked button -> Escape closes topmost layer cleanly
    await tab.page.click('#open-modal')
    await tab.page.fill('#modal-note', 'Q4-reconcile')
    await tab.page.click('#open-drawer')
    await tab.page.check('#policy-ack')
    await tab.page.click('#drawer-apply')
    expect(await tab.page.evaluate<string>('document.getElementById("admin-status").textContent')).toBe('policy-applied:Q4-reconcile')
    // Press Escape to dismiss remaining modal
    await tab.page.pressKey('Escape')
    expect(await tab.page.evaluate<string>('document.getElementById("modal-overlay").style.display')).toBe('none')

    await manager.closeTab(tab.tabId)
  }, 30_000)

  it('Archetype 2: drives collaborative contenteditable editor (slash menu, @mention, keyboard shortcut) and hidden-textarea code editor', async () => {
    if (!chromeBin || !manager) return
    const tab = await manager.openTab({ url: `${baseUrl}/editor` })

    // 1. Replace contenteditable cleanly & trigger slash command menu
    await tab.page.fill('#doc-editor', 'Project overview ')
    await tab.page.type('#doc-editor', '/')
    await tab.page.click('#cmd-callout')
    expect(await tab.page.evaluate<string>('document.getElementById("doc-meta").textContent')).toBe('callout-inserted')
    expect(await tab.page.evaluate<string>('document.getElementById("doc-editor").innerText')).toContain('Important Callout')

    // 2. Trigger @mention popover and confirm via Enter key
    await tab.page.fill('#doc-editor', 'Assigned to ')
    await tab.page.type('#doc-editor', '@ali')
    await tab.page.waitForLocator('#mention-alice', { state: 'visible', timeoutMs: 4000 })
    await tab.page.pressKey('Enter')
    expect(await tab.page.evaluate<string>('document.getElementById("doc-meta").textContent')).toBe('mentioned-alice')
    expect(await tab.page.evaluate<string>('document.querySelector(".mention")?.textContent')).toBe('@Alice')

    // 3. Editor keyboard shortcut (Cmd/Ctrl+B)
    await tab.page.click('#doc-editor')
    await tab.page.pressKey(process.platform === 'darwin' ? 'Meta+b' : 'Control+b')
    expect(await tab.page.evaluate<string>('document.getElementById("doc-meta").textContent')).toBe('bold-shortcut-fired')

    // 4. CodeMirror / Monaco-style hidden textarea overlay
    await tab.page.fill('#code-hidden-ta', 'export const answer = 42;')
    expect(await tab.page.evaluate<string>('document.getElementById("code-view").textContent')).toBe(
      'export const answer = 42;',
    )

    await manager.closeTab(tab.tabId)
  }, 25_000)

  it('Archetype 3: pierces 3-level nested Shadow DOM Web Components, slotted buttons, and Shadow-scoped snapshots', async () => {
    if (!chromeBin || !manager) return
    const tab = await manager.openTab({ url: `${baseUrl}/shadow` })

    // 1. Snapshot scoped into a Shadow DOM child element (#settings-panel inside #app-shell's ShadowRoot!)
    const scopedShadowSnap = await tab.snapshots.capture(tab.session, {
      scope: '#settings-panel',
      showDiffSinceLastCall: false,
    })
    expect(scopedShadowSnap.text).toContain('Deep Settings')
    expect(scopedShadowSnap.text).toContain('Auto Deploy: OFF')
    expect(scopedShadowSnap.text).toContain('Save Deep Settings')

    // 2. Fill input 3 ShadowRoots deep, toggle switch 3 ShadowRoots deep, click save 2 ShadowRoots deep
    await tab.page.fill('#app-shell >> #settings-panel >> #custom-input >> #deep-name', 'apollo-prod')
    await tab.page.click('role=switch[name="Auto Deploy"]')
    await tab.page.click('text=Save Deep Settings')
    // 3. Click light-DOM button projected into Shadow DOM <slot>
    await tab.page.click('#slotted-publish')

    expect(await tab.page.evaluate<string>('document.getElementById("wc-status").textContent')).toBe(
      'saved:apollo-prod:auto=true|published',
    )

    await manager.closeTab(tab.tabId)
  }, 25_000)
})
