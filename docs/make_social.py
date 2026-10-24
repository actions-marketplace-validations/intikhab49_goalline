"""Generate the social preview card (1280x640, GitHub's recommended size).

  python docs/make_social.py

Writes docs/social.svg and, with Chrome installed, renders docs/social.png. Upload the PNG in GitHub:
Settings, General, Social preview. The website's og:image is the same file. It reuses the header's
colours and its ledger, so the click counts are the real ones.
"""
import pathlib
import shutil
import subprocess
import sys
import xml.dom.minidom

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))

import make_header as h  # noqa: E402

W, H = 1280, 640
FLAGGED, LOW, HELD = (h.LEDGER.count(c) for c in "flh")


def pills(x0, y0, items):
    out, x = [], x0
    for text, colour in items:
        w = 34 + 10.8 * len(text.replace("&#183;", "."))
        out.append(f'<rect x="{x:.0f}" y="{y0}" width="{w:.0f}" height="40" rx="20" fill="none" '
                   f'stroke="{colour}" stroke-opacity="0.6"/>')
        out.append(f'<text x="{x + w / 2:.0f}" y="{y0 + 27}" fill="{colour}" text-anchor="middle">{text}</text>')
        x += w + 14
    return "\n    ".join(out)


def build():
    x0, y0 = 843, 152
    ledger = h.ledger_svg(x0, y0, cell=24, gap=7, cols=12)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img"
     aria-label="goalline: did your agent fix the code, or the test? Old tests replayed on new code. On
     pallets/click, {FLAGGED} of {len(h.LEDGER)} test-editing PRs moved an expectation.">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="{h.AMBER}"/>
      <stop offset="55%" stop-color="{h.CORAL}"/>
      <stop offset="100%" stop-color="{h.PINK}"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{h.CORAL}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="{h.BG}" stop-opacity="0"/>
    </linearGradient>
    <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
      <path d="M28 0 L0 0 0 28" fill="none" stroke="#FFFFFF" stroke-opacity="0.04" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="{W}" height="{H}" fill="{h.BG}"/>
  <rect width="{W}" height="{H}" fill="url(#grid)"/>
  <circle cx="{W - 170}" cy="90" r="330" fill="url(#fade)"/>

  <text x="72" y="104" font-family="{h.MONO}" font-size="20" letter-spacing="4" fill="{h.LIME}">GOAL-LINE
        TECHNOLOGY &#183; FOR YOUR TESTS</text>
  <text x="66" y="226" font-family="Georgia,'Times New Roman',serif" font-size="120" font-weight="700"
        fill="url(#grad)">goalline</text>
  <text x="72" y="292" font-family="{h.SANS}" font-size="34" fill="#E8E8F0">Did your agent fix the code, or the test?</text>
  <text x="72" y="340" font-family="{h.SANS}" font-size="26" fill="{h.DIM}">Old tests replayed on new code. Every moved</text>
  <text x="72" y="374" font-family="{h.SANS}" font-size="26" fill="{h.DIM}">expectation, with its old and new values.</text>

  <g font-family="{h.MONO}" font-size="18">
    {pills(72, 414, [("JEST &#183; VITEST &#183; PYTEST", h.AMBER), ("GITHUB ACTION", h.LIME),
                     ("CLAUDE CODE HOOK", h.PINK)])}
  </g>

  <text x="72" y="552" font-family="{h.MONO}" font-size="26" fill="#E8E8F0">$ npx github:intikhab49/goalline</text>
  <text x="72" y="592" font-family="{h.MONO}" font-size="19" fill="{h.DIM}">free &#183; open source &#183; MIT &#183; zero dependencies</text>

  <text x="{x0}" y="{y0 - 22}" font-family="{h.MONO}" font-size="16" letter-spacing="1.5" fill="{h.DIM}">PALLETS/CLICK
        &#183; {len(h.LEDGER)} TEST-EDITING PRs</text>
  <g>
    {ledger}
  </g>
  <g font-family="{h.MONO}" font-size="26">
    <text x="{x0}" y="{y0 + 262}" fill="#FFFFFF" font-weight="700">{FLAGGED} flagged, with values</text>
    <text x="{x0}" y="{y0 + 300}" fill="{h.DIM}">{HELD} kept every old test</text>
    <text x="{x0}" y="{y0 + 338}" fill="{h.DIM}"> {LOW} low risk &#183; 0 not judged</text>
  </g>
</svg>
"""


if __name__ == "__main__":
    svg = build()
    xml.dom.minidom.parseString(svg)          # fails loudly on a bare '&'
    (HERE / "social.svg").write_text(svg, encoding="utf-8", newline="\n")
    chrome = shutil.which("chrome") or r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    if pathlib.Path(chrome).exists():
        subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--window-size={W},{H}",
                        f"--screenshot={HERE / 'social.png'}", (HERE / "social.svg").resolve().as_uri()],
                       check=False, capture_output=True)
    print("wrote docs/social.svg" + (" and docs/social.png" if (HERE / "social.png").exists() else ""))
