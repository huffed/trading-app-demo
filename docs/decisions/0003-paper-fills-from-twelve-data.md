# 0003 — Paper fills come from Twelve Data quotes, not from the OANDA bar feed

**Date:** 2026-10-30 (`retro`: the choice predates the decisions log; the exact date and author of the original change are not recorded) · **Status:** active, under review by the audit · **Phase:** C (logged as found).

## Decision

The paper engine prices entries and the SL/TP checks from **Twelve Data live quotes** (`fetchBatchQuotes` in `src/lib/market-data/twelve-data.ts`), while signals are computed on **OANDA bars** (head of the price fallback chain, `src/lib/market-data/prices.ts`). When the quote call fails, including an HTTP 200 with an error body, the engine falls back to the bar close and fills there without flagging it.

## Why

**Reason not recorded.** No commit message, PR, roadmap entry or memory explains why fills use a different provider than signals. The most likely explanation from the code's history is that Twelve Data offered a cheap per-symbol quote endpoint when the paper engine was written, before OANDA was promoted to the head of the bar chain on 2026-05-12, and nothing revisited the split afterwards.

## Alternatives considered

Not recorded at the time. Options for Phase E (one engine, two adapters): price fills from the same provider as the signal bars; or keep a dedicated quote provider but fail closed when it fails, and record `price_source` on every position.

## Consequences

- Two providers, two clocks and two symbol maps sit between a signal and its fill; the backtester uses neither (it fills at bar close plus slippage), which is part of the live-versus-backtest parity gap in DEBT D-02.
- A silent fallback to the bar close on quote failure is audit finding F1 and DEBT D-04 (Critical, fail-open).
- This entry records the fact so the audit and Phase E can decide with it in view; it changes nothing.

## Evidence

`docs/STACK.md` §6 (Twelve Data row); `docs/CODE_QUALITY.md` §3.1 F1-7 and §3.2 (fill rules); `src/lib/market-data/twelve-data.ts:97-109`; audit `review/01-audit.md` finding F1.
