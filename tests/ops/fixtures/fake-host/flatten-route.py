"""Stands for /api/admin/flatten-algo: closes the algorithm's open rows, as src/lib/scan/flatten.ts does
whatever the broker answered, and answers with a canned body when a test wrote one. keep-open-<id> stands
for a paper update that did not land."""
import json
import os
import sys

host, algorithm = sys.argv[1:3]
with open(f"{host}/open.json", encoding="utf-8") as f:
    rows = json.load(f)
mine = [r for r in rows if r["algorithm_id"] == algorithm]
if not os.path.exists(f"{host}/keep-open-{algorithm}"):
    with open(f"{host}/open.json", "w", encoding="utf-8") as f:
        json.dump([r for r in rows if r["algorithm_id"] != algorithm], f)
canned = f"{host}/flatten-{algorithm}.json"
if os.path.exists(canned):
    with open(canned, encoding="utf-8") as f:
        print(f.read(), end="")
else:
    results = [{"ticker": "XAU/USD", "broker_position_id": None, "status": "paper-only"} for _ in mine]
    print(json.dumps({"flattened": len(results), "results": results}), end="")
