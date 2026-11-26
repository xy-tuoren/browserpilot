import type { TraceData } from '@browserpilot/protocol'

function serializeTraceJsonSafely(data: TraceData): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

/**
 * Generates a zero-dependency, offline-capable single-file HTML Trace Viewer
 * with Filmstrip timeline, Before/After/Split stage + click reticle + highlight box,
 * synchronized Call/Network/Console inspector, and Replay Code (Playwright TS / BrowserPilot JS).
 */
export function renderTraceViewerHtml(trace: TraceData): string {
  const safeJson = serializeTraceJsonSafely(trace)
  const safeTitle = (trace.title || 'BrowserPilot Trace')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle} — BrowserPilot Trace Viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1120;
      --surface: #0f172a;
      --surface-2: #162033;
      --border: #1e293b;
      --border-strong: #334155;
      --text: #e2e8f0;
      --text-strong: #f8fafc;
      --muted: #64748b;
      --muted-strong: #94a3b8;
      --accent: #2dd4bf;
      --accent-soft: rgba(45, 212, 191, 0.14);
      --ok: #34d399;
      --err: #f87171;
      --err-soft: rgba(248, 113, 113, 0.14);
      --warn: #fbbf24;
      --code-bg: #090e1a;
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --bg: #f1f5f9;
      --surface: #ffffff;
      --surface-2: #f8fafc;
      --border: #e2e8f0;
      --border-strong: #cbd5e1;
      --text: #1e293b;
      --text-strong: #0f172a;
      --muted: #64748b;
      --muted-strong: #475569;
      --accent: #0d9488;
      --accent-soft: #ccfbf1;
      --ok: #059669;
      --err: #dc2626;
      --err-soft: #fee2e2;
      --warn: #d97706;
      --code-bg: #f8fafc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
    }
    header {
      height: 48px;
      padding: 0 16px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-shrink: 0;
    }
    .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px var(--accent); flex-shrink: 0; }
    .title { font-weight: 650; font-size: 14px; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta-pills { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .badge {
      font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 4px 8px;
      border-radius: 999px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--muted-strong);
      white-space: nowrap;
    }
    .badge.ok { color: var(--ok); border-color: rgba(52, 211, 153, 0.35); }
    .badge.err { color: var(--err); background: var(--err-soft); border-color: rgba(248, 113, 113, 0.4); }
    button {
      cursor: pointer;
      border: 1px solid var(--border-strong);
      background: var(--surface-2);
      color: var(--text-strong);
      font: 500 12px/1 inherit;
      padding: 6px 10px;
      border-radius: 6px;
      white-space: nowrap;
    }
    button:hover { border-color: var(--accent); }
    button.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); font-weight: 600; }

    /* Filmstrip */
    .filmstrip {
      height: 92px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      overflow-x: auto;
      flex-shrink: 0;
    }
    .thumb {
      width: 112px;
      height: 74px;
      border: 1.5px solid var(--border);
      border-radius: 6px;
      background: var(--code-bg);
      flex-shrink: 0;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
      transition: border-color 120ms ease, transform 120ms ease;
    }
    .thumb:hover { border-color: var(--muted-strong); }
    .thumb.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .thumb.failed { border-color: var(--err); }
    .thumb img { width: 100%; height: 54px; object-fit: cover; display: block; background: #000; }
    .thumb .no-shot { height: 54px; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 11px; }
    .thumb-foot {
      height: 20px;
      padding: 0 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      background: var(--surface-2);
      color: var(--muted-strong);
    }

    /* 3-pane workspace */
    .workspace {
      flex: 1;
      display: grid;
      grid-template-columns: 300px minmax(0, 1fr) 360px;
      min-height: 0;
    }
    .pane {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-right: 1px solid var(--border);
      background: var(--surface);
    }
    .pane:last-child { border-right: 0; border-left: 1px solid var(--border); }
    .pane-head {
      height: 38px;
      padding: 0 10px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      flex-shrink: 0;
    }
    .tab-row { display: flex; gap: 4px; align-items: center; }
    .tab-btn {
      border: 0;
      border-bottom: 2px solid transparent;
      border-radius: 0;
      background: transparent;
      color: var(--muted-strong);
      padding: 9px 8px;
      font-size: 12px;
      font-weight: 600;
    }
    .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); background: transparent; }
    .search-box {
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
    }
    .search-box input {
      width: 100%;
      padding: 6px 9px;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      background: var(--bg);
      color: var(--text-strong);
      font: 12px inherit;
      outline: none;
    }
    .search-box input:focus { border-color: var(--accent); }
    .scroll-area { flex: 1; overflow-y: auto; padding: 8px; }

    /* Step rows */
    .step-item {
      padding: 8px 9px;
      border-radius: 7px;
      border: 1px solid transparent;
      cursor: pointer;
      margin-bottom: 4px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .step-item:hover { background: var(--surface-2); }
    .step-item.selected { background: var(--accent-soft); border-color: var(--accent); }
    .step-item.error { border-color: rgba(248, 113, 113, 0.45); }
    .step-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .step-act {
      font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase;
      padding: 3px 5px;
      border-radius: 4px;
      background: var(--surface-2);
      color: var(--accent);
    }
    .step-item.error .step-act { color: var(--err); background: var(--err-soft); }
    .step-dur { font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
    .step-title {
      font: 500 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--text-strong);
      word-break: break-all;
    }

    /* Center stage */
    .stage-pane {
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--bg);
    }
    .stage-body {
      flex: 1;
      overflow: auto;
      padding: 16px;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      gap: 14px;
    }
    .frame-wrap {
      position: relative;
      width: 100%;
      max-width: 1080px;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      overflow: hidden;
      background: #000;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.32);
    }
    .split-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      width: 100%;
      align-items: start;
    }
    .split-grid .frame-wrap { max-width: none; }
    .frame-caption {
      font: 600 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 4px 10px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      color: var(--muted-strong);
    }
    .frame-img-box { position: relative; line-height: 0; }
    .frame-img-box img { width: 100%; height: auto; display: block; }
    .overlay-svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    .empty-stage { color: var(--muted); font-size: 13px; text-align: center; padding: 40px; }

    /* Inspector */
    .kv { margin-bottom: 10px; }
    .kv-label { font-size: 11px; font-weight: 600; color: var(--muted); margin-bottom: 3px; }
    .kv-val {
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 8px;
      word-break: break-all;
      white-space: pre-wrap;
      color: var(--text-strong);
    }
    .kv-val.err { color: var(--err); border-color: rgba(248, 113, 113, 0.45); background: var(--err-soft); }
    .net-card, .log-card {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 9px;
      margin-bottom: 6px;
      font: 11.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .net-card summary { cursor: pointer; list-style: none; display: flex; justify-content: space-between; gap: 6px; }
    .net-url { word-break: break-all; color: var(--text-strong); margin-top: 3px; }
    pre.code-block {
      margin: 0;
      padding: 10px;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 7px;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--text-strong);
      overflow-x: auto;
      white-space: pre;
    }
    @media (max-width: 1024px) {
      .workspace { grid-template-columns: 240px minmax(0, 1fr) 280px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span class="dot"></span>
      <span class="title" id="hdr-title"></span>
    </div>
    <div class="meta-pills">
      <span class="badge" id="hdr-steps"></span>
      <span class="badge" id="hdr-dur"></span>
      <span class="badge" id="hdr-net"></span>
      <span class="badge" id="hdr-status"></span>
      <button id="btn-export-json"></button>
      <button id="btn-lang">EN</button>
      <button id="btn-theme"></button>
    </div>
  </header>

  <div class="filmstrip" id="filmstrip"></div>

  <div class="workspace">
    <!-- Left: Steps & Codegen -->
    <div class="pane">
      <div class="pane-head">
        <div class="tab-row">
          <button class="tab-btn active" id="ltab-steps"></button>
          <button class="tab-btn" id="ltab-code"></button>
        </div>
      </div>
      <div class="search-box" id="step-filter-wrap">
        <input id="step-filter" type="search" />
      </div>
      <div class="scroll-area" id="left-body"></div>
    </div>

    <!-- Center: Viewport Before / After / Split -->
    <div class="stage-pane">
      <div class="pane-head" style="background:var(--surface)">
        <div class="tab-row">
          <button class="tab-btn" id="vmode-before"></button>
          <button class="tab-btn active" id="vmode-after"></button>
          <button class="tab-btn" id="vmode-split"></button>
        </div>
        <span class="badge" id="stage-url" style="max-width:52%;overflow:hidden;text-overflow:ellipsis"></span>
      </div>
      <div class="stage-body" id="stage-body"></div>
    </div>

    <!-- Right: Call / Network / Console -->
    <div class="pane">
      <div class="pane-head">
        <div class="tab-row">
          <button class="tab-btn active" id="rtab-call"></button>
          <button class="tab-btn" id="rtab-net"></button>
          <button class="tab-btn" id="rtab-console"></button>
        </div>
        <button id="btn-scope-toggle" style="padding:4px 7px;font-size:11px"></button>
      </div>
      <div class="scroll-area" id="right-body"></div>
    </div>
  </div>

  <script id="bp-trace-data" type="application/json">${safeJson}</script>
  <script>
    (() => {
      const TRACE = JSON.parse(document.getElementById('bp-trace-data').textContent);
      const I18N = {
        zh: {
          stepsCount: (n) => n + ' 步',
          netCount: (n) => n + ' 请求',
          okStatus: '全部通过',
          errStatus: (n) => n + ' 处异常',
          exportJson: '导出 JSON',
          themeDark: '深色',
          themeLight: '浅色',
          stepsTab: '操作步骤',
          codeTab: '生成代码',
          filterPh: '筛选步骤 / 定位器…',
          before: '动作前',
          after: '动作后',
          split: '并排对比',
          noShot: '无截图',
          noSteps: '暂无记录的操作步骤',
          callTab: '步骤详情',
          netTab: '网络',
          consoleTab: '控制台',
          scopeStep: '仅当前步',
          scopeAll: '全部记录',
          copy: '复制代码',
          copied: '已复制',
          lblAction: '动作',
          lblTarget: '目标定位器',
          lblValue: '输入 / 参数',
          lblTiming: '耗时与坐标',
          lblUrl: '页面地址',
          lblError: '错误详情',
          lblDom: '页面结构摘要',
          lblReqBody: '请求体',
          lblResPreview: '响应预览',
          noNet: '当前范围无网络请求',
          noLogs: '当前范围无控制台日志',
        },
        en: {
          stepsCount: (n) => n + ' steps',
          netCount: (n) => n + ' reqs',
          okStatus: 'PASSED',
          errStatus: (n) => n + ' errors',
          exportJson: 'Export JSON',
          themeDark: 'Dark',
          themeLight: 'Light',
          stepsTab: 'Actions',
          codeTab: 'Codegen',
          filterPh: 'Filter actions or locators…',
          before: 'Before',
          after: 'After',
          split: 'Side-by-Side',
          noShot: 'No screenshot',
          noSteps: 'No recorded trace steps.',
          callTab: 'Call',
          netTab: 'Network',
          consoleTab: 'Console',
          scopeStep: 'This Step',
          scopeAll: 'All Steps',
          copy: 'Copy Code',
          copied: 'Copied!',
          lblAction: 'Action',
          lblTarget: 'Locator',
          lblValue: 'Value / Key',
          lblTiming: 'Duration & Coordinates',
          lblUrl: 'URL',
          lblError: 'Error',
          lblDom: 'DOM / AX Summary',
          lblReqBody: 'Request Body',
          lblResPreview: 'Response Preview',
          noNet: 'No network requests in this scope.',
          noLogs: 'No console messages in this scope.',
        }
      };

      function prettyPayload(raw) {
        if (!raw) return '';
        try {
          return JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          return String(raw);
        }
      }

      let lang = 'zh';
      let theme = 'dark';
      let selectedIdx = TRACE.steps.length ? 0 : -1;
      let leftTab = 'steps';
      let codeFmt = 'playwright';
      let viewMode = 'after';
      let rightTab = 'call';
      let stepScoped = true;
      let filterText = '';

      const $ = (id) => document.getElementById(id);
      const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      function renderOverlaySvg(step) {
        if (!step || (!step.point && !step.box)) return '';
        const vw = (step.viewport && step.viewport.width) || (TRACE.viewport && TRACE.viewport.width) || 1280;
        const vh = (step.viewport && step.viewport.height) || (TRACE.viewport && TRACE.viewport.height) || 720;
        let shapes = '';
        if (step.box && step.box.width > 0 && step.box.height > 0) {
          shapes += '<rect x="' + step.box.x + '" y="' + step.box.y + '" width="' + step.box.width + '" height="' + step.box.height + '" rx="4" fill="rgba(45,212,191,0.16)" stroke="#2dd4bf" stroke-width="2.5"/>';
        }
        if (step.point) {
          shapes += '<circle cx="' + step.point.x + '" cy="' + step.point.y + '" r="14" fill="rgba(244,63,94,0.24)" stroke="#f43f5e" stroke-width="2"/>';
          shapes += '<circle cx="' + step.point.x + '" cy="' + step.point.y + '" r="4.5" fill="#f43f5e"/>';
        }
        return '<svg class="overlay-svg" viewBox="0 0 ' + vw + ' ' + vh + '" preserveAspectRatio="none">' + shapes + '</svg>';
      }

      function renderFrameCard(label, src, stepForOverlay) {
        const t = I18N[lang];
        if (!src) {
          return '<div class="frame-wrap"><div class="frame-caption">' + esc(label) + '</div><div class="empty-stage">' + esc(t.noShot) + '</div></div>';
        }
        return '<div class="frame-wrap"><div class="frame-caption">' + esc(label) + '</div><div class="frame-img-box"><img src="' + src + '" alt="' + esc(label) + '"/>' + (stepForOverlay ? renderOverlaySvg(stepForOverlay) : '') + '</div></div>';
      }

      function renderAll() {
        const t = I18N[lang];
        document.documentElement.dataset.theme = theme;
        document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';

        $('hdr-title').textContent = TRACE.title || 'BrowserPilot Trace';
        $('hdr-steps').textContent = t.stepsCount(TRACE.steps.length);
        $('hdr-dur').textContent = (TRACE.durationMs / 1000).toFixed(2) + 's';
        $('hdr-net').textContent = t.netCount(TRACE.totalNetworkRequests || 0);
        const failedSteps = TRACE.steps.filter((s) => s.status === 'error').length;
        const errTotal = failedSteps + (TRACE.totalErrors || 0);
        $('hdr-status').textContent = errTotal > 0 ? t.errStatus(errTotal) : t.okStatus;
        $('hdr-status').className = 'badge ' + (errTotal > 0 ? 'err' : 'ok');

        $('btn-export-json').textContent = t.exportJson;
        $('btn-lang').textContent = lang === 'zh' ? 'EN' : '中文';
        $('btn-theme').textContent = theme === 'dark' ? t.themeDark : t.themeLight;

        $('ltab-steps').textContent = t.stepsTab;
        $('ltab-code').textContent = t.codeTab;
        $('ltab-steps').classList.toggle('active', leftTab === 'steps');
        $('ltab-code').classList.toggle('active', leftTab === 'code');
        $('step-filter-wrap').style.display = leftTab === 'steps' ? 'block' : 'none';
        $('step-filter').placeholder = t.filterPh;

        $('vmode-before').textContent = t.before;
        $('vmode-after').textContent = t.after;
        $('vmode-split').textContent = t.split;
        $('vmode-before').classList.toggle('active', viewMode === 'before');
        $('vmode-after').classList.toggle('active', viewMode === 'after');
        $('vmode-split').classList.toggle('active', viewMode === 'split');

        const step = TRACE.steps[selectedIdx] || null;
        const netCount = step && stepScoped ? step.networkEntries.length : TRACE.steps.reduce((a, s) => a + s.networkEntries.length, 0);
        const logCount = step && stepScoped ? step.consoleEntries.length : TRACE.steps.reduce((a, s) => a + s.consoleEntries.length, 0);

        $('rtab-call').textContent = t.callTab;
        $('rtab-net').textContent = t.netTab + ' (' + netCount + ')';
        $('rtab-console').textContent = t.consoleTab + ' (' + logCount + ')';
        $('rtab-call').classList.toggle('active', rightTab === 'call');
        $('rtab-net').classList.toggle('active', rightTab === 'net');
        $('rtab-console').classList.toggle('active', rightTab === 'console');
        $('btn-scope-toggle').style.display = rightTab === 'call' ? 'none' : 'inline-block';
        $('btn-scope-toggle').textContent = stepScoped ? t.scopeStep : t.scopeAll;
        $('btn-scope-toggle').classList.toggle('active', !stepScoped);

        // Filmstrip
        const strip = $('filmstrip');
        strip.innerHTML = TRACE.steps.map((s, idx) => {
          const shot = s.afterScreenshot || s.beforeScreenshot;
          const rel = '+' + ((s.startedAt - TRACE.startedAt) / 1000).toFixed(2) + 's';
          return '<div class="thumb ' + (idx === selectedIdx ? 'selected ' : '') + (s.status === 'error' ? 'failed' : '') + '" data-idx="' + idx + '">' +
            (shot ? '<img src="' + shot + '" loading="lazy"/>' : '<div class="no-shot">' + esc(s.action) + '</div>') +
            '<div class="thumb-foot"><span>#' + (idx + 1) + ' ' + esc(s.action) + '</span><span>' + rel + '</span></div></div>';
        }).join('');
        strip.querySelectorAll('.thumb').forEach((el) => {
          el.addEventListener('click', () => {
            selectedIdx = Number(el.dataset.idx);
            renderAll();
          });
        });

        // Left body
        const leftBody = $('left-body');
        if (leftTab === 'steps') {
          const q = filterText.trim().toLowerCase();
          const filtered = TRACE.steps.map((s, idx) => ({ s, idx })).filter(({ s }) =>
            !q || s.title.toLowerCase().includes(q) || s.action.toLowerCase().includes(q) || (s.target || '').toLowerCase().includes(q)
          );
          if (!filtered.length) {
            leftBody.innerHTML = '<div class="empty-stage">' + esc(t.noSteps) + '</div>';
          } else {
            leftBody.innerHTML = filtered.map(({ s, idx }) =>
              '<div class="step-item ' + (idx === selectedIdx ? 'selected ' : '') + (s.status === 'error' ? 'error' : '') + '" data-idx="' + idx + '">' +
              '<div class="step-top"><span class="step-act">' + esc(s.action) + '</span><span class="step-dur">' + s.durationMs + 'ms</span></div>' +
              '<div class="step-title">' + esc(s.title) + '</div></div>'
            ).join('');
            leftBody.querySelectorAll('.step-item').forEach((el) => {
              el.addEventListener('click', () => {
                selectedIdx = Number(el.dataset.idx);
                renderAll();
              });
            });
          }
        } else {
          const code = codeFmt === 'playwright' ? (TRACE.playwrightScript || '') : (TRACE.execScript || '');
          leftBody.innerHTML =
            '<div style="display:flex;gap:6px;margin-bottom:8px">' +
            '<button id="cf-pw" class="' + (codeFmt === 'playwright' ? 'active' : '') + '">Playwright TS</button>' +
            '<button id="cf-bp" class="' + (codeFmt === 'browserpilot' ? 'active' : '') + '">BrowserPilot JS</button>' +
            '<button id="cf-copy" style="margin-left:auto">' + esc(t.copy) + '</button></div>' +
            '<pre class="code-block">' + esc(code) + '</pre>';
          $('cf-pw').onclick = () => { codeFmt = 'playwright'; renderAll(); };
          $('cf-bp').onclick = () => { codeFmt = 'browserpilot'; renderAll(); };
          $('cf-copy').onclick = (ev) => {
            navigator.clipboard?.writeText(code);
            ev.target.textContent = t.copied;
            setTimeout(() => { ev.target.textContent = t.copy; }, 1200);
          };
        }

        // Center stage
        const stageBody = $('stage-body');
        $('stage-url').textContent = step ? (step.urlAfter || step.urlBefore || '') : (TRACE.finalUrl || TRACE.initialUrl || '');
        if (!step) {
          stageBody.innerHTML = '<div class="empty-stage">' + esc(t.noSteps) + '</div>';
        } else if (viewMode === 'before') {
          stageBody.innerHTML = renderFrameCard(t.before + ' — ' + step.title, step.beforeScreenshot || step.afterScreenshot, step);
        } else if (viewMode === 'after') {
          const hasAfter = Boolean(step.afterScreenshot);
          stageBody.innerHTML = renderFrameCard(t.after + ' — ' + step.title, step.afterScreenshot || step.beforeScreenshot, hasAfter ? null : step);
        } else {
          stageBody.innerHTML = '<div class="split-grid">' +
            renderFrameCard(t.before, step.beforeScreenshot, step) +
            renderFrameCard(t.after, step.afterScreenshot, null) +
            '</div>';
        }

        // Right inspector
        const rightBody = $('right-body');
        if (!step && rightTab === 'call') {
          rightBody.innerHTML = '<div class="empty-stage">' + esc(t.noSteps) + '</div>';
        } else if (rightTab === 'call' && step) {
          let html = '';
          if (step.error) {
            html += '<div class="kv"><div class="kv-label">' + esc(t.lblError) + '</div><div class="kv-val err">' + esc(step.error) + '</div></div>';
          }
          html += '<div class="kv"><div class="kv-label">' + esc(t.lblAction) + '</div><div class="kv-val">' + esc(step.action) + ' (#' + (step.index + 1) + ')</div></div>';
          if (step.target) {
            html += '<div class="kv"><div class="kv-label">' + esc(t.lblTarget) + '</div><div class="kv-val">' + esc(step.target) + '</div></div>';
          }
          if (step.value !== undefined || step.key) {
            html += '<div class="kv"><div class="kv-label">' + esc(t.lblValue) + '</div><div class="kv-val">' + esc(step.value ?? step.key ?? '') + '</div></div>';
          }
          const coordText = step.point ? ' @ (' + Math.round(step.point.x) + ', ' + Math.round(step.point.y) + ')' : '';
          html += '<div class="kv"><div class="kv-label">' + esc(t.lblTiming) + '</div><div class="kv-val">' + step.durationMs + 'ms' + esc(coordText) + '</div></div>';
          const urlInfo = step.urlBefore === step.urlAfter ? step.urlAfter : (step.urlBefore + ' -> ' + step.urlAfter);
          html += '<div class="kv"><div class="kv-label">' + esc(t.lblUrl) + '</div><div class="kv-val">' + esc(urlInfo) + '</div></div>';
          if (step.domSummary) {
            html += '<div class="kv"><div class="kv-label">' + esc(t.lblDom) + '</div><div class="kv-val">' + esc(step.domSummary) + '</div></div>';
          }
          rightBody.innerHTML = html;
        } else if (rightTab === 'net') {
          const items = step && stepScoped ? step.networkEntries : TRACE.steps.flatMap((s) => s.networkEntries);
          if (!items.length) {
            rightBody.innerHTML = '<div class="empty-stage">' + esc(t.noNet) + '</div>';
          } else {
            rightBody.innerHTML = items.map((n) => {
              const bad = n.failed || (n.status && n.status >= 400);
              const statusTxt = n.status ? String(n.status) : (n.errorText || 'PENDING');
              const durTxt = n.timing && n.timing.totalMs !== undefined ? Math.round(n.timing.totalMs) + 'ms' : '';
              let details = '';
              if (n.requestPostData) details += '<div class="kv-label" style="margin-top:6px">' + esc(t.lblReqBody) + '</div><div class="kv-val">' + esc(prettyPayload(n.requestPostData.slice(0, 2000))) + '</div>';
              if (n.responseBodyPreview) details += '<div class="kv-label" style="margin-top:6px">' + esc(t.lblResPreview) + '</div><div class="kv-val">' + esc(prettyPayload(n.responseBodyPreview)) + '</div>';
              return '<details class="net-card"><summary><span style="color:' + (bad ? 'var(--err)' : 'var(--ok)') + ';font-weight:700">' + esc(n.method) + ' ' + esc(statusTxt) + '</span><span style="color:var(--muted)">' + esc(durTxt) + '</span></summary><div class="net-url">' + esc(n.url) + '</div>' + details + '</details>';
            }).join('');
          }
        } else {
          const logs = step && stepScoped ? step.consoleEntries : TRACE.steps.flatMap((s) => s.consoleEntries);
          if (!logs.length) {
            rightBody.innerHTML = '<div class="empty-stage">' + esc(t.noLogs) + '</div>';
          } else {
            rightBody.innerHTML = logs.map((l) => {
              const isErr = l.level === 'error' || l.level === 'exception' || l.level === 'assert';
              return '<div class="log-card" style="border-color:' + (isErr ? 'rgba(248,113,113,0.45)' : 'var(--border)') + '"><div style="color:' + (isErr ? 'var(--err)' : 'var(--muted-strong)') + ';font-weight:700">[' + esc(l.level) + ']</div><div style="margin-top:3px;word-break:break-word">' + esc(l.text) + '</div></div>';
            }).join('');
          }
        }
      }

      $('hdr-status').style.cursor = 'pointer';
      $('hdr-status').onclick = () => {
        const errStepIdx = TRACE.steps.findIndex((s) => s.status === 'error' || s.consoleEntries.some((c) => c.level === 'error' || c.level === 'exception'));
        if (errStepIdx >= 0) {
          selectedIdx = errStepIdx;
          if (TRACE.steps[errStepIdx].status !== 'error') rightTab = 'console';
          else rightTab = 'call';
          renderAll();
        }
      };
      $('btn-lang').onclick = () => { lang = lang === 'zh' ? 'en' : 'zh'; renderAll(); };
      $('btn-theme').onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; renderAll(); };
      $('btn-export-json').onclick = () => {
        const blob = new Blob([JSON.stringify(TRACE, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'browserpilot-trace-' + TRACE.startedAt + '.json';
        a.click();
      };
      $('ltab-steps').onclick = () => { leftTab = 'steps'; renderAll(); };
      $('ltab-code').onclick = () => { leftTab = 'code'; renderAll(); };
      $('step-filter').oninput = (e) => { filterText = e.target.value; renderAll(); };
      $('vmode-before').onclick = () => { viewMode = 'before'; renderAll(); };
      $('vmode-after').onclick = () => { viewMode = 'after'; renderAll(); };
      $('vmode-split').onclick = () => { viewMode = 'split'; renderAll(); };
      $('rtab-call').onclick = () => { rightTab = 'call'; renderAll(); };
      $('rtab-net').onclick = () => { rightTab = 'net'; renderAll(); };
      $('rtab-console').onclick = () => { rightTab = 'console'; renderAll(); };
      $('btn-scope-toggle').onclick = () => { stepScoped = !stepScoped; renderAll(); };

      window.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
        if ((e.key === 'ArrowRight' || e.key === 'ArrowDown') && selectedIdx < TRACE.steps.length - 1) {
          e.preventDefault();
          selectedIdx++;
          renderAll();
        } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowUp') && selectedIdx > 0) {
          e.preventDefault();
          selectedIdx--;
          renderAll();
        }
      });

      renderAll();
    })();
  </script>
</body>
</html>`
}
