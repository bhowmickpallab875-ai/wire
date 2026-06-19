/**
 * WIRE — static file server
 * ---------------------------------------------------------------------------
 * A zero-dependency static server for login.html / chat.html / style.css.
 * No npm install needed — only built-in Node modules are used.
 *
 * Usage:
 *   node server.js
 *   PORT=8080 node server.js
 *
 * Then open: http://localhost:3000/login.html
 * ---------------------------------------------------------------------------
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

/* ===========================================================================
   Config
============================================================================ */
const CONFIG = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || 'localhost',
  rootDir: __dirname,
  defaultFile: 'login.html',
  rateLimit: {
    windowMs: 10_000,   // 10 seconds
    maxRequests: 100,   // per IP, per window
  },
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/* ===========================================================================
   Tiny logger — no dependency, just ANSI color codes
============================================================================ */
const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
}

function colorForStatus(status) {
  if (status >= 500) return COLORS.red
  if (status >= 400) return COLORS.yellow
  if (status >= 300) return COLORS.cyan
  return COLORS.green
}

function log(method, url, status, durationMs, ip) {
  const time = new Date().toISOString()
  const color = colorForStatus(status)
  console.log(
    `${COLORS.gray}${time}${COLORS.reset} ` +
    `${COLORS.cyan}${method}${COLORS.reset} ${url} ` +
    `${color}${status}${COLORS.reset} ` +
    `${COLORS.gray}${durationMs}ms — ${ip}${COLORS.reset}`
  )
}

function logInfo(message) {
  console.log(`${COLORS.green}[wire-server]${COLORS.reset} ${message}`)
}

function logError(message) {
  console.error(`${COLORS.red}[wire-server]${COLORS.reset} ${message}`)
}

/* ===========================================================================
   Very small in-memory rate limiter (per IP)
   Good enough to stop a runaway loop on localhost — not meant for production.
============================================================================ */
const requestLog = new Map() // ip -> array of timestamps

function isRateLimited(ip) {
  const now = Date.now()
  const windowStart = now - CONFIG.rateLimit.windowMs
  const timestamps = (requestLog.get(ip) || []).filter((t) => t > windowStart)
  timestamps.push(now)
  requestLog.set(ip, timestamps)
  return timestamps.length > CONFIG.rateLimit.maxRequests
}

// Periodically clear old entries so the map doesn't grow forever
setInterval(() => {
  const now = Date.now()
  const windowStart = now - CONFIG.rateLimit.windowMs
  for (const [ip, timestamps] of requestLog.entries()) {
    const fresh = timestamps.filter((t) => t > windowStart)
    if (fresh.length === 0) requestLog.delete(ip)
    else requestLog.set(ip, fresh)
  }
}, 30_000).unref()

/* ===========================================================================
   Security headers — sensible defaults for a small local dev server
============================================================================ */
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade')
  // Not a strict CSP since we load Google Fonts + the Supabase ESM CDN
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co; " +
    "img-src 'self' data:;"
  )
}

/* ===========================================================================
   Error pages
============================================================================ */
function errorPage(title, message) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #F7F5F1; color: #1F2421;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  .box { text-align:center; }
  h1 { font-size: 56px; margin: 0; color: #2D6A4F; }
  p { color: #6B756F; }
</style></head>
<body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`
}

const NOT_FOUND_PAGE = errorPage('404', 'That page doesn\'t exist.')
const FORBIDDEN_PAGE = errorPage('403', 'You can\'t access that.')
const SERVER_ERROR_PAGE = errorPage('500', 'Something went wrong on the server.')
const RATE_LIMIT_PAGE = errorPage('429', 'Slow down — too many requests.')

/* ===========================================================================
   Request handling
============================================================================ */
function resolveFilePath(requestUrl) {
  let urlPath = requestUrl.split('?')[0]
  if (urlPath === '/') urlPath = '/' + CONFIG.defaultFile

  const decoded = decodeURIComponent(urlPath)
  const fullPath = path.normalize(path.join(CONFIG.rootDir, decoded))

  // Prevent directory traversal outside the project root
  if (!fullPath.startsWith(CONFIG.rootDir)) return null
  return fullPath
}

function sendFile(res, filePath, status = 200) {
  const ext = path.extname(filePath)
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendError(res, 404)
      return
    }
    applySecurityHeaders(res)
    res.writeHead(status, { 'Content-Type': contentType })
    res.end(data)
  })
}

function sendError(res, status) {
  applySecurityHeaders(res)
  const pages = { 403: FORBIDDEN_PAGE, 404: NOT_FOUND_PAGE, 429: RATE_LIMIT_PAGE, 500: SERVER_ERROR_PAGE }
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(pages[status] || SERVER_ERROR_PAGE)
}

function handleRequest(req, res) {
  const start = Date.now()
  const ip = req.socket.remoteAddress || 'unknown'

  res.on('finish', () => {
    log(req.method, req.url, res.statusCode, Date.now() - start, ip)
  })

  // Health check — handy for uptime monitors / docker healthchecks
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }))
    return
  }

  if (isRateLimited(ip)) {
    sendError(res, 429)
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 403)
    return
  }

  const filePath = resolveFilePath(req.url)
  if (!filePath) {
    sendError(res, 403)
    return
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      sendError(res, 404)
      return
    }
    sendFile(res, filePath)
  })
}

/* ===========================================================================
   Server bootstrap
============================================================================ */
const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res)
  } catch (err) {
    logError('Unhandled error: ' + err.message)
    sendError(res, 500)
  }
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logError(`Port ${CONFIG.port} is already in use. Set a different PORT env var and try again.`)
    process.exit(1)
  }
  logError(err.message)
})

server.listen(CONFIG.port, () => {
  logInfo(`Server running → http://${CONFIG.host}:${CONFIG.port}/${CONFIG.defaultFile}`)
  logInfo(`Health check     → http://${CONFIG.host}:${CONFIG.port}/health`)
  logInfo('Press Ctrl+C to stop.')
})

/* ===========================================================================
   Graceful shutdown
============================================================================ */
function shutdown(signal) {
  logInfo(`Received ${signal}, shutting down…`)
  server.close(() => {
    logInfo('Server closed. Bye!')
    process.exit(0)
  })
  // Force-exit if something hangs
  setTimeout(() => process.exit(1), 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))