# soul.md — why Siftly exists

## The problem

Your Twitter/X bookmarks are a graveyard. You save the good stuff — the threading on a bug you'll hit next month, the chart that explains the market, the tool that would have saved you a week — and then X's own search fails you, the list scrolls into infinity, and the knowledge dies in a private tab you never reopen.

Bookmarks are not a to-do list. They are the outline of what you actually care about. Siftly treats them that way.

## Principles

**Local-first, always.** One SQLite file on your machine. No cloud account, no telemetry, no subscription. If Siftly disappeared tomorrow, you'd still have your data in formats that outlive any app: SQLite, Markdown, CSV.

**AI as librarian, not author.** The models read, tag, categorize, and summarize. They never invent. Fact-checking pulls *evidence* (Exa) and the model's job is to weigh it — verdict, confidence, and the sources are stored side by side so you can disagree with the machine and win.

**No vendor lock-in — including the AI.** This fork talks to NVIDIA NIM open-weights models through a small local proxy (`nvidia-claude-proxy`). The proxy speaks the Anthropic Messages API, so the model behind Siftly is a config line, not a rewrite. When a model goes end-of-life (it happens — three did while this was being built), you swap one env var.

**The graph is the point.** Every bookmark links to its author; every author links back; categories and tags cross-cut everything. Exported to Obsidian, the notes form a **Twitter-Graph** — a personal map of who you trust, what you're learning, and what's worth keeping (`keep_score` exists so the graph stays curated, not hoarded).

**Fact-check before you repeat.** The most dangerous bookmarks aren't the memes — they're the confident-sounding claims you quote at dinner. Siftly's pipeline extracts the verifiable claims, searches for evidence, and stamps each tweet TRUE / FALSE / MISLEADING / UNVERIFIABLE with a confidence score. Reading is a responsibility.

## What this is not

- Not a read-later app. There is no "inbox zero" here.
- Not a scraping tool. You export *your own* bookmarks, with X's own data.
- Not a hosted service. If you want to share it, share the repo, not the database.

---

*Local-first · Own your data · AI as librarian, not overlord*
