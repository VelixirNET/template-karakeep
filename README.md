# Karakeep

[![Deploy on velixir](https://velixir.net/img/deploy-on-velixir.svg)](https://velixir.net/new?template=karakeep)

Save links, notes and images in one place and find them again in seconds.
[Karakeep](https://karakeep.app) (formerly Hoarder) fetches the title, image and readable text of
every link you save, so you can search everything you have ever kept, not just titles. This
template runs it in the EU, keeps your library on a persistent volume, and starts locked to you.

[Deploy it on velixir](https://velixir.net/new?template=karakeep), open the deploy log for your
password, and save your first link.

## What you get

- **Karakeep 0.33.2**, built from the pinned upstream release: bookmarks, notes and images, lists
  and tags, highlights, RSS feeds, imports from Pocket, Omnivore, Linkwarden and browser bookmark
  files, and the REST API.
- **Full-text search** over everything you save, by Meilisearch running inside the app.
- **Optional AI tagging and summaries.** Add an OpenAI key, or the address of any OpenAI-compatible
  API, and new bookmarks are tagged (and, if you like, summarised) automatically.
- **Your phone and browser.** Karakeep's iOS and Android apps and its Chrome and Firefox extensions
  connect to your app's address.
- **Your library kept safe.** The template adds a persistent volume and keeps Karakeep's database,
  saved pages and images, and the search index there, so they survive restarts and redeploys.
  Snapshots are taken daily and can be restored from the app's Volume tab.
- **Nobody else can claim it.** On a fresh Karakeep the first person to sign up becomes the admin.
  Here the first start creates the admin account before the app goes public, prints the password
  once to the deploy log, and leaves sign-ups closed.

## Getting started

1. **Deploy it.** It takes a few minutes to build and about ten seconds to start.
2. **Find your password.** Open the app's log and find the box that begins
   **Karakeep is ready**. It holds the admin email (`admin@` your app's host) and a random password,
   printed once.
3. **Sign in** at your app's address, then change the email and password under **User Settings**.
4. **Save something**: paste a link, or install the browser extension or mobile app and point it at
   your app's address.

Sign-ups are closed. To add people, create their accounts in the **Admin Settings**, or set
`DISABLE_SIGNUPS=false` to let anyone with the address sign up.

| Variable | Required | What it does |
| --- | --- | --- |
| `OPENAI_API_KEY` | no | Turns on AI tagging. With `OPENAI_BASE_URL` it works with any OpenAI-compatible API; set `INFERENCE_TEXT_MODEL` and `INFERENCE_IMAGE_MODEL` to models your provider offers. |
| `INFERENCE_ENABLE_AUTO_SUMMARIZATION` | no | `true` to summarise new bookmarks as well as tag them. |
| `KARAKEEP_ADMIN_PASSWORD` | no | Sets the admin's password on every start (or picks the first one). The way back in if you lose it; remove it afterwards. |
| `KARAKEEP_ADMIN_EMAIL` | no | The admin's email, `admin@` your app's host unless you set it before the first start. Also the account `KARAKEEP_ADMIN_PASSWORD` applies to. |
| `DISABLE_SIGNUPS` | no | `false` to open sign-ups. Closed unless you set it. |
| `PUBLIC_URL` | no | Your own domain, for example `https://keep.example.com`, once you have added it to the app. Sign-in links and the apps use it. |

Karakeep's other settings are environment variables too; see its
[configuration page](https://docs.karakeep.app/configuration/environment-variables). The session
secret and the search engine's key are generated on the first start and kept on the volume, so
you never need to set them.

## Things to know

**Pages are read without a browser.** Karakeep normally drives a headless Chrome to fetch pages.
This template has none, so it reads them over plain HTTP, as upstream does when no browser is
configured. Titles, descriptions, images and readable text work for most articles and blogs, but
there are no page screenshots, and pages that only render with JavaScript come back thin. Full
page archives and video downloads (both off by default upstream) are not included either, and
uploaded PDFs are saved and searchable but get no preview image.

**It needs a paid plan with 1 GB of memory.** The web app, the background workers and the search
engine run side by side. In testing they used about 360 MB with 1 GB available. Volumes come with
paid plans, and on the Free plan the app would sleep and start over empty, so this template rules
Free out.

**Without a volume, everything resets.** If you untick the volume, Karakeep still runs, but
bookmarks, saved pages, the search index and the admin account start from scratch on every restart
and redeploy. The log says so on every start.

**Email.** Karakeep can send email over SMTP for verification and password resets, but velixir
apps cannot reach SMTP ports. Leave it off (the default): accounts work without it, and the admin
can reset passwords.

**Web-only network access.** The app reaches the internet on ports 80 and 443 only. Saving pages,
RSS feeds and AI providers over HTTPS work; a model server of your own must be reachable over HTTPS
on port 443.

**One replica.** Karakeep keeps its data in SQLite and files on the volume, so it runs as one copy.

**Health check:** `/api/health` answers 200 once Karakeep is up. While it starts, `/healthz` answers
200 and other pages show a short "starting" page.

## What this repo is

A thin wrapper, not a fork. `package.json` pins a Karakeep release, plus a Meilisearch release and
its SHA-256, and:

- `build-karakeep.js` runs during the build. It downloads the tagged source from GitHub and builds
  it the way upstream's Dockerfile does: the database migrations, the web app and the background
  workers. It then fetches Meilisearch's release binary (the version Karakeep's own
  `docker-compose.yml` runs) and refuses it unless its checksum matches. It all ends up in
  `./karakeep`.
- `start.js` is the process supervisor upstream's container gets from s6, translating what velixir
  provides:

| velixir provides | Karakeep gets |
| --- | --- |
| `PORT` | the web app on `0.0.0.0:$PORT`; Meilisearch on loopback only |
| `VELIXIR_VOLUME_PATH` | `DATA_DIR` and Meilisearch's data on the volume (or the container disk, with a warning) |
| `VELIXIR_APP_SLUG` / `PUBLIC_URL` | `NEXTAUTH_URL` |
| nothing | migrations before start, generated secrets kept on the volume, the admin created on loopback, sign-ups closed, every part stopped together |

To upgrade Karakeep, change `karakeep.version` in `package.json` and deploy. Read the
[release notes](https://github.com/karakeep-app/karakeep/releases) first, and take a volume snapshot
before you do. Keep Meilisearch on the version Karakeep's `docker-compose.yml` names; moving it to a
new version may need the search index rebuilt (Admin Settings has a button for that).

## Running it locally

```bash
npm run build
npm start
```

Then open http://localhost:3000 and sign in with the details printed in the terminal. The build
needs Node 22 on Linux x64 (Meilisearch is the Linux binary) and a few gigabytes of disk. Data goes
in `.karakeep-data/` in this folder.

## Upstream

Karakeep is open source under the AGPL-3.0, by Mohamed Bassem and contributors. If you change
Karakeep's own code and let other people use your instance, the AGPL asks you to offer them that
changed source. Meilisearch is MIT (the Community Edition used here). This wrapper is MIT.

- Docs: https://docs.karakeep.app
- Source: https://github.com/karakeep-app/karakeep
