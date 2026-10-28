#!/usr/bin/env python3
"""Phase 1 — reconcile the operator's reconstructed spring-2026 figures against
the archived May-2026 LLM walk-forward trade logs (scripts/archive/2026-06-18/).

Reads only. Prints per-run: n, wins, PF, mean R (from the recorded r_multiple),
winners at full +3R TP, max drawdown of cumulative realized P&L (in $, as % of
the inferred per-trade risk capital, and as % of $100k), plus the in-sample /
held-out window dates. Reproduce: python3 review/scripts/spring_reconcile.py
"""
import glob, json, os, statistics as st

ARCH = "scripts/archive/2026-06-18"
RECON = {  # operator-supplied reconstruction, review/inputs/spring-report-reconstructed.md
    "in_sample": {"pf": 3.64, "mean_r": 1.04, "n": 25, "full_tp_winners": "11 of 14", "max_dd_pct": 1.50},
    "held_out": {"pf": 1.15, "mean_r": 0.09, "n": 14, "max_dd_pct": None},
}

def load(path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]

def stats(trades):
    pnl = [t["realized_pnl"] for t in trades]
    wins = [p for p in pnl if p > 0]; losses = [p for p in pnl if p < 0]
    pf = (sum(wins) / abs(sum(losses))) if losses else float("inf")
    rs = [t.get("r_multiple") for t in trades if t.get("r_multiple") is not None]
    full_tp = sum(1 for t in trades if t["realized_pnl"] > 0 and abs((t.get("r_multiple") or 0) - 3.0) < 1e-6)
    # drawdown on cumulative realized pnl, trades in exit order
    cum = 0.0; peak = 0.0; mdd = 0.0
    for t in sorted(trades, key=lambda x: x["exit_date"]):
        cum += t["realized_pnl"]; peak = max(peak, cum); mdd = max(mdd, peak - cum)
    # infer risk $ per trade from the |pnl|/|R| ratio
    risk_dollars = st.median([abs(t["realized_pnl"]) / abs(t["r_multiple"]) for t in trades if t.get("r_multiple")])
    return {
        "n": len(trades), "wins": len(wins), "wr_pct": 100 * len(wins) / len(trades) if trades else 0,
        "pf": pf, "mean_r": st.mean(rs) if rs else None, "sum_pnl": sum(pnl),
        "full_tp_winners": full_tp, "max_dd_usd": mdd, "risk_usd_per_trade": risk_dollars,
        "max_dd_pct_of_100k": 100 * mdd / 100_000,
        "max_dd_pct_if_1pct_risk": 100 * mdd / (risk_dollars * 100) if risk_dollars else None,
        "first_entry": min(t["entry_date"] for t in trades), "last_exit": max(t["exit_date"] for t in trades),
        "exit_reasons": {k: sum(1 for t in trades if t["exit_reason"] == k) for k in sorted({t["exit_reason"] for t in trades})},
    }

files = sorted(glob.glob(f"{ARCH}/llm-trader-wf-trades-anthropic-4h-6x40d-*2026-05-0[12]*.jsonl"))
print(f"{len(files)} May 1–2 4h 6x40d trade logs\n")
rows = []
for f in files:
    tr = load(f)
    if not tr: continue
    s = stats(tr); s["file"] = os.path.basename(f); rows.append(s)
    print(f"{s['file']}")
    print(f"  window {s['first_entry']} → {s['last_exit']}  n={s['n']} wins={s['wins']} ({s['wr_pct']:.1f}%)  PF={s['pf']:.2f}  meanR={s['mean_r']:+.3f}  "
          f"sumP&L=${s['sum_pnl']:,.0f}  fullTP={s['full_tp_winners']}/{s['wins']}  maxDD=${s['max_dd_usd']:,.0f} "
          f"(={s['max_dd_pct_of_100k']:.2f}% of $100k; ={s['max_dd_pct_if_1pct_risk']:.2f}% if risk/trade=1% of capital; risk/trade≈${s['risk_usd_per_trade']:,.0f})  exits={s['exit_reasons']}")
print("\n--- reconstructed figures (operator) ---")
print(json.dumps(RECON, indent=1))
json.dump(rows, open("review/results/spring-reconcile.json", "w"), indent=1)
