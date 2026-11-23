#!/usr/bin/env python3
"""Runs avail_block_lint.py on a file and prints the per-block result as JSON.

Used by src/__tests__/availBlockLint.test.ts to compare the TypeScript port
(src/avail/blockLint.ts) with this reference implementation, and to refresh the
committed snapshot:
  python3 tools/avail/lint_to_json.py tools/avail/fixtures/engineer-blocks.json \
    > tools/avail/fixtures/engineer-blocks.expected.json
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from avail_block_lint import devices, lint_device  # noqa: E402

doc = json.load(open(sys.argv[1], encoding="utf-8"))
out = []
for d in devices(doc):
    lv, E, W = lint_device(d)
    out.append({"label": d.get("label", "?"), "level": lv, "errors": E, "warnings": W})
print(json.dumps(out, ensure_ascii=False, indent=2))
