"""Generate the goalline website. GitHub Pages serves docs/ from main.

  python docs/make_site.py

Writes the landing page, the guides, the command reference, llms.txt, llms-full.txt, sitemap.xml and
favicon.svg. The version comes from package.json, the command reference from `goalline help`, the
Action's inputs from action.yml, the example from a real goalpost run on a two-file repository, and
the click numbers from the header's ledger. After a change, re-run this script and commit what
changed. Needs Node 20+ and git.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
from html import escape

DOCS = pathlib.Path(__file__).resolve().parent
ROOT = DOCS.parent
sys.path.insert(0, str(DOCS))

import make_header as h  # noqa: E402

SITE = "https://intikhab49.github.io/goalline/"
REPO = "https://github.com/intikhab49/goalline"
MARKET = "https://github.com/marketplace/actions/goalline-catch-ai-edited-tests"
NPX = "npx github:intikhab49/goalline"
PAPER = "https://arxiv.org/abs/2510.20270"
AUTHOR = {"@type": "Person", "@id": "https://github.com/intikhab49", "name": "Intikhab Azam",
          "url": "https://github.com/intikhab49"}
BING_VERIFY = '<meta name="msvalidate.01" content="8696AEC33B172905558B45B0DB631DAD">\n'  # Bing Webmaster Tools, keep
TODAY = dt.date.today()
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]

# The click benchmark (README, Benchmark): the counts come from the header's ledger.
FLAGGED, LOW, HELD = (h.LEDGER.count(c) for c in "flh")
EDITED = len(h.LEDGER)
CLICK = {"replayed": 200, "not_judged": 0, "minutes": "about 2 minutes", "through": "2026-10-04",
         "pytest": "pytest 9.0.2 on Python 3.11", "first_heads": 199}
QUOTE = "an LLM agent with access to unit tests may delete failing tests rather than fix the underlying bug"


# ---------------------------------------------------------------- facts from the project itself
def cli_help() -> str:
    out = subprocess.run(["node", str(ROOT / "bin" / "goalline.mjs"), "help"], capture_output=True, text=True,
                         encoding="utf-8", check=True).stdout
    return out.rstrip("\n")


def action_inputs() -> list[tuple[str, str, str, bool]]:
    """(name, default, description, required) for each input in action.yml, in order."""
    text = (ROOT / "action.yml").read_text(encoding="utf-8").replace("\r\n", "\n")
    block = text.split("\ninputs:\n", 1)[1].split("\noutputs:\n", 1)[0]
    out = []
    for m in re.finditer(r"^  ([a-z-]+):\n((?:    .*\n?)+)", block, re.M):
        body = m.group(2)
        desc = re.search(r"description: '(.*)'", body).group(1).replace("''", "'")
        default = re.search(r"default: '(.*)'", body)
        out.append((m.group(1), default.group(1) if default else "", desc, "required: true" in body))
    return out


def example() -> tuple[str, str]:
    """A real goalpost run: a change makes add(2, 3) return 6 and edits its test's 5 to 6.
    Returns the terminal output and the Markdown card a pull request gets."""
    env = {**os.environ, "GIT_AUTHOR_NAME": "example", "GIT_AUTHOR_EMAIL": "example@example.invalid",
           "GIT_COMMITTER_NAME": "example", "GIT_COMMITTER_EMAIL": "example@example.invalid",
           "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z"}
    test = ("import { add } from '../src/add.mjs';\ntest('adds two numbers', () => {\n  const got = add(2, 3);\n"
            "  if (got !== 5) throw new Error(`Expected: 5\\nReceived: ${got}`);\n});\n")
    with tempfile.TemporaryDirectory() as tmp:
        repo = pathlib.Path(tmp) / "example"
        (repo / "src").mkdir(parents=True)
        (repo / "test").mkdir()
        git = lambda *a: subprocess.run(["git", "-C", str(repo), *a], env=env, check=True, capture_output=True)  # noqa: E731
        git("init", "-q", "-b", "main")
        git("config", "core.autocrlf", "false")
        (repo / "src/add.mjs").write_text("export const add = (a, b) => a + b;\n", newline="\n")
        (repo / "test/add.test.mjs").write_text(test, newline="\n")
        git("add", "-A")
        git("commit", "-q", "-m", "base")
        git("checkout", "-q", "-b", "moved")
        (repo / "src/add.mjs").write_text("export const add = (a, b) => a + b + 1;\n", newline="\n")
        (repo / "test/add.test.mjs").write_text(test.replace("5", "6"), newline="\n")
        git("commit", "-q", "-am", "add one more")
        r = subprocess.run(["node", str(ROOT / "bin" / "goalline.mjs"), "goalpost", "--repo", str(repo), "--base", "main",
                            "--quiet", "--no-fail", "--", "node", str(ROOT / "test" / "fake-jest.mjs"), "{files}"],
                           env={**env, "GOALLINE_HOME": str(pathlib.Path(tmp) / "home")}, capture_output=True,
                           text=True, encoding="utf-8", check=True)
        terminal = r.stdout.split("\nreceipt: ")[0].strip()
        card = pathlib.Path(re.search(r"^PR comment: (.+)$", r.stdout, re.M).group(1).strip()).read_text(encoding="utf-8")
    assert "Expected 5, received 6" in terminal and "MOVED" in terminal, terminal
    return terminal, card.strip()


# ---------------------------------------------------------------- html helpers
def jsonld(data) -> str:
    return json.dumps(data, indent=1, ensure_ascii=False).replace("<", "\\u003c")


def md(text: str) -> str:
    """Escape text; `code`, **bold** and [links](url) become HTML."""
    parts = escape(text, quote=False).split("`")
    for i, part in enumerate(parts):
        if i % 2:
            parts[i] = f"<code>{part}</code>"
        else:
            part = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", part)
            parts[i] = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', part)
    return "".join(parts)


def plain(text: str) -> str:
    """The same text without markup, for JSON-LD and llms.txt."""
    return re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text).replace("**", "").replace("`", "")


def p(*texts: str) -> str:
    return "".join(f"<p>{md(t)}</p>\n" for t in texts)


def pre(code: str) -> str:
    return f"<pre><code>{escape(code)}</code></pre>\n"


def table(head: list[str], rows: list[list[str]]) -> str:
    th = "".join(f"<th>{md(c)}</th>" for c in head)
    trs = "".join("<tr>" + "".join(f"<td>{md(c)}</td>" for c in row) + "</tr>" for row in rows)
    return f'<div class="t"><table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div>\n'


def ul(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{md(i)}</li>" for i in items) + "</ul>\n"


CSS = """
:root{--ink:#16202c;--muted:#5a6675;--blue:#2a78d6;--coral:#e8553a;--bg:#fbfcfd;--code:#0f1722;--line:#e3e8ee}
*{box-sizing:border-box}
body{margin:0;font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
.top{border-bottom:1px solid var(--line);background:#fff}
.top div{max-width:980px;margin:0 auto;padding:12px 22px;display:flex;flex-wrap:wrap;gap:6px 22px;align-items:center}
.top a{color:var(--ink);text-decoration:none;font-size:.95rem}
.top a.brand{font-family:Georgia,serif;font-weight:700;font-size:1.2rem;margin-right:auto}
main{max-width:980px;margin:0 auto;padding:28px 22px 64px}
img{max-width:100%;height:auto}
h1{font-size:2rem;line-height:1.2;margin:22px 0 12px}
h2{font-size:1.35rem;margin:44px 0 10px}
h3{font-size:1.02rem;margin:22px 0 4px}
p.lead{font-size:1.12rem;color:var(--muted)}
a{color:var(--blue)}
.crumbs{font-size:.88rem;color:var(--muted)}
.crumbs a{color:var(--muted)}
.cta{display:inline-block;margin:8px 10px 0 0;padding:11px 18px;border-radius:8px;background:var(--blue);color:#fff;text-decoration:none;font-weight:600}
.cta.alt{background:transparent;color:var(--blue);border:1.5px solid var(--blue)}
pre{background:var(--code);color:#dfe7ef;padding:16px 18px;border-radius:8px;overflow-x:auto;font-size:.86rem;line-height:1.5}
code{font-family:ui-monospace,"Cascadia Code",Consolas,monospace}
p code,li code,td code{background:#eef2f6;padding:1px 5px;border-radius:4px;font-size:.84em}
.t{overflow-x:auto;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:.9rem;background:#fff}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:#f3f6f9;font-weight:600}
.stat{color:var(--coral);font-weight:700}
ul{padding-left:22px}
footer{max-width:980px;margin:0 auto;padding:18px 22px 40px;border-top:1px solid var(--line);color:var(--muted);font-size:.88rem}
"""

FAVICON = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{h.AMBER}"/>
<stop offset=".55" stop-color="{h.CORAL}"/><stop offset="1" stop-color="{h.PINK}"/></linearGradient></defs>
<rect width="64" height="64" rx="14" fill="{h.BG}"/>
<text x="32" y="46" text-anchor="middle" font-family="Georgia,serif" font-size="44" font-weight="700" fill="url(#g)">g</text>
</svg>
"""

NAV = [("How it works", "catch-ai-edited-tests/"), ("Claude Code hook", "claude-code-stop-hook/"),
       ("GitHub Action", "github-action/"), ("Benchmark", "benchmark/"), ("Commands", "commands/")]


def page(path: str, title: str, desc: str, body: str, graph: list, crumb: str | None = None) -> tuple[str, str]:
    assert len(title) <= 65, f"title too long ({len(title)}): {title}"
    assert len(desc) <= 155, f"description too long ({len(desc)}): {desc}"
    url = SITE + path
    trail = ""
    if crumb:
        graph = graph + [{"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "goalline", "item": SITE},
            {"@type": "ListItem", "position": 2, "name": crumb, "item": url}]}]
        trail = f'<p class="crumbs"><a href="{SITE}">goalline</a> / {escape(crumb)}</p>'
    nav = "".join(f'<a href="{SITE + p_}">{escape(n)}</a>' for n, p_ in NAV)
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(title)}</title>
<meta name="description" content="{escape(desc)}">
<link rel="canonical" href="{url}">
{BING_VERIFY if not path else ""}<link rel="icon" href="{SITE}favicon.svg" type="image/svg+xml">
<meta name="author" content="Intikhab Azam">
<meta property="og:type" content="{"website" if not path else "article"}">
<meta property="og:site_name" content="goalline">
<meta property="og:title" content="{escape(title)}">
<meta property="og:description" content="{escape(desc)}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{SITE}social.png">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="640">
<meta property="og:image:alt" content="goalline: did your agent fix the code, or the test? Old tests replayed on new code.">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="text/plain" href="{SITE}llms.txt" title="llms.txt">
<script type="application/ld+json">
{jsonld({"@context": "https://schema.org", "@graph": graph})}
</script>
<style>{CSS}</style>
</head>
<body>
<header class="top"><div><a class="brand" href="{SITE}">goalline</a>
{nav}<a href="{REPO}">GitHub</a></div></header>
<main>
{trail}
{body}
</main>
<footer>
goalline {VERSION} · MIT · free and open source · by <a href="https://github.com/intikhab49">Intikhab Azam</a> ·
<a href="{REPO}">Source</a> · <a href="{MARKET}">GitHub Marketplace</a> · <a href="{SITE}llms.txt">llms.txt</a><br>
Guides: {" · ".join(f'<a href="{SITE + g["path"]}">{escape(g["crumb"])}</a>' for g in GUIDES)}
</footer>
</body>
</html>
"""
    return path, html


def article(g: dict, body: str) -> tuple[str, str]:
    graph = [{"@type": "TechArticle", "@id": SITE + g["path"] + "#article", "headline": g["h1"],
              "description": g["desc"], "url": SITE + g["path"], "inLanguage": "en", "author": AUTHOR,
              "dateModified": TODAY.isoformat(), "isPartOf": {"@id": SITE + "#website"},
              "about": {"@id": SITE + "#code"}}]
    head = f'<h1>{md(g["h1"])}</h1>\n<p class="lead">{md(g["lead"])}</p>\n'
    related = [x for x in GUIDES if x is not g]
    tail = ("<h2>Related</h2>\n" + ul([f"[{x['crumb']}]({SITE + x['path']}): {x['blurb']}" for x in related]))
    return page(g["path"], g["title"], g["desc"], head + body + tail, graph, g["crumb"])


# ---------------------------------------------------------------- the guides
GUIDES = [
    {"path": "catch-ai-edited-tests/", "crumb": "How it works",
     "title": "How to tell if an AI agent edited a test to make it pass",
     "h1": "How to tell if an AI coding agent edited a test to make it pass",
     "desc": "When a change edits the code and its test together, CI passes either way. Run the old tests on the "
             "new code to see which expectation moved, and to what.",
     "lead": "Run the old version of each test the change edited against the new code. If an old test fails, "
             "behaviour changed and the test was rewritten to match. goalline does this for every pull request, "
             "with Jest, Vitest or pytest, and shows the old and new values.",
     "blurb": "old tests on new code, the verdicts, and what it can't catch"},
    {"path": "claude-code-stop-hook/", "crumb": "Claude Code hook",
     "title": "Stop Claude Code from editing tests to pass: a Stop hook",
     "h1": "Stop Claude Code from editing tests to pass",
     "desc": "A Claude Code Stop hook that runs the old tests on the agent's work and keeps it working until it "
             "restores the behaviour or explains why it changed.",
     "lead": "`goalline guard` is a Claude Code Stop hook. Before the agent may finish, the old versions of the "
             "tests its work edited run against that work. If an old expectation no longer holds, the agent keeps "
             "working until it restores the behaviour or records why the change is intended.",
     "blurb": "a Stop hook that won't let the agent finish until it explains a moved test"},
    {"path": "github-action/", "crumb": "GitHub Action",
     "title": "GitHub Action: catch tests edited to pass in pull requests",
     "h1": "A GitHub Action that catches tests edited to pass",
     "desc": "goalline's GitHub Action runs the old tests on each pull request's new code and puts every moved "
             "expectation, with its values, on the job summary.",
     "lead": "The goalline Action runs on every pull request. It replays the old versions of the tests the pull "
             "request edited against its new code, and puts a card on the job summary listing every expectation "
             "that moved, with the old and new values.",
     "blurb": "one step in a workflow, with Jest, Vitest or pytest"},
    {"path": "prove-red/", "crumb": "prove-red",
     "title": "Check that new tests fail on the old code (prove-red)",
     "h1": "Check that new tests fail on the old code",
     "desc": "A test that passes before the fix proves nothing. goalline prove-red runs a change's new tests on the "
             "base code and flags any that already pass.",
     "lead": "A new test that already passes on the old code doesn't test the change. `goalline prove-red` runs the "
             "tests a change adds against the base code: each one should fail there. Any that pass are flagged.",
     "blurb": "new tests must fail on the base code first, or they test nothing"},
    {"path": "skip-tests-already-passed/", "crumb": "Skip what passed",
     "title": "Skip CI tests the same code already passed: signed receipts",
     "h1": "Skip CI tests that the exact same code already passed",
     "desc": "goalline keeps a signed receipt for every test run, keyed by the git tree, so a gate this exact code "
             "already passed is skipped instead of run again.",
     "lead": "Every time a check runs, goalline keeps a signed receipt tied to the exact code it ran on: the git "
             "tree, not the commit. When that same code comes back (a rebase, a re-run, a merge that changes "
             "nothing), the gate is skipped and the earlier pass is shown instead.",
     "blurb": "signed receipts keyed by the git tree, and safe reuse"},
    {"path": "database-schema-inputs/", "crumb": "Database inputs",
     "title": "Test caching that notices database schema changes",
     "h1": "Test caching that notices when the database schema changed",
     "desc": "goalline --input db=pg hashes the schema PostgreSQL reports before and after each test run, so a "
             "cached pass never stands in for a different database.",
     "lead": "A test run can pass because of the database it hit, not the code. `goalline run --input db=pg` reads "
             "the schema PostgreSQL reports right before and right after the gate and keeps its hash on the "
             "receipt, so a pass on one schema never stands in for another.",
     "blurb": "the database schema on the receipt, with --input db=pg"},
    {"path": "benchmark/", "crumb": "Benchmark",
     "title": "Replaying 200 merged pull requests of pallets/click",
     "h1": "Replaying 200 merged pull requests of pallets/click",
     "desc": f"goalline history on pallets/click: of the last 200 merged PRs, {EDITED} edited a test, {HELD} kept "
             f"every old test passing and {FLAGGED} moved an expectation.",
     "lead": f"`goalline history` ran goalpost on the last {CLICK['replayed']} merged pull requests of "
             f"[pallets/click](https://github.com/pallets/click). {EDITED} edited an existing test. {HELD} of those "
             f"kept every old test passing, and {FLAGGED} moved an expectation, each shown with its old and new "
             f"values. It took {CLICK['minutes']} of machine time.",
     "blurb": f"{FLAGGED} of {EDITED} test-editing PRs moved an expectation"},
    {"path": "commands/", "crumb": "Commands",
     "title": "goalline command reference: run, verify, goalpost, guard",
     "h1": "goalline command reference",
     "desc": "Every goalline command and option, from goalline help: run, verify, goalpost, prove-red, guard, "
             "history, prune and trial-report.",
     "lead": f"Every command and option of goalline {VERSION}, exactly as `goalline help` prints it.",
     "blurb": "every command and option"},
]
G = {g["path"]: g for g in GUIDES}

ACTION_YAML = """name: goalline
on: pull_request
jobs:
  goalpost:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - uses: intikhab49/goalline@v0
        with:
          command: npx jest {files}"""

HOOK_JSON = """{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "goalline guard --hook --base origin/main -- npx jest {files}", "timeout": 600 }
        ]
      }
    ]
  }
}"""

FRESH_DB = """goalline prove-red --base origin/main --cwd apps/api \\
  --fresh-db 'DATABASE_URL=postgresql://app@localhost:5432/{db}' \\
  --setup 'createdb {db} && npx prisma migrate deploy' --teardown 'dropdb {db}' \\
  -- npx jest --runInBand {files}"""

VERDICTS = [
    ["HELD", "Every old test still passes on the new code.", "no"],
    ["MOVED", "An old test fails on the new code: behaviour changed and the test was edited to match. Shown with "
              "the old and new values, such as `Expected 5, received 6`.", "yes"],
    ["BROKE", "The old test file no longer loads against the new code (a missing module or export).", "yes"],
    ["CRASHED", "The old test crashed inside the new code (a TypeError, say) before reaching its expectations: its "
                "fixtures or mocks lack something the new code needs. Not judged; for Jest and Vitest, the "
                "assertion transplant then runs the old expectations with the new file's setup.", "yes, not judged"],
    ["EMPTY", "No old tests ran in that file.", "no"],
    ["UNKNOWN", "The test runner did not report the file.", "yes, not judged"],
]

FAQ = [
    ("How do I know if an AI coding agent changed a test to make it pass?",
     "Run the old version of every test the change edited against the new code. If an old test now fails, "
     "behaviour changed and the test was rewritten to match. `goalline goalpost` does exactly that and shows the "
     "old and new values, for example `Expected 5, received 6`."),
    ("Why doesn't CI catch a test that was edited to pass?",
     "Because CI runs the new tests on the new code. When a change edits the code and its test in the same diff, "
     "the suite passes either way, so a green check can't tell you whether behaviour changed."),
    ("Is a flagged pull request a bug?",
     "No. A flag means a person should look. Many changes move an expectation on purpose: on pallets/click, "
     "maintainers changed behaviour deliberately and updated the tests to match. goalline shows exactly what moved "
     "so the reviewer can confirm it was intended."),
    ("Does goalline use AI or an LLM?",
     "No. It runs your own test runner on two versions of your code and compares the results. No source code "
     "leaves the machine."),
    ("Which test runners does goalline support?",
     "Jest, Vitest and pytest are judged test by test. Any other command is judged file by file, by its exit code."),
    ("How do I stop Claude Code from editing tests to pass?",
     "Add `goalline guard --hook` as a Claude Code Stop hook. Before the agent may finish, the old tests it edited "
     "run against its work; a moved expectation sends it back to work until it restores the behaviour or records "
     "why the change is intended."),
    ("How do I check that a new test actually tests the change?",
     "Run it on the code before the change: it should fail there. `goalline prove-red` runs every test a change "
     "adds against the base code and flags any that already pass."),
    ("Can CI skip tests that already passed on the same code?",
     "Yes. `goalline run --reuse` keeps a signed receipt for every run, keyed by the git tree, and skips a gate "
     "that exact code already passed. With `--input db=pg`, a change to the database schema means it runs again."),
    ("Does goalline catch hard-coded answers?",
     "No. It catches tests that were edited, not code that special-cases the test's inputs. Hard-coded answers "
     "still need hidden tests or mutation testing."),
    ("What does goalline cost, and what does it need?",
     f"It is free and open source (MIT). It needs Node 20 or newer and git, and has zero dependencies: "
     f"`{NPX} help` runs it without installing anything."),
]


# ---------------------------------------------------------------- pages
def landing(terminal: str) -> tuple[str, str]:
    guides = ul([f"[{g['h1']}]({SITE + g['path']}): {g['blurb']}" for g in GUIDES])
    body = f"""<img src="header.svg" alt="goalline: goal-line technology for your tests. Prove it passed, skip what's proven, catch what moved." width="980" height="278">
<h1>Did your coding agent fix the code, or the test?</h1>
<p class="lead">goalline is a free, open source command-line tool and GitHub Action for teams that use AI coding
agents. It runs the <strong>old</strong> version of every test a change edited against the <strong>new</strong> code.
When an old test fails, behaviour changed and the test was rewritten to match, and you see exactly what moved, with
the old and new values. It also keeps a signed receipt for every check, so nothing that already passed on the same
code has to run again.</p>
<a class="cta" href="{REPO}">View on GitHub</a>
<a class="cta alt" href="{MARKET}">GitHub Marketplace</a>
<a class="cta alt" href="{SITE}catch-ai-edited-tests/">How it works</a>

<h2>The problem</h2>
{p(f'Coding agents are known to change the test instead of fixing the code. [ImpossibleBench]({PAPER}) (Zhong, '
   f'Raghunathan and Carlini, 2025) puts it plainly: "{QUOTE}".',
   'When a pull request edits the code and its test in the same diff, the suite passes either way. A green check '
   "can't tell you whether behaviour changed. goalline can.")}
<h2>What it catches</h2>
{p("A change made `add(2, 3)` return 6 and edited its test's 5 to 6, so every check is green. goalline runs the "
   "old test on the new code. This is its real output:")}
{pre(terminal)}
<h2>Prove, skip, catch</h2>
{table(["", "Commands", "What you get"], [
    ["**Prove**", "`run` · `verify`", "A signed receipt every time a check runs, tied to the exact code it ran on "
     "(the git tree). `verify` says which gates already passed on this code without re-running anything."],
    ["**Skip**", "`run --reuse` · `--rules` · `--input`", "Skip a gate this exact code already passed. Rules carry a "
     "pass over changes that can't affect the gate, and `--input db=pg` keeps the database schema on the receipt."],
    ["**Catch**", "`goalpost` · `prove-red` · `guard` · `history`", "Old tests on new code, new tests that must "
     "fail on the old code first, a Claude Code Stop hook, and all of it replayed on your merged pull requests."]])}
{p("Jest, Vitest and pytest are judged test by test; any other command file by file. Zero dependencies.")}
<h2>On 200 real pull requests</h2>
{p(f"On [pallets/click]({SITE}benchmark/)'s last {CLICK['replayed']} merged pull requests, {EDITED} edited an "
   f"existing test. {HELD} kept every old test passing and **{FLAGGED} moved an expectation**, each shown with its "
   f"old and new values; {LOW} more were low risk. That took {CLICK['minutes']} of machine time. A flag is not a "
   "bug report: it means a person should look.")}
<h2>On every pull request</h2>
{p(f"The [GitHub Action]({SITE}github-action/) puts the card on the job summary ([on the Marketplace]({MARKET})):")}
{pre(ACTION_YAML)}
<h2>Inside Claude Code</h2>
{p(f"As a [Stop hook]({SITE}claude-code-stop-hook/), `goalline guard` keeps the agent working while an old test "
   "expectation no longer holds, until it restores the behaviour or says why the change is intended. In "
   "`.claude/settings.json`:")}
{pre(HOOK_JSON)}
<h2>Quick start</h2>
{p("Node 20+ and git, nothing else. Run it from a checkout whose dependencies are installed:")}
{pre(f'''# What would it have flagged on your last 200 merged PRs? (writes goalline-history/report.md)
{NPX} history --from-git -- npx jest {{files}}

# One change, before you merge it: old tests on the new code
{NPX} goalpost --base origin/main -- npx jest {{files}}
#   Vitest:  -- npx vitest run {{files}}
#   pytest:  -- python -m pytest {{files}}''')}
<h2>Guides</h2>
{guides}
<h2>FAQ</h2>
{"".join(f"<h3>{escape(q)}</h3>{p(a)}" for q, a in FAQ)}"""
    graph = [
        {"@type": "WebSite", "@id": SITE + "#website", "url": SITE, "name": "goalline", "inLanguage": "en",
         "publisher": AUTHOR},
        {"@type": "SoftwareSourceCode", "@id": SITE + "#code", "name": "goalline", "url": SITE,
         "description": ("Open source command-line tool and GitHub Action that replays the old tests on the new "
                         "code, so a test an AI coding agent edited to pass shows up with its exact old and new "
                         "values. Also keeps signed receipts (in-toto, Ed25519) for every check so CI can skip what "
                         "the same code already passed, checks that new tests fail on the old code, and runs as a "
                         "Claude Code Stop hook. Jest, Vitest and pytest."),
         "codeRepository": REPO, "programmingLanguage": "JavaScript", "runtimePlatform": "Node.js 20+",
         "version": VERSION, "license": "https://opensource.org/licenses/MIT", "isAccessibleForFree": True,
         "keywords": "AI coding agents, test integrity, tests edited to pass, reward hacking, Claude Code hook, "
                     "GitHub Action, regression testing, Jest, Vitest, pytest, test result caching, in-toto",
         "sameAs": [REPO, MARKET], "author": AUTHOR},
        {"@type": "FAQPage", "@id": SITE + "#faq", "mainEntity": [
            {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": plain(a)}} for q, a in FAQ]},
    ]
    return page("", "goalline: catch AI coding agents that edit tests to pass",
                "Free, open source CLI and GitHub Action. It replays the old tests on the new code, so a test "
                "edited to pass shows up with its exact old and new values.", body, graph)


def how_it_works(terminal: str) -> tuple[str, str]:
    g = G["catch-ai-edited-tests/"]
    body = f"""<h2>Why a green check can't tell you</h2>
{p("CI runs the new tests on the new code. When a change edits the code and its test in the same diff, both sides "
   "move together and the suite passes either way. A reviewer then has to spot, in the test diff, that an "
   "expectation changed, and decide whether it should have.",
   f'Coding agents make this common. ImpossibleBench ([arXiv 2510.20270]({PAPER})) gives agents tasks whose tests '
   f'contradict the spec, so any pass is a shortcut, and reports that "{QUOTE}".')}
<h2>The method: old tests on new code</h2>
{ul(["Find the test files the change edited or deleted, against the merge base.",
     "Take their **old** versions, from the base.",
     "Run them on the **new** code in a scratch copy of the head commit, using your checkout's installed packages. "
     "Nothing in your checkout changes.",
     "Compare: an old test that now fails means behaviour changed, and the change's own edit to that test hid it."])}
{p("This is real goalline output for a change that made `add(2, 3)` return 6 and edited the test's 5 to 6:")}
{pre(terminal)}
<h2>The verdicts</h2>
{table(["Verdict", "Meaning", "Flagged"], VERDICTS)}
{p("Flagged files are sorted by how much a reviewer is needed. **Needs a look** is an old test whose lines the "
   "change removed or rewrote. **Low risk** is an old test the change only added lines to (a list that grew, a "
   "mock that was added), so every old line is still there. An added early `return`, dead branch, skip or focus "
   "never counts as low risk.",
   "With ts-jest, an old file that only fails to compile against the new types is run again with the type check "
   "off, so it is judged on behaviour. A crash in the new code is not called a behaviour change: it is CRASHED, "
   "and for Jest and Vitest the old expectations are transplanted into the new test file, with its setup, and run "
   "again.")}
<h2>Try it</h2>
{pre(f'''# One change: old tests on the new code (exits 2 when something is flagged)
{NPX} goalpost --base origin/main -- npx jest {{files}}

# Your history: what it would have flagged on the last 200 merged PRs
{NPX} history --from-git -- npx jest {{files}}''')}
{p("Vitest: `-- npx vitest run {files}`. pytest: `-- python -m pytest {files}`, with the project's virtualenv "
   "active. goalpost also writes a Markdown summary ready to paste as a pull request comment.")}
<h2>What it can't catch</h2>
{ul(["**Hard-coded answers.** goalline catches tests that were edited, not code that special-cases the test's "
     "inputs. Those still need hidden tests or mutation testing.",
     "**New tests that test nothing.** That is a different check: [prove-red](" + SITE + "prove-red/).",
     "**Tests with computed titles** (`each`, template strings) inside an edited file are matched by title, so "
     "they can be missed."])}
"""
    return article(g, body)


def hook_page() -> tuple[str, str]:
    g = G["claude-code-stop-hook/"]
    body = f"""<h2>What the agent sees</h2>
{p("When Claude Code is about to stop, the hook runs goalpost on the work as it stands, uncommitted files included, "
   "against the base branch. If an old test expectation no longer holds, the hook exits 2 and its message goes "
   "back to the agent: which tests, with the exact old and new values, and what to do about each one.",
   "For each one the agent either restores the behaviour or records why the change is intended:")}
{pre('goalline guard --ack "src/cart.spec.ts::Cart applies the discount" --why "the task asks for the discount to apply before tax"')}
{p("Editing the test to match does not get past the guard, because it runs the **old** version of the test. The "
   "reasons form the reviewer's ledger: `goalline guard --report` prints them as Markdown for the pull request.")}
<h2>Set it up</h2>
{p("Install goalline once (`npm install -g github:intikhab49/goalline`), then add the hook to "
   "`.claude/settings.json`. The timeout is in seconds; a cold Jest run can take more than a minute.")}
{pre(HOOK_JSON)}
{p("For a monorepo, add `--cwd apps/web`. For Vitest or pytest, change the command after `--`.")}
<h2>It never traps the agent</h2>
{ul(["The guard never blocks because of its own failure: if the check can't run, the agent may stop.",
     "After `--max-blocks` identical blocks (default 3), it lets the agent stop with a warning that a person must "
     "review the changes.",
     "Nothing in the checkout changes: the snapshot of the work is a loose git object, not a commit on the branch."])}
<h2>Other agents</h2>
{p("The guard is a plain command: run `goalline guard -- <test command>` as the last step of any agent loop. Exit "
   "2 means an old expectation moved and the work isn't done; exit 0 means it may stop.")}
"""
    return article(g, body)


def action_page(card: str) -> tuple[str, str]:
    g = G["github-action/"]
    rows = [[f"`{n}`", "required" if req else (f"`{d}`" if d else "(see description)"), desc]
            for n, d, desc, req in action_inputs()]
    body = f"""<h2>Add it to a workflow</h2>
{pre(ACTION_YAML)}
{p("The action fetches the history it needs, so the default shallow checkout is fine. It is listed on the "
   f"[GitHub Marketplace]({MARKET}).")}
<h2>Vitest and pytest</h2>
{pre('''      - uses: intikhab49/goalline@v0
        with:
          command: npx vitest run {files}''')}
{pre('''      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install -e . pytest
      - uses: intikhab49/goalline@v0
        with:
          command: python -m pytest {files}''')}
<h2>Inputs</h2>
{table(["Input", "Default", "What it does"], rows)}
{p("Outputs: `flagged` (`true` or `false`) and `report` (the path of the Markdown card).")}
<h2>The card on the job summary</h2>
{p("This is the real card for a change that made `add(2, 3)` return 6 and edited its test to match, as Markdown:")}
{pre(card)}
<h2>New tests that test nothing</h2>
{p(f"With `check: prove-red`, the action runs the new tests a pull request adds against the base code instead, "
   f"and flags any that already pass there. See [prove-red]({SITE}prove-red/).")}
"""
    return article(g, body)


def prove_red_page() -> tuple[str, str]:
    g = G["prove-red/"]
    body = f"""<h2>Why</h2>
{p("Test-driven development starts red: a test for a bug should fail before the fix and pass after it. A coding "
   "agent asked to fix a bug and add a test can write a test that passes either way, and CI shows two green checks. "
   "Nothing proves the new test covers the change.")}
<h2>Run it</h2>
{pre(f'''{NPX} prove-red --base origin/main -- npx jest {{files}}
{NPX} prove-red --base origin/main -- npx vitest run {{files}}
{NPX} prove-red --base origin/main -- python -m pytest {{files}}''')}
{p("It runs the new tests the change adds (new files, and new tests inside edited files, found by their titles) "
   "against the base code in a scratch copy. A new test that passes there does not test the change, and is flagged. "
   "It exits 2 when something is flagged (`--no-fail` to always exit 0), and prints a Markdown summary ready to "
   "paste as a pull request comment.")}
<h2>In a pull request</h2>
{pre('''      - uses: intikhab49/goalline@v0
        with:
          check: prove-red
          command: npx jest {files}''')}
<h2>Tests that need a database</h2>
{p("Each run can get its own database, set up in the scratch copy and dropped afterwards. A setup that fails judges "
   "nothing, and the teardown always runs. Only the variable name goes on the receipt, since the URL can hold a "
   "password.")}
{pre(FRESH_DB)}
"""
    return article(g, body)


def skip_page() -> tuple[str, str]:
    g = G["skip-tests-already-passed/"]
    body = f"""<h2>Run gates through goalline</h2>
{pre('''# Skip the gate when this exact code already passed it
goalline run --gate api-unit --reuse -- npx jest

# Two passes, one on an idle machine, for a flaky browser suite
goalline run --gate browser --reuse --reuse-runs 2 --reuse-idle -- npx playwright test

# Which gates are already proven for the code in this checkout? Nothing is re-run.
goalline verify --require api-unit,browser:2 --idle browser''')}
{p("`run` exits with the command's own exit code, so it wraps any gate: tests, lint, a build. `verify` ends with "
   "what still has to run, and only that, or `Nothing to re-run`.")}
<h2>Keyed by the code, not the commit</h2>
{p("A receipt is keyed by the content of the code: the git tree. A run on uncommitted work therefore verifies once "
   "exactly that work is committed, and a merge whose result equals an already-tested tree is already proven.")}
<h2>What a receipt is</h2>
{p("An [in-toto](https://in-toto.io) statement of type `test-result/v0.1` about one git tree, in a DSSE envelope "
   "signed with the machine's Ed25519 key. It records what ran (command, exit code, test counts, failed test names, "
   "duration), the tree and commit, the Node version, the OS and the lockfile digest, whether the machine was idle, "
   "and the full log, gzipped next to it.")}
{p("A receipt counts only if the signature is valid, the tree matches, the code didn't change during the run, the "
   "Node major version matches, any `--input` still reads the same, and the result is a clean pass: no failures, "
   "no flaky tests, and at least one test ran.")}
<h2>Carrying a pass over changes that can't affect it</h2>
{p("With `--rules rules.json`, a pass can also carry over changes outside what a gate depends on: the file names "
   "areas of the repo and the areas each gate depends on, and a changed file in no area re-runs everything. Rules "
   "start as a trial: the gate still runs, and `goalline trial-report` shows whether skipping would have been "
   "right. With no disagreement in at least 20 would-be skips, `--trust-rules` really skips, and `verify` shows "
   "`CARRIED`, never `VERIFIED`.")}
<h2>Trust model</h2>
{ul(["**Tamper-evident, not forgery-proof.** Everyone on one machine shares one key: an edited receipt fails "
     "verification, but anything running as your user can sign.",
     "**A receipt proves a run happened, not that the tests are good.** That is what goalpost and prove-red are for.",
     "**Nothing secret is stored.** Extra env vars are kept as hashes, and no source code leaves the machine."])}
"""
    return article(g, body)


def inputs_page() -> tuple[str, str]:
    g = G["database-schema-inputs/"]
    pg = ul(["`db=pg` reads the schema PostgreSQL reports for `$DATABASE_URL`: `pg_dump --schema-only --no-owner "
             "--no-privileges`, without the lines that change on every dump (pg_dump's own version, the random "
             "`\\restrict` key), plus the server's major version.",
             "`db=pg:TEST_DATABASE_URL` reads another variable.",
             "Prisma's own URL parameters (`?schema=public`) are dropped before pg_dump sees the URL.",
             "A password in a probe's URL never reaches the receipt."])
    body = f"""<h2>The problem</h2>
{p("Test result caching keys on the code. But a dev database that drifted, a migration that half-applied or another "
   "server version can make the same code pass or fail, and the cache can't see any of it.")}
<h2>Name what the gate depends on</h2>
{pre('''goalline run --gate api --reuse --input db=pg -- npx jest apps/api
goalline verify --require unit,api --input db=pg''')}
{p("goalline reads each input right before and right after the gate and keeps a hash of it on the receipt. In "
   "`verify` and `--reuse`, the receipt counts only while the same probe reads the same thing, and never when an "
   "input changed during the run. `--reuse` says why an earlier pass no longer counts.")}
<h2>PostgreSQL: db=pg</h2>
{pg}
<h2>Any other database</h2>
{p("Any other probe is a command whose output says what matters:")}
{pre('''goalline run --gate api --input db="sqlite3 dev.db .schema" -- npm test
goalline run --gate api --input db="mysqldump --no-data --skip-dump-date app" -- npm test''')}
<h2>Only the gates that use it</h2>
{p("In `rules.json`, `inputs` says which gates depend on what, so a schema change doesn't re-run the unit tests:")}
{pre('{ "inputs": { "api-*": ["db"] } }')}
{p("A gate the rules tie to an input that no `--input` reads gets a receipt that proves nothing, and says why.")}
<h2>Limits</h2>
{ul(["Per gate, not per test: any schema change re-runs the whole gate.",
     "The clock is not part of the fingerprint yet."])}
"""
    return article(g, body)


def benchmark_page() -> tuple[str, str]:
    g = G["benchmark/"]
    body = f"""<img src="../charts/click-history.png" alt="goalline on pallets/click, the last 200 merged PRs: {EDITED} edited an existing test, {HELD} kept every old test passing, {FLAGGED} were flagged with their old and new values, {LOW} were low risk, 0 could not be judged." width="980">
{table(["", "PRs"], [
    ["Merged PRs replayed", str(CLICK["replayed"])],
    ['Edited an existing test (a "test changed" alarm fires on every one)', str(EDITED)],
    ["Kept every old test passing", f"**{HELD}**"],
    ["Flagged: an old expectation moved, shown with its old and new values", f"**{FLAGGED}**"],
    ["Low risk: the old test fails, but the PR only added lines to it", str(LOW)],
    ["Could not be judged", str(CLICK["not_judged"])],
    ["Machine time", CLICK["minutes"]]])}
{p(f"Each PR was judged on its merge commit against its first parent, with {CLICK['pytest']}, for the merged PRs "
   f"up to {CLICK['through']}.")}
<h2>A flag is not a bug report</h2>
{p("click's maintainers changed behaviour on purpose and updated the tests to match. In "
   "[#3239](https://github.com/pallets/click/pull/3239), a `--flag` option with `prompt=True, default=True, "
   "flag_value=False` went from `Flag [y/N]:` (Enter gives `False`) to `Flag [Y/n]:` (Enter gives `True`), with "
   "three lines of a test table edited to match and all 11 CI checks green. That is the point: a reviewer sees the "
   "change and its values, not just a green check.",
   f"Judged as first opened as well (`--first-heads`, {CLICK['first_heads']} PRs), no PR edited a test to hide a "
   "change that review then took back.")}
<h2>Reproduce it</h2>
{p("Clone click, install it and pytest into a virtualenv, activate it, and run:")}
{pre(f"{NPX} history --from-git --limit 200 -- python -m pytest {{files}}")}
<h2>Run it on your repository</h2>
{pre(f"{NPX} history --from-git -- npx jest {{files}}")}
{p("It writes `goalline-history/report.md`: the PRs that need a look, with the old and new values, next to the "
   "number a 'test file changed' alarm would fire on. It runs one check at a time while the machine is idle, and "
   "resumes where it stopped.")}
"""
    return article(g, body)


def commands_page(help_text: str) -> tuple[str, str]:
    g = G["commands/"]
    return article(g, pre(help_text) + p(f"Install: `npm install -g github:intikhab49/goalline`, or run any command "
                                         f"with `{NPX} <command>`."))


# ---------------------------------------------------------------- llms.txt, sitemap
def llms(help_text: str) -> tuple[str, str]:
    lines = ["# goalline", "",
             "> Free, open source CLI and GitHub Action that catches AI coding agents editing tests to pass. It "
             "replays the old version of every test a change edited against the new code, so a moved expectation "
             "shows up with its exact old and new values. It also keeps signed receipts for every check, so CI "
             "can skip what the same code already passed.", "",
             f"- Run: `{NPX} <command>` or `npm install -g github:intikhab49/goalline`. Node 20+ and git, zero "
             f"dependencies, MIT. Version {VERSION}.",
             "- `goalline goalpost --base origin/main -- npx jest {files}`: old tests on the new code. Verdicts: "
             "HELD, MOVED (with old and new values), BROKE, CRASHED (not judged), EMPTY, UNKNOWN. Exits 2 when "
             "something is flagged.",
             "- `goalline prove-red`: new tests must fail on the base code, or they test nothing.",
             "- `goalline guard --hook`: a Claude Code Stop hook that keeps the agent working until it restores a "
             "moved expectation or records why (`guard --ack ... --why ...`, ledger via `guard --report`).",
             "- `goalline history --from-git`: replays the last 200 merged pull requests and reports what goalpost "
             "would have flagged.",
             "- `goalline run --gate <name> --reuse`: signed receipts (in-toto test-result, DSSE, Ed25519) keyed "
             "by the git tree; skips a gate the same code already passed. `--input db=pg` adds the PostgreSQL "
             "schema to the receipt. `goalline verify --require a,b` says which gates are proven.",
             "- Jest, Vitest and pytest are judged test by test; any other runner file by file, by exit code.",
             f"- GitHub Action: `uses: intikhab49/goalline@v0` with `command: npx jest {{files}}`. Marketplace: {MARKET}",
             f"- Benchmark: on pallets/click's last 200 merged PRs, {EDITED} edited a test, {HELD} kept every old "
             f"test passing, {FLAGGED} were flagged with values and {LOW} were low risk, in {CLICK['minutes']}.",
             "- No AI model is involved and no source code leaves the machine.",
             "- Independent project by Intikhab Azam.", "",
             "## Guides", ""]
    lines += [f"- [{g['h1']}]({SITE + g['path']}): {plain(g['desc'])}" for g in GUIDES]
    lines += ["", "## Docs", "",
              f"- [README]({REPO}#readme): everything, with the limits and the trust model",
              f"- [Releases]({REPO}/releases): what changed in each version", ""]
    short_txt = "\n".join(lines + ["## Optional", "", f"- [llms-full.txt]({SITE}llms-full.txt): the README and the "
                                   "full command reference as plain text", ""])
    readme = (ROOT / "README.md").read_text(encoding="utf-8").replace("\r\n", "\n")
    readme = readme.split("\n---\n", 1)[1].strip() if "\n---\n" in readme else readme
    full = "\n".join(lines).rstrip("\n") + "\n\n# README\n\n" + readme + "\n\n# Command reference (goalline help)\n\n" + help_text + "\n"
    return short_txt, full


def sitemap(paths) -> str:
    urls = "".join(f"  <url><loc>{SITE + p_}</loc><lastmod>{TODAY.isoformat()}</lastmod></url>\n" for p_ in paths)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            f"{urls}</urlset>\n")


def readme_faq() -> None:
    """The README's FAQ is the site's FAQ, written between its two markers."""
    path = ROOT / "README.md"
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    start = text.index("<!-- faq:start")
    start = text.index("-->", start) + 3
    end = text.index("<!-- faq:end -->")
    items = "\n\n".join(f"### {q}\n\n{a}" for q, a in FAQ)
    path.write_text(f"{text[:start]}\n\n{items}\n\n{text[end:]}", encoding="utf-8", newline="\n")


def main() -> None:
    readme_faq()
    help_text = cli_help()
    terminal, card = example()
    pages = [landing(terminal), how_it_works(terminal), hook_page(), action_page(card), prove_red_page(),
             skip_page(), inputs_page(), benchmark_page(), commands_page(help_text)]
    assert [p_ for p_, _ in pages[1:]] == [g["path"] for g in GUIDES], "every guide has a page, in order"
    for path, html in pages:
        out = DOCS / path / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(html, encoding="utf-8", newline="\n")
    short_txt, full_txt = llms(help_text)
    (DOCS / "llms.txt").write_text(short_txt, encoding="utf-8", newline="\n")
    (DOCS / "llms-full.txt").write_text(full_txt, encoding="utf-8", newline="\n")
    (DOCS / "sitemap.xml").write_text(sitemap([p_ for p_, _ in pages]), encoding="utf-8", newline="\n")
    (DOCS / "favicon.svg").write_text(FAVICON, encoding="utf-8", newline="\n")
    (DOCS / ".nojekyll").write_text("", encoding="utf-8")
    print(f"wrote {len(pages)} pages, llms.txt, llms-full.txt ({len(full_txt)} chars), sitemap.xml, favicon.svg")


if __name__ == "__main__":
    main()
