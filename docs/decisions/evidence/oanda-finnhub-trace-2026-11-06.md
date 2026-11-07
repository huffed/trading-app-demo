# OANDA and Finnhub failures on the VPS: read-only trace, 2026-11-06

Measured for the audit's fill findings. Nothing was changed. Sources: `journalctl -u quanttrader` (the journal starts 2026-08-27 17:01Z), `/var/log/quanttrader/oanda-positioning.log`, the `scan` cron log, the code on `dev`, and read-only queries on the database. The app writes everything to the journal at info priority, so `journalctl -p err` returns nothing and proves nothing; these counts come from the message text.

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

By UTC hour there is no pattern. Inferred, not proven: the failures cluster where the most OANDA calls run at once, since the :00 tick overlaps the scan's own candle calls. The token works on the other ticks, so a bad or expired key does not explain it.

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

## 4. Second read: which endpoint, which hours, which token

Read 2026-11-06 about 19:10Z, for the three questions the operator passed on with this file. Nothing was changed. Sources: `sudo -n journalctl -u quanttrader` from 2026-08-27 17:01Z, and `/var/log/quanttrader/oanda-positioning.log`. As `ops` without sudo the journal starts at 2026-11-01T13:25Z, when D.2 moved the service to that user, so read the history with sudo.

**Which endpoint.** Both calls in §1 return the same 401 body, and the candle call fails on both granularities it requests. Since 20 October the lines after a candle 401 are the `DQ.4` lines of 658 `1day` and 461 `4h` refreshes. So it is not one endpoint or one granularity. All candle failures to date: 2,000 × 401, 247 × 504, 1 × 502.

**Which hours.** Not by UTC hour, but by minute of the hour.

Candle 401s, all time, by UTC hour:

| 00 | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 | 10 | 11 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 87 | 77 | 70 | 99 | 67 | 70 | 75 | 119 | 92 | 95 | 107 | 87 |

| 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 113 | 87 | 90 | 70 | 70 | 81 | 74 | 80 | 81 | 71 | 61 | 77 |

The busiest hour has under twice the quietest. By minute of the hour, all time: `:00` 1,454 (73%), `:30` 356, `:45` 79, `:15` 60, every other minute 8 or fewer. By second of the minute since 2 November: 127 in 00–09, 107 in 10–19, 63 in 20–29, 29 in 30–39, 12 in 40–49, 2 in 50–59. In a minute with any candle 401 since 2 November, 99 minutes had one, 44 had two and 39 had three to seven.

Position-book ticks since 20 October, 401s out of ticks. This log records every tick, so these are real rates:

| Tick | 00–06Z | 07–12Z | 13–20Z | 21–23Z |
|---|---:|---:|---:|---:|
| `:00` | 26/126 (20.6%) | 22/108 (20.4%) | 23/143 (16.1%) | 4/51 (7.8%) |
| `:20` | 2/126 (1.6%) | 2/108 (1.9%) | 4/141 (2.8%) | 1/51 (2.0%) |
| `:40` | 2/126 (1.6%) | 3/108 (2.8%) | 3/142 (2.1%) | 0/51 (0%) |

By weekday, candle 401s per day: Mon 31, Tue 41, Wed 47, Thu 43, Fri 35, Sat 2, Sun 7. They are rising. By ISO week, W35 to W45, the last ending 19:00Z on Friday: 33, 155, 118, 84, 169, 204, 256, 92, 247, 302, 340. This session did not establish why.

**Which token.** The same on both machines. The operator compared the two copies on 2026-11-07 with a check that prints `same`, `different` or `missing`, and it printed `same`. No value was read by a session. So D-31 is not a token mismatch, which fits the counts: one service process with one `OANDA_API_KEY` succeeds on about 80% to 100% of position-book ticks.

**The operator's reading (2026-11-07):** the clustering on the `:00` minute points at rate limiting or contention at the top of the hour.

Inferred, not proven, and consistent with that reading: the failures follow how many OANDA calls run at once, since they sit in the first seconds of the ticks that overlap the scan. Whether OANDA is limiting this key or the host is contending with itself is not established. Successful candle calls log nothing, so a candle failure rate per call still cannot be computed.
