---
name: validate
description: Run the validation harness (`make validate`) and report the result. Use when asked to validate, re-validate or "run the validator" on the deployed algorithms. Currently a stub until the audit's scripts reach dev.
allowed-tools: Bash(make validate *)
---

Run exactly:

```bash
make validate
```

Report the output verbatim and the exit code.

**Today this target is a stub that exits 2** with the message that the validation harness lives on the audit branch `review/skeptical-audit-2026-10` and is wired to `make validate` when it lands on `dev` (`docs/DEBT.md` D-20; the Makefile target says so). Do not substitute another script: the pre-audit validator `scripts/canonical/validate-algo.ts` writes to the database when `PERSIST=1` and is not what the operator means by "validate" until the audit's verdict.

If the exit code is 0, the harness is wired: report its pass/fail lines per algorithm and the data sha it printed. If it fails for a reason other than the stub message, quote the failing lines and stop.
