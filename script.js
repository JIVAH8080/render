'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SGYT ENGINE — Frontend JS (Render edition)                            ║
 * ║                                                                          ║
 * ║  FLOW (everything is one fetch call now):                               ║
 * ║    1. User enters YouTube URL + picks quality, clicks INITIATE          ║
 * ║    2. POST /extract to the Render API (waits ~5-10s)                   ║
 * ║    3. Server runs yt-dlp --get-url internally, returns CDN link        ║
 * ║    4. Browser shows GRAB FILE button with the direct link              ║
 * ║                                                                          ║
 * ║  ▸ UPDATE API_BASE BELOW to your Render service URL after deploying.   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

// ── CONFIG ────────────────────────────────────────────────────────────────────
// Change API_BASE to your deployed Render service URL.
// Example: 'https://sgyt-engine.onrender.com'
// Leave API_KEY blank unless you set one in the Render environment variables.
const _C = Object.freeze({
    API_BASE:        'https://YOUR-SERVICE.onrender.com',
    API_KEY:         '',   // optional — must match API_KEY in Render env vars

    // Render's free tier sleeps after 15 min of inactivity.
    // The first request after sleep triggers a cold start (~20-30s spin-up).
    // We ping /health first and wait for the server to wake before extracting.
    WAKE_TIMEOUT_MS: 40_000,  // how long to wait for the server to wake up
    EXTRACT_TIMEOUT_MS: 45_000, // how long to wait for yt-dlp to finish

    API_KEY_STORAGE: 'sgyt_api_key',
});

// ── DOM HELPERS ───────────────────────────────────────────────────────────────
const DOM = {
    btn:          () => document.getElementById('startBtn'),
    termBody:     () => document.getElementById('terminalBody'),
    urlInput:     () => document.getElementById('ytUrl'),
    quality:      () => document.getElementById('quality'),
    downloadArea: () => document.getElementById('downloadArea'),
    artifactLink: () => document.getElementById('artifactLink'),
    statusDot:    () => document.getElementById('statusDot'),
    statusText:   () => document.getElementById('statusText'),
    card:         () => document.getElementById('mainCard'),
    // The old GitLab token field is now repurposed as an optional API key field.
    // If your HTML still has #ghToken, it can store the API_KEY from the server.
    apiKeyInput:  () => document.getElementById('ghToken'),
};

// ── INIT ──────────────────────────────────────────────────────────────────────
window.onload = () => {
    const saved = localStorage.getItem(_C.API_KEY_STORAGE);
    if (saved && DOM.apiKeyInput()) DOM.apiKeyInput().value = saved;
    log('SGYT Engine ready. Render server standing by.', 'info');
    setStatus('SYSTEM READY', 'idle');
};

function saveApiKey() {
    const el = DOM.apiKeyInput();
    if (el && el.value.trim()) {
        localStorage.setItem(_C.API_KEY_STORAGE, el.value.trim());
    }
}

// ── TERMINAL LOGGER ───────────────────────────────────────────────────────────
// flex-direction: column-reverse floats newest entries to the top automatically.
function log(msg, type = 'info') {
    const p  = document.createElement('p');
    const ts = new Date().toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const colors = {
        info:    '#38bdf8',
        success: '#34d399',
        error:   '#f87171',
        warn:    '#fbbf24',
        debug:   '#a78bfa',
    };
    p.style.color = colors[type] || colors.info;
    p.innerHTML   = `<span class="prompt">❯</span>`
        + `<span style="opacity:0.35;font-size:0.6rem;margin-right:6px">${ts}</span>`
        + msg;
    const body = DOM.termBody();
    body.prepend(p);
    // Cap at 8 lines so the terminal doesn't overflow
    if (body.children.length > 8) body.lastChild.remove();
}

function clearTerminal() {
    DOM.termBody().innerHTML = '';
    log('Terminal cleared.', 'debug');
}

// ── STATUS BAR ────────────────────────────────────────────────────────────────
function setStatus(text, state = 'idle') {
    DOM.statusDot().className  = 'status-dot'  + (state !== 'idle' ? ` ${state}` : '');
    DOM.statusText().className = 'status-text' + (state !== 'idle' ? ` ${state}` : '');
    DOM.statusText().textContent = text;
}

// ── BUILD HEADERS ─────────────────────────────────────────────────────────────
// Attach the API key if one is configured. The server ignores this header if
// no API_KEY is set on the backend.
function buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    // Read from the input field first (user may have typed one), then from _C
    const keyInput = DOM.apiKeyInput();
    const key = (keyInput && keyInput.value.trim()) || _C.API_KEY;
    if (key) headers['X-API-Key'] = key;
    return headers;
}

// ── WAKE THE SERVER ───────────────────────────────────────────────────────────
// Render free tier spins down after 15 min of inactivity. The first HTTP request
// to a sleeping service returns after ~20-30s once the container is warm again.
// We use a simple /health ping with a generous timeout to handle the cold start
// gracefully rather than letting the main /extract call time out.
async function wakeServer() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), _C.WAKE_TIMEOUT_MS);

    try {
        const res = await fetch(`${_C.API_BASE}/health`, {
            headers: buildHeaders(),
            signal:  controller.signal,
        });
        clearTimeout(timer);
        return res.ok;
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error('Server wake timed out. Render may be under load.');
        throw err;
    }
}

// ── MAIN ACTION ───────────────────────────────────────────────────────────────
async function triggerAction() {
    const url     = DOM.urlInput().value.trim();
    const quality = DOM.quality().value;
    const btn     = DOM.btn();

    // Basic input validation before touching the network
    if (!url) {
        log('⛔ No video URL entered.', 'error');
        setStatus('URL MISSING', 'error');
        DOM.urlInput().focus();
        return;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        log('⛔ URL must start with http:// or https://', 'error');
        setStatus('BAD URL', 'error');
        return;
    }

    // ── Disable button and show spinner ──────────────────────────────────────
    btn.disabled  = true;
    DOM.downloadArea().style.display = 'none';
    clearTerminal();

    // ── Step 1: Wake the Render server ────────────────────────────────────────
    // Skip if the server is already warm (fast response), but we don't know
    // that in advance — so always ping first. The ping itself is what warms it.
    try {
        btn.innerHTML = btnLabel('<span class="spinner"></span>', 'WAKING SERVER...');
        setStatus('WAKING SERVER', 'busy');
        log('Pinging Render server (free tier may be sleeping)...', 'debug');

        await wakeServer();
        log('✅ Server awake.', 'success');
    } catch (err) {
        log(`❌ Server unreachable: ${err.message}`, 'error');
        log('Check that API_BASE in script.js matches your Render service URL.', 'warn');
        setStatus('SERVER OFFLINE', 'error');
        resetButton();
        return;
    }

    // ── Step 2: Extract the direct CDN URL ───────────────────────────────────
    // This is where yt-dlp runs on the Render server. It typically takes 4-8s.
    // We set a generous AbortController timeout in case yt-dlp hangs.
    try {
        btn.innerHTML = btnLabel('<span class="spinner"></span>', 'EXTRACTING...');
        setStatus('EXTRACTING', 'busy');
        log(`Extracting direct link (quality: <span style="color:#00f5ff">${quality}</span>)...`, 'info');

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), _C.EXTRACT_TIMEOUT_MS);

        const response = await fetch(`${_C.API_BASE}/extract`, {
            method:  'POST',
            headers: buildHeaders(),
            body:    JSON.stringify({ url, quality }),
            signal:  controller.signal,
        });
        clearTimeout(timer);

        const data = await response.json();

        if (!response.ok) {
            // The server sends { error: "..." } for 4xx/5xx responses
            throw new Error(data.error || `Server error ${response.status}`);
        }

        // ── Success ───────────────────────────────────────────────────────────
        log(`✅ Link extracted! <span style="opacity:0.5;font-size:0.65em">${data.title || ''}</span>`, 'success');
        if (data.duration) {
            const mins = Math.floor(data.duration / 60);
            const secs = Math.floor(data.duration % 60).toString().padStart(2, '0');
            log(`Duration: ${mins}:${secs} · Quality: ${data.quality_used} · Ext: ${data.ext}`, 'debug');
        }

        setStatus('DOWNLOAD READY', 'idle');
        showFinalLink(data.download_url, data.filename);

    } catch (err) {
        let msg = err.message || String(err);
        if (err.name === 'AbortError') msg = 'Request timed out — yt-dlp took too long. Try again.';

        log(`❌ ${msg}`, 'error');

        // Surface common failure reasons with actionable hints
        if (msg.includes('bot detection') || msg.includes('Sign in')) {
            log('Tip: YouTube rate-limits bot traffic. Wait a minute and retry.', 'warn');
        } else if (msg.includes('private') || msg.includes('members')) {
            log('Private/members-only videos cannot be extracted.', 'warn');
        } else if (msg.includes('geo')) {
            log('This video is region-locked.', 'warn');
        } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
            log('Network error — check CORS_ORIGIN on the Render server.', 'warn');
        }

        setStatus('EXTRACTION FAILED', 'error');
        resetButton();
    }
}

// ── SHOW DOWNLOAD LINK ────────────────────────────────────────────────────────
// Unchanged from the original — still shows the GRAB FILE button.
// download attribute on <a> suggests the filename to the browser's save dialog.
function showFinalLink(fileUrl, filename) {
    resetButton();
    const link       = DOM.artifactLink();
    link.href        = fileUrl;
    if (filename) link.setAttribute('download', filename);
    link.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        GRAB FILE`;
    DOM.downloadArea().style.display = 'block';
    if (navigator.vibrate) navigator.vibrate([80, 40, 120]);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function btnLabel(iconHtml, label) {
    return `<span class="btn-bg"></span>${iconHtml}<span class="btn-label">${label}</span>`;
}

function resetButton() {
    const btn    = DOM.btn();
    btn.disabled = false;
    btn.innerHTML = `
        <span class="btn-bg"></span>
        <svg class="btn-icon" width="18" height="18" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        <span class="btn-label">INITIATE DOWNLOAD</span>`;
}

function exitApp() {
    DOM.card().classList.add('closing');
    setTimeout(() => {
        window.close();
        if (!window.closed) {
            document.body.innerHTML = `
                <div style="color:#475569;font-family:'JetBrains Mono',monospace;font-size:0.75rem;
                    letter-spacing:0.15em;position:fixed;inset:0;display:flex;align-items:center;
                    justify-content:center;background:#030712;flex-direction:column;gap:12px;">
                    <div>SESSION TERMINATED</div>
                    <div style="font-size:0.55rem;opacity:0.5;">You can close this tab.</div>
                </div>`;
        }
    }, 420);
}
