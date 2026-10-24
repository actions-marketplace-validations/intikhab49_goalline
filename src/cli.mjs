import fs from 'node:fs';
import { cmdGoalpost } from './goalpost.mjs';
import { cmdGuard } from './guard.mjs';
import { cmdHistory } from './history.mjs';
import { cmdProveRed } from './provered.mjs';
import { cmdPrune } from './prune.mjs';
import { cmdTrialReport } from './reuse.mjs';
import { cmdRun } from './run.mjs';
import { ensureKey, openEnvelope } from './sign.mjs';
import { parseArgs, UsageError, VERSION } from './util.mjs';
import { cmdVerify } from './verify.mjs';

const HELP = `goalline ${VERSION}: goal-line technology for your tests. Signed receipts that a check ran on this
exact code, and checks that catch a coding agent moving the goalposts. (Its old name, receipts, still works.)

  goalline run --gate <name> [options] -- <command>
      Run a gate (tests, lint, build) and save a signed receipt for the exact code it ran on.
      Exits with the command's own exit code.
      --count label=regex   count a pattern in the output; any hit makes the receipt WARNED
                            (e.g. --count 'http429="statusCode":429')
      --idle-mb <n>         free memory needed at the start to call the run idle (default 1600)
      --env-keys A,B        also record these env vars, as hashes
      --no-machine          skip the idle and other-runner checks
      --reuse               skip the gate when this exact code already passed it: prints that pass and
                            exits 0 (--reuse-runs 2 needs two passes, --reuse-idle one on an idle machine)
      --rules <file>        also check whether the files changed since an earlier pass can affect this
                            gate. A trial unless trusted: the gate still runs, and whether skipping would
                            have been right is recorded (goalline trial-report)
      --trust-rules         with --rules: really skip, writing a CARRIED receipt for this code

  goalline verify [--require a,b,browser:2] [--idle browser] [--json]
      Show which gates have valid receipts for the code in this checkout, without re-running them.
      Exits 1 if a --require'd gate is not proven.

  goalline goalpost [--base origin/main] [--head HEAD] [--cwd apps/web] -- npx jest {files}
      Run the OLD versions of the test files this change edited or deleted against the NEW code.
      An old test that now fails means behaviour changed and the tests were edited to match.
      Jest, Vitest (-- npx vitest run {files}) and pytest (-- python -m pytest {files}) are
      judged test by test; any other runner file by file, by its exit code.
      An old file that only fails to compile against the new types (ts-jest) is run again with the
      type check off, so its tests are judged on behaviour (--no-retry-untyped: leave it BROKE).
      An old test that only crashes inside the new code (its fixtures or mocks lack something the
      new code needs) is CRASHED: not judged, rather than MOVED.

  goalline prove-red [--base origin/main] [--head HEAD] [--cwd apps/web] -- npx jest {files}
      Run the NEW tests this change adds against the BASE code. A new test that passes there
      does not test the change.

  goalline guard [--base origin/main] [--cwd apps/web] [--hook] -- npx jest {files}
      A stop check for coding agents: goalpost on the work as it stands (uncommitted files
      included). Exits 2 while an old test expectation no longer holds and is not acknowledged,
      so a Claude Code Stop hook keeps the agent working. --hook reads the hook's JSON on stdin.
      goalline guard --ack "<test file>::<test name>" --why "<reason>"   accept one change
      goalline guard --report                                           the reviewer's ledger
      --max-blocks <n>   stop blocking after n identical blocks (default 3)

  goalline history [--limit 200] [--cwd apps/web] [--out goalline-history] [--from-git] -- npx jest {files}
      What goalpost would have flagged on the repository's last merged PRs: each merge commit
      against its first parent, one at a time while the machine is idle. Writes report.md (the
      PRs that need a look, with the old and new values) and results.jsonl (resumable).
      --from-git reads the PRs from merge commits instead of GitHub. --first-heads also judges
      each PR as first opened. --max-minutes <n> pauses (exit 4); run it again to resume.
      --plan counts what would run; --config <file.json> for several areas.

  goalline prune [--older-than 30d] [--before <time>] [--tree <sha>] [--gate <name>] [--dry-run]
      Delete receipts that can never prove anything (unreadable, or the code changed during the
      run), plus the ones that match every filter given. A failed or flagged run is never deleted
      just because a later run passed: it is the record that the gate was flaky.

  goalline trial-report             what reuse saved, and how the rules trial is going

  goalline show <file.dsse.json>    print a receipt and check its signature
  goalline key                      print this machine's signing key

Common options: --repo <dir> (default: current directory) · --gate <name> · --deps-from <dir>
(where node_modules come from; default: --repo) · --tests <globs> · --keep (keep the scratch copy)
· --no-fail (exit 0 even when flagged) · --quiet (hide test output)
Tests that need a database (goalpost, prove-red):
  --fresh-db VAR=url-with-{db}   a database name for this run alone, in VAR for setup, tests and teardown
  --setup "<command>"            run in the scratch copy before the tests, e.g. "createdb {db} && npx prisma migrate deploy"
  --teardown "<command>"         always run afterwards, e.g. "dropdb {db}"
goalpost and prove-red exit 2 when they flag something. Receipts live in ~/.receipts (GOALLINE_HOME).`;

const BOOLEANS = ['noMachine', 'json', 'keep', 'noFail', 'quiet', 'dryRun', 'reuse', 'reuseIdle', 'trustRules', 'retryUntyped', 'noRetryUntyped', 'noTransplant', 'hook', 'report', 'plan', 'summary', 'rejudgeTypes', 'fromGit', 'firstHeads'];

function cmdShow([file]) {
  if (!file) throw new UsageError('show needs a receipt file (.dsse.json)');
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  const opened = openEnvelope(envelope);
  const statement = opened.statement || JSON.parse(Buffer.from(envelope.payload || '', 'base64').toString('utf8') || '{}');
  console.log(`signature: ${opened.ok ? `valid (key ${opened.keyid})` : `NOT VALID: ${opened.reason}`}`);
  console.log(JSON.stringify(statement, null, 2));
  return opened.ok ? 0 : 1;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) {
    console.log(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === 'version') {
    console.log(VERSION);
    return 0;
  }
  try {
    const { opts, positional, command } = parseArgs(rest, { booleans: BOOLEANS, repeat: ['count'] });
    switch (cmd) {
      case 'run':
        return await cmdRun(opts, command);
      case 'verify':
        return cmdVerify(opts);
      case 'goalpost':
        return await cmdGoalpost(opts, command);
      case 'prove-red':
        return await cmdProveRed(opts, command);
      case 'guard':
        return await cmdGuard(opts, command);
      case 'history':
        return await cmdHistory(opts, command);
      case 'prune':
        return cmdPrune(opts);
      case 'trial-report':
        return cmdTrialReport();
      case 'show':
        return cmdShow(positional);
      case 'key': {
        const k = ensureKey();
        console.log(`key ${k.keyid}\npublic key: ${k.pubFile}`);
        console.log("To trust this machine's receipts on another machine, copy that file into its ~/.receipts/trusted/.");
        return 0;
      }
      default:
        throw new UsageError(`unknown command "${cmd}" (try: goalline help)`);
    }
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`goalline: ${err.message}`);
    return 64;
  }
}
