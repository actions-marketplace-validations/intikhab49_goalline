"""Generate the README header SVG. Self-hosted on purpose.

Badge and banner services time out through GitHub's camo proxy often enough to leave a broken image
on the front page, so the header is generated here and committed. Regenerate with:
    python docs/make_header.py

The grid on the right is a real result: the 84 pallets/click PRs (of its last 200 merged) that
edited an existing test, in merge order, each coloured by what goalline found. Validates as XML
before writing: a bare '&' in SVG text is invalid XML and GitHub shows "Invalid image source".
"""
import pathlib
import xml.dom.minidom

W, H = 1200, 340
BG = "#0A0A14"
AMBER, CORAL, PINK = "#FFB020", "#FF6B4A", "#FF4E88"
LIME, BLUE, DIM = "#A3E635", "#5B9BFF", "#8B8BA7"
MONO = "ui-monospace,SFMono-Regular,Menlo,monospace"
SANS = "-apple-system,Segoe UI,Helvetica,sans-serif"

# f = flagged (an old expectation moved), l = low risk, h = held. From goalline history on
# pallets/click at 2247b35: 19 f, 2 l, 63 h.
LEDGER = "fhhhhhhhffhhfhhhhhhhhhhhhhhhfhhhhhhfhhhlhfhhhffhhhfhhhfhhlfhhhhhhhhfhffhhhhhhfhhhfff"
assert (LEDGER.count("f"), LEDGER.count("l"), LEDGER.count("h")) == (19, 2, 63)


def ledger_svg(x0, y0, cell=14, gap=5, cols=12):
    out = []
    for i, c in enumerate(LEDGER):
        x, y = x0 + (i % cols) * (cell + gap), y0 + (i // cols) * (cell + gap)
        fill, op = {"f": ("url(#grad)", "1"), "l": (AMBER, "0.9"), "h": ("#E8E8F0", "0.2")}[c]
        out.append(f'<rect x="{x}" y="{y}" width="{cell}" height="{cell}" rx="2" fill="{fill}" opacity="{op}"/>')
    return "\n    ".join(out)


def pill(x, w, label, colour):
    return (f'<rect x="{x}" y="262" width="{w}" height="28" rx="14" fill="none" stroke="{colour}" '
            f'stroke-opacity="0.55"/>\n    <text x="{x + w / 2:.0f}" y="281" fill="{colour}" '
            f'text-anchor="middle">{label}</text>')


PILLS = [(184, "JEST &#183; VITEST &#183; PYTEST", AMBER), (150, "ZERO DEPENDENCIES", LIME),
         (138, "SIGNED RECEIPTS", BLUE), (146, "CLAUDE CODE HOOK", PINK)]
pills, x = [], 64
for w, label, colour in PILLS:
    pills.append(pill(x, w, label, colour))
    x += w + 12

SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}"
     viewBox="0 0 {W} {H}" role="img"
     aria-label="goalline: goal-line technology for your tests. Prove it passed, skip what's proven,
     catch what moved. On pallets/click's last 200 merged PRs, 84 edited a test, 63 kept every old
     test passing and 19 were flagged with exact values.">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="{AMBER}"/>
      <stop offset="55%" stop-color="{CORAL}"/>
      <stop offset="100%" stop-color="{PINK}"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{CORAL}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="{BG}" stop-opacity="0"/>
    </linearGradient>
    <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
      <path d="M28 0 L0 0 0 28" fill="none" stroke="#FFFFFF" stroke-opacity="0.04" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="{W}" height="{H}" fill="{BG}"/>
  <rect width="{W}" height="{H}" fill="url(#grid)"/>
  <circle cx="{W - 160}" cy="70" r="240" fill="url(#fade)"/>

  <text x="64" y="86" font-family="{MONO}" font-size="13" letter-spacing="3.5" fill="{LIME}">GOAL-LINE
        TECHNOLOGY &#183; FOR YOUR TESTS</text>

  <text x="60" y="164" font-family="Georgia,'Times New Roman',serif" font-size="68" font-weight="700"
        fill="url(#grad)">goalline</text>

  <text x="64" y="204" font-family="{SANS}" font-size="19" fill="#E8E8F0">Prove it passed. Skip
        what's proven. Catch what moved.</text>
  <text x="64" y="232" font-family="{SANS}" font-size="19" fill="{DIM}">Signed receipts for every
        check, and the old tests replayed on the new code.</text>

  <g font-family="{MONO}" font-size="12">
    {(chr(10) + "    ").join(pills)}
  </g>

  <text x="818" y="74" font-family="{MONO}" font-size="11" letter-spacing="2" fill="{DIM}">PALLETS/CLICK
        &#183; 84 PRs THAT EDITED A TEST</text>
  <g>
    {ledger_svg(818, 90)}
  </g>
  <g font-family="{MONO}" font-size="13">
    <text x="818" y="250" fill="#FFFFFF" font-weight="700">19  flagged, with exact values</text>
    <text x="818" y="272" fill="{DIM}">63  kept every old test passing</text>
    <text x="818" y="294" fill="{DIM}"> 2  low risk &#183;  0 not judged</text>
  </g>
</svg>
"""

if __name__ == "__main__":
    out = pathlib.Path(__file__).parent / "header.svg"
    xml.dom.minidom.parseString(SVG)  # fails loudly on a bare '&'
    out.write_text(SVG, encoding="utf-8")
    print(f"wrote {out} ({len(SVG)} bytes, valid XML)")
