# Algorithms detail page — sectioned redesign plan

Status: **proposal** · Drafted 2026-04-29 · Review before implementation

## Why

The algorithm detail page accumulated features across the daily-review UI series (PRs #68-#74) without an IA refresh. Current layout:

```
Algorithm detail
├── FtmoComplianceCard           ← floats above tabs
├── ReadinessCheckCard            ← floats above tabs
└── Top-level tabs:
    ├── Overview                  ← rules display
    ├── Watchlist
    ├── Backtest
    ├── Paper Trading             ← 95% of action lives here
    │   ├── ScanControls
    │   ├── HealthHeader
    │   ├── OpenPositions         ← expandable cards w/ inner sub-tabs
    │   │                            (Stats / Conditions / Activity / Chart)
    │   ├── EquityCurve
    │   ├── ClosedPositions       ← same expansion
    │   ├── NearMissFeed
    │   └── RecentActivity
    └── StrategyStats
```

Pain points:
- Tabs nested in tabs (top-level → Paper Trading → per-position sub-tabs)
- 95% of actual usage in one tab; the others are setup/historical and rarely opened
- Floating compliance/readiness cards above tabs make the page feel top-heavy
- Discovery / readiness / scan controls scattered across sections
- Hard to scan for "is the system OK?" — that answer requires looking in three different places

## Goal

A single sectioned scroll page that matches the actual daily-review workflow:
1. **"Is the system OK?"** — answered in 3 seconds, top of page, always visible
2. **"What's happening today?"** — second section, primary daily focus
3. **"What's the historical performance?"** — third section, weekly/monthly review
4. **"What's the configuration?"** — last section, rare action

Each section is independently collapsible with state persisted to localStorage. Default-expanded states match the typical session.

## Anti-goals

- **Don't rebuild the per-position card.** PRs #68-#74 already built the right per-position UX (expandable cards with Stats/Conditions/Activity/Chart sub-tabs, near-miss feed, etc.). Keep all of that. The redesign is the **outer container**, not the inside.
- **Don't add a master-detail / TradingView-style chart-as-master layout.** Single-operator, single-screen, no need for power-user efficiency at the cost of mobile-friendliness.
- **Don't preserve the current tab URLs.** They're internal-only; no incoming links rely on them.

## Proposed structure

```
Algorithm detail page
├── Sticky header (always visible)
│   ├── Algo name
│   ├── Status badges: active/paused/draft, live/paper
│   ├── Quick action buttons: Pause/Resume, Edit, Close all positions
│   └── (Edit Mode toggle, replaces current pencil icon)
│
├── Section 1 — Status (always expanded, no collapse)
│   ├── Health row: open count · today P&L · last scan · alerts
│   ├── FTMO compliance summary (currently a separate card)
│   ├── Readiness check verdict (currently a separate card)
│   └── Scan Now button
│
├── Section 2 — Today (default expanded)
│   ├── Open positions (expandable detail cards)
│   ├── Closed today (default collapsed sub-section, last 24h)
│   └── Considered (near-miss feed — already shipped)
│
├── Section 3 — History (default collapsed)
│   ├── Equity curve
│   ├── Closed positions all-time (paginated)
│   ├── Strategy stats summary
│   └── Discovery panel
│
├── Section 4 — Setup (default collapsed)
│   ├── Rules display
│   ├── Watchlist
│   └── Backtest results + Run backtest button
│
└── Section 5 — Activity log (default collapsed)
    └── Algorithm-level events (scan_completed, halts, errors, etc.)
```

### Section 1 — Status (no collapse)

The "is it OK?" answer in one viewport. Replaces:
- Current `AlgorithmHealthHeader`
- Current `FtmoComplianceCard` (currently floating above tabs)
- Current `ReadinessCheckCard` (currently floating above tabs)
- Current `ScanControls` (currently inside Paper Trading)

Compresses into one card:

```
┌────────────────────────────────────────────────────────────────────┐
│ Status                                          [⏵ Scan now]       │
├────────────────────────────────────────────────────────────────────┤
│ ⏺ Active · Live  (FTMO MT5 demo · $100K)                            │
│ Open 6 · Closed today 4 · Today P&L +$XX (open +$X · closed -$Y)    │
│ Last scan 12 min ago · No halts active                              │
│                                                                     │
│ Compliance: ✓ DD 0.3% / 10% · ✓ daily-loss within limits            │
│ Readiness: caution — 5 trades since drift baseline                  │
└────────────────────────────────────────────────────────────────────┘
```

Why no collapse: this is the operator's first glance every session. Hiding it adds a click for zero benefit.

### Section 2 — Today (default expanded)

The daily-review primary surface. Order matters:
1. **Open positions** — what's live right now (expandable cards from PR #68)
2. **Closed today** — what just happened (last 24h, expandable cards)
3. **Considered** — what got rejected and why (near-miss feed from PR #73)

Drops the today/all-time merge in `ClosedPositionsCard` — closed-today goes here, all-time-closed moves to History section.

### Section 3 — History (default collapsed)

Weekly / monthly review surface. Performance data:
- Equity curve chart
- Closed positions (full list, paginated, beyond the last 24h)
- Strategy stats (current StrategyStatsTab content)
- Discovery panel (currently in Watchlist tab)

Why collapsed: review is weekly, not daily. The operator opens this when explicitly evaluating; it shouldn't compete with Today.

### Section 4 — Setup (default collapsed)

Configuration. Rare daily action. Combines current Overview + Watchlist + Backtest tabs:
- Rules display (read-only by default; "Edit" button in sticky header switches to edit view)
- Watchlist
- Backtest results panel + Run Backtest button

### Section 5 — Activity log (default collapsed)

Algorithm-level event stream. Currently `RecentActivity` at the bottom of Paper Trading — moved to its own section for prominence when investigating.

## State persistence

Per-algorithm localStorage keys:

| Key | Default | Purpose |
|---|---|---|
| `algo:{id}:section:today` | true | Today section expanded |
| `algo:{id}:section:history` | false | History section expanded |
| `algo:{id}:section:setup` | false | Setup section expanded |
| `algo:{id}:section:activity` | false | Activity log expanded |
| `algo:{id}:closed_today` | true | "Closed today" sub-section within Today |

Status section is always expanded — no key needed.

Existing per-position localStorage keys (from earlier PRs) stay unchanged — the inner card UX doesn't change.

## What to drop

Things in the current page that don't survive the redesign:
- **Floating `FtmoComplianceCard` and `ReadinessCheckCard`** above tabs — content folded into Status section
- **Top-level tab navigation** — replaced by sections
- **Duplicated Scan Now button locations** — single button in Status section
- **`PaperTradingTab`** wrapper — content unspools into Today + History
- **`OverviewTab`, `BacktestTab`, etc.** — content moves into Setup

The per-position `PositionDetailCard` and its inner Stats/Conditions/Activity/Chart sub-tabs **stay exactly as they are**. Same for `NearMissFeed`, `AlgoEquityCurveCard`, `WatchlistCard`, `RulesDisplay`, etc. — they're slotted into new section containers.

## Migration plan

**Single PR.** Tabbed layout is internal; no incoming URLs depend on `?tab=N` query params. Roll forward, roll back via revert if anything breaks.

Estimated diff:
- New: ~5 section container components + 1 page-level layout wrapper
- Modified: `(dashboard)/algorithms/[algoId]/page.tsx` — top-level structure changes
- Removed: `paper-trading-tab.tsx` (content unspooled), top-level Tabs wiring
- Untouched: every per-position component, near-miss feed, equity curve, rules display, watchlist, backtest cards

Net: ~600-800 lines, mostly composition. No new server actions, no new hooks.

## Open questions

1. **Sticky header on scroll?** Yes — the operator wants "is the system OK?" always answerable. Status section stays in flow, but the header bar with name/status/Scan-now action sticks.
2. **What about Edit mode?** Current page has a pencil icon that swaps to a giant edit form. Keep as a button in the sticky header that opens the edit form as either (a) inline replacement of Setup section content, or (b) a dialog. Recommend (a) — feels more like inline editing.
3. **How does the back-compat with `?tab=` query param work?** Since the tabs are gone, the param is ignored. No 404s, no redirects needed.
4. **Mobile considerations?** Each section is a card; on narrow viewports they stack at full width. Sticky header collapses to single-line essentials.
5. **Loading states?** Each section independently loads its data (already true with React Query). No global loading overlay needed.

## Open question for you

Worth confirming before I start coding:
- Sectioned-scroll structure as described above ✓ / wants tweaks?
- Default expansion states (Today=open, History=closed, Setup=closed, Activity=closed) right?
- Drop `?tab=` param entirely or preserve it as a redirect for muscle memory?
- Sticky header: minimal action bar, or richer status info pinned?

Once approved, implementation is one PR with the structure above.
