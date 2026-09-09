<div align="center">
  <img src="public/logo.svg" alt="Siftly" width="80" height="80" />

  <h1>Siftly</h1>

  <p><strong>Local-first Twitter/X bookmark manager — AI organization, fact-checking, and Obsidian export, through your own NVIDIA NIM proxy.</strong></p>

  <p>Fork of <a href="https://github.com/viperrcrypto/Siftly">viperrcrypto/Siftly</a> · See <a href="soul.md">soul.md</a> for the manifesto</p>

  <p>
    <img src="https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js" alt="Next.js 16" />
    <img src="https://img.shields.io/badge/SQLite-local-green?style=flat-square&logo=sqlite" alt="SQLite" />
    <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" alt="MIT License" />
  </p>
</div>

---

## What is Siftly?

Siftly turns your Twitter/X bookmarks into a searchable, categorized, visual knowledge base that runs entirely on your machine. Import via the built-in bookmarklet, then a 4-stage AI pipeline (entity extraction → vision analysis → semantic tagging → categorization) enriches every bookmark. No cloud account, no telemetry — the only external calls are the AI endpoints you configure.

This fork adds three things on top of upstream:

| Addition | What it does |
|----------|--------------|
| **NIM proxy** | `nvidia-claude-proxy/` (sibling repo) speaks the Anthropic Messages API and forwards to NVIDIA NIM open-weights models — no Anthropic subscription, no vendor lock-in |
| **Fact-check** | `/api/factcheck` extracts verifiable claims from a tweet, checks them against live web results via Exa, and stores a verdict + keep-score per bookmark |
| **Obsidian export** | `POST /api/export/obsidian` writes your library into an Obsidian vault as linked Markdown — the seed of a personal Twitter-Graph |

## Prerequisites

- **Node.js 26.8.1** (npm 12 ships with it)
- **Python 3** with a venv at `nvidia-claude-proxy/venv/` (for the AI proxy)
- An **NVIDIA API key** (`nvapi-...`) from https://build.nvidia.com — free credits, no subscription
- An **Exa API key** (fact-check only; everything else works without it)

> **npm 12 quirk:** npm 12 blocks install scripts by default, which silently breaks `better-sqlite3`'s native build. The setup steps below handle this explicitly — do not skip the approval step.

## Setup

### 1. Siftly app

```bash
cd siftly
npm install --ignore-scripts
npm install-scripts approve better-sqlite3   # run the native build npm 12 skipped
npx prisma generate                          # generate the Prisma client
npx prisma db push                           # create prisma/dev.db (SQLite)
cp .env.example .env                         # then fill in keys (see Environment below)
npm run dev                                  # http://localhost:3000
```

### 2. NVIDIA NIM proxy

```bash
cd ../nvidia-claude-proxy
cp .env.example .env                         # set PROVIDER_API_KEY (+ UPSTREAM_URL)
./venv/bin/python main.py                    # listens on 127.0.0.1:8089
```

Point Siftly at the proxy in `siftly/.env`:

```env
ANTHROPIC_BASE_URL=http://localhost:8089
ANTHROPIC_API_KEY=<key the proxy expects>
```

The proxy translates Anthropic Messages API → OpenAI chat completions → NVIDIA NIM. Test it with the `curl -N http://127.0.0.1:8089/v1/messages` example in [`nvidia-claude-proxy/README.md`](../nvidia-claude-proxy/README.md).

### Environment variables

**`siftly/.env`:**

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | SQLite path (default `file:./prisma/dev.db`) |
| `ANTHROPIC_BASE_URL` | AI endpoint — `http://localhost:8089` for the NIM proxy |
| `ANTHROPIC_API_KEY` | Sent on AI requests |
| `EXA_API_KEY` | Exa search key — required for fact-checking only |
| `AI_MODEL` | NIM model for claim extraction / verdicts — see [`docs/nim-models.md`](docs/nim-models.md) (current: `nvidia/nemotron-3-super-120b-a12b`) |

**`nvidia-claude-proxy/.env`:**

| Variable | Purpose |
|----------|---------|
| `PROVIDER_API_KEY` | Your `nvapi-...` key, forwarded to NVIDIA as Bearer token |
| `UPSTREAM_URL` | `https://integrate.api.nvidia.com/v1/chat/completions` |
| `ADDR` | Listen host:port (default `127.0.0.1:8089`) |

Never commit `.env` files — both repos read secrets from them at runtime.

## Importing bookmarks

Built-in tool, no browser extensions:

1. Siftly → **Import** → drag the **"Export X Bookmarks"** bookmarklet to your bookmarks bar (or copy the console script)
2. Open [x.com/i/bookmarks](https://x.com/i/bookmarks), click the bookmarklet, hit **▶ Auto-scroll**
3. Upload the downloaded `bookmarks.json` back in Siftly

Re-import anytime — duplicates are skipped and the AI pipeline starts automatically on new items.

## Fact-checking

Pipeline per bookmark: **claim extraction** (LLM via NIM) → **evidence search** (Exa) → **verdict** (LLM) → persisted to SQLite.

```bash
# run a check
curl -X POST http://localhost:3000/api/factcheck \
  -H 'Content-Type: application/json' \
  -d '{"tweetId":"123...","tweetText":"...","authorHandle":"someone"}'

# read a stored result
curl 'http://localhost:3000/api/factcheck?tweetId=123...'
```

Stored on the `Bookmark` row:

| Field | Meaning |
|-------|---------|
| `verdict` | `TRUE` · `FALSE` · `MISLEADING` · `UNVERIFIABLE` |
| `confidence` | 0–100 |
| `ai_summary` | two-line explanation |
| `keep_score` | 0–10 — is this worth keeping in your graph? |

## Obsidian export

Set your vault path in **Settings** (stored as the `obsidianVaultPath` setting), then:

```bash
curl -X POST http://localhost:3000/api/export/obsidian \
  -H 'Content-Type: application/json' \
  -d '{"category":"ai-resources","overwrite":true}'   # both fields optional
```

Vault layout produced:

```
<Vault>/Twitter Bookmarks/
├── <tweet note>.md        # frontmatter: tweet_id, author, author_name, date,
│                          #   source, categories, tags; body: text + ## Media + ## Source
└── _index/
    ├── _<Category>.md     # one index note per category, links to member notes
    └── @<handle>.md       # one index note per author
```

Each note carries `twitter/bookmark`, `author/…`, `category/…` tags plus its semantic tags — Obsidian's graph view renders the Twitter-Graph out of the box.

## Running at boot

From the project root (`Default Project/`):

```bash
./start-all.sh          # start proxy (:8089) + Siftly (:3000), no-op if already up
./start-all.sh status   # check
./start-all.sh stop     # stop both
```

For autostart at login/boot, systemd user units are installed and enabled (`~/.config/systemd/user/nvidia-claude-proxy.service` + `siftly.service`; user linger is on, so they start without an active session):

```bash
systemctl --user status siftly nvidia-claude-proxy
journalctl --user -u siftly -f          # logs
```

## API reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/bookmarks` | GET / DELETE | List, filter, paginate, delete |
| `/api/import` | POST | Upload `bookmarks.json` (dedup + auto-pipeline) |
| `/api/categorize` | POST / GET | Start 4-stage AI pipeline / SSE progress stream |
| `/api/factcheck` | POST / GET | Run fact-check / read stored verdict |
| `/api/categories` | GET / POST | Category CRUD |
| `/api/search/ai` | GET | FTS5 + semantic search |
| `/api/mindmap` | GET | Graph nodes + edges |
| `/api/export` | GET | `?type=csv\|json\|zip` |
| `/api/export/obsidian` | POST | Write vault notes + `_index/` notes |
| `/api/stats` | GET | Dashboard counts |
| `/api/settings` | GET / POST | API keys, model, vault path |

## Development

```bash
npm run dev                      # dev server on :3000
npx tsc --noEmit                 # type check
npx vitest run                   # tests
npx prisma studio                # database GUI
npx tsx cli/siftly.ts stats      # CLI access to the DB (run from project root)
npm run build && npm start       # production build
```

Schema changes: edit `prisma/schema.prisma`, then `npx prisma db push`. Default categories live in `lib/categorizer.ts` (`DEFAULT_CATEGORIES`) — their `description` field is passed verbatim to the AI.

## Tech stack

Next.js 16 (App Router) · TypeScript 5 · Prisma 7 + SQLite (FTS5) · Tailwind v4 · `@xyflow/react` mindmap · Anthropic SDK (against the NIM proxy) · FastAPI proxy (Python).

## Privacy

- Everything lives in one SQLite file on your machine; exports are plain Markdown
- External calls, and only the ones you configure: NVIDIA NIM (AI), Exa (fact-check evidence), x.com (media)
- No telemetry, no accounts, no tracking

## Credits

Upstream: [viperrcrypto/Siftly](https://github.com/viperrcrypto/Siftly) — import pipeline, categorizer, vision analysis, and mindmap are its work. MIT licensed.

---

<div align="center">
  <p>Local-first · Own your data · AI as librarian, not overlord</p>
</div>

