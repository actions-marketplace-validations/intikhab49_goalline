#!/usr/bin/env bash
# A tiny repository whose one change moves a test's expectation (the code and its test edited
# together), for checking the GitHub Action end to end:  bash test/action-fixture.sh <dir>
# With a second argument, explained, the change also says why in .goalpost-acks.json.
set -euo pipefail
dir="$1"
mkdir -p "$dir/src" "$dir/test"
cd "$dir"
git init -q -b main
git config user.name fixture
git config user.email fixture@example.invalid
cat > src/add.mjs <<'JS'
export const add = (a, b) => a + b;
JS
cat > test/add.test.mjs <<'JS'
import { add } from '../src/add.mjs';
test('adds two numbers', () => {
  const got = add(2, 3);
  if (got !== 5) throw new Error(`Expected: 5\nReceived: ${got}`);
});
JS
git add -A
git commit -q -m base
git checkout -q -b moved
cat > src/add.mjs <<'JS'
export const add = (a, b) => a + b + 1;
JS
sed -i 's/5/6/g' test/add.test.mjs
if [ "${2:-}" = explained ]; then
  cat > .goalpost-acks.json <<'JSON'
[
  {
    "test": "test/add.test.mjs::adds two numbers",
    "why": "add now counts one more, as the task asks",
    "at": "2026-10-25T00:00:00.000Z"
  }
]
JSON
fi
git add -A
git commit -q -m "add one more"
