#!/usr/bin/env python3
"""Phase 1.7 — data quality of the pinned corpora and the 2026-10-28 refresh.
Checks: sha256 of bars vs manifest, bar count/range, duplicate timestamps,
monotonicity, spacing distribution (gaps), weekend bars, UTC hour-of-day grid
(NY-session alignment → DST phase shifts), and OHLC agreement between the
canonical pins and the refresh on their overlap. Read-only.
Reproduce: python3 review/scripts/data_quality.py
"""
import json, hashlib, collections, datetime as dt

FILES = {
  "canonical H4": "scripts/canonical/data/xau-usd-h4-pinned.json",
  "canonical D":  "scripts/canonical/data/xau-usd-d-pinned.json",
  "canonical H1": "scripts/canonical/data/xau-usd-h1-pinned.json",
  "refresh H4":   "review/data/xau-usd-h4-pinned-2026-10-28.json",
  "refresh D":    "review/data/xau-usd-d-pinned-2026-10-28.json",
  "refresh H1":   "review/data/xau-usd-h1-pinned-2026-10-28.json",
}
EXPECTED_MIN = {"H4": 240, "D": 1440, "H1": 60}

def load(p):
    with open(p) as f: raw = json.load(f)
    bars = raw["bars"]
    sha = hashlib.sha256(json.dumps(bars, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    return raw["manifest"], bars, sha

def parse(d): return dt.datetime.fromisoformat(d.replace("Z", "+00:00"))

out = {}
for label, path in FILES.items():
    man, bars, sha = load(path)
    gran = label.split()[-1]
    dates = [parse(b["date"]) for b in bars]
    dup = len(dates) - len(set(dates))
    mono = all(dates[i] < dates[i+1] for i in range(len(dates)-1))
    spacing = collections.Counter()
    for a, b in zip(dates, dates[1:]):
        spacing[int((b - a).total_seconds() // 60)] += 1
    exp = EXPECTED_MIN[gran]
    weekend = sum(1 for d in dates if d.weekday() == 5 or (d.weekday() == 6 and d.hour < 20))
    hours = collections.Counter(d.hour for d in dates)
    # phase transitions for H4: NY-17:00 alignment → 21:00 UTC start in summer, 22:00 in winter
    phase_changes = []
    if gran == "H4":
        prev_phase = None
        for d in dates:
            ph = d.hour % 4
            if prev_phase is not None and ph != prev_phase: phase_changes.append((d.isoformat(), prev_phase, ph))
            prev_phase = ph
    bad_ohlc = sum(1 for b in bars if not (b["low"] <= min(b["open"], b["close"]) <= max(b["open"], b["close"]) <= b["high"]))
    zero_vol = sum(1 for b in bars if (b.get("volume") or 0) == 0)
    top_spacing = sorted(spacing.items(), key=lambda kv: -kv[1])[:6]
    out[label] = {
        "bars": len(bars), "first": bars[0]["date"], "last": bars[-1]["date"], "manifest_bar_count": man["bar_count"],
        "sha_ok": sha == man["sha256"], "duplicates": dup, "monotonic": mono, "weekend_bars": weekend,
        "bad_ohlc": bad_ohlc, "zero_volume": zero_vol,
        "spacing_top": top_spacing, "gaps_gt_expected": sum(v for k, v in spacing.items() if k > exp),
        "max_gap_min": max(spacing), "hours_hist": dict(sorted(hours.items())),
        "phase_changes": phase_changes[:12], "n_phase_changes": len(phase_changes),
    }
    o = out[label]
    print(f"== {label}: {o['bars']} bars {o['first']} → {o['last']} | sha {'OK' if o['sha_ok'] else 'MISMATCH'} | dup={dup} mono={mono} weekend={weekend} badOHLC={bad_ohlc} zeroVol={zero_vol}")
    print(f"   spacing(min→count) top: {top_spacing}; gaps>expected: {o['gaps_gt_expected']}; max gap {max(spacing)} min")
    if gran == "H4":
        print(f"   UTC start-hour histogram: {o['hours_hist']}")
        print(f"   phase changes (DST): {len(phase_changes)} — first few: {phase_changes[:4]}")
    if gran == "D":
        print(f"   UTC start-hour histogram: {o['hours_hist']}")

# overlap agreement canonical vs refresh
def by_date(bars): return {b["date"]: b for b in bars}
for gran in ["H4", "D", "H1"]:
    _, c, _ = load(FILES[f"canonical {gran}"]); _, r, _ = load(FILES[f"refresh {gran}"])
    cd, rd = by_date(c), by_date(r)
    common = sorted(set(cd) & set(rd))
    diffs = [(d, max(abs(cd[d][k] - rd[d][k]) for k in ("open", "high", "low", "close"))) for d in common]
    mism = [(d, x) for d, x in diffs if x > 1e-6]
    only_c = sorted(set(cd) - set(rd)); only_r = sorted(set(rd) - set(cd))
    first_r = r[0]["date"]; last_c = c[-1]["date"]
    only_c_in_overlap = [d for d in only_c if d >= first_r]
    only_r_in_overlap = [d for d in only_r if d <= last_c]
    print(f"== overlap {gran}: common={len(common)} ({common[0] if common else '-'} → {common[-1] if common else '-'}) OHLC mismatches={len(mism)} max|Δ|={max([x for _, x in diffs], default=0):.5f}; "
          f"in canonical only (within overlap)={len(only_c_in_overlap)} {only_c_in_overlap[:3]}; in refresh only (within overlap)={len(only_r_in_overlap)} {only_r_in_overlap[:3]}")
    out[f"overlap {gran}"] = {"common": len(common), "mismatches": len(mism), "max_abs_diff": max([x for _, x in diffs], default=0),
                              "only_canonical_in_overlap": only_c_in_overlap[:20], "only_refresh_in_overlap": only_r_in_overlap[:20]}
json.dump(out, open("review/results/data-quality.json", "w"), indent=1, default=str)
