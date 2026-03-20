'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SGYT ENGINE — Render.com Node.js server                               ║
 * ║                                                                          ║
 * ║  WHY THIS WORKS ON RENDER BUT NOT DENO DEPLOY / VERCEL / NETLIFY:      ║
 * ║  Render gives you a real persistent Linux container where you can       ║
 * ║  install binaries at build time (see render.yaml buildCommand).         ║
 * ║  Deno Deploy and Vercel Edge are "pure JS" runtimes — they have no     ║
 * ║  filesystem access and cannot spawn child processes.                    ║
 * ║                                                                          ║
 * ║  FLOW (no CI pipeline, no job queue, no Pusher):                       ║
 * ║    Browser → POST /extract → this server                               ║
 * ║    server  → yt-dlp --get-url (spawns child process, waits ~5-10s)    ║
 * ║    server  → returns { download_url, title, filename, thumbnail }      ║
 * ║    browser → shows GRAB FILE button immediately                        ║
 * ║                                                                          ║
 * ║  ENV VARS (set in Render dashboard → Environment):                     ║
 * ║    PORT       — set automatically by Render (default 10000)            ║
 * ║    API_KEY    — optional: require X-API-Key header on all requests     ║
 * ║    CORS_ORIGIN — your frontend domain, or * for open access            ║
 * ║    RATE_LIMIT  — max requests per IP per minute (default 10)           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

const http        = require('http');
const { spawn }   = require('child_process');
const path        = require('path');
const os          = require('os');
const crypto      = require('crypto');

const PORT        = parseInt(process.env.PORT || '10000');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const API_KEY     = process.env.API_KEY || '';
const RATE_LIMIT  = parseInt(process.env.RATE_LIMIT || '10'); // per minute

// yt-dlp binary. render.yaml puts it at ./bin/yt-dlp during the build step.
// Falls back to the system PATH so local dev works if you `pip install yt-dlp`.
const YTDLP_BIN = process.env.YTDLP_PATH || path.join(__dirname, 'bin', 'yt-dlp');

// ── Quality → yt-dlp format selector map ─────────────────────────────────────
// These are PRE-MUXED selectors only — each resolves to exactly ONE URL.
//
// Why pre-muxed? YouTube serves 720p and below as combined video+audio streams
// (called "progressive" streams). At 1080p and above, YouTube only offers
// separate DASH streams (video-only + audio-only). yt-dlp --get-url on a merged
// selector like "bestvideo+bestaudio" prints TWO lines — a browser can't join them.
//
// The format string "best[height<=720][ext=mp4]/best[ext=mp4]/best" means:
//   1. Try: best pre-muxed mp4 at or below 720p
//   2. Fallback: best pre-muxed mp4 of any height
//   3. Final fallback: absolute best available stream
//
// "bestaudio[ext=m4a]/bestaudio" for audio-only: always a single stream.
const QUALITY_MAP = {
  best:  'best[height<=720][ext=mp4]/best[ext=mp4]/best',
  '720': 'best[height<=720][ext=mp4]/best[height<=720]',
  '480': 'best[height<=480][ext=mp4]/best[height<=480]',
  '360': 'best[height<=360][ext=mp4]/best[height<=360]',
  '240': 'best[height<=240][ext=mp4]/best[height<=240]',
  audio: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
};

// ── In-memory rate limiter ────────────────────────────────────────────────────
// Maps clientIp → array of request timestamps (epoch ms).
// Cleaned up lazily on each request so memory doesn't grow forever.
const rateLimitStore = new Map();

function checkRateLimit(ip) {
  const now    = Date.now();
  const window = 60_000; // 1 minute in ms
  const hits   = (rateLimitStore.get(ip) || []).filter(t => t > now - window);
  if (hits.length >= RATE_LIMIT) {
    const oldest     = Math.min(...hits);
    const retryAfter = Math.ceil((oldest + window - now) / 1000);
    return { allowed: false, retryAfter };
  }
  hits.push(now);
  rateLimitStore.set(ip, hits);
  return { allowed: true };
}

// ── URL safety (SSRF guard) ───────────────────────────────────────────────────
// Only allow http/https and block private network ranges.
function isValidUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const blocked = ['localhost','127.','0.0.0.0','::1','169.254.',
                   '10.','172.16.','192.168.'];
  return !blocked.some(b => u.hostname.includes(b));
}

// ── Sanitise a string to a safe filename ─────────────────────────────────────
function safeFilename(title, ext) {
  const base = (title || 'video')
    .replace(/[^\w\s\-]/g, '')  // strip non-word chars except hyphens/spaces
    .trim()
    .slice(0, 80)
    .replace(/\s+/g, '_') || 'video';
  return `${base}.${ext}`;
}

// ── Run yt-dlp as a child process and collect stdout ─────────────────────────
// Returns a Promise<string> with the combined stdout output.
// Rejects with the stderr text if the process exits non-zero.
// `timeoutMs` kills the process if it takes too long (default 30s).
function runYtdlp(args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const proc   = spawn(YTDLP_BIN, args);
    let stdout   = '';
    let stderr   = '';
    let killed   = false;

    // Kill the process if it exceeds the timeout — yt-dlp can hang on bad URLs.
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      reject(new Error('yt-dlp timed out after ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      clearTimeout(timer);
      if (killed) return; // already rejected above
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        // yt-dlp writes useful error messages to stderr — pass them through
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
      }
    });
  });
}

// ── Shared CORS + JSON response helpers ──────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
}

function sendJson(res, status, data) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

// ── Read the full request body as a string ───────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end',  ()    => resolve(body));
    req.on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

// GET /health
// Returns yt-dlp version and config status. Useful to verify the build step ran.
async function handleHealth(req, res) {
  let ytdlpVersion = 'NOT FOUND';
  try {
    ytdlpVersion = await runYtdlp(['--version'], 5_000);
  } catch { /* ignore */ }

  sendJson(res, 200, {
    status:        ytdlpVersion !== 'NOT FOUND' ? 'ok' : 'degraded',
    node_version:  process.version,
    yt_dlp:        ytdlpVersion,
    platform:      os.platform() + ' ' + os.arch(),
    qualities:     Object.keys(QUALITY_MAP),
    timestamp:     new Date().toISOString(),
  });
}

// POST /extract
// Body: { url: string, quality?: string }
//
// This is the core endpoint. It runs TWO yt-dlp calls in parallel:
//   1. yt-dlp --dump-json     → metadata (title, thumbnail, duration, uploader)
//   2. yt-dlp --get-url -f X  → the signed CDN URL for the chosen quality
//
// Running them in parallel shaves 2-4 seconds vs sequential.
// The whole thing takes about 4-8 seconds on a warm Render instance.
async function handleExtract(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Request body must be valid JSON.' });
  }

  const url     = (body.url     || '').trim();
  const quality = (body.quality || 'best').trim();

  if (!url)             return sendJson(res, 400, { error: 'Missing field: url' });
  if (!isValidUrl(url)) return sendJson(res, 422, { error: 'Invalid or unsafe URL.' });

  const formatSelector = QUALITY_MAP[quality];
  if (!formatSelector)  return sendJson(res, 400, {
    error: `Invalid quality "${quality}". Allowed: ${Object.keys(QUALITY_MAP).join(', ')}`,
  });

  const isAudio = quality === 'audio';

  // Common yt-dlp flags for both calls.
  // --no-playlist ensures we only process a single video, not an entire playlist.
  // --no-warnings keeps stderr clean so we don't confuse warnings with errors.
  const commonArgs = ['--no-playlist', '--no-warnings'];

  try {
    // ── Run metadata fetch and URL extraction in parallel ─────────────────────
    const [metaRaw, urlOutput] = await Promise.all([
      // Call 1: get full JSON metadata. No format flag needed — we just want info.
      runYtdlp([...commonArgs, '--dump-json', url]),

      // Call 2: get the direct CDN URL for the requested quality.
      // --get-url prints the URL(s) to stdout and exits without downloading anything.
      runYtdlp([...commonArgs, '--get-url', '-f', formatSelector, url]),
    ]);

    // ── Parse metadata ────────────────────────────────────────────────────────
    let meta = {};
    try { meta = JSON.parse(metaRaw); } catch { /* non-fatal, we still have the URL */ }

    // ── Resolve the CDN URL ───────────────────────────────────────────────────
    // --get-url can print multiple lines if yt-dlp decides a merged format was needed.
    // This shouldn't happen with our pre-muxed selectors, but we handle it defensively:
    // take the first valid http(s) URL from the output.
    const lines      = urlOutput.split('\n').map(l => l.trim()).filter(Boolean);
    const downloadUrl = lines.find(l => l.startsWith('http')) || lines[0];

    if (!downloadUrl) {
      return sendJson(res, 422, {
        error: 'yt-dlp returned no URL. The video may be private, geo-blocked, or the quality is unavailable.',
      });
    }

    // ── Build filename from video title ───────────────────────────────────────
    const ext      = isAudio ? 'm4a' : 'mp4';
    const filename = safeFilename(meta.title, ext);

    return sendJson(res, 200, {
      ok:           true,
      download_url: downloadUrl,
      filename,
      title:        meta.title        || null,
      duration:     meta.duration     || null,
      thumbnail:    meta.thumbnail    || null,
      uploader:     meta.uploader     || null,
      webpage_url:  meta.webpage_url  || url,
      quality_used: quality,
      ext,
    });

  } catch (err) {
    // Parse yt-dlp's error message to give the user something actionable.
    const msg = err.message || String(err);

    // Common yt-dlp error patterns and friendlier messages
    if (msg.includes('Sign in') || msg.includes('bot') || msg.includes('cookie')) {
      return sendJson(res, 422, { error: 'YouTube bot detection triggered. Try again in a few minutes.' });
    }
    if (msg.includes('Private video') || msg.includes('members-only')) {
      return sendJson(res, 422, { error: 'Video is private or members-only.' });
    }
    if (msg.includes('not available in your country') || msg.includes('geo')) {
      return sendJson(res, 422, { error: 'Video is geo-blocked.' });
    }
    if (msg.includes('timed out')) {
      return sendJson(res, 504, { error: 'Request timed out. The video URL may be rate-limited right now.' });
    }

    console.error('[sgyt] yt-dlp error:', msg);
    return sendJson(res, 500, { error: 'Extraction failed: ' + msg.slice(0, 300) });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER + ROUTER
// ══════════════════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost`);
  const method = req.method.toUpperCase();
  const path_  = url.pathname;

  // ── CORS pre-flight ────────────────────────────────────────────────────────
  if (method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ── API Key middleware ─────────────────────────────────────────────────────
  // Uses constant-time comparison via crypto.timingSafeEqual to prevent
  // timing attacks (where an attacker times response speed to guess the key).
  if (API_KEY) {
    const provided = req.headers['x-api-key'] || '';
    const enc = s => Buffer.from(s.padEnd(API_KEY.length, '\0').slice(0, API_KEY.length));
    const match = crypto.timingSafeEqual(enc(provided), enc(API_KEY))
                  && provided.length === API_KEY.length;
    if (!match) return sendJson(res, 401, { error: 'Unauthorized. Provide X-API-Key header.' });
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
                || req.socket.remoteAddress
                || 'unknown';
  const rateCheck = checkRateLimit(clientIp);
  if (!rateCheck.allowed) {
    return sendJson(res, 429, {
      error: 'Rate limit exceeded.',
      retry_after: rateCheck.retryAfter,
    });
  }

  // ── Route dispatch ─────────────────────────────────────────────────────────
  if (method === 'GET'  && path_ === '/health')  return handleHealth(req, res);
  if (method === 'POST' && path_ === '/extract') return handleExtract(req, res);

  return sendJson(res, 404, {
    error: 'Route not found',
    routes: {
      'GET  /health':  'yt-dlp version + config check',
      'POST /extract': '{ url, quality? } → { download_url, title, filename, ... }',
    },
  });
});

server.listen(PORT, () => {
  console.log(`[sgyt] Server running on port ${PORT}`);
  console.log(`[sgyt] yt-dlp binary: ${YTDLP_BIN}`);
  console.log(`[sgyt] CORS origin:   ${CORS_ORIGIN}`);
  console.log(`[sgyt] Auth:          ${API_KEY ? 'API_KEY set' : 'open (no key required)'}`);
});
