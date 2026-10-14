// Builds the Karakeep release pinned in package.json ("karakeep": { ... }) into ./karakeep, with
// the Meilisearch search engine next to it.
//
// Nothing of Karakeep's is committed to this repository. The build downloads the tagged source
// from GitHub and builds it the way upstream's own Dockerfile does: the database migrations, the
// web app (Next.js) and the background workers, each with what it needs to run and nothing else.
// Meilisearch (what Karakeep searches with) is upstream's release binary, at the version
// Karakeep's own docker-compose.yml runs, checked against the SHA-256 pinned in package.json.
// Upgrading is a version bump.
//
// Nixpacks runs this as `npm run build`. It needs internet access (GitHub and the npm registry)
// and no app environment: nothing here reads a secret.
//
// Everything happens in this one command on purpose. Each Nixpacks phase is one image layer, so
// the source, the build dependencies and every cache are created and deleted in the same layer
// and never reach the image. Only ./karakeep is left behind.

'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pin = require('./package.json').karakeep || {};
const version = pin.version;
const meili = pin.meilisearch || {};

const root = __dirname;
const runtime = path.join(root, 'karakeep');
// Outside this repository on purpose: Next.js takes the directory of the highest lockfile it can
// find as its tracing root, and this folder has a package-lock.json of its own.
const work = path.join(os.tmpdir(), 'velixir-karakeep-build');
const src = path.join(work, 'src');
const home = path.join(work, 'home');

const env = {
  ...process.env,
  HOME: home,
  XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  npm_config_cache: path.join(home, '.npm'),
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  NEXT_TELEMETRY_DISABLED: '1',
  TURBO_TELEMETRY_DISABLED: '1',
  // Karakeep's workers can drive a browser through Playwright, but this image has none (the
  // crawler reads pages over plain HTTP instead, see the README), so nothing downloads one.
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  PUPPETEER_SKIP_DOWNLOAD: 'true',
  // pnpm prompts when it would remove a node_modules folder it did not make; there is no one to
  // answer in a build.
  CI: 'true',
};
// Nixpacks sets NPM_CONFIG_PRODUCTION=false for its own install step; each install below says
// what it wants instead.
delete env.NPM_CONFIG_PRODUCTION;
delete env.npm_config_production;

const started = Date.now();

main().catch((err) => fail(err.stack || err.message));

async function main() {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    fail('package.json needs "karakeep": { "version": "x.y.z", ... }, naming a release such as "0.33.2".');
  }
  if (!/^\d+\.\d+\.\d+$/.test(meili.version || '') || !/^[0-9a-f]{64}$/.test(meili.sha256 || '')) {
    fail('package.json needs "karakeep.meilisearch": { "version": "x.y.z", "sha256": "..." } for meilisearch-linux-amd64.');
  }

  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  // ─── Source ─────────────────────────────────────────────────────────────────

  step(`fetching Karakeep ${version} from GitHub`);
  const archive = path.join(work, 'karakeep.tar.gz');
  await download(`https://github.com/karakeep-app/karakeep/archive/refs/tags/v${version}.tar.gz`, archive);
  log(`karakeep-${version}.tar.gz sha256 ${sha256(archive)}`);
  run('tar', ['-xzf', archive, '-C', src, '--strip-components=1']);

  const webPkg = readJson(path.join(src, 'apps', 'web', 'package.json'));
  log(`apps/web is ${webPkg.name} ${webPkg.version}`);

  // ─── Dependencies ───────────────────────────────────────────────────────────

  const upstream = readJson(path.join(src, 'package.json'));
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)/.exec(upstream.packageManager || '')?.[1];
  if (!pnpmVersion) fail(`Karakeep ${version} does not pin a pnpm version in packageManager.`);

  step(`installing pnpm ${pnpmVersion}, the version Karakeep ${version} builds with`);
  const pnpmDir = path.join(work, 'pnpm');
  fs.mkdirSync(pnpmDir);
  npm(['install', '--prefix', pnpmDir, '--no-save', `pnpm@${pnpmVersion}`]);
  const pnpmBinDir = path.join(pnpmDir, 'node_modules', '.bin');
  env.PATH = pnpmBinDir + path.delimiter + env.PATH;
  const store = path.join(work, 'pnpm-store');
  const pnpm = (cwd, args, extraEnv = {}) =>
    run(path.join(pnpmBinDir, 'pnpm'), args, { cwd, env: { ...env, ...extraEnv } });

  step("installing the dependencies of Karakeep's web app, workers and database");
  // Only the parts that run on a server. The repository also holds the mobile app, the browser
  // extension and the docs, which are most of its dependencies and none of this app.
  pnpm(src, ['install', '--frozen-lockfile', '--store-dir', store,
    '--filter', '@karakeep/web...', '--filter', '@karakeep/workers...', '--filter', '@karakeep/db...'],
  // Build tools (Next.js's compiler plugins, tsdown, ncc) are devDependencies, and Nixpacks
  // sets NODE_ENV=production for the whole build, which makes pnpm skip them.
  { NODE_ENV: 'development' });

  // ─── Build ──────────────────────────────────────────────────────────────────

  const out = path.join(work, 'out');
  fs.mkdirSync(out);

  step('bundling the database migrations');
  const dbDir = path.join(src, 'packages', 'db');
  pnpm(dbDir, ['exec', 'ncc', 'build', 'migrate.ts', '-o', path.join(out, 'db_migrations')]);
  fs.cpSync(path.join(dbDir, 'drizzle'), path.join(out, 'db_migrations', 'drizzle'), { recursive: true });

  step('building the web app (the slow part, several minutes)');
  pnpm(path.join(src, 'apps', 'web'), ['exec', 'next', 'build', '--experimental-build-mode', 'compile'], {
    NODE_ENV: 'production',
    NODE_OPTIONS: '--max-old-space-size=4096',
  });

  step('building the background workers');
  const workersDir = path.join(src, 'apps', 'workers');
  pnpm(workersDir, ['--config.verify-deps-before-run=false', 'build'], { NODE_ENV: 'production' });
  pnpm(src, ['deploy', '--node-linker=isolated', '--legacy', '--filter', '@karakeep/workers', '--prod',
    '--store-dir', store, path.join(out, 'workers')], { NODE_ENV: 'production' });

  // ─── Runtime ────────────────────────────────────────────────────────────────

  step('assembling the runtime in ./karakeep');
  fs.rmSync(runtime, { recursive: true, force: true });
  fs.mkdirSync(runtime);
  const web = path.join(src, 'apps', 'web');
  // The same layout as upstream's image: Next.js's standalone output at the top (it contains
  // apps/web/server.js), the web app's static files beside it, then the migrations and workers.
  copy(path.join(web, '.next', 'standalone'), runtime);
  copy(path.join(web, 'public'), path.join(runtime, 'apps', 'web', 'public'));
  copy(path.join(web, '.next', 'static'), path.join(runtime, 'apps', 'web', '.next', 'static'));
  copy(path.join(out, 'db_migrations'), path.join(runtime, 'db_migrations'));
  copy(path.join(out, 'workers'), path.join(runtime, 'apps', 'workers'));
  fs.writeFileSync(path.join(runtime, 'VERSION'), `${version}\n`);

  // ─── Meilisearch ────────────────────────────────────────────────────────────

  step(`fetching Meilisearch ${meili.version}, the search engine Karakeep uses`);
  const meiliBin = path.join(runtime, 'meilisearch');
  await download(`https://github.com/meilisearch/meilisearch/releases/download/v${meili.version}/meilisearch-linux-amd64`, meiliBin);
  const actual = sha256(meiliBin);
  if (actual !== meili.sha256) {
    fail(`meilisearch-linux-amd64 has SHA-256 ${actual}, but package.json pins ${meili.sha256}. Refusing to install it.`);
  }
  fs.chmodSync(meiliBin, 0o755);
  log(`meilisearch-linux-amd64 sha256 ${actual} (matches the pin)`);

  // Fail here rather than at runtime.
  for (const file of [
    path.join(runtime, 'apps', 'web', 'server.js'),
    path.join(runtime, 'apps', 'workers', 'dist', 'index.js'),
    path.join(runtime, 'db_migrations', 'index.js'),
  ]) {
    if (!fs.existsSync(file)) fail(`the build produced no ${path.relative(runtime, file)}.`);
  }
  const sqliteCheck = spawnSync(process.execPath, ['-e', "new (require('better-sqlite3'))(':memory:')"],
    { cwd: path.join(runtime, 'apps', 'workers'), env, encoding: 'utf8' });
  if (sqliteCheck.status !== 0) fail(`the SQLite driver does not load:\n${sqliteCheck.stderr}`);
  const meiliCheck = spawnSync(meiliBin, ['--version'], { encoding: 'utf8' });
  if (meiliCheck.status !== 0) fail(`Meilisearch does not run here:\n${meiliCheck.stderr}`);
  log(meiliCheck.stdout.trim());

  fs.rmSync(work, { recursive: true, force: true });
  step(`done: Karakeep ${version} in ./karakeep (${megabytes(runtime)} MB), ${Math.round((Date.now() - started) / 1000)}s in total`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function step(message) {
  const s = Math.round((Date.now() - started) / 1000);
  console.log(`\n==> karakeep build [${s}s]: ${message}`);
}

function log(message) {
  console.log(`    ${message}`);
}

function fail(message) {
  console.error(`\nkarakeep build failed: ${message}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(cmd, args, { cwd = work, env: runEnv = env } = {}) {
  const result = spawnSync(cmd, args, { cwd, env: runEnv, stdio: 'inherit' });
  if (result.error) fail(`${cmd} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${path.basename(cmd)} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
}

// npm sets npm_execpath when it runs a script, so `npm run build` reuses the very npm that is
// running it. Run by hand, fall back to whatever npm is on the PATH.
function npm(args) {
  const cli = process.env.npm_execpath;
  if (cli && /npm-cli\.js$/.test(cli)) return run(process.execPath, [cli, ...args]);
  return run('npm', args);
}

async function download(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) fail(`${url} does not exist. Check the versions in package.json.`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (err) {
      if (attempt === 3) fail(`could not download ${url}: ${err.message}`);
      log(`download failed (${err.message}), retrying`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }
}

// verbatimSymlinks keeps relative links relative. Without it, fs.cpSync rewrites them to absolute
// paths into the scratch folder, which is deleted at the end of the build.
function copy(from, to) {
  if (!fs.existsSync(from)) fail(`the build did not produce ${path.relative(work, from)}`);
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

function megabytes(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else bytes += fs.lstatSync(p).size;
    }
  };
  walk(dir);
  return Math.round(bytes / 1048576);
}
