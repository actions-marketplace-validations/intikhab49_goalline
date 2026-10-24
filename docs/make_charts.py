"""Charts for the README, in Open Jev's palette. Regenerate with:  python docs/make_charts.py

The numbers come from one run, written down here so the chart never drifts from it:
    goalline history --from-git --limit 200 -- python -m pytest {files}
on pallets/click at 2247b35 (the last 200 merged PRs, up to 2026-10-04), pytest 9.0.2, Python 3.11.
"""
import pathlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

SURFACE, INK, INK_2, MUTED, BASELINE = "#fcfcfb", "#0b0b0b", "#52514e", "#898781", "#c3c2b7"
S1, S2, GOOD, CRITICAL = "#2a78d6", "#eb6834", "#0ca30c", "#d03b3b"

ROWS = [
    ("merged PRs replayed", 200, BASELINE),
    ('edited an existing test\n(a "test changed" alarm fires)', 84, S1),
    ("kept every old test passing", 63, GOOD),
    ("flagged: an old expectation moved,\nshown with its old and new values", 19, CRITICAL),
    ("low risk: the PR only added\nlines to the old test", 2, S2),
    ("could not be judged", 0, MUTED),
]


def style():
    matplotlib.rcParams.update({
        "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
        "text.color": INK, "axes.labelcolor": INK_2, "xtick.color": MUTED, "ytick.color": INK_2,
        "axes.edgecolor": BASELINE, "axes.linewidth": 1.0,
        "axes.spines.top": False, "axes.spines.right": False,
        "axes.grid": True, "grid.color": BASELINE, "grid.alpha": 0.45, "grid.linewidth": 0.8,
        "font.size": 11, "axes.titlesize": 13, "axes.titleweight": "bold",
        "axes.titlelocation": "left", "axes.titlepad": 26, "figure.dpi": 120,
    })


def click_history(out):
    fig, ax = plt.subplots(figsize=(9.6, 4.6))
    labels = [r[0] for r in ROWS][::-1]
    values = [r[1] for r in ROWS][::-1]
    colours = [r[2] for r in ROWS][::-1]
    ax.barh(labels, values, color=colours, height=0.62, zorder=3)
    for y, v in enumerate(values):
        ax.text(v + 3, y, str(v), va="center", ha="left", fontsize=12, fontweight="bold", color=INK, zorder=4)
    ax.set_xlim(0, 230)
    ax.grid(axis="y", visible=False)
    ax.set_axisbelow(True)
    ax.set_title("goalline on pallets/click: the last 200 merged PRs")
    ax.text(0, 1.035, "Each PR's old tests, run on its merged code. About 2 minutes of machine time.",
            transform=ax.transAxes, fontsize=10.5, color=INK_2)
    ax.set_xlabel("PRs")
    fig.tight_layout()
    fig.savefig(out, dpi=160)
    plt.close(fig)


if __name__ == "__main__":
    style()
    charts = pathlib.Path(__file__).parent / "charts"
    charts.mkdir(exist_ok=True)
    click_history(charts / "click-history.png")
    print(f"wrote {charts / 'click-history.png'}")
