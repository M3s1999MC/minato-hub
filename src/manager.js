'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const db = require('./db');
const remote = require('./remote');
const RingBuffer = require('./ringbuffer');
const { HubError } = require('./errors');

const BASE_DIR = path.resolve(process.env.MINATO_DATA_DIR || path.join(process.cwd(), 'data'));
const INSTANCES_DIR = path.join(BASE_DIR, 'instances');
const IS_WIN = process.platform === 'win32';

const LOG_LINES = 200;
const STOP_GRACE_MS = 8000;
const FAST_CRASH_MS = 60000;      // una caída antes de este tiempo cuenta como "rápida"
const MAX_FAST_CRASHES = 5;       // tras N caídas rápidas seguidas se deja de reiniciar
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;

// Variables del hub que SÍ se heredan a los hijos. Nada más (DATABASE_URL, MINATO_SECRET, etc. no pasan).
const PASS_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'SHELL', 'SystemRoot', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
const URL_RE = /^(https?:\/\/|ssh:\/\/|git@)\S+$/;

const runtimes = new Map(); // id -> estado de ejecución en memoria
let shuttingDown = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRemote = (inst) => !!inst.target_node && inst.target_node !== 'local';
const redact = (s) => String(s).replace(/(\/\/)[^\/@\s:]+(:[^\/@\s]*)?@/g, '$1***@');
const instDir = (id) => path.join(INSTANCES_DIR, id);
const depsHashFile = (dir) => path.join(dir, '.minato-deps.sha256');

function rt(id) {
  let r = runtimes.get(id);
  if (!r) {
    r = {
      id, cfg: null, proc: null, pid: null, job: null, status: 'stopped', logs: new RingBuffer(LOG_LINES),
      startedAt: null, deployedAt: null, restarts: 0, fastCrashes: 0, timer: null, nextRestartAt: 0,
      stopping: false, cancelled: false, busy: null, lastExit: null, onExit: [],
    };
    runtimes.set(id, r);
  }
  return r;
}

function hubLog(r, msg) {
  r.logs.push('hub', redact(msg) + '\n');
}

async function computeDepsHash(dir) {
  const files = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
  const h = crypto.createHash('sha256');
  let found = false;
  for (const name of files) {
    const p = path.join(dir, name);
    try {
      const buf = await fsp.readFile(p);
      found = true;
      h.update(`\0${name}\0`);
      h.update(buf);
    } catch { /* archivo opcional */ }
  }
  return found ? h.digest('hex') : null;
}

async function readSavedDepsHash(dir) {
  try {
    return (await fsp.readFile(depsHashFile(dir), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function saveDepsHash(dir, hash) {
  if (!hash) return;
  await fsp.writeFile(depsHashFile(dir), hash + '\n', 'utf8');
}

async function needsInstall(dir) {
  const hasModules = fs.existsSync(path.join(dir, 'node_modules'));
  const currentHash = await computeDepsHash(dir);
  if (!currentHash) return !hasModules;
  if (!hasModules) return true;
  const savedHash = await readSavedDepsHash(dir);
  return savedHash !== currentHash;
}

/* ------------------------------ validación ------------------------------ */

function parseEnv(v) {
  if (typeof v === 'string') {
    try { v = v.trim() ? JSON.parse(v) : {}; } catch { throw new HubError(400, 'env_json no es JSON válido'); }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HubError(400, 'env_json debe ser un objeto');
  const keys = Object.keys(v);
  if (keys.length > 100) throw new HubError(400, 'env_json admite como máximo 100 variables');
  const out = {};
  for (const k of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new HubError(400, `Nombre de variable inválido: ${k}`);
    const x = v[k];
    if (!['string', 'number', 'boolean'].includes(typeof x)) throw new HubError(400, `Valor inválido para ${k}`);
    const s = String(x);
    if (s.length > 4000) throw new HubError(400, `Valor demasiado largo para ${k}`);
    out[k] = s;
  }
  return out;
}

function toBool(v, def, field) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new HubError(400, `Campo "${field}" debe ser booleano`);
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function validate(inp, create) {
  if (!inp || typeof inp !== 'object' || Array.isArray(inp)) throw new HubError(400, 'El cuerpo debe ser un objeto JSON');
  const out = {};
  const want = (k) => create || inp[k] !== undefined;
  const getText = (k, min, max, def) => {
    let v = inp[k];
    if ((v === undefined || v === null) && create && def !== undefined) v = def;
    if (typeof v !== 'string') throw new HubError(400, `Campo "${k}" inválido o ausente`);
    v = v.trim();
    if (v.length < min || v.length > max) throw new HubError(400, `Campo "${k}" debe tener entre ${min} y ${max} caracteres`);
    return v;
  };

  if (want('name')) out.name = getText('name', 1, 60);
  if (create) {
    const id = String(inp.id || slug(out.name)).toLowerCase();
    if (!ID_RE.test(id)) throw new HubError(400, 'id inválido: usa 2-40 caracteres [a-z0-9_-], empezando por letra o número');
    out.id = id;
  }
  if (want('repo_url')) {
    out.repo_url = getText('repo_url', 1, 500);
    if (!URL_RE.test(out.repo_url)) throw new HubError(400, 'repo_url debe empezar por https://, http://, ssh:// o git@');
  }
  if (want('branch')) {
    out.branch = getText('branch', 1, 100, 'main');
    if (!REF_RE.test(out.branch) || out.branch.includes('..')) throw new HubError(400, 'branch inválida');
  }
  if (want('install_cmd')) out.install_cmd = getText('install_cmd', 0, 500, 'npm install --omit=dev');
  if (want('start_cmd')) out.start_cmd = getText('start_cmd', 1, 500, 'npm start');
  if (want('max_memory_mb')) {
    const n = Number(inp.max_memory_mb === undefined || inp.max_memory_mb === null ? 256 : inp.max_memory_mb);
    if (!Number.isInteger(n) || n < 32 || n > 16384) throw new HubError(400, 'max_memory_mb debe ser un entero entre 32 y 16384');
    out.max_memory_mb = n;
  }
  if (want('auto_restart')) out.auto_restart = toBool(inp.auto_restart, true, 'auto_restart');
  if (want('enabled')) out.enabled = toBool(inp.enabled, true, 'enabled');
  if (want('env_json')) out.env_json = parseEnv(inp.env_json === undefined || inp.env_json === null ? {} : inp.env_json);
  if (want('target_node')) {
    const t = inp.target_node === undefined || inp.target_node === null || inp.target_node === '' ? 'local' : inp.target_node;
    if (typeof t !== 'string' || !/^[\w.-]{1,40}$/.test(t)) throw new HubError(400, 'target_node inválido');
    if (t !== 'local' && !remote.isConfigured(t)) throw new HubError(400, `El nodo remoto "${t}" no está configurado en MINATO_NODES`);
    out.target_node = t;
  }
  if (!create && Object.keys(out).length === 0) throw new HubError(400, 'No hay campos válidos para actualizar');
  return out;
}

/* --------------------------- procesos y comandos --------------------------- */

function killTree(proc, signal) {
  if (!proc || !proc.pid) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } else {
      process.kill(-proc.pid, signal); // grupo de procesos (detached: true)
    }
  } catch {
    try { proc.kill(signal); } catch { /* ya terminó */ }
  }
}

function baseEnv() {
  const env = {};
  for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

function buildEnv(inst, forRun) {
  const env = Object.assign(baseEnv(), inst.env_json || {});
  env.MINATO_INSTANCE_ID = inst.id;
  if (env.FORCE_COLOR === undefined) env.FORCE_COLOR = '0';
  if (forRun) {
    let no = env.NODE_OPTIONS || '';
    if (!/--max-old-space-size/.test(no)) no = `${no} --max-old-space-size=${inst.max_memory_mb}`.trim();
    env.NODE_OPTIONS = no;
  }
  return env;
}

/** Ejecuta un comando de corta duración (git / instalación) volcando su salida al ring buffer. */
function runCommand(r, label, command, args, opts) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let child;
    try {
      child = args
        ? spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: !IS_WIN, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        : spawn(command, { cwd: opts.cwd, env: opts.env, shell: true, detached: !IS_WIN, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return reject(new Error(`${label}: no se pudo ejecutar (${e.message})`));
    }
    r.job = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => r.logs.push('out', redact(d)));
    child.stderr.on('data', (d) => r.logs.push('err', redact(d)));
    const timer = setTimeout(() => { timedOut = true; killTree(child, 'SIGKILL'); }, opts.timeout);
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      r.logs.flush('out'); r.logs.flush('err');
      if (r.job === child) r.job = null;
      if (err) reject(err); else resolve();
    };
    child.on('error', (e) => finish(new Error(`${label}: no se pudo ejecutar (${e.message})`)));
    child.on('close', (code, sig) => {
      if (timedOut) return finish(new Error(`${label}: tiempo agotado`));
      if (code === 0) return finish();
      finish(new Error(`${label} falló (${code !== null ? 'código ' + code : 'señal ' + sig})`));
    });
  });
}

const git = (r, args, cwd) =>
  runCommand(r, `git ${args[0]}`, 'git', args, { cwd, env: Object.assign(baseEnv(), { GIT_TERMINAL_PROMPT: '0' }), timeout: GIT_TIMEOUT_MS });

async function syncRepo(r, inst) {
  const dir = instDir(inst.id);
  await fsp.mkdir(INSTANCES_DIR, { recursive: true });
  if (fs.existsSync(path.join(dir, '.git'))) {
    hubLog(r, `Actualizando repositorio (rama ${inst.branch})…`);
    await git(r, ['remote', 'set-url', 'origin', inst.repo_url], dir);
    await git(r, ['fetch', '--depth', '1', 'origin', inst.branch], dir);
    await git(r, ['reset', '--hard', 'FETCH_HEAD'], dir);
  } else {
    if (fs.existsSync(dir)) await fsp.rm(dir, { recursive: true, force: true });
    hubLog(r, `Clonando ${inst.repo_url} (rama ${inst.branch})…`);
    await git(r, ['clone', '--depth', '1', '--branch', inst.branch, '--', inst.repo_url, dir], INSTANCES_DIR);
  }
}

function spawnProcess(r, inst, dir) {
  r.cfg = inst;
  hubLog(r, `Iniciando: ${inst.start_cmd}`);
  const child = spawn(inst.start_cmd, {
    cwd: dir, env: buildEnv(inst, true), shell: true, detached: !IS_WIN,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  r.proc = child;
  r.pid = child.pid || null;
  r.status = 'running';
  r.startedAt = Date.now();
  r.stopping = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => r.logs.push('out', d));
  child.stderr.on('data', (d) => r.logs.push('err', d));
  child.on('error', (e) => { hubLog(r, `Error del proceso: ${e.message}`); handleExit(r, child, null, null); });
  child.on('exit', (code, sig) => handleExit(r, child, code, sig));
}

function handleExit(r, child, code, sig) {
  if (r.proc !== child) return; // ya procesado
  r.logs.flush('out'); r.logs.flush('err');
  const uptime = Date.now() - r.startedAt;
  r.proc = null;
  r.pid = null;
  r.lastExit = { code, signal: sig, at: Date.now() };
  const waiters = r.onExit.splice(0);
  if (r.stopping) {
    r.stopping = false;
    r.status = 'stopped';
    hubLog(r, `Proceso detenido (code=${code}, signal=${sig})`);
    waiters.forEach((f) => f());
    return;
  }
  hubLog(r, `El proceso terminó inesperadamente (code=${code}, signal=${sig}) tras ${Math.round(uptime / 1000)}s`);
  waiters.forEach((f) => f());
  scheduleRestart(r, uptime);
}

/** Watchdog: auto-reinicio con backoff exponencial y corte tras demasiadas caídas rápidas. */
function scheduleRestart(r, uptime) {
  const cfg = r.cfg;
  if (shuttingDown || !cfg || !cfg.auto_restart || !cfg.enabled) { r.status = 'crashed'; return; }
  r.fastCrashes = uptime < FAST_CRASH_MS ? r.fastCrashes + 1 : 0;
  if (r.fastCrashes > MAX_FAST_CRASHES) {
    r.status = 'failed';
    hubLog(r, `Demasiadas caídas rápidas seguidas (${r.fastCrashes - 1}); auto-reinicio desactivado. Revisa los logs e inicia manualmente.`);
    return;
  }
  const n = Math.max(r.fastCrashes, 1);
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS);
  r.status = 'backoff';
  r.nextRestartAt = Date.now() + delay;
  hubLog(r, `Reinicio automático en ${Math.round(delay / 1000)}s (caída rápida ${r.fastCrashes}/${MAX_FAST_CRASHES})`);
  r.timer = setTimeout(() => {
    r.timer = null;
    if (shuttingDown || !r.cfg || !r.cfg.enabled || !r.cfg.auto_restart) { r.status = 'crashed'; return; }
    try {
      r.restarts++;
      spawnProcess(r, r.cfg, instDir(r.id));
    } catch (e) {
      r.status = 'error';
      hubLog(r, `No se pudo reiniciar: ${e.message}`);
    }
  }, delay);
}

async function terminate(r) {
  const child = r.proc;
  if (!child) return;
  r.stopping = true;
  r.status = 'stopping';
  hubLog(r, 'Deteniendo proceso (SIGTERM)…');
  const exited = new Promise((res) => r.onExit.push(res));
  killTree(child, 'SIGTERM');
  const killer = setTimeout(() => { hubLog(r, 'No respondió a SIGTERM; enviando SIGKILL'); killTree(child, 'SIGKILL'); }, STOP_GRACE_MS);
  let guard;
  await Promise.race([exited, new Promise((res) => { guard = setTimeout(res, STOP_GRACE_MS + 5000); })]);
  clearTimeout(killer);
  clearTimeout(guard);
  if (r.proc === child) {
    r.proc = null; r.pid = null; r.stopping = false; r.status = 'stopped';
    hubLog(r, 'El proceso no confirmó su salida; se marca como detenido');
  }
}

function clearTimer(r) {
  if (r.timer) { clearTimeout(r.timer); r.timer = null; }
}

/* --------------------------- acciones locales --------------------------- */

async function withLock(r, label, fn) {
  if (r.busy) throw new HubError(409, `Operación en curso: ${r.busy}`);
  r.busy = label;
  try { return await fn(); } finally { r.busy = null; }
}

async function startLocal(r, inst) {
  if (r.proc) throw new HubError(409, 'La instancia ya está corriendo');
  clearTimer(r);
  if (!fs.existsSync(instDir(inst.id))) throw new HubError(409, 'La instancia aún no está desplegada; usa Deploy');
  r.fastCrashes = 0;
  try { spawnProcess(r, inst, instDir(inst.id)); }
  catch (e) { r.status = 'error'; throw new HubError(500, `No se pudo iniciar: ${e.message}`); }
}

async function stopLocal(r) {
  if (r.busy === 'deploy') {
    if (r.job) {
      r.cancelled = true;
      killTree(r.job, 'SIGKILL');
      hubLog(r, 'Deploy cancelado por el usuario');
      return;
    }
    throw new HubError(409, 'Deploy en curso; inténtalo de nuevo en unos segundos');
  }
  if (r.busy) throw new HubError(409, `Operación en curso: ${r.busy}`);
  if (r.timer) {
    clearTimer(r);
    r.status = 'stopped';
    hubLog(r, 'Reinicio automático cancelado');
    return;
  }
  if (r.stopping) throw new HubError(409, 'La instancia ya se está deteniendo');
  if (!r.proc) throw new HubError(409, 'La instancia ya está detenida');
  await terminate(r);
}

async function doDeploy(r, inst, { forceInstall = false } = {}) {
  r.cancelled = false;
  try {
    clearTimer(r);
    if (r.proc) await terminate(r);
    r.status = 'deploying';
    hubLog(r, 'Deploy iniciado');
    await syncRepo(r, inst);
    const dir = instDir(inst.id);
    const shouldInstall = inst.install_cmd && inst.install_cmd.trim() && (forceInstall || await needsInstall(dir));
    if (shouldInstall) {
      r.status = 'installing';
      hubLog(r, `Instalando: ${inst.install_cmd}`);
      await runCommand(r, 'Instalación', inst.install_cmd, null,
        { cwd: dir, env: buildEnv(inst, false), timeout: INSTALL_TIMEOUT_MS });
      const newHash = await computeDepsHash(dir);
      await saveDepsHash(dir, newHash);
    } else if (inst.install_cmd && inst.install_cmd.trim()) {
      hubLog(r, 'Dependencias sin cambios; se omite instalación');
    }
    r.deployedAt = Date.now();
    hubLog(r, 'Deploy completado');
    if (shuttingDown) return;
    if (inst.enabled) { r.fastCrashes = 0; spawnProcess(r, inst, dir); }
    else r.status = 'stopped';
  } catch (e) {
    if (r.cancelled) { r.status = 'stopped'; }
    else { r.status = 'error'; hubLog(r, `Deploy fallido: ${e.message}`); }
  }
}

/** Adquiere el lock de forma síncrona y devuelve una promesa que nunca rechaza. */
function startDeploy(inst, opts) {
  const r = rt(inst.id);
  if (r.busy) throw new HubError(409, `Operación en curso: ${r.busy}`);
  r.busy = 'deploy';
  r.cfg = inst;
  return doDeploy(r, inst, opts).finally(() => { r.busy = null; });
}

/* ------------------------------ API pública ------------------------------ */

async function mustGet(id) {
  if (!ID_RE.test(id)) throw new HubError(400, 'ID de instancia inválido');
  const inst = await db.getInstance(id);
  if (!inst) throw new HubError(404, 'Instancia no encontrada');
  return inst;
}

async function describe(inst) {
  if (isRemote(inst)) {
    let rs;
    try { rs = await remote.status(inst); } catch (e) { rs = { status: 'unreachable', error: e.message }; }
    return {
      ...inst, status: rs.status || 'unknown', pid: rs.pid ?? null, uptime_s: rs.uptime_s ?? null,
      restarts: rs.restarts ?? 0, remote: true, error: rs.error,
    };
  }
  const r = runtimes.get(inst.id);
  if (!r) return { ...inst, status: 'stopped', pid: null, uptime_s: null, restarts: 0, busy: null };
  return {
    ...inst,
    status: r.status,
    pid: r.pid,
    uptime_s: r.proc && r.startedAt ? Math.floor((Date.now() - r.startedAt) / 1000) : null,
    restarts: r.restarts,
    busy: r.busy,
    next_restart_in_s: r.timer ? Math.max(0, Math.ceil((r.nextRestartAt - Date.now()) / 1000)) : null,
    last_exit: r.lastExit,
    deployed_at: r.deployedAt,
  };
}

async function list() {
  const rows = await db.listInstances();
  return Promise.all(rows.map(describe));
}

async function get(id) {
  return describe(await mustGet(id));
}

async function create(input) {
  const v = validate(input, true);
  let row;
  try { row = await db.insertInstance(v); }
  catch (e) {
    if (e.code === '23505') throw new HubError(409, 'Ya existe una instancia con ese id');
    throw e;
  }
  return describe(row);
}

async function update(id, input) {
  const before = await mustGet(id);
  const v = validate(input, false);
  const row = await db.updateInstance(id, v);
  if (!row) throw new HubError(404, 'Instancia no encontrada');
  const r = runtimes.get(id);
  if (r) r.cfg = row;
  const d = await describe(row);
  d.restart_required = !isRemote(before) && !!(r && r.proc);
  return d;
}

async function remove(id, purge = true) {
  const inst = await mustGet(id);
  if (isRemote(inst)) {
    await remote.remove(inst);
  } else {
    const r = runtimes.get(id);
    if (r) {
      if (r.busy) throw new HubError(409, `Operación en curso: ${r.busy}`);
      clearTimer(r);
      if (r.proc) await terminate(r);
    }
  }
  await db.deleteInstance(id);
  runtimes.delete(id);
  if (purge && !isRemote(inst)) {
    const dir = instDir(id);
    if (dir.startsWith(INSTANCES_DIR + path.sep)) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return { deleted: id };
}

async function act(id, action) {
  const inst = await mustGet(id);
  if (isRemote(inst)) {
    await remote.act(inst, action);
    return describe(inst);
  }
  const r = rt(id);
  r.cfg = inst;
  switch (action) {
    case 'start':
      await withLock(r, 'start', () => startLocal(r, inst));
      break;
    case 'stop':
      await stopLocal(r);
      break;
    case 'restart':
      await withLock(r, 'restart', async () => {
        clearTimer(r);
        if (r.proc) await terminate(r);
        await startLocal(r, inst);
      });
      break;
    case 'deploy':
      startDeploy(inst); // corre en segundo plano; el estado se ve en el panel / logs
      break;
    default:
      throw new HubError(400, 'Acción desconocida');
  }
  return describe(inst);
}

async function logs(id, since) {
  const inst = await mustGet(id);
  if (isRemote(inst)) return remote.logs(inst, since);
  const r = runtimes.get(id);
  if (!r) return { lines: [], next: 0 };
  return { lines: r.logs.since(since), next: r.logs.seq };
}

/** Al arrancar: restaura las instancias locales habilitadas, una a una para no disparar la RAM. */
async function restoreAll() {
  let rows;
  try { rows = await db.listInstances(); }
  catch (e) { console.error('[manager] no se pudieron cargar las instancias:', e.message); return; }
  const todo = rows.filter((i) => i.enabled && !isRemote(i));
  console.log(`[manager] restaurando ${todo.length} instancia(s) habilitada(s)`);
  for (const inst of todo) {
    if (shuttingDown) return;
    const r = rt(inst.id);
    r.cfg = inst;
    try {
      const dir = instDir(inst.id);
      if (fs.existsSync(path.join(dir, '.git')) && !(await needsInstall(dir))) {
        await withLock(r, 'start', () => startLocal(r, inst));
      } else {
        await startDeploy(inst);
      }
    } catch (e) {
      r.status = 'error';
      hubLog(r, `No se pudo restaurar: ${e.message}`);
      console.error(`[manager] ${inst.id}: ${e.message}`);
    }
    await sleep(1500);
  }
}

async function stopAll() {
  shuttingDown = true;
  const jobs = [];
  for (const r of runtimes.values()) {
    clearTimer(r);
    if (r.job) { r.cancelled = true; killTree(r.job, 'SIGKILL'); }
    if (r.proc) {
      if (r.stopping) jobs.push(new Promise((res) => r.onExit.push(res)));
      else jobs.push(terminate(r));
    }
  }
  await Promise.allSettled(jobs);
}

async function metrics() {
  const mu = process.memoryUsage();
  const MB = 1024 * 1024;
  let total = null;
  try { total = await db.countInstances(); } catch { /* base de datos no disponible */ }
  let running = 0;
  for (const r of runtimes.values()) if (r.proc) running++;
  return {
    hub: {
      rss_mb: +(mu.rss / MB).toFixed(1),
      heap_used_mb: +(mu.heapUsed / MB).toFixed(1),
      uptime_s: Math.floor(process.uptime()),
      node_version: process.version,
      pid: process.pid,
      platform: process.platform,
    },
    system: {
      total_mb: Math.round(os.totalmem() / MB),
      free_mb: Math.round(os.freemem() / MB),
      load: os.loadavg().map((x) => +x.toFixed(2)),
      cpus: os.cpus().length,
    },
    instances: { total, running },
  };
}

module.exports = { list, get, create, update, remove, act, logs, restoreAll, stopAll, metrics };
