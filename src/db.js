'use strict';

const { Pool } = require('pg');

const COLS = ['id', 'name', 'repo_url', 'branch', 'install_cmd', 'start_cmd',
  'max_memory_mb', 'auto_restart', 'enabled', 'env_json', 'target_node'];

let pool = null;

async function init() {
  let cs = process.env.DATABASE_URL;
  if (!cs) throw new Error('DATABASE_URL no está definida');
  if (/neon\.tech/.test(cs) && !/sslmode=/.test(cs)) cs += (cs.includes('?') ? '&' : '?') + 'sslmode=require';

  pool = new Pool({
    connectionString: cs,
    max: 3,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 20000,
    query_timeout: 30000,
  });
  pool.on('error', (e) => console.error('[db] error en conexión inactiva:', e.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS minato_instances (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      repo_url      TEXT NOT NULL,
      branch        TEXT NOT NULL DEFAULT 'main',
      install_cmd   TEXT NOT NULL DEFAULT 'npm install --omit=dev',
      start_cmd     TEXT NOT NULL DEFAULT 'npm start',
      max_memory_mb INTEGER NOT NULL DEFAULT 256,
      auto_restart  BOOLEAN NOT NULL DEFAULT TRUE,
      enabled       BOOLEAN NOT NULL DEFAULT TRUE,
      env_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
      target_node   TEXT NOT NULL DEFAULT 'local',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

const q = (text, params) => pool.query(text, params);

async function listInstances() {
  return (await q('SELECT * FROM minato_instances ORDER BY created_at, id')).rows;
}

async function getInstance(id) {
  return (await q('SELECT * FROM minato_instances WHERE id = $1', [id])).rows[0] || null;
}

async function insertInstance(i) {
  const r = await q(
    `INSERT INTO minato_instances
      (id, name, repo_url, branch, install_cmd, start_cmd, max_memory_mb, auto_restart, enabled, env_json, target_node)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING *`,
    [i.id, i.name, i.repo_url, i.branch, i.install_cmd, i.start_cmd, i.max_memory_mb,
      i.auto_restart, i.enabled, JSON.stringify(i.env_json), i.target_node]);
  return r.rows[0];
}

async function updateInstance(id, patch) {
  const sets = [];
  const vals = [id];
  for (const k of COLS) {
    if (k === 'id' || patch[k] === undefined) continue;
    vals.push(k === 'env_json' ? JSON.stringify(patch[k]) : patch[k]);
    sets.push(`${k} = $${vals.length}${k === 'env_json' ? '::jsonb' : ''}`);
  }
  if (!sets.length) return getInstance(id);
  sets.push('updated_at = now()');
  const r = await q(`UPDATE minato_instances SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
  return r.rows[0] || null;
}

async function deleteInstance(id) {
  return (await q('DELETE FROM minato_instances WHERE id = $1', [id])).rowCount > 0;
}

async function countInstances() {
  return Number((await q('SELECT count(*)::int AS n FROM minato_instances')).rows[0].n);
}

async function close() {
  if (pool) await pool.end().catch(() => {});
}

module.exports = { init, listInstances, getInstance, insertInstance, updateInstance, deleteInstance, countInstances, close };
