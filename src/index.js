'use strict';

const fs = require('fs');
const path = require('path');

// Carga opcional de .env (sin dependencias). Las variables ya definidas no se pisan.
function loadDotEnv(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of txt.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(process.cwd(), '.env'));

const db = require('./db');
const manager = require('./manager');
const { createServer } = require('./server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null;
let shuttingDown = false;

async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[hub] cerrando (${reason})…`);
  const hard = setTimeout(() => { console.error('[hub] cierre forzado por tiempo'); process.exit(1); }, 20000);
  hard.unref();
  try {
    if (server) {
      server.close();
      if (server.closeIdleConnections) server.closeIdleConnections();
    }
    await manager.stopAll();
    await db.close();
  } catch (e) {
    console.error('[hub] error durante el cierre:', e.message);
  }
  if (server && server.closeAllConnections) server.closeAllConnections();
  process.exit(code);
}

// Errores globales: se registran y el hub sigue vivo, salvo que sean una ráfaga.
const errTimes = [];
function onFatal(kind, err) {
  console.error(`[hub] ${kind}:`, err && err.stack ? err.stack : err);
  const now = Date.now();
  errTimes.push(now);
  while (errTimes.length && now - errTimes[0] > 60000) errTimes.shift();
  if (errTimes.length > 10) {
    console.error('[hub] demasiados errores no controlados en 1 minuto; saliendo para que el supervisor reinicie el hub');
    shutdown('errores repetidos', 1);
  }
}
process.on('unhandledRejection', (reason) => onFatal('unhandledRejection', reason));
process.on('uncaughtException', (err) => onFatal('uncaughtException', err));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function initDb() {
  for (let i = 1; i <= 5; i++) {
    try { await db.init(); return; }
    catch (e) {
      console.error(`[db] intento ${i}/5 falló: ${e.message}`);
      if (i === 5) throw e;
      await sleep(3000 * i);
    }
  }
}

async function main() {
  const secret = process.env.MINATO_SECRET;
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL (cadena de conexión de Neon)');
  if (!secret || secret.length < 8) throw new Error('Falta MINATO_SECRET (mínimo 8 caracteres)');

  await initDb();
  server = createServer(secret);
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log(`[hub] Minato Hub escuchando en http://${host}:${port}`);

  manager.restoreAll().catch((e) => console.error('[hub] restauración falló:', e.message));
}

main().catch((e) => {
  console.error('[hub] no se pudo iniciar:', e.message);
  process.exit(1);
});
