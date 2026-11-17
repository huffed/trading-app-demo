# OANDA and Finnhub failures on the VPS: read-only trace, 2026-11-06

Measured for the audit's fill findings. Nothing was changed. Sources: `sudo -n journalctl -u quanttrader` (from 2026-08-27 17:01Z; without sudo, `ops` sees only entries since 2026-11-01T13:25Z, when D.2 moved the service to that user), `/var/log/quanttrader/oanda-positioning.log`, the `scan` cron log, the code on `dev`, and read-only queries on the database. The app writes everything to the journal at info priority, so `journalctl -p err` returns nothing and proves nothing; these counts come from the message text.

## 1. Two OANDA calls fail with the same 401

Both use `OANDA_API_KEY`, the candle call against `api-fxpractice.oanda.com` and the position book against that host by default (`OANDA_API_HOST`, whose value on the VPS was not checked), and both get `401 {"errorMessage":"Insufficient authorization to perform request."}`.

| Call | Code | Used by |
|---|---|---|
| `GET /v3/instruments/XAU_USD/candles` | `fetchDailyPrices`, `src/lib/market-data/oanda.ts:105-126`, called first by `fetchWithFallback`, `prices.ts:136-146` | the bars behind scan and manage |
| `GET /v3/instruments/XAU_USD/positionBook` | `src/lib/market-data/oanda-positioning.ts:82-89` | the 20-minute snapshot job only; from reading the code, nothing in the engine or market-data directories reads `oanda_positioning_cache` |

Candles, failures per period (`other` is mostly HTML gateway pages: 247 × 504 and 1 × 502 all time, plus 2 lines with no status):

| Period | 401 | other |
|---|---:|---:|
| 27–31 Aug | 61 | 5 |
| Sep | 610 | 76 |
| 1–9 Oct | 335 | 44 |
| 10–19 Oct | 125 | 22 |
| 20–29 Oct | 480 | 78 |
| 30–31 Oct | 34 | 5 |
| 1–6 Nov 13:00Z | 310 | 20 |

Candles since 2026-11-02, 315 failures by minute of the hour:

| :00 | :15 | :30 | :45 | :05 :10 :20 :25 :35 :40 :50 :55 |
|---:|---:|---:|---:|---:|
| 159 | 35 | 58 | 35 | 28 in total |

Per day: 71, 36, 52, 84, then 72 by 13:00Z on 6 Nov. Successful calls log nothing, so a failure rate per call cannot be computed from the journal.

Position book since 2026-10-20, 1,262 ticks: 1,175 OK, 85 × 401, 2 others. Longest run of consecutive 401s: 2. All time: 224 × 401 in 5,098 ticks, the first on 2026-08-28 05:00:01Z.

| Tick minute | 401 | ticks | rate |
|---|---:|---:|---:|
| :00, shares its minute with the scan | 73 | 421 | 17.3% |
| :20 | 6 | 420 | 1.4% |
| :40 | 6 | 421 | 1.4% |

By UTC hour there is no pattern. Inferred, not proven: the failures cluster where the most OANDA calls run at once, since the :00 tick overlaps the scan's own candle calls. The token works on the other ticks, so a bad or expired key does not explain it. §4's later reads argue against this: see the table of explanations there.

## 2. What the system does when a candle call fails

From reading the code, except the counts:

1. `fetchWithFallback` logs `[prices] OANDA failed` and asks Twelve Data, which returned 5,000 bars for the 4h request. Since 2 Nov Twelve Data itself failed 22 times with 429, and on 7 of those Yahoo then refused the 4h request. When the chain is exhausted the caller keeps the bars it had and the staleness gate decides (`prices.ts:124-133`).
2. `savePricesToCache` filters that payload before merging. Since 2 Nov there are 181 `DQ.4` lines for 4h bars, every one with `incoming=5000` and 1,965 or 1,966 `off-grid` bars dropped; a sampled line also shows `forming=1 weekend=658`, and the forming and weekend counts were not tallied. 173 of the 181 sit within six journal lines of an OANDA failure.
3. The refresh path hands the caller the unfiltered list: `const fresh = await fetchDailyPrices(…); savePricesToCache(…); return fresh;` (`prices.ts:124-127`). The filter protects the cache, not that tick's evaluation. On the one sampled line above that list held 2,624 rejected bars of 5,000 (52%), including the forming bar, so a partial bar can reach that evaluation. One line is a sample, not a rate.

So when an algorithm's OANDA call fails, that algorithm's evaluation appears to run on Twelve Data 4h bars, about 40% of which by count, across the whole payload rather than the evaluated tail, the cache would reject as off-grid. The refresh is per algorithm: `prices.ts:109-122` measures age from the bar open, so the last closed 4h bar is always past the threshold, each algorithm refreshes on every scan, and siblings in one tick can see different series. Exits see the same bars (`manage.ts:67`). This is read from the code, not observed: which bars a given scan used is not logged. From that reading there are about 5 × 436 = 2,180 scan-path 4h calls from 2 November to 6 November 13:00Z, so the 181 lines mean at most about 8% of evaluations. The cron layer shows nothing: all 532 scan ticks since 1 Nov answered 200 with no `"error"` in the body, and the failures appear only as journal warnings.

## 3. Finnhub: the calendar calls and the veto's record

`[economic-calendar] Finnhub returned 403`, per period (`other` is any other non-OK status):

| Period | 403 | other |
|---|---:|---:|
| 27–31 Aug | 1,084 | 52 |
| Sep | 7,865 | 8 |
| 1–9 Oct | 1,281 | 0 |
| 10–19 Oct | 1 | 0 |
| 20–29 Oct | 1,685 | 0 |
| 30–31 Oct | 541 | 0 |
| 1–6 Nov 13:00Z | 2,123 | 3 |

The first 403 is 2026-08-27 17:15Z, 14 minutes into the journal. Successes log nothing, so these counts alone cannot prove every call failed. Two things can be said:

- **In the full-rate hours from 30 October none succeeded.** 480 lines a day is 20 an hour, or 5 algorithms × 4 scans, one call per evaluation (read from the code: the veto runs before any condition check, `entry-deterministic-gates.ts:280`). A success is cached for an hour (`economic-calendar.ts:120-126,145`) and a failure is not, so a full rate means no success. November to the 6th has 102 hours at that rate and 6 partial; the partial hours are 34 lines short, more than one success would silence, so they are not settled.
- **Earlier periods run below that rate, unexplained.** Hours at the full rate: 56 in August, 354 in September, 138 in October, and 2 to 118 partial hours in each; from 22 September to 9 October and 20 to 28 October many days show 17 to 60 lines. A halt or an earlier gate would also cut the count, and so would a working calendar.

What settles it is the veto's own record. When it fires it writes `signal_no_action` with `reason: "News veto: …"` (`entry-deterministic-gates.ts:282-287`). In the database on 2026-11-06:

| Table | Rows | `signal_no_action` | Mentioning a news veto |
|---|---:|---:|---:|
| `activity_log`, 2026-06-11 to 2026-11-06 | 155,419 | 42,245 | **0** |
| `activity_log_archive`, 2026-04-28 to 2026-06-11 | 17,164 | not counted | 16 |

All five deployed algorithms have `rules.news_veto.enabled = true`, which is the key the gate reads (`entry-gates.ts:69`), with `min_impact` high, 15 minutes before, 30 after. On failure `fetchEconomicCalendar` returns `[]` (`economic-calendar.ts:138-139`), the veto finds no event and passes. The 16 archive rows are real firings on named events (for example `USD Non Farm Payrolls` on 2026-05-08), on four algorithms now archived, none of today's five, 13 of the rows from the LLM trader, and the last is 2026-06-10 12:30Z, so the endpoint returned events until at least that date. The archive ends at 2026-06-11 10:35:01Z and the live table starts at 10:40:01Z, one 5-minute tick later, so no window is missing and nothing has been logged since. Today's five algorithms were created between 2026-06-29 and 2026-07-20, so their whole lives sit inside that live table, which has no `News veto:` row. A rejected insert would be lost, because `logActivity` only logs the failure, but 42,245 rows of that event type landed. Cause unknown: the endpoint returned events in the spring and answers 403 on the VPS, so the key, the plan or Finnhub's terms changed; the 403 body is not logged, and no log covers 11 June to 27 August. Backtests pass no events to the veto (`options.events ?? []`, `portfolio-backtest.ts:1195`), so paper and backtest agree, but only because neither applies it.

## 4. Later reads: which endpoint, which hours, which token

Read on 2026-11-06 about 19:10Z and 2026-11-07 about 15:35Z, for the three questions the operator passed on with this file. Nothing was changed. Sources: `sudo -n journalctl -u quanttrader` from 2026-08-27 17:01Z, and `/var/log/quanttrader/oanda-positioning.log`, which records every tick. Counts run to the time of the read, so they are higher than §1's, which ended 13:00Z on 6 November.

**Which endpoint.** Both calls in §1 return the same 401 body, and the candle call fails on both granularities it requests. Each candle 401 to 15:35Z on 7 November, matched to the first `DQ.4` line within the next six journal lines: 1,066 were `4h` refreshes, 930 `1day`, and 59 had no `DQ.4` line that close. So it is not one endpoint or one granularity. Candle failures to 19:10Z on 6 November: 2,000 × 401, 247 × 504, 1 × 502. None of the `OANDA request failed:` lines lacks a status. §1 also counted 2 lines with no status, which this session did not identify; the totals here exclude them.

**Which hours.** Not by UTC hour, and until this week mostly on the `:00` minute.

Candle 401s to 19:10Z on 6 November, by UTC hour:

| 00 | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 | 10 | 11 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 87 | 77 | 70 | 99 | 67 | 70 | 75 | 119 | 92 | 95 | 107 | 87 |

| 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 113 | 87 | 90 | 70 | 70 | 81 | 74 | 80 | 81 | 71 | 61 | 77 |

The busiest hour has under twice the quietest (119 at 07Z, 61 at 22Z). By minute of the hour over the same span: `:00` 1,454 (73%), `:30` 356, `:45` 79, `:15` 60, every other minute 8 or fewer.

**This week the pattern changed.** Candle 401s by ISO week, to 15:35Z on 7 November:

| Week | W35 | W36 | W37 | W38 | W39 | W40 | W41 | W42 | W43 | W44 | W45 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| All | 33 | 155 | 118 | 84 | 169 | 204 | 256 | 92 | 247 | 302 | 395 |
| On `:00` | 26 | 102 | 80 | 72 | 132 | 158 | 207 | 79 | 211 | 231 | 164 |
| Off `:00` | 7 | 53 | 38 | 12 | 37 | 46 | 49 | 13 | 36 | 71 | 231 |

The counts rise over the period but not week on week: W37, W38 and W42 fall. W42 is the egress lockout, when, inferred from the lockout, the call volume fell; yet it has the highest position-book `:00` rate of any week (33/168, 19.6%). Through W44, 66% to 86% fell on `:00` each week. In W45, 2 to 7 November, only 42% did.

The position book shows the same change, with real rates:

| Week | W35 | W36 | W37 | W38 | W39 | W40 | W41 | W42 | W43 | W44 | W45 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `:00` ticks | 4/78 | 17/168 | 13/168 | 9/168 | 17/168 | 20/168 | 15/168 | 33/168 | 32/168 | 30/168 | 23/136 |
| `:20` and `:40` ticks | 0/158 | 0/336 | 0/336 | 0/336 | 0/336 | 0/336 | 1/336 | 0/336 | 0/336 | 0/335 | 17/271 |

One failure on a `:20` or `:40` tick in ten weeks, then 17 in W45. On the afternoon of 6 November alone: 13:20, 15:40, 16:00, 16:20, 17:00, 17:20 and 18:40Z, five of them off `:00`. That is why §1's position-book counts (73/421, 6/420 and 6/421) and the first §4 read's (75/428, 9/426 and 8/427) differ by more than six hours of ticks would suggest.

By weekday, candle 401s per day, over the days of each weekday from 2026-08-27 to 2026-11-07: Mon 31 (310 in 10 days), Tue 41 (414 in 10), Wed 43 (427 in 10), Thu 39 (431 in 11), Fri 34 (376 in 11), Sat 3 (37 in 11), Sun 6 (60 in 10). The crons run every day and the refresh has no market-hours check that this session found, so the weekend fall is not explained by the host's own load.

**Which token.** The workstation's `.env.local` and the host's `/opt/quanttrader/.env.local` hold the same `OANDA_API_KEY`. The operator compared the two on 2026-11-07 with a check that prints `same`, `different` or `missing`, and it printed `same`. No value was read by a session. A matching file does not prove what the running process holds. What rules out a wrong or revoked key is that the failures are intermittent: one service process makes both calls, and the position book succeeds on most ticks with that key.

**What could explain it, side by side. None is established.**

| Explanation | What it predicts | Against it |
|---|---|---|
| OANDA limiting this key (the operator's reading of the `:00` clustering, 2026-11-07) | Failures where this key's calls bunch, and fewer when calls fall | Recalled in review, not verified: OANDA's rate-limit answer is 429, not 401. From reading the crontab and the reconcile route, `:30` has the same host load as `:15` and `:45` but far more failures. W42 had the fewest candle calls and the highest position-book `:00` rate |
| OANDA-side load at the top and half of the hour, whatever the key | Failures at `:00`, then `:30`, few on weekends | Does not by itself explain W45's spread to other minutes |
| A second client using the same key | Failures when the other client is busy | The key is in the workstation's `.env.local`. Nothing in the app schedules a scan by itself, so the workstation's app calls OANDA only when something calls its routes, such as a `pnpm dev` with the workstation crontab installed (`scripts/README.md:283`); a script that reads the key itself, such as `scripts/canonical/fetch-pinned-history.ts`, calls OANDA's candles directly. Whether that ran this week is not known |

**Update, 2026-11-07 (operator):** `pnpm dev` has not run on the workstation this week and its crontab is not installed (`crontab -l` empty, no `/tmp/quanttrader-*.log`), so the workstation's app and crontab are out as the second client for this week's failures. A script that reads the key directly and any other machine holding it were not checked, so the explanation is narrowed, not excluded; the other two stay open for the audit.

Host contention cannot produce OANDA's 401 body by itself. Successful candle calls log nothing, so a per-call failure rate for candles still cannot be computed; the position book's rates are the only real ones.
