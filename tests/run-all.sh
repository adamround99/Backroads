#!/bin/sh
# Every harness, in one go. No dependencies beyond Node.
cd "$(dirname "$0")/.."
for f in tests/*.js; do
  echo "──────── $f"
  node "$f" || echo "  ^ FAILED"
done
