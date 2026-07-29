# Algo-search spec — the 2026-10 Gold-Maximization + Forex round (E2.30/E2.31)

**LOCKED 2026-07-29. IMMUTABLE.** Any change after this commit = a new dated spec file.
Executes at the 2026-10-01 quarterly cycle (H.5), or earlier only on explicit operator
word. Supersedes nothing: `algo-search.spec.md` (the 2026-06-23 round) remains the
immutable record of ITS round; this spec governs the NEXT selection event only.

Operator doctrine driving this round (2026-07-29, verbatim intent): *"maximise gold
before moving on — not stick with gold on one conservatively played edge"* + *"trading
everything that is solid and available is the key to winning."* This round therefore
searches BOTH the un-searched gold dimensions (E2.31) and the never-modern-searched
forex universe (E2.30) in ONE pre-registered pass.

## 1 — Framing + standing constraints

- Verdict-grade only: pinned sha-verified datasets, complete-fidelity harness
  (session-day D1 override, floating-ML, de-compounding, gap fills), all 7 fidelity
  gates ON. Live `price_cache` is never read by any selection step (E2.19.e).
- **Pin refresh precondition:** `fetch-pinned-history.ts` re-run for ALL 4 instruments
  × D/H4/H1/M30 immediately before the round; new sha stamps recorded. The gold tail
  since 2026-07-09/17 (~3 months) has never been read by any selection — it is the
  honest fresh-OOS window, REQUIRED for judging the newly-admitted WR 35–37 band.
- **Research/deployment split (E2.30):** this round produces VALIDATED CANDIDATES ONLY.
  Nothing deploys — not even paper — before M1 (G.8) PASS. Additions after M1 follow
  the evidence-clock rule (E2.24.g.v) + sibling-aware composition (2026-07-10 rule).
- Budget: $0 (deterministic, no LLM). Wall-clock estimate §6.

## 2 — Search space

### Layer A — cell enumeration

Axes (the first four are the existing enumerator; the last two are NEW — E2.31):

| Axis | Levels | Notes |
|---|---|---|
| Instrument | XAU/USD, EUR/USD, GBP/USD, USD/JPY | `ENABLE_FOREX_SEARCH=1` for this round |
| Timeframe | 30m, 1h, 4h | |
| Pattern | the 17 in `SEARCH_PATTERNS` (`src/lib/algo-search/enumerate.ts`) | spec/impl drift from the old spec's "16" is RECONCILED here: 17 is correct; the enumerator is the source of truth |
| Direction | long, short (per `supportsShort`) | shorts are first-class, symmetric |
| **daily_bias** | **{without, with-aligned}** | NEW AXIS — bias is no longer a fixture (E2.31 finding 1) nor an out-of-band augment. "with-aligned" = bullish for longs, bearish for shorts. This IS the pre-registered regime conditioning for shorts (E2.31.v) — no bear-window sub-corpus tests, ever. |
| **session** | **{all, london, newyork}** — 30m + 1h cells ONLY; 4h cells are always `all` | NEW AXIS — windows reuse the existing pre-registered constants in `gold-session-window.ts`: london = 06:00–10:00 UTC, newyork = 11:00–15:00 UTC (inclusive start, exclusive end). UTC-fixed; ±1h DST drift vs local sessions is an accepted, stated approximation. |

**Cell count (the Bonferroni denominator, stamped exactly at enumeration):**
per instrument: 4h = 32 base × 2 bias = 64; 30m = 30 × 2 × 3 = 180; 1h = 30 × 2 × 3 = 180
→ 424/instrument → **N = 1,696** across 4 instruments. The driver MUST print the
enumerated N at run start and abort if it differs from 1,696 (spec/impl drift guard).

Layer A geometry: existing per-pattern defaults (unchanged). Pattern-detector
lookbacks remain the Layer-A defaults — NOT swept (grid discipline); flagged as a
possible future axis only if this round's intraday results warrant a follow-up spec.

### Layer B — geometry sweep (survivors only)

96 variants per survivor, same shape as the 2026-06 round with ONE change:

| Axis | Levels |
|---|---|
| RR | 2, 2.5, 3, 5 |
| **SL lookback** | **TIME-RELATIVE (E2.31 finding 3): {12h, 24h, 48h}** → bars per TF: 4h {3, 6, 12} · 1h {12, 24, 48} · 30m {24, 48, 96}. (12-bar structure at 4h and all intraday values above 6 bars are NEWLY expressible.) |
| Risk/trade | 0.6%, 1.0% |
| regime_filter | on, off |
| adx_filter | on, off |

## 3 — Methodology (engine + statistical contract)

- Engine: `runPortfolioBacktest` with `dailyBarsOverride = pinnedSessionDaily(ticker)`
  (E2.19.b), all 7 fidelity gates ON, per-instrument friction from the catalog
  (forex frictions per B.1.8.a state at run time — if still catalog-default, that is
  DISCLOSED on every forex verdict).
- **Block bootstrap: B = 20,000 iterations** (raised from 10k). REASON (E2.25.g class):
  the p-floor 0.5/(B+1) must sit BELOW α/N = 0.05/1,696 ≈ 2.95e-5; B=20,000 gives
  floor ≈ 2.50e-5 < 2.95e-5. The driver MUST assert floor < α/N at startup and abort
  otherwise (the unpassable-by-construction guard, now spec-mandated).
- DSR family honesty (E2.25.g.3): `nTrials` = the CUMULATIVE ledger of all candidate
  tests ever run on this corpus family (prior rounds' cells + Layer-B variants + this
  round's N), computed by the driver from the artifacts ledger — never the
  name-family shortcut.
- OOS: rolling 12-month holdout at run date + the never-seen pin tail (§1).
- Per-window decomp + sample-size adequacy: unchanged from the 2026-06 spec.

## 4 — Pre-registered success criteria

### Per-candidate operator bar (v4 — this round)

1. n ≥ 30 (full corpus, post-gates)
2. **WR ≥ 35** (OPERATOR-LOCKED 2026-07-29, lowered from 37; `feedback_wr_floor_35`)
3. static DD ≤ 10%
4. daily DD ≤ 5%
5. total pnl > 0
6. Layer B fragility screen: |WR(r06) − WR(r10)| < 2.5pp (CHOCH lesson)
7. Bonferroni leg: block-bootstrap mean-R p ≤ 0.05/1,696 (strict tier — reported
   PASS/FAIL separately; not the sole gate, same two-tier structure as v3)

### Portfolio composition (across Layer-B winners + the 5 incumbents)

- |ρ| < 0.40 pairwise (MtM floating-equity deltas — the E2.24.f.v upgrade)
- Sibling-aware dollar-pool ML stress: worst-window floating ML within the operator
  band (≤ 8) at composed sizing; DL ≤ 5 with buffer
- **Blended account WR ≥ 35 (OPERATOR-LOCKED): pooled wins/trades across the WHOLE
  FTMO account — incumbents + additions together — must stay ≥ 35.** Current
  incumbent blend = 35.59% (0.6pp headroom); the composer enforces this as a hard
  reject, not a warning.
- Additions evaluated SIBLING-AWARE only (2026-07-10 rule; independent-union banned).

### Frontier-closure statements (pre-registered kill criteria)

- If an instrument×TF stratum produces 0 operator-bar passers across ALL its cells
  (both bias states, all sessions), that stratum is recorded CLOSED for deterministic
  patterns at retail data depth — no re-search of it before a genuinely new corpus
  epoch (≥ 2 quarterly refreshes) or a new pattern class.
- If bias-free intraday produces passers where biased intraday produced none, that is
  recorded as CONFIRMATION of E2.31 finding 1 (the fixture, not the market, was the
  constraint) — and the daily_bias-as-fixture practice is retired permanently.

## 5 — Selection procedure (deterministic)

1. Pin refresh + sha stamps + driver prints N and asserts N == 1,696 and
   p-floor < α/N.
2. Layer A full enumeration → per-candidate criteria 1–5 (+ 7 reported).
3. Layer B 96-grid on Layer-A passers → criteria 1–6 per variant; best-by-DSR per
   family with honest nTrials.
4. Composer over Layer-B winners + incumbents → §4 portfolio gates.
5. Acceptance packet with per-criterion blocker table (every cell's failure reason
   persisted — `/reports?tab=search` shape) → operator stamp → candidates WAIT for
   M1 PASS.

## 6 — Compute budget

~1,696 Layer-A backtests (30m corpus ≈ 144k bars × ~570 intraday-cells dominates) +
96 × (Layer-A passer count) Layer-B runs + B=20k bootstraps on passers only.
Estimate: 2–4 days wall-clock on the operator Mac, $0. If wall-clock exceeds 6 days,
the driver checkpoints per-stratum (resumable), never trims the universe silently.

## 7 — Machinery prerequisites (build BEFORE the round; E2.30 deliverable 2)

Buildable now without touching selection; each with tests:

- [ ] `session_filter: { start_hour_utc, end_hour_utc }` rule — types + Zod +
      backtest entry check (portfolio-backtest, beside the ATR gate) + live ladder
      step (beside the adaptive time_filter) + gate tests. (The old clock-window
      filter was deleted for being a hardcoded constant; this returns as a
      per-algo RULE, enumerated not assumed.)
- [ ] daily_bias axis in `enumerateLayerACandidates` (+ cell_key, cardinality, tests)
- [ ] session axis (30m/1h only) in the enumerator (+ tests)
- [ ] time-relative SL lookbacks in `layer-b-enumerate.ts` (per-TF bar mapping + tests)
- [ ] blended-WR gate in `portfolio-composer.ts` (wins/trades threaded through
      `CandidateInput`; pooled with incumbents; hard reject < 35) (+ tests)
- [ ] `BOOTSTRAP_ITERATIONS` 20k + startup floor-vs-α/N assert in the round driver
- [ ] cumulative-family DSR ledger computation in the driver
- [ ] driver N==1,696 assert + per-stratum checkpointing

## 8 — Out of scope for this round

Universe expansion beyond the 4 instruments (indices/oil/crypto — filed in E2.30 as
M2+, needs operator stamp + friction/data work); LLM-trader (E2.26 owns it);
pattern-detector lookback sweeps; any deployment decision.
