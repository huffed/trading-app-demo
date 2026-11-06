# OANDA and Finnhub failures on the VPS: read-only trace, 2026-11-06

Measured for the audit's fill findings. Nothing was changed. Sources: `journalctl -u quanttrader` (the journal starts 2026-08-27 17:01Z), `/var/log/quanttrader/oanda-positioning.log`, the `scan` cron log, the code on `dev`, and two read-only queries on the database. The app writes everything to the journal at info priority, so `journalctl -p err` returns nothing and proves nothing; these counts come from the message text.

## 1. Two OANDA calls fail with the same 401

Both use `OANDA_API_KEY` against `api-fxpractice.oanda.com` and both get `401 {"errorMessage":"Insufficient authorization to perform request."}`.

| Call | Code | Used by |
|---|---|---|
| `GET /v3/instruments/XAU_USD/candles` | `fetchDailyPrices`, `src/lib/market-data/oanda.ts:105-122`, called first by `fetchWithFallback`, `prices.ts:136-146` | the bars behind scan and manage |
| `GET /v3/instruments/XAU_USD/positionBook` | `src/lib/market-data/oanda-positioning.ts:82-89` | the 20-minute snapshot job only; nothing on the scan path reads `oanda_positioning_cache` |

Candles, failures per period (5xx are HTML gateway pages: 247 × 504, 1 × 502 all time):

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
2. `savePricesToCache` filters that payload before merging. Since 2 Nov there are 181 `DQ.4` lines for 4h bars, every one with `incoming=5000` and 1,965 or 1,966 `off-grid` bars dropped; 173 of the 181 sit within six journal lines of an OANDA failure.
3. The refresh path hands the caller the unfiltered list: `const fresh = await fetchDailyPrices(…); savePricesToCache(…); return fresh;` (`prices.ts:124-127`). The filter protects the cache, not that tick's evaluation.

So on a tick whose OANDA call failed, the evaluation appears to run on Twelve Data 4h bars, about 40% of which the cache would reject as off-grid. This is read from the code, not observed: which bars a given scan used is not logged. The cron layer shows nothing: all 532 scan ticks since 2 Nov answered 200 with no `"error"` in the body, and the failures appear only as journal warnings.

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

The first 403 is 2026-08-27 17:15Z, 14 minutes into the journal. Successes log nothing, but the count itself answers that: 480 a day is 20 an hour, or 5 algorithms × 4 scans, one call per evaluation. A success is cached for an hour (`docs/CODE_QUALITY.md` §3.1), so that rate means none succeeded. On a failure `fetchEconomicCalendar` returns `[]` (`economic-calendar.ts:138-139`), the veto finds no event and passes.

All five deployed algorithms have `rules.news_veto.enabled = true` (database, 2026-11-06: `min_impact` high, 15 minutes before, 30 after). The veto has therefore not been able to fire on the VPS at any point in this journal. Inferred: the Finnhub plan in use does not include `/calendar/economic`; the 403 body is not logged. Backtests pass no events to the veto (`docs/CODE_QUALITY.md` §3.2), so paper and backtest agree, but only because neither applies it.
