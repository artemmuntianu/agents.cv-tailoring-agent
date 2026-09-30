# scout/ - the scheduled vacancy intake

Turns configured RSS and Atom feeds into cards in the board's **Scraped** column, and tells Telegram
about each new one. It is the machine half of the intake: the operator's browser scrape is the other.

Read `CONSTITUTION.md` first (invariants 16, 17, 23, 25); this file is the layer-specific detail.

## Adding a feed

Everything here is built around one contract (`contracts.py`): **a source is a site, a feed is one
URL of it**, and the URL's *host* is what selects the parser and the card's `resumes.source` slug.
No module outside `parsers/` names a site, so adding one is local:

1. `scout/parsers/<site>.py` - copy the closest module and export
   `SOURCE = FeedSource(name="<slug>", hosts=("<host>",), parse_feed=parse_feed, label="<Label>")`.
   The slug has to be the one the browser scrape of that site sends
   (`extension/src/background.js::sourceForUrl`), or the two writers fork one vacancy into two
   cards (`resumes_job_key_idx`).
2. One URL in `SCOUT_FEEDS` (`config.py`, and the scout chart's `config.feeds`) - the host is
   enough; nothing maps URLs to parsers by hand.
3. A fixture plus the site's assertions in `tests/test_scout.py`, and its entry in that file's
   `FIXTURES` map.

The suite is the safety net: every discovered source must have a fixture, every configured feed URL
must be routable, and a duplicated slug or host fails at load. A half-added feed is therefore a red
build instead of a card filed under the wrong site - which is the one mistake nobody would ever
find again.

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
| `contracts.py` | The interface a feed source must satisfy: `FeedSource(name, hosts, parse_feed)` and the `Vacancy`/`ScopedVacancy` card shapes - the file that makes a new site a local change |
| `sources.py` | The registry: discovers `scout/parsers/*`, routes a feed URL to its site (`source_for_url`), refuses a duplicated slug or host (`validate`) |
| `parsers/` | One **pure** module per site, each exporting `SOURCE` (`dou.py`, `djinni.py`, `landingjobs.py`): the site's own id rule, title shape and text quirks |
| `html_text.py` | The escaped-HTML -> plain-text pass the parsers share - the double unescape and the `&nbsp;` normalisation live here once |
| `feeds.py` | The only network code: fetch each configured URL, tolerate a broken one |
| `policy.py` | What deserves a card at all: the feed's own date, the age cutoff (`SCOUT_MAX_AGE_DAYS`) and the counts of what it refused (`select`) - the operator's "no old vacancies" rule, in one place |
| `store.py` | The board writes: per-site, board-scoped dedupe (`find_existing_ids`), then one `resumes` row per new vacancy with `status = 'submitted'` |
| `telegram.py` | One plain-text message per new vacancy (`build_message` is pure, `send` is the call) |
| `run.py` | Preflight, `collect` (host routing + the site stamp), `main` - the orchestration |
| `__main__.py` | `python -m scout` |

## Run ledger

Every run opens one row in `process_runs` (`utils/process_runs.py`) and closes it with its
counters - `feeds`, `feeds_ok`, `parsed`, `sources`, `feeds_skipped`, `max_age_days`,
`stale_dropped`, `new_cards`, `created_cards`, `notified` - which is what
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
- **No site-specific code outside `scout/parsers/`.** Routing, the cards, the ledger, the messages
  and the tests are site-blind: a new board is a parser module plus a feed URL (see *Adding a
  feed*), never an edit to the flow.

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

## Feed contract (Djinni)

```
<rss><channel><item>
  <title>Lead Platform Engineer</title>
  <link>https://djinni.co/jobs/850592-lead-platform-engineer/</link>
  <description>… escaped HTML …</description>
  <pubDate>Tue, 15 Sep 2026 13:07:09 +0300</pubDate>
  <guid>https://djinni.co/jobs/850592-lead-platform-engineer/</guid>
  <category>.NET</category>
```

- The endpoint is the operator's **listing URL with `/jobs/rss/` instead of `/jobs/`**, so the
  search itself (keywords, salary, experience, employment, English level) is the feed. `search_type`
  and the repeated `primary_keyword`/`english_level` parameters are simply passed through;
  `english_level=pre` is not a Djinni value and is ignored rather than an error.
- The **id** is the number in the link path (`/jobs/850592-slug/`) - the same id space the
  extension's `job-item-<id>` cards use, so a scouted Djinni vacancy and the same vacancy scraped
  in the browser are one card, with `source` = `djinni` completing the identity.
- The title is the **role alone**: Djinni's company, salary and location live on the listing card,
  not in the feed, so those three fields stay empty instead of being guessed from the prose - and
  a title like `Team Lead (.NET + Angular)` is left whole for the same reason.
- The description is escaped HTML with entities double-escaped (`&amp;nbsp;`, `&amp;amp;`) and
  `<br>` tags, exactly like DOU's, so the shared `html_text.to_text` handles it; unlike DOU, the
  feed appends no "apply" chrome to cut.
- `link` and `guid` are the same job URL, and the guid is the fallback identity when a feed ever
  ships without a link.

## Feed contract (Landing.Jobs)

```
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>https://landing.jobs/at/damia/uphill-health-senior-platform-engineer</id>
    <published>2026-09-29T16:06:54Z</published>
    <link rel="alternate" href="https://landing.jobs/at/damia/…-engineer?utm_source=rss"/>
    <title>Uphill Health - Senior Platform Engineer</title>
    <content type="html"><![CDATA[ … the description as HTML … ]]></content>
    <author><name>Damia</name></author>
    <lj:city>Lisbon</lj:city><lj:salary/><lj:job_type>Permanent</lj:job_type>
```

- The endpoint is the site's **Atom** feed (`https://landing.jobs/feed`, advertised in its own markup
  as "Landing.Jobs » Offers feed"), and **one document carries every vacancy open on the board** -
  there is no per-keyword search to tune, which is exactly what the age rule below is for. Nothing
  else there is a feed: `/feed/rss`, `/rss`, `/rss.xml`, `/jobs.rss` are 404. `/api/v1/jobs` answers
  JSON, but `robots.txt` disallows `/api/` *and* its 50-item page ignores `page`/`per_page`, so the
  feed is both the sanctioned and the complete source (2026-09-30: 56 vacancies in the feed, all 50
  of the API's plus 6 newer ones).
- **The document is not well-formed.** Every entry ends in `<lj:city>`, `<lj:salary>`,
  `<lj:job_type>`, … whose `xmlns:lj` is declared nowhere, so a strict parser stops at the first one
  (`unbound prefix`) and the whole site would silently read as empty. `landingjobs.repair_prefixes`
  injects the missing declaration - only when it is absent - and the fixture keeps the site's own
  bug, so the workaround cannot rot unnoticed. This is why the parser looks elements up by local
  name rather than by a hardcoded namespace.
- The **id** is the vacancy's URL path (`/at/damia/…-engineer`), which is the `<id>` the site itself
  publishes: a Landing.Jobs page carries no number, so the path is the only usable identity.
- The **company is `<author><name>`**, not part of the title: only 3 of the 56 live titles carry a
  " - " marker and the rest are the role alone (`Analytics Engineer`, `Oracle DBA`), so nothing is
  split on a dash - a guessed split would misread 53 of them.
- `lj:salary` (an empty element when the posting states none), `lj:city` + `lj:country` - falling
  back to the nested `lj:location` block - fill the salary and location a card shows. `lj:job_type`,
  `lj:category`, `lj:remote_policy` and `lj:expires_at` are read by nobody on purpose: the card has
  no field for them and inventing one would only put the feed's taxonomy in a prompt.
- The description is HTML inside CDATA. It **keeps** the feed's own terms line ("At Damia (Permanent),
  in Lisbon, Portugal / Expires at: … / Remote policy: …") and loses only the logo `<img>`, which is
  a tag like any other: that line is the posting's terms and it grounds the tailoring prompt, unlike
  DOU's "apply" link.
- The **date is ISO-8601** (`2026-09-29T16:06:54Z`), not RFC-822: `policy.parse_feed_date` reads
  both, which is what stops a whole-board feed from becoming a dump of everything still open.
- The browser scrape has **no extractor for this site**: `extension/src/extract.js` is DOM-shaped per
  site (Djinni's `div[id^="job-item-"]`, DOU, Greenhouse) and knows nothing about a Landing.Jobs
  page, so the feed is currently the only way a Landing.Jobs vacancy reaches the board. Writing that
  extractor - with the same URL path as its id - is what would let the two writers share a card.

## The age rule (what is not scraped)

A feed is a window, not a stream: it keeps returning what it published weeks ago. A vacancy the feed
dated older than `SCOUT_MAX_AGE_DAYS` (14) is **not scraped at all** - no card, no dedupe check, no
Telegram message (`scout/policy.py`). Live evidence, 2026-09-28: of the 122 items the four feeds then
configured returned, **86 were older than the 7 days** in force at the time. 2026-09-30: of the 56
vacancies the Landing.Jobs feed carried - its whole open board - only **4 were inside 7 days** and 11
inside 14, which is what makes the rule load-bearing rather than a tidy-up.

- The age comes from the feed's own date in either standard form: RFC-822 (`<pubDate>`, the RSS
  boards) or ISO-8601 (`<published>`, the Atom one), both read by `policy.parse_feed_date`. RFC-822's
  offset is honoured, so a site's timezone cannot move a vacancy across the cutoff. Reading only
  RFC-822 would make every Atom card *undated*, i.e. exempt from the rule - a whole board of old
  postings would land on the board as new.
- A vacancy with **no usable date is kept** and counted (`undated`): the rule judges what a feed
  said, never what it omitted - a feed that stops publishing dates must not become a silent no-op.
- `0` disables the rule. The cutoff is `age > limit`, so a limit can never refuse everything a
  feed sends.
- Only the intake is affected: the browser scrape carries no publication date to judge, and the
  operator is looking at the page anyway.

## Configuration

| Variable | Default | Notes |
|---|---|---|
`SCOUT_FEEDS` | three DOU feeds (`.NET 5+`, `Engineering Manager`, `Architect`) + the Djinni search + the Landing.Jobs Atom feed | comma-separated; each URL's **host** picks the parser and the card's slug (`scout/sources.py`), so a new site is a new URL and nothing else |
`SCOUT_USER_ID` | – | **required**: a provisioned `app_users.id` (`npm run user -- add`), or the drag's message would fork a second row |
`SCOUT_MAX_PER_RUN` | `0` (everything) | cap for a runaway feed |
`SCOUT_MAX_AGE_DAYS` | `14` | a vacancy the feed itself dated older than this is not scraped (`0` disables the rule; a vacancy with no usable date is kept) |
`SCOUT_NOTIFY` | `telegram` | `none` keeps the cards but sends nothing |
`SCOUT_TELEGRAM_TOKEN` / `_CHAT_ID` | – | from the Secret, never from git |
`SCOUT_TIMEOUT_SECONDS` | `20` | per feed |
`PROCESS_RUN_STALE_HOURS` | `24` | when a `running` ledger row is retired as `aborted` |

## Testing this layer

`tests/test_scout.py` is hermetic: the feeds are fixtures copied from the live ones (escaped HTML,
double-escaped entities, the utm link, the apply tail, Djinni's role-only title, and the Atom feed
whose `lj:` prefix is deliberately left unbound the way the site ships it), the store is the
file backend, and Telegram is never called. It pins what would break silently:

1. per-site parsing (the id from the link, DOU's title split, the plain-text description with both
   entity layers gone - for both sites);
2. the **registry contract**, which is what makes "add a feed" safe: every discovered source has a
   fixture, every default `SCOUT_FEEDS` URL is routable, each slug is one the DB accepts
   (`resumes_source_shape`), and a duplicated slug or host is refused - a half-added site fails the
   suite instead of the cluster;
3. the age rule (`policy.py`): the cutoff is `>` (exactly the limit is kept), `0` disables it, a
   vacancy with no usable date is kept **and counted**, and the offset in a feed's date is honoured -
   the fixtures date themselves relative to *now*, because a hardcoded date would rot under this rule;
4. routing (`collect` stamps the parser's slug; the same number from two sites stays two cards; a
   feed no parser owns is skipped);
5. dedupe (`new_vacancies` returns nothing for a board that already has the vacancy, whatever its
   status - and another site's board never hides this one's card);
6. **the scout queues nothing** - both queues stay empty after a run;
7. the run's ledger row (one per run, with the counters the Processes window shows, and none at
   all for a `--dry-run`).

## Don't

- Call Gemini, the broker, or `worker.py`/`cover.py` from here.
- Add a site anywhere but `scout/parsers/`: the registry is the only place a URL is recognised
  (`scout/sources.py::source_for_url`), and preflight refuses a feed it cannot route - a `if "dou"
  in url` branch in the flow is exactly the coupling the registry exists to remove.
- Write a card directly with SQL: `store.create_cards` goes through `upsert_job` so the business
  key and the "someone else got there first" answer are the store's, not ours.
- Log the bot token: `telegram._redact` exists because urllib errors quote the URL.
- Replace "no feed answered" with an empty result.
