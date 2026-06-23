#!/usr/bin/env python3
"""
H.3 — Feature importance via xgboost. Python sidecar invoked by
scripts/canonical/feature-importance.ts.

Protocol:
  stdin  : JSON payload {
    "feature_names": [str, ...],
    "rows": [{"features": {name: float|null, ...}, "label": 0|1}, ...],
    "holdout_cutoff_idx": int  # first row index belonging to held-out (chronological split)
  }
  stdout : JSON payload {
    "auc_train": float,
    "auc_holdout": float,
    "n_train": int,
    "n_holdout": int,
    "feature_importance": [{"name": str, "gain": float}, ...],  # sorted desc by gain
    "label_balance_train": {"pos": int, "neg": int},
    "label_balance_holdout": {"pos": int, "neg": int}
  }
  exit 0 on success; non-zero with stderr message on failure.

The TS driver writes the stdin payload + parses stdout. Total RAM
footprint at ~14k bars × ~62 features = ~7MB on the wire; comfortable.

Why xgboost (per ROADMAP H.3): "mature ecosystem; TS port is risky."
Tree-based classifier handles missing values natively (sets the
"default direction" per split) — perfect for the H.2 null-on-
insufficient-lookback contract; no imputation needed.

Determinism: random_state=42 + n_jobs=1. Same data → same model →
same AUC + importances. Critical for H.5 quarterly research cycle
reproducibility.
"""
import json
import sys


def fail(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(1)


def main() -> None:
    try:
        import numpy as np
        import xgboost as xgb
        from sklearn.metrics import roc_auc_score
    except ImportError as e:
        fail(
            f"H.3 Python deps missing ({e.name}). "
            f"Install: pip install --user -r scripts/python/requirements.txt"
        )

    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        fail(f"Bad stdin JSON: {e}")

    feature_names = payload.get("feature_names")
    rows = payload.get("rows")
    holdout_cutoff_idx = payload.get("holdout_cutoff_idx")

    if not isinstance(feature_names, list) or not feature_names:
        fail("payload.feature_names must be non-empty list")
    if not isinstance(rows, list) or not rows:
        fail("payload.rows must be non-empty list")
    if not isinstance(holdout_cutoff_idx, int) or holdout_cutoff_idx <= 0 or holdout_cutoff_idx >= len(rows):
        fail(
            f"payload.holdout_cutoff_idx ({holdout_cutoff_idx}) must satisfy "
            f"0 < idx < n_rows ({len(rows)})"
        )

    # Build the design matrix. Nulls → np.nan (xgboost handles natively).
    n_rows = len(rows)
    n_feat = len(feature_names)
    X = np.full((n_rows, n_feat), np.nan, dtype=np.float64)
    y = np.empty(n_rows, dtype=np.int32)
    for i, row in enumerate(rows):
        feats = row.get("features", {})
        for j, name in enumerate(feature_names):
            v = feats.get(name)
            if v is None or not isinstance(v, (int, float)):
                continue  # leave as NaN
            if v != v:  # NaN check (JSON can't represent NaN; this is a safety net)
                continue
            X[i, j] = float(v)
        label = row.get("label")
        if label not in (0, 1):
            fail(f"row {i} has invalid label: {label!r} (must be 0 or 1)")
        y[i] = int(label)

    # Chronological train/holdout split.
    X_train, X_holdout = X[:holdout_cutoff_idx], X[holdout_cutoff_idx:]
    y_train, y_holdout = y[:holdout_cutoff_idx], y[holdout_cutoff_idx:]

    # Edge case: degenerate label distribution in either split → AUC
    # undefined. Report counts + abort with a clear message.
    if y_train.sum() == 0 or y_train.sum() == len(y_train):
        fail(f"train split has degenerate labels (all {y_train[0]}) — need both classes")
    if y_holdout.sum() == 0 or y_holdout.sum() == len(y_holdout):
        fail(f"holdout split has degenerate labels (all {y_holdout[0]}) — need both classes")

    # Train. Hyperparameters chosen for feature-importance signal quality
    # over peak AUC — modest depth, moderate trees, regularisation, no
    # subsample tricks. The output is operator-facing diagnostic, not a
    # production classifier.
    model = xgb.XGBClassifier(
        n_estimators=200,
        max_depth=4,
        learning_rate=0.05,
        reg_lambda=1.0,
        subsample=1.0,
        colsample_bytree=1.0,
        random_state=42,
        n_jobs=1,
        eval_metric="auc",
        # Suppress noisy "use device=cuda" warnings on Macs without GPU
        tree_method="hist",
        verbosity=0,
    )
    model.fit(X_train, y_train, verbose=False)

    # AUC on train + holdout
    y_train_pred = model.predict_proba(X_train)[:, 1]
    y_holdout_pred = model.predict_proba(X_holdout)[:, 1]
    auc_train = float(roc_auc_score(y_train, y_train_pred))
    auc_holdout = float(roc_auc_score(y_holdout, y_holdout_pred))

    # Feature importance — use "gain" (average information gain per split,
    # the canonical importance metric for tree models). Rank desc.
    booster = model.get_booster()
    gain_scores = booster.get_score(importance_type="gain")
    # xgboost reports keys as "f0", "f1", ... — map back to feature names.
    importance = []
    for j, name in enumerate(feature_names):
        key = f"f{j}"
        importance.append({"name": name, "gain": float(gain_scores.get(key, 0.0))})
    importance.sort(key=lambda r: r["gain"], reverse=True)

    out = {
        "auc_train": auc_train,
        "auc_holdout": auc_holdout,
        "n_train": int(len(y_train)),
        "n_holdout": int(len(y_holdout)),
        "feature_importance": importance,
        "label_balance_train": {
            "pos": int(y_train.sum()),
            "neg": int(len(y_train) - y_train.sum()),
        },
        "label_balance_holdout": {
            "pos": int(y_holdout.sum()),
            "neg": int(len(y_holdout) - y_holdout.sum()),
        },
    }
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
