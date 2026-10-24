#!/usr/bin/env bash
# The goalline GitHub Action: goalpost (or prove-red) on the pull request, with the PR card added to
# the job summary. The inputs arrive as INPUT_* environment variables (see action.yml).
set -uo pipefail

repo="${INPUT_REPO:-$GITHUB_WORKSPACE}"
check="${INPUT_CHECK:-goalpost}"
case "$check" in
  goalpost | prove-red) ;;
  *) echo "::error::check must be goalpost or prove-red, not '$check'"; exit 64 ;;
esac

# The merge base needs the history and the base branch, which a default shallow checkout lacks.
if [ "$(git -C "$repo" rev-parse --is-shallow-repository)" = "true" ]; then
  git -C "$repo" fetch --quiet --unshallow || echo "::warning::could not fetch the full history"
fi
base="${INPUT_BASE:-}"
if [ -z "$base" ]; then
  branch="${GITHUB_BASE_REF:-main}"
  git -C "$repo" fetch --quiet --no-tags origin "+refs/heads/$branch:refs/remotes/origin/$branch" \
    || echo "::warning::could not fetch origin/$branch"
  base="origin/$branch"
fi

args=("$check" --repo "$repo" --base "$base")
[ -n "${INPUT_CWD:-}" ] && args+=(--cwd "$INPUT_CWD")
[ -n "${INPUT_TESTS:-}" ] && args+=(--tests "$INPUT_TESTS")

out="${RUNNER_TEMP:-/tmp}/goalline-$check.txt"
node "$GITHUB_ACTION_PATH/bin/goalline.mjs" "${args[@]}" -- "$INPUT_COMMAND" | tee "$out"
code=${PIPESTATUS[0]}

# goalpost and prove-red print the path of their PR card; with nothing to check there is none.
report=$(sed -n 's/^PR comment: //p' "$out" | tail -n 1)
if [ -n "$report" ] && [ -f "$report" ]; then
  cat "$report" >> "$GITHUB_STEP_SUMMARY"
else
  { echo "### goalline $check"; echo; echo '```'; sed '/^receipt: /,$d' "$out"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
flagged=false
[ "$code" -eq 2 ] && flagged=true
{ echo "report=$report"; echo "flagged=$flagged"; } >> "$GITHUB_OUTPUT"

if [ "$flagged" = true ] && [ "${INPUT_FAIL_ON_FLAG:-true}" != "true" ]; then exit 0; fi
exit "$code"
