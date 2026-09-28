# scout/ - the scheduled vacancy intake

Turns configured RSS feeds into cards in the board's **Scraped** column, and tells Telegram about
each new one. It is the machine half of the intake: the operator's browser scrape is the other.

Read `CONSTITUTION.md` first (invariants 16, 17, 23, 25); this file is the layer-specific detail.

## Run it

```sh
python -m scout --dry-run     # fetch, parse, print what would be created, write nothing
python -m scout               # the CronJob's command (records `trigger: schedule`)
python -m scout --trigger startup   # what the deploy's startup hook Job runs
                              # (`charts/cv-tailoring-scout`, `post-install,post-upgrade`)
python -m scout --feeds "https://jobs.dou.ua/vacancies/feeds/?remote&category=Architect"
make scout-dry-run            # the dry run with DB_BACKEND/DATABASE_SSLMODE set
```

There is deliberately **no** root `scout.py`: a package and a module with the same name in one
directory collide, and `import scout` would quietly resolve to the package while the script ran a
different file. `python -m scout` is unambiguous (`__main__.py` -> `run.main`).

Exit codes are part of the contract: **0** = the run finished (including "nothing new"), **1** =
the run could not be trusted (no feed answered, the job store refused, or the owner account is
missing). A CronJob has to tell "every feed is down" from "a quiet week", so "no feed answered"
is never reported as an empty result.

## Files

| File | Owns |
|---|---|
| `dou.py` | DOU feed parsing - **pure**: title -> role/company/location/salary, the vacancy id from the link, description HTML -> text, `parse_feed` |
| `feeds.py` | The only network code: fetch each configured URL, tolerate a broken one |
| `store.py` | The board writes: board-scoped dedupe (`find_existing_ids`), then one `resumes` row per new vacancy with `status = 'submitted'` |
| `telegram.py` | One plain-text message per new vacancy (`build_message` is pure, `send` is the call) |
| `run.py` | Preflight, `collect`, `main` - the orchestration |
| `__main__.py` | `python -m scout` |

## Run ledger

Every run opens one row in `process_runs` (`utils/process_runs.py`) and closes it with its
counters - `feeds`, `feeds_ok`, `parsed`, `new_cards`, `created_cards`, `notified` - which is what
the board's **Processes** window shows. A dry run writes **no** row at all; a preflight failure or
"no feed answered" is recorded as `failed` like any other outcome; and a run whose pod died is
retired as `aborted` by the next run (`PROCESS_RUN_STALE_HOURS`). The ledger never decides whether
the intake runs - the CronJob slot, a hand-run (`--trigger manual`) or the deploy's startup hook
(`--trigger startup`) do - it only records what happened, and *which* of them it was: the column's
CHECK is `schedule | manual | startup` (`utils/db.py`), so a new trigger is a migration and a word
the CLI accepts, never a free-text value.

## What it does NOT do (on purpose)

- **No Gemini, ever.** Scoring was dropped with the n8n integration: the only LLM work left is the
  tailoring the operator asks for and the cover letter they ask for.
- **No queue message.** The scout creates cards and stops; the drag into Prepare publishes
  (`CONSTITUTION.md` invariant 23). That is why a run is free no matter how many vacancies it
  finds - and why there is no per-run limit (0 = everything; `SCOUT_MAX_PER_RUN` exists only to
  cap a runaway feed).
- **No `resumes.status` beyond `submitted`.** The worker owns every later transition.
- **No `vacancies.parse`.** That queue is still declared and unused; the scout parses in-process
  and does not need a hop through the broker (`CONSTITUTION.md` D12).
- **No notification for a browser scrape.** The extension answers in the page; only scheduled
  sources reach a phone.

## Feed contract (DOU)

```
<rss><channel><item>
  <title>Senior Full Stack .NET Engineer в Talmatic, $5000–6000, віддалено</title>
  <link>https://jobs.dou.ua/companies/talmatic/vacancies/374708/?utm_source=jobsrss</link>
  <description>… escaped HTML …</description>
  <pubDate>Thu, 17 Sep 2026 15:11:24 +0300</pubDate>
```

- The **vacancy id** is the number in the link path. It is the same id space the listing page
  uses, so a scouted vacancy and the same vacancy scraped in the browser are one card - with
  `source` (here `dou`) completing the identity (`resumes_job_key_idx`).
- The description is **escaped HTML inside XML**: one unescape happens in the XML parser, a second
  one is ours (`AT&amp;amp;T` is a real example), and the trailing "Відгукнутись на вакансію" link
  is site chrome, cut off.
- A title that does not match `… в <company>, <tail>` keeps its whole text as the role rather than
  dropping the vacancy; a location that states a salary has the salary split out.

## Configuration

| Variable | Default | Notes |
|---|---|---|
`SCOUT_FEEDS` | three DOU feeds (`.NET 5+`, `Engineering Manager`, `Architect`) | comma-separated |
`SCOUT_SOURCE` | `dou` | the slug every card gets; also what the browser scrape of the same site must send |
`SCOUT_USER_ID` | – | **required**: a provisioned `app_users.id` (`npm run user -- add`), or the drag's message would fork a second row |
`SCOUT_MAX_PER_RUN` | `0` (everything) | cap for a runaway feed |
`SCOUT_NOTIFY` | `telegram` | `none` keeps the cards but sends nothing |
`SCOUT_TELEGRAM_TOKEN` / `_CHAT_ID` | – | from the Secret, never from git |
`SCOUT_TIMEOUT_SECONDS` | `20` | per feed |
`PROCESS_RUN_STALE_HOURS` | `24` | when a `running` ledger row is retired as `aborted` |

## Testing this layer

`tests/test_scout.py` is hermetic: the feed is a fixture copied from the live one (escaped HTML,
double-escaped entities, the utm link, the apply tail), the store is the file backend, and
Telegram is never called. It pins the three things that would break silently:

1. parsing (id from the link, title split, plain-text description);
2. dedupe (`new_vacancies` returns nothing for a board that already has the vacancy, whatever its
   status);
3. **the scout queues nothing** - both queues stay empty after a run;
4. the run's ledger row (one per run, with the counters the Processes window shows, and none at
   all for a `--dry-run`).

## Don't

- Call Gemini, the broker, or `worker.py`/`cover.py` from here.
- Write a card directly with SQL: `store.create_cards` goes through `upsert_job` so the business
  key and the "someone else got there first" answer are the store's, not ours.
- Log the bot token: `telegram._redact` exists because urllib errors quote the URL.
- Replace "no feed answered" with an empty result.
