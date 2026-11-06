# OANDA and Finnhub failures on the VPS: read-only trace, 2026-11-06

Measured for the audit's fill findings. Nothing was changed. Sources: `journalctl -u quanttrader` (the journal starts 2026-08-27 17:01Z), `/var/log/quanttrader/oanda-positioning.log`, the `scan` cron log, the code on `dev`, and two read-only queries on the database. The app writes everything to the journal at info priority, so `journalctl -p err` returns nothing and proves nothing; these counts come from the message text.

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
3. The refresh path hands the caller the unfiltered list: `const fresh = await fetchDailyPrices(…); savePricesToCache(…); return fresh;` (`prices.ts:124-127`). The filter protects the cache, not that tick's evaluation.

So when an algorithm's OANDA call fails, that algorithm's evaluation appears to run on Twelve Data 4h bars, about 40% of which by count, across the whole payload rather than the evaluated tail, the cache would reject as off-grid. The refresh is per algorithm: `prices.ts:109-122` measures age from the bar open, so the last closed 4h bar is always past the threshold, each algorithm refreshes on every scan, and siblings in one tick can see different series. Exits see the same bars (`manage.ts:67`). This is read from the code, not observed: which bars a given scan used is not logged. From that reading there are about 5 × 436 = 2,180 scan-path 4h calls from 2 November to 6 November 13:00Z, so the 181 lines mean at most about 8% of evaluations. The cron layer shows nothing: all 532 scan ticks since 1 Nov answered 200 with no `"error"` in the body, and the failures appear only as journal warnings.

## 3. Finnhub: every economic-calendar call fails

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

- **From 30 October to 6 November none succeeded.** 480 lines a day is 20 an hour, or 5 algorithms × 4 scans, one call per evaluation (read from the code: the veto runs before any condition check, `entry-deterministic-gates.ts:280`). A success is cached for an hour (`economic-calendar.ts:120-126,145`) and a failure is not, so a full rate means no success.
- **Earlier periods run below that rate, unexplained.** Hours at the full rate: 56 in August, 354 in September, 138 in October, and 2 to 118 partial hours in each; from 22 September to 9 October and 20 to 28 October many days show 17 to 60 lines. A halt or an earlier gate would also cut the count, and so would a working calendar.

What settles it is the veto's own record. When it fires it writes `signal_no_action` with `reason: "News veto: …"` (`entry-deterministic-gates.ts:282-287`). In the database on 2026-11-06:

| Table | Rows | `signal_no_action` | Mentioning a news veto |
|---|---:|---:|---:|
| `activity_log`, 2026-06-11 to 2026-11-06 | 155,419 | 42,245 | **0** |
| `activity_log_archive`, 2026-04-28 to 2026-06-11 | 17,164 | not counted | 16 |

All five deployed algorithms have `rules.news_veto.enabled = true`, which is the key the gate reads (`entry-gates.ts:69`), with `min_impact` high, 15 minutes before, 30 after. On failure `fetchEconomicCalendar` returns `[]` (`economic-calendar.ts:138-139`), the veto finds no event and passes. So the veto worked in the spring and has not fired once since 11 June. Inferred: the Finnhub plan in use does not include `/calendar/economic`; the 403 body is not logged. Backtests pass no events to the veto (`options.events ?? []`, `portfolio-backtest.ts:1195`), so paper and backtest agree, but only because neither applies it.
