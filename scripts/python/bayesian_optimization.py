#!/usr/bin/env python3
"""H.9 Bayesian Optimization sidecar — stateless reinvocation pattern.

Reads JSON from stdin, returns next-suggested params + iteration state via
stdout. Caller persists eval_history between invocations.

Why stateless: keeps the TS driver in control of evaluation loop; lets us
checkpoint/resume; avoids long-running Python process state issues. Re-init
overhead per call is ~100ms — negligible vs ~5s/backtest.

Why scikit-optimize: standard library, GP surrogate + EI acquisition, handles
mixed Real/Integer dimensions (essential for Layer B's regime_filter/adx_filter
binary axes). Apache 2.0 licensed.

Stdin payload:
    {
      "dimensions": [
        {"type": "Real", "low": 1.5, "high": 5.0, "name": "rr_multiple"},
        {"type": "Real", "low": 3.0, "high": 12.0, "name": "sl_lookback"},
        {"type": "Real", "low": 0.3, "high": 1.2, "name": "risk_per_trade_pct"},
        {"type": "Integer", "low": 0, "high": 1, "name": "regime_filter"},
        {"type": "Integer", "low": 0, "high": 1, "name": "adx_filter"}
      ],
      "eval_history": [
        {"params": [3.0, 6, 0.6, 0, 0], "objective": 0.6325}
      ],
      "n_initial_points": 10,
      "acq_func": "EI",
      "random_seed": 42
    }

Stdout response:
    {
      "next_params": [3.5, 5, 0.8, 1, 0],
      "iteration": 1,
      "evals_so_far": 1
    }

Convention: caller MINIMIZES (multiply Sharpe by -1 before sending) OR the
"objective" field is what BO minimizes directly. We use the latter — caller
sends -Sharpe when maximizing.
"""
import json
import sys
from typing import Any

from skopt import Optimizer
from skopt.space import Integer, Real


def parse_dimension(d: dict[str, Any]) -> Any:
    """Convert JSON dimension spec to skopt dimension object."""
    dim_type = d.get("type", "Real")
    name = d.get("name")
    if dim_type == "Real":
        return Real(d["low"], d["high"], name=name)
    if dim_type == "Integer":
        return Integer(d["low"], d["high"], name=name)
    raise ValueError(f"unknown dimension type: {dim_type}")


def main() -> None:
    payload = json.loads(sys.stdin.read())
    dimensions = [parse_dimension(d) for d in payload["dimensions"]]
    history = payload.get("eval_history", [])
    n_initial = int(payload.get("n_initial_points", 10))
    acq_func = payload.get("acq_func", "EI")
    seed = int(payload.get("random_seed", 42))

    opt = Optimizer(
        dimensions=dimensions,
        n_initial_points=n_initial,
        acq_func=acq_func,
        random_state=seed,
    )

    # Replay history into the optimizer state
    for entry in history:
        # Optimizer.tell expects each x as either a list (single point)
        # or list-of-lists (batch). We pass single points.
        opt.tell(entry["params"], entry["objective"])

    next_params = opt.ask()

    # skopt returns numpy types; convert to native Python for JSON serialization
    next_params_native = []
    for v in next_params:
        if hasattr(v, "item"):
            next_params_native.append(v.item())
        else:
            next_params_native.append(v)

    response = {
        "next_params": next_params_native,
        "iteration": len(history),
        "evals_so_far": len(history),
        "is_initial_random_phase": len(history) < n_initial,
    }
    sys.stdout.write(json.dumps(response))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        # Surface errors to TS caller via stderr; exit 1 so caller detects failure
        sys.stderr.write(f"bayesian_optimization.py error: {e}\n")
        sys.exit(1)
