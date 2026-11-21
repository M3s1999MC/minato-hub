'use strict';

/**
 * Base para delegar instancias a nodos remotos (otros Minato Hub).
 * Un nodo se define en MINATO_NODES:
 *   {"vps2":{"url":"https://hub2.ejemplo.com","token":"<MINATO_SECRET del hub 2>"}}
 * y una instancia con target_node="vps2" NO se ejecuta aquí: este hub
 * sincroniza su configuración con el hub remoto y le reenvía las acciones.
 */

const http = require('http');
const https = require('https');
const { HubError } = require('./errors');

let NODES = {};
try {
  if (process.env.MINATO_NODES) NODES = JSON.parse(process.env.MINATO_NODES);
} catch (e) {
  console.error('[remote] MINATO_NODES no es JSON válido:', e.message);
}

const isConfigured = (name) => !!(NODES[name] && NODES[name].url && NODES[name].token);
const enc = encodeURIComponent;

function request(node, method, urlPath, body, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const cfg = NODES[node];
    if (!cfg) return reject(new HubError(400, `Nodo remoto no configurado: ${node}`));
    let u;
    try { u = new URL(cfg.url.replace(/\/+$/, '') + urlPath); }
    catch { return reject(new HubError(400, `URL inválida para el nodo ${node}`)); }

    const payload = body ? JSON.stringify(body) : null;
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'x-minato-token': cfg.token, 'content-type': 'application/json' };
    if (payload) headers['content-length'] = Buffer.byteLength(payload);

    const req = lib.request(u, { method, headers, timeout }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 1e6) return req.destroy(new Error('respuesta demasiado grande'));
        chunks.push(c);
      });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* sin cuerpo JSON */ }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('tiempo agotado')));
    req.on('error', (e) => reject(new HubError(502, `Nodo ${node} inaccesible: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

const errMsg = (r) => (r.data && r.data.error) || `HTTP ${r.status}`;

function remoteConfig(inst) {
  return {
    name: inst.name, repo_url: inst.repo_url, branch: inst.branch,
    install_cmd: inst.install_cmd, start_cmd: inst.start_cmd,
    max_memory_mb: inst.max_memory_mb, auto_restart: inst.auto_restart,
    enabled: inst.enabled, env_json: inst.env_json || {}, target_node: 'local',
  };
}

async function sync(inst) {
  const cfg = remoteConfig(inst);
  let r = await request(inst.target_node, 'PUT', `/api/instances/${enc(inst.id)}`, cfg);
  if (r.status === 404) r = await request(inst.target_node, 'POST', '/api/instances', { id: inst.id, ...cfg });
  if (r.status >= 400) throw new HubError(502, `Sincronización remota falló: ${errMsg(r)}`);
}

async function status(inst) {
  const r = await request(inst.target_node, 'GET', `/api/instances/${enc(inst.id)}`, null, 3000);
  if (r.status === 404) return { status: 'not_synced' };
  if (r.status >= 400) throw new HubError(502, errMsg(r));
  return r.data;
}

async function act(inst, action) {
  if (action !== 'stop') await sync(inst);
  const r = await request(inst.target_node, 'POST', `/api/instances/${enc(inst.id)}/${action}`, {});
  if (r.status >= 400) throw new HubError(r.status === 409 ? 409 : 502, errMsg(r));
  return r.data;
}

async function logs(inst, since) {
  const r = await request(inst.target_node, 'GET', `/api/instances/${enc(inst.id)}/logs?since=${Number(since) || 0}`);
  if (r.status === 404) return { lines: [], next: 0 };
  if (r.status >= 400) throw new HubError(502, errMsg(r));
  return r.data;
}

async function remove(inst) {
  try { await request(inst.target_node, 'DELETE', `/api/instances/${enc(inst.id)}`); } catch { /* mejor esfuerzo */ }
}

module.exports = { isConfigured, status, act, logs, remove };
