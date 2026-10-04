"""One module per site - the site profiles of the intake.

Each module is a **pure** feed parser (`feed body in, cards out`, no network, no database) and
exports exactly one `SOURCE = FeedSource(...)` naming the site's slug and hosts. `scout.sources`
discovers what is here, and the test suite refuses to leave the system in a half-added state: a
module without a fixture, or a configured feed URL no module claims, fails the build.

Adding a site, in full:

1. copy the closest existing module (they are deliberately small);
2. write `SOURCE` with the site's slug - the same one the browser scrape of that site sends, or the
   two writers would create two cards for one vacancy (`resumes_job_key_idx`);
3. add a fixture + the site's assertions to `apps/worker/tests/test_scout.py` and its entry to that file's
   `FIXTURES` map;
4. add one feed URL to `SCOUT_FEEDS` (and to the scout chart's `config.feeds`).

Nothing else in the layer names a site.
"""
