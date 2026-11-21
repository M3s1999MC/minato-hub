'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const manager = require('./manager');
const { HubError } = require('./errors');

const MAX_BODY = 256 * 1024;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const PANEL = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'));
const fails = new Map(); // ip -> { count, reset }

function clientIp(req) {
  if (process.env.MINATO_TRUST_PROXY === '1') {
    const x = req.headers['x-forwarded-for'];
    if (x) return String(x).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function tokenOf(req) {
  let tok = req.headers['x-minato-token'];
  if (!tok && req.headers.authorization) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization);
    tok = m ? m[1] : req.headers.authorization;
  }
  return typeof tok === 'string' ? tok.trim() : '';
}

function send(res, status, body, extra) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }, extra));
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) { done = true; reject(new HubError(413, 'Cuerpo demasiado grande')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HubError(400, 'JSON mal formado en el cuerpo de la petición')); }
    });
    req.on('error', () => { if (!done) { done = true; reject(new HubError(400, 'Error leyendo la petición')); } });
  });
}

function createServer(secret) {
  const secretHash = sha(secret);

  function checkAuth(req) {
    const ip = clientIp(req);
    const now = Date.now();
    const f = fails.get(ip);
    if (f && f.reset > now && f.count >= MAX_FAILS) throw new HubError(429, 'Demasiados intentos fallidos; espera un minuto');
    const tok = tokenOf(req);
    if (tok && crypto.timingSafeEqual(sha(tok), secretHash)) return;
    if (!f || f.reset <= now) fails.set(ip, { count: 1, reset: now + FAIL_WINDOW_MS });
    else f.count++;
    throw new HubError(401, 'No autorizado');
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;

    if (p === '/health') {
      if (m !== 'GET' && m !== 'HEAD') throw new HubError(405, 'Método no permitido');
      return send(res, 200, { ok: true, uptime_s: Math.floor(process.uptime()) });
    }
    if (p === '/' || p === '/index.html') {
      if (m !== 'GET' && m !== 'HEAD') throw new HubError(405, 'Método no permitido');
      return send(res, 200, PANEL, {
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      });
    }
    if (p === '/favicon.ico') return send(res, 204, '');

    if (!p.startsWith('/api/')) throw new HubError(404, 'Ruta no encontrada');
    checkAuth(req);

    if (p === '/api/metrics') {
      if (m !== 'GET') throw new HubError(405, 'Método no permitido');
      return send(res, 200, await manager.metrics());
    }
    if (p === '/api/instances') {
      if (m === 'GET') return send(res, 200, { instances: await manager.list() });
      if (m === 'POST') return send(res, 201, await manager.create(await readJson(req)));
      throw new HubError(405, 'Método no permitido');
    }

    const mm = /^\/api\/instances\/([^/]+)(?:\/(start|stop|restart|deploy|logs))?$/.exec(p);
    if (!mm) throw new HubError(404, 'Ruta no encontrada');
    let id;
    try { id = decodeURIComponent(mm[1]); } catch { throw new HubError(400, 'ID inválido'); }
    const action = mm[2];

    if (!action) {
      if (m === 'GET') return send(res, 200, await manager.get(id));
      if (m === 'PUT' || m === 'PATCH') return send(res, 200, await manager.update(id, await readJson(req)));
      if (m === 'DELETE') return send(res, 200, await manager.remove(id, url.searchParams.get('purge') !== '0'));
      throw new HubError(405, 'Método no permitido');
    }
    if (action === 'logs') {
      if (m !== 'GET') throw new HubError(405, 'Método no permitido');
      return send(res, 200, await manager.logs(id, Number(url.searchParams.get('since')) || 0));
    }
    if (m !== 'POST') throw new HubError(405, 'Método no permitido');
    const out = await manager.act(id, action);
    return send(res, action === 'deploy' ? 202 : 200, out);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HubError) return send(res, e.status, { error: e.message });
      console.error('[http] error no controlado:', e);
      send(res, 500, { error: 'Error interno del hub' });
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, f] of fails) if (f.reset <= now) fails.delete(ip);
  }, 5 * 60 * 1000);
  sweep.unref();

  return server;
}

module.exports = { createServer };
