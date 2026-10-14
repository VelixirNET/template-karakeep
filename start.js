// Starts Karakeep the way velixir runs apps.
//
// Upstream's container runs three things under a process supervisor: the web app, the background
// workers (fetching pages, tagging, indexing) and, in a separate container, Meilisearch for
// search. velixir runs one process per app, so this file is the supervisor. It also adds what a
// public deploy needs:
//
//   1. Everything on the volume. Karakeep's database, saved pages and images, and the search index
//      live under VELIXIR_VOLUME_PATH, so bookmarks survive restarts and redeploys. Without a
//      volume they live on the container disk and start over on every restart, and the log says
//      so.
//   2. Stable secrets without setup. The session secret and Meilisearch's key are generated once
//      and kept on the volume, unless you set NEXTAUTH_SECRET or MEILI_MASTER_KEY yourself.
//   3. Nobody else can claim it. On a fresh Karakeep the first person to sign up becomes the
//      admin. Here the first start creates the admin account on loopback before going public,
//      prints the password once to the deploy log, and leaves sign-ups off (set
//      DISABLE_SIGNUPS=false to open them).
//   4. One part stopping stops the app, so the platform restarts it rather than leaving it
//      half-working. Stop signals reach every part, so the database closes cleanly.
//
// While Karakeep starts, $PORT serves a short "starting" page and /healthz answers 200.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn, spawnSync } = require('node:child_process');

const PORT = Number(process.env.PORT || 3000);
const PRIVATE_WEB_PORT = PORT === 3291 ? 3292 : 3291;
const MEILI_PORT = PORT === 7700 ? 7701 : 7700;

const appDir = path.join(__dirname, 'karakeep');
const version = fs.existsSync(path.join(appDir, 'VERSION')) ? fs.readFileSync(path.join(appDir, 'VERSION'), 'utf8').trim() : '';

const volume = (process.env.VELIXIR_VOLUME_PATH || '').trim();
const base = volume ? path.join(volume, 'karakeep') : path.join(__dirname, '.karakeep-data');
const dataDir = path.join(base, 'data');
const meiliDir = path.join(base, 'meilisearch');
const secretsFile = path.join(base, 'velixir-secrets.json');

const publicUrl = (process.env.PUBLIC_URL || process.env.NEXTAUTH_URL
  || (process.env.VELIXIR_APP_SLUG ? `https://${process.env.VELIXIR_APP_SLUG}.velixir.run` : `http://localhost:${PORT}`))
  .replace(/\/+$/, '');
const adminEmail = (process.env.KARAKEEP_ADMIN_EMAIL || `admin@${new URL(publicUrl).hostname.replace(/^localhost$/, 'example.com')}`).trim().toLowerCase();
const adminPassword = process.env.KARAKEEP_ADMIN_PASSWORD || '';

// Packages from Karakeep's own build, for the database checks below: the workers' SQLite driver,
// and the password hashing Karakeep's auth code uses (a dependency of its trpc package, which the
// workers' isolated node_modules only exposes from that package's own folder).
const karakeepRequire = (name) => {
  const workers = path.join(appDir, 'apps', 'workers');
  const places = [workers, appDir];
  try { places.push(fs.realpathSync(path.join(workers, 'node_modules', '@karakeep', 'trpc'))); } catch { /* not there */ }
  for (const from of places) {
    try { return createRequire(path.join(from, 'package.json'))(name); } catch { /* next */ }
  }
  throw new Error(`${name} is not in Karakeep's build`);
};

const children = [];
let stopping = false;

// ─── The page shown while Karakeep starts ────────────────────────────────────

const STARTING_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Starting Karakeep</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0b0b10; color:#e8e8ef;
         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  p { color:#7a7a8c; font-size:.875rem; }
</style>
<div><h1>Karakeep is starting</h1><p>This takes a few seconds. The page reloads by itself.</p></div>
</html>`;

function startingServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5', 'cache-control': 'no-store' });
    res.end(STARTING_PAGE);
  });
  server.listen(PORT, '0.0.0.0');
  return server;
}

// ─── Secrets ─────────────────────────────────────────────────────────────────

function loadSecrets() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(secretsFile, 'utf8')); } catch { /* first start */ }
  let changed = false;
  for (const key of ['nextauthSecret', 'meiliMasterKey']) {
    if (!saved[key]) { saved[key] = crypto.randomBytes(32).toString('base64url'); changed = true; }
  }
  if (changed) fs.writeFileSync(secretsFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
  return {
    nextauthSecret: process.env.NEXTAUTH_SECRET || saved.nextauthSecret,
    meiliMasterKey: process.env.MEILI_MASTER_KEY || saved.meiliMasterKey,
  };
}

// ─── Environment ─────────────────────────────────────────────────────────────

function karakeepEnv(secrets, overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    DATA_DIR: dataDir,
    NEXTAUTH_URL: publicUrl,
    NEXTAUTH_SECRET: secrets.nextauthSecret,
    NEXTAUTH_URL_INTERNAL: `http://127.0.0.1:${PORT}`,
    MEILI_ADDR: `http://127.0.0.1:${MEILI_PORT}`,
    MEILI_MASTER_KEY: secrets.meiliMasterKey,
    HOSTNAME: '0.0.0.0',
    PORT: String(PORT),
    SERVER_VERSION: process.env.SERVER_VERSION || version,
    // Upstream's default is "debug", which is a lot of log for a small app.
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    // Sign-ups stay closed unless you open them: the admin can create accounts and invite people.
    DISABLE_SIGNUPS: process.env.DISABLE_SIGNUPS || 'true',
    ...overrides,
  };
}

// ─── Processes ───────────────────────────────────────────────────────────────

function launch(name, cmd, args, cwd, env) {
  const child = spawn(cmd, args, { cwd, env, stdio: 'inherit' });
  children.push(child);
  child.on('exit', (code, signal) => {
    children.splice(children.indexOf(child), 1);
    if (child.velixirExpected) return;
    if (stopping) {
      if (!children.length) process.exit(process.exitCode ?? 0);
      return;
    }
    // When one part stops, stop the rest and let the platform restart the app, rather than run
    // with part of it missing.
    console.error(`Karakeep ${name} stopped (${signal || `exit ${code}`}); stopping the app so it restarts.`);
    process.exitCode = 1;
    stopAll('SIGTERM');
    setTimeout(() => process.exit(1), 15000).unref();
  });
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.velixirExpected = true;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

function stopAll(signal) {
  stopping = true;
  for (const c of [...children]) if (c.exitCode === null && c.signalCode === null) c.kill(signal);
}

async function waitFor(url, label, child, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited while starting`);
    const ok = await new Promise((resolve) => {
      const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode < 500); });
      req.on('error', () => resolve(false));
      req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} did not start within ${Math.round(timeoutMs / 1000)} seconds`);
}

function startMeilisearch(secrets) {
  fs.mkdirSync(meiliDir, { recursive: true });
  return launch('search (Meilisearch)', path.join(appDir, 'meilisearch'), [
    '--db-path', path.join(meiliDir, 'data.ms'),
    '--dump-dir', path.join(meiliDir, 'dumps'),
    '--snapshot-dir', path.join(meiliDir, 'snapshots'),
    '--http-addr', `127.0.0.1:${MEILI_PORT}`,
    '--env', 'production',
    '--no-analytics',
    // Meilisearch sizes itself for the whole machine otherwise. One thread and a modest
    // indexing budget keep it inside a small plan; a personal bookmark library indexes fast.
    '--max-indexing-threads', '1',
    '--max-indexing-memory', process.env.MEILI_MAX_INDEXING_MEMORY || '256 MiB',
  ], meiliDir, { ...process.env, MEILI_MASTER_KEY: secrets.meiliMasterKey });
}

// ─── The admin account ───────────────────────────────────────────────────────

function openDb() {
  const Database = karakeepRequire('better-sqlite3');
  return new Database(path.join(dataDir, 'db.db'));
}

function userCount() {
  const db = openDb();
  try { return db.prepare('SELECT COUNT(*) AS n FROM user').get().n; } finally { db.close(); }
}

async function createFirstAdmin(secrets) {
  const password = adminPassword || randomPassword(24);
  console.log('Karakeep: first start. Creating the admin account on loopback before going public.');

  // Karakeep's own sign-up, on a private port, with sign-ups open only here. The first account
  // Karakeep creates is its admin.
  const web = launch('web app (first start)', process.execPath, ['server.js'], path.join(appDir, 'apps', 'web'),
    karakeepEnv(secrets, { PORT: String(PRIVATE_WEB_PORT), HOSTNAME: '127.0.0.1', DISABLE_SIGNUPS: 'false' }));
  try {
    await waitFor(`http://127.0.0.1:${PRIVATE_WEB_PORT}/api/health`, 'Karakeep', web);
    const res = await fetch(`http://127.0.0.1:${PRIVATE_WEB_PORT}/api/trpc/users.create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { name: 'Admin', email: adminEmail, password, confirmPassword: password } }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Karakeep refused the admin account (HTTP ${res.status}): ${body.slice(0, 300)}`);
  } finally {
    await stopChild(web);
  }

  box([
    'Karakeep is ready. Your admin account:',
    '',
    `  URL:       ${publicUrl}`,
    `  Email:     ${adminEmail}`,
    `  Password:  ${adminPassword ? '(the one in KARAKEEP_ADMIN_PASSWORD)' : password}`,
    '',
    'This is shown once. Change it in User Settings, or set',
    'KARAKEEP_ADMIN_PASSWORD on the Environment tab to reset it on the next start.',
  ]);
}

async function resetAdminPassword() {
  const bcrypt = karakeepRequire('bcryptjs');
  const hash = await bcrypt.hash(adminPassword, 10);
  const db = openDb();
  try {
    const target = process.env.KARAKEEP_ADMIN_EMAIL
      ? db.prepare('SELECT id, email FROM user WHERE lower(email) = ?').get(adminEmail)
      : db.prepare("SELECT id, email FROM user WHERE role = 'admin' ORDER BY rowid LIMIT 1").get();
    if (!target) {
      console.log(`Karakeep: KARAKEEP_ADMIN_PASSWORD is set, but there is no user ${process.env.KARAKEEP_ADMIN_EMAIL || 'with the admin role'}.`);
      return;
    }
    // Karakeep hashes password + salt; an empty salt means the password alone.
    db.prepare("UPDATE user SET password = ?, salt = '' WHERE id = ?").run(hash, target.id);
    console.log(`Karakeep: password for ${target.email} set from KARAKEEP_ADMIN_PASSWORD.`);
  } finally {
    db.close();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });

  if (!volume) {
    box([
      "No volume: Karakeep's data is on the container disk.",
      '',
      'Bookmarks, saved pages, images, the search index and the admin',
      'account start empty again on every restart and redeploy. Add a',
      "volume on the app's Volume tab (a paid plan) to keep them.",
    ]);
  }

  const placeholder = startingServer();
  const secrets = loadSecrets();

  console.log('Karakeep: applying database migrations.');
  const migration = spawnSync(process.execPath, ['index.js'],
    { cwd: path.join(appDir, 'db_migrations'), env: karakeepEnv(secrets), stdio: 'inherit' });
  if (migration.status !== 0) throw new Error(`database migration failed (exit ${migration.status ?? migration.signal})`);

  const meili = startMeilisearch(secrets);
  await waitFor(`http://127.0.0.1:${MEILI_PORT}/health`, 'Meilisearch', meili);

  if (userCount() === 0) {
    await createFirstAdmin(secrets);
  } else if (adminPassword) {
    await resetAdminPassword();
  }
  if (stopping) return;

  await new Promise((resolve) => placeholder.close(() => resolve()));
  if (stopping) return;

  launch('workers', process.execPath, ['dist/index.js'], path.join(appDir, 'apps', 'workers'), karakeepEnv(secrets));
  launch('web app', process.execPath, ['server.js'], path.join(appDir, 'apps', 'web'), karakeepEnv(secrets));
}

// As PID 1, node gets no default signal handling: without this a redeploy's SIGTERM would be
// ignored until the platform's grace period ran out.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (!children.length) process.exit(0);
    stopAll(signal);
    setTimeout(() => process.exit(0), 20000).unref();
  });
}

function randomPassword(n) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  while (out.length < n) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

function box(lines) {
  const width = Math.max(...lines.map((l) => l.length));
  const border = `+${'-'.repeat(width + 2)}+`;
  console.log(['', border, ...lines.map((l) => `| ${l.padEnd(width)} |`), border].join('\n'));
}

main().catch((err) => {
  console.error(`Karakeep could not start: ${err.message}`);
  process.exitCode = 1;
  stopAll('SIGTERM');
  setTimeout(() => process.exit(1), 5000).unref();
});
