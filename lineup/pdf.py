"""PDF print-out of a line-up: page 1 is the drawing, page 2 the valve list.

The drawing mirrors render() in component/frontend/main.js using the same network data.
"""

from __future__ import annotations

import io
import math
from datetime import datetime

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfgen import canvas as pdfcanvas

from .solver import (TEMP_KINDS, active, build_graph, cond_ok, line_active, notes as state_notes, passable,
                     path_info, pipe_mode, temp_item, temp_of)

OPEN = HexColor("#22b14c")
CLOSED = HexColor("#e02424")
HOSE = HexColor("#8e24aa")
ORANGE = HexColor("#ff8c00")
DARK = HexColor("#222222")

PIPE_TEXT = {"none": "no pipe in hole", "drilling": "string made up to top drive", "hangoff": "string hung off"}

_ASCII = str.maketrans({"▲": "^", "▼": "v", "→": "->", "−": "-"})


def _t(s) -> str:
    return str(s).translate(_ASCII)


class _Page:
    """Maps canvas pixel coordinates onto the PDF page."""

    def __init__(self, c, bounds, area):
        bx, by, bw, bh = bounds
        ax, ay, aw, ah = area
        self.c = c
        self.s = min(aw / bw, ah / bh)
        self.ox = ax + (aw - bw * self.s) / 2 - bx * self.s
        self.top = ay + ah - (ah - bh * self.s) / 2 + by * self.s

    def p(self, x, y):
        return self.ox + x * self.s, self.top - y * self.s

    def line(self, pts, color, width, dash=None, alpha=1.0, cap=0):
        c = self.c
        c.saveState()
        c.setStrokeColor(color)
        c.setStrokeAlpha(alpha)
        c.setLineWidth(width * self.s)
        c.setLineCap(cap)
        c.setLineJoin(1)
        if dash:
            c.setDash([d * self.s for d in dash])
        path = c.beginPath()
        for i, (x, y) in enumerate(pts):
            (path.lineTo if i else path.moveTo)(*self.p(x, y))
        c.drawPath(path, stroke=1, fill=0)
        c.restoreState()

    def text(self, x, y, s, size=10, anchor="start", bold=False, color=DARK):
        c = self.c
        c.setFillColor(color)
        c.setFont("Helvetica-Bold" if bold else "Helvetica", size * self.s)
        lines = _t(s).split("\n")
        y0 = y - (len(lines) - 1) * size * 0.55
        for i, ln in enumerate(lines):
            px, py = self.p(x, y0 + i * size * 1.1)
            {"middle": c.drawCentredString, "end": c.drawRightString}.get(anchor, c.drawString)(px, py, ln)

    def rect(self, x, y, w, h, fill=None, stroke=DARK, width=1.0, radius=0, dash=None):
        c = self.c
        c.saveState()
        px, py = self.p(x, y + h)
        if fill is not None:
            c.setFillColor(fill)
        c.setStrokeColor(stroke if stroke is not None else white)
        c.setLineWidth(width * self.s)
        if dash:
            c.setDash([d * self.s for d in dash])
        c.roundRect(px, py, w * self.s, h * self.s, radius * self.s,
                    stroke=1 if stroke is not None else 0, fill=1 if fill is not None else 0)
        c.restoreState()

    def circle(self, x, y, r, fill=None, stroke=DARK, width=1.0, dash=None):
        c = self.c
        c.saveState()
        if fill is not None:
            c.setFillColor(fill)
        if stroke is not None:
            c.setStrokeColor(stroke)
        c.setLineWidth(width * self.s)
        if dash:
            c.setDash([d * self.s for d in dash])
        c.circle(*self.p(x, y), r * self.s, stroke=1 if stroke is not None else 0, fill=1 if fill is not None else 0)
        c.restoreState()

    def poly(self, pts, fill, stroke=DARK, width=1.0):
        c = self.c
        c.saveState()
        c.setFillColor(fill)
        c.setStrokeColor(stroke)
        c.setLineWidth(width * self.s)
        path = c.beginPath()
        for i, (x, y) in enumerate(pts):
            (path.lineTo if i else path.moveTo)(*self.p(x, y))
        path.close()
        c.drawPath(path, stroke=1, fill=1)
        c.restoreState()


def _wrap(s, max_chars):
    lines, cur = [], ""
    for w in str(s).split(" "):
        if cur and len(cur) + 1 + len(w) > max_chars:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    lines.append(cur)
    return "\n".join(lines)


DASHDOT = [14, 4, 3, 4]  # every broken line uses this dash-dot pattern (mirrors DASHDOT in main.js)


def _dash(style):
    return DASHDOT if style else None


def _trim(pts, d):
    def cut(p, d):
        while len(p) > 1 and d > 0:
            (x0, y0), (x1, y1) = p[0], p[1]
            L = math.hypot(x1 - x0, y1 - y0)
            if L <= d:
                p.pop(0)
                d -= L
            else:
                p[0] = [x0 + (x1 - x0) * d / L, y0 + (y1 - y0) * d / L]
                d = 0
    p = [list(q) for q in pts]
    cut(p, d)
    p.reverse()
    cut(p, d)
    p.reverse()
    return p


def _label_pos(n, off):
    lp = n.get("lp", "r")
    if lp == "l":
        return n["x"] - off, n["y"] + 4, "end"
    if lp == "t":
        return n["x"], n["y"] - off + 2, "middle"
    if lp == "tr":
        return n["x"] - 4, n["y"] - off + 2, "start"
    if lp == "b":
        return n["x"], n["y"] + off + 8, "middle"
    return n["x"] + off, n["y"] + 4, "start"


def _bounds(net, temp):
    xs, ys = [], []
    for n in [*net["nodes"].values(), *temp["items"]]:
        xs.append(n["x"]); ys.append(n["y"])
    for line in temp["lines"]:
        for x, y in line.get("pts", []):
            xs.append(x); ys.append(y)
    for e in net["edges"]:
        for seg in e["segs"]:
            for x, y in seg:
                xs.append(x); ys.append(y)
    for d in net["decor"]:
        xs.append(d["x"]); ys.append(d["y"])
        if "w" in d:
            xs.append(d["x"] + d["w"]); ys.append(d["y"] + d["h"])
    return min(xs) - 30, min(ys) - 30, max(xs) - min(xs) + 60, max(ys) - min(ys) + 60


def _valve(pg, x, y, angle, open_, blocked, auto=False, temp=False, choke=False):
    ca, sa = math.cos(math.radians(angle)), math.sin(math.radians(angle))

    def rot(px, py):
        return x + px * ca - py * sa, y + px * sa + py * ca

    if blocked:
        pg.circle(x, y, 13, stroke=ORANGE, width=3)
    if auto:
        pg.line([rot(0, 0), rot(0, -12)], DARK, 1.2)
        pg.poly([rot(-5, -19), rot(5, -19), rot(5, -11), rot(-5, -11)], white, width=1.2)
    fill = OPEN if open_ else CLOSED
    stroke = HOSE if temp else DARK
    pg.poly([rot(-10, -7), rot(0, 0), rot(-10, 7)], fill, stroke, 1.3)
    pg.poly([rot(10, -7), rot(0, 0), rot(10, 7)], fill, stroke, 1.3)
    if choke:  # diagonal arrow through the valve (mirrors drawValve in main.js)
        pg.line([rot(-12, 10), rot(9, -8)], DARK, 1.6)
        pg.poly([rot(13, -11), rot(4, -8.5), rot(10, -2)], DARK, DARK, 0.5)




def _pos(net, temp, iid):
    n = net["nodes"].get(iid) or temp_item(temp, iid)
    return (n["x"], n["y"])


def _line_points(net, temp, line):
    """Straight segments: start, bends, end; without bends an elbow. Mirrors linePoints() in main.js."""
    a, b = _pos(net, temp, line["a"]), _pos(net, temp, line["b"])
    bends = [tuple(p) for p in line.get("pts", [])]
    pts = [a, *bends]
    last = pts[-1]
    if last[0] != b[0] and last[1] != b[1]:
        pts.append((b[0], last[1]) if bends else (b[0], a[1]))
    pts.append(b)
    return pts


def _edge_points(net, state, e, temp):
    """Polyline of an edge from e['a'] to e['b'] (None for virtual edges). Mirrors edgePoints() in main.js."""
    if e.get("line"):
        return _line_points(net, temp, next(x for x in temp["lines"] if x["id"] == e["line"]))
    if not e.get("segs"):
        return None
    return [p for seg in e["segs"] for p in seg]


def _arrows(pg, pts, color, dx=0.0, scale=1.0):
    lengths = [math.hypot(x1 - x0, y1 - y0) for (x0, y0), (x1, y1) in zip(pts, pts[1:])]
    total = sum(lengths)
    if total < 28:
        return
    n = max(1, round(total / 150))
    for k in range(n):
        d = total * (k + 0.5) / n
        for i, s in enumerate(lengths):
            if d <= s or i == len(lengths) - 1:
                (x0, y0), (x1, y1) = pts[i], pts[i + 1]
                t = min(1, d / s) if s else 0
                ang = math.atan2(y1 - y0, x1 - x0)
                ca, sa = math.cos(ang), math.sin(ang)
                cx, cy = x0 + (x1 - x0) * t + dx, y0 + (y1 - y0) * t
                tri = [(cx + scale * (px * ca - py * sa), cy + scale * (px * sa + py * ca))
                       for px, py in ((-6, -5), (7, 0), (-6, 5))]
                pg.poly(tri, color, white, 0.8)
                break
            d -= s


def _draw_network(pg, net, state, graph, infos):
    nodes = net["nodes"]
    colors = {k: HexColor(v) for k, v in net["colors"].items()}
    valves = state["valves"]
    P = net["pipe"]
    mode = pipe_mode(state)

    def pipe_at(y):  # is there drill pipe in the bore at this height? (mirrors pipeAt in main.js)
        return mode == "drilling" or (mode == "hangoff" and y >= P["hang_top"] - 0.5)

    emap = {e["id"]: e for e in graph[1]}
    color_of = {}
    for p in state.get("paths", []):
        for s in p.get("steps", []):
            if s["e"] in emap:
                color_of[s["e"]] = HexColor(p["color"])
    warn = {n for i in infos for n in i["closed_inside"]}

    for d in net["decor"]:
        if d["t"] == "text":
            pg.text(d["x"], d["y"], d["s"], d["size"], d["anchor"], d["weight"] == "bold", HexColor(d["color"]))
        elif d["t"] == "rect":
            pg.rect(d["x"], d["y"], d["w"], d["h"], stroke=HexColor(d["stroke"]), dash=[6, 4] if d.get("dash") else None)
        elif d["t"] == "bop":
            rx, ry, rw, rh = d["riser"]
            pg.rect(rx - 3, ry, rw + 6, rh, fill=HexColor("#cfd4da"), stroke=HexColor("#444444"))
            pg.rect(d["x"], d["y"], d["w"], d["h"], fill=HexColor("#cfd4da"), stroke=HexColor("#444444"), width=1.5, radius=6)

    visible = [e for e in net["edges"] if cond_ok(e.get("cond"), state)]

    def draw_line(e):
        for seg in e["segs"]:
            pg.line(seg, color_of.get(e["id"], colors.get(e["r"], DARK)), 3, _dash(e.get("style")))

    for e in visible:
        if not e.get("over") and e["r"] not in ("bore", "string"):
            draw_line(e)
    for e in visible:
        if e.get("over"):
            for seg in e["segs"]:
                pg.line(_trim(seg, 12), white, 11)
            draw_line(e)
    bores = [e for e in visible if e["r"] == "bore"]
    for e in bores:
        for seg in e["segs"]:
            pg.line(seg, HexColor("#444444"), P["bore"] + 4)
    for e in bores:
        for seg in e["segs"]:
            pg.line(seg, color_of.get(e["id"], white), P["bore"])
    for e in visible:  # hollow drill pipe: walls with its own inside channel
        if e["r"] == "string":
            for seg in e["segs"]:
                pg.line(seg, HexColor("#111111"), P["od"])
                pg.line(seg, color_of.get(e["id"], white), P["id"])
    for e in visible:
        for t in e.get("tags", []):
            pg.text(t["x"], t["y"], t["s"], 9, t.get("anchor", "start"), color=HexColor("#555555"))

    # temporary lines (straight segments) and their labels
    temp = temp_of(net, state)
    line_labels = []
    for line in temp["lines"]:
        if not line_active(line, net, state, temp):
            continue
        pts = _line_points(net, temp, line)
        pg.line(pts, color_of.get(line["id"], HOSE), 3, DASHDOT)
        if line.get("label"):
            best, at, horiz = -1, pts[0], True
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                L = math.hypot(x1 - x0, y1 - y0)
                if L > best:
                    best, at, horiz = L, ((x0 + x1) / 2, (y0 + y1) / 2), abs(x1 - x0) >= abs(y1 - y0)
            # drawn after everything else, so equipment never hides it
            line_labels.append((at[0], at[1] - 7, "middle") if horiz else (at[0] + 7, at[1] + 4, "start"))
            line_labels[-1] += (line["label"],)

    # flow direction arrows
    for p in state.get("paths", []):
        if not p.get("arrows", True):
            continue
        for s in p.get("steps", []):
            e = emap.get(s["e"])
            pts = e and _edge_points(net, state, e, temp)
            if not pts:
                continue
            fwd = pts if s["from"] == e["a"] else pts[::-1]
            col = HexColor(p["color"])
            if e["r"] == "bore" and pipe_at(nodes[e["a"]]["y"]) and pipe_at(nodes[e["b"]]["y"]):
                off = (P["od"] + (P["bore"] - P["od"]) / 2) / 2  # annulus: an arrow on each side of the pipe
                _arrows(pg, fwd, col, -off, 0.7)
                _arrows(pg, fwd, col, off, 0.7)
            else:
                _arrows(pg, fwd, col, 0, 0.75 if e["r"] == "string" else 1)

    # nodes
    for n in nodes.values():
        if not active(n, state):
            continue
        t = n["type"]
        if t == "valve":
            _valve(pg, n["x"], n["y"], -90 if n["o"] == "v" else 0, valves.get(n["id"]) == "open",
                   n["id"] in warn, n.get("auto"), choke=n.get("choke", False))
            if n.get("label") and not n.get("hide"):
                actuator_side = "l" if n["o"] == "v" else "t"
                x, y, a = _label_pos(n, 24 if n.get("auto") and n.get("lp") == actuator_side else 13)
                pg.text(x, y, n["label"], 10, a, True)
        elif t == "ram":
            closed = valves.get(n["id"]) == "closed"
            half, stub, h = 48, 20, (16 if n["kind"] == "annular" else 10)
            col = CLOSED if closed else OPEN
            if closed and pipe_at(n["y"]) and not n["kind"].startswith("shear"):
                w = half - P["od"] / 2  # closed around the pipe
                pg.rect(n["x"] - half, n["y"] - h / 2, w, h, fill=col, width=2)
                pg.rect(n["x"] + half - w, n["y"] - h / 2, w, h, fill=col, width=2)
                if n["id"] in warn:
                    pg.rect(n["x"] - half - 3, n["y"] - h / 2 - 3, 2 * half + 6, h + 6, stroke=ORANGE, width=2.5)
            elif closed:
                pg.rect(n["x"] - half, n["y"] - h / 2, 2 * half, h, fill=col, width=2)
                if n["id"] in warn:
                    pg.rect(n["x"] - half - 3, n["y"] - h / 2 - 3, 2 * half + 6, h + 6, stroke=ORANGE, width=2.5)
            else:
                pg.rect(n["x"] - half, n["y"] - h / 2, stub, h, fill=col)
                pg.rect(n["x"] + half - stub, n["y"] - h / 2, stub, h, fill=col)
            pg.text(n["x"] + 66, n["y"] + 4, n["label"] + (" (closed)" if closed else ""), 10, bold=closed,
                    color=HexColor("#bb0000") if closed else DARK)
        elif t == "pump":
            on = n["id"] in state.get("pumps", [])  # running is a visual aid only
            fill = HexColor("#1aa64a") if on else HexColor("#3b5ba5")
            if n.get("shape") == "rect":
                pg.rect(n["x"] - 28, n["y"] - 18, 56, 36, fill=fill, radius=4)
                if on:
                    pg.rect(n["x"] - 32, n["y"] - 22, 64, 44, stroke=fill, width=2.5, radius=6, dash=[6, 4])
            else:
                pg.circle(n["x"], n["y"], 24, fill=fill)
                if on:
                    pg.circle(n["x"], n["y"], 29, stroke=fill, width=2.5, dash=[6, 4])
            pg.text(n["x"], n["y"] + 4, n["label"], 8 if n.get("shape") == "rect" else 10, "middle", True, white)
        elif t == "outlet":
            pg.circle(n["x"], n["y"], 5, fill=HexColor("#777777"))
            x, y, a = _label_pos(n, 9)
            pg.text(x, y, n["label"], 9.5, a)
        elif t in ("vessel", "buffer"):
            x, y, w, h = n["rect"]
            radius = n.get("radius", min(w, h) / 2.5 if t == "vessel" else 2)
            pg.rect(x, y, w, h, fill=HexColor("#eceff1"), width=1.5, radius=radius)
            if n.get("label"):
                if h > w * 2:
                    c = pg.c
                    c.saveState()
                    c.translate(*pg.p(x + w / 2 + 3, y + h / 2))
                    c.rotate(90)
                    c.setFillColor(DARK)
                    c.setFont("Helvetica-Bold", 10 * pg.s)
                    c.drawCentredString(0, 0, n["label"])
                    c.restoreState()
                elif h > 40:
                    pg.text(x + w / 2, y + h / 2 + 3, _wrap(n["label"], 9), 9, "middle", True)
                else:
                    pg.text(x + w / 2, y + h / 2 + 3, n["label"], 8, "middle")
        elif t == "box":
            pg.rect(n["x"] - n["w"] / 2, n["y"] - n["h"] / 2, n["w"], n["h"], fill=HexColor(n["fill"]), width=1.2)
            if n.get("label"):
                pg.text(n["x"], n["y"] + 3, _wrap(n["label"], max(4, int(n["w"] / 6))),
                        12 if n["w"] < 30 else 8.5, "middle", True)
        elif t == "cp":
            pg.circle(n["x"], n["y"], 6, fill=white, stroke=HOSE, width=2.5)
            x, y, a = _label_pos(n, 10)
            pg.text(x, y, n["label"], 8.5, a, color=HOSE)

    # temporary parts and labels on top (mirrors drawTempItems in main.js)
    for x, y, anchor, s in line_labels:
        pg.text(x, y, s, 10, anchor, True, HOSE)
    for it in temp["items"]:
        x, y, kind = it["x"], it["y"], it["kind"]
        ang = -90 if it.get("o") == "v" else 0
        ca, sa = math.cos(math.radians(ang)), math.sin(math.radians(ang))

        def rot(px, py):
            return x + px * ca - py * sa, y + px * sa + py * ca

        if kind == "text":
            pg.text(x, y, it.get("label") or "Text", 11, "start", True, HOSE)
            continue
        if kind in ("valve", "lotorq"):
            _valve(pg, x, y, ang, valves.get(it["id"]) == "open", it["id"] in warn, temp=True)
            if kind == "lotorq":
                pg.circle(x, y, 3.5, fill=white, width=1.3)
        elif kind in ("tee", "cross"):
            pg.rect(x - 6, y - 6, 12, 12, fill=white, stroke=HOSE, width=2)
            if kind == "tee":
                pg.line([rot(-4, -3), rot(4, -3)], HOSE, 1.6)
                pg.line([rot(0, -3), rot(0, 4)], HOSE, 1.6)
            else:
                pg.line([(x - 4, y), (x + 4, y)], HOSE, 1.6)
                pg.line([(x, y - 4), (x, y + 4)], HOSE, 1.6)
        elif kind == "cap":
            pg.poly([rot(-3, -9), rot(3, -9), rot(3, 9), rot(-3, 9)], HOSE, DARK, 1)
        if it.get("label"):
            if it.get("o") == "v":
                pg.text(x + 15, y + 4, it["label"], 10, "start", True, HOSE)
            else:
                pg.text(x, y - 15, it["label"], 10, "middle", True, HOSE)


def _name(net, state, nid):
    n = net["nodes"].get(nid)
    if n:
        return (n.get("label") or nid).replace("\n", " ")
    it = temp_item(temp_of(net, state), nid)
    if it:
        return it.get("label") or f"{TEMP_KINDS[it['kind']][1]} (temp.)"
    return nid


def build_pdf(net: dict, state: dict, name: str, notes: str = "", author: str = "",
              warnings: dict | None = None) -> bytes:
    """warnings: path id -> conflict warnings, as computed by the canvas (pathWarnings in main.js)."""
    warnings = warnings or {}
    graph = build_graph(net, state)
    paths = state.get("paths", [])
    infos = [path_info(net, state, p) for p in paths]
    buf = io.BytesIO()
    W, H = landscape(A3)
    c = pdfcanvas.Canvas(buf, pagesize=(W, H))
    c.setTitle(f"Line-up: {name}")
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")

    def header(page):
        c.setFont("Helvetica-Bold", 16)
        c.setFillColor(DARK)
        c.drawString(30, H - 36, f"{net['rig']} - Line-up: {name or 'Unsaved'}")
        c.setFont("Helvetica", 9)
        right = f"Printed {stamp}" + (f"  |  {author}" if author else "") + f"  |  Page {page}/2"
        c.drawRightString(W - 30, H - 36, right)
        c.setLineWidth(0.6)
        c.line(30, H - 44, W - 30, H - 44)

    def path_title(p, i, x, y):
        c.setFillColor(HexColor(p["color"]))
        c.rect(x, y - 1, 22, 6, stroke=0, fill=1)
        c.setFillColor(DARK)
        c.setFont("Helvetica-Bold", 9)
        txt = p.get("name", p["id"])
        if i["start"]:
            txt += f":  {_name(net, state, i['start'])} -> {_name(net, state, i['end'])}"
        c.drawString(x + 28, y, _t(txt))

    # ---- page 1: drawing, with a key of the traced paths along the bottom
    header(1)
    pg = _Page(c, _bounds(net, temp_of(net, state)), (25, 70, W - 50, H - 125))
    _draw_network(pg, net, state, graph, infos)
    for k, (p, i) in enumerate(zip(paths, infos)):
        path_title(p, i, 30 + (k // 4) * 380, 52 - (k % 4) * 13)
    c.setFont("Helvetica", 9)
    c.setFillColor(DARK)
    c.drawRightString(W - 30, 22, f"Pipe: {PIPE_TEXT[pipe_mode(state)]}")
    c.showPage()

    # ---- page 2: lists
    header(2)
    y = H - 70
    nodes = net["nodes"]
    valves = state["valves"]
    temp = temp_of(net, state)
    temp_valves = [i for i in temp["items"] if i["kind"] in ("valve", "lotorq")]
    real_valves = [n for n in nodes.values() if n["type"] == "valve"]

    def section(title, items, x, y):
        c.setFillColor(DARK)
        c.setFont("Helvetica-Bold", 11)
        c.drawString(x, y, title)
        y -= 14
        c.setFont("Helvetica", 9)
        for it in items or ["-"]:
            c.drawString(x + 8, y, _t(it))
            y -= 12
        return y - 10

    def wrap_list(labels, width=52):
        lines, cur = [], ""
        for lbl in labels:
            if cur and len(cur) + len(lbl) + 2 > width:
                lines.append(cur + ",")
                cur = lbl
            else:
                cur = f"{cur}, {lbl}" if cur else lbl
        if cur:
            lines.append(cur)
        return lines

    order = lambda n: (n["x"] > 1150, n["y"], n["x"])  # noqa: E731
    opened = [n for n in sorted(real_valves, key=order) if valves.get(n["id"]) == "open"]
    closed_ = [n for n in sorted(real_valves, key=order) if valves.get(n["id"]) != "open"]
    rams = [n for n in nodes.values() if n["type"] == "ram"]

    col = [30, 300, 570, 840]
    y1 = section("OPEN valves", [f"{n['label'] or n['id']}" + (" (auto)" if n.get("auto") else "") for n in opened], col[0], y)
    section("Temporary valves", [f"{TEMP_KINDS[v['kind']][1]} {v.get('label', '')}: {valves.get(v['id'], 'closed').upper()}"
                                 for v in temp_valves], col[0], y1)
    section("CLOSED valves", wrap_list([n["label"] or n["id"] for n in closed_]), col[1], y)
    y3 = section("BOP", [f"{r['label']}: {valves.get(r['id'], 'open').upper()}" for r in rams] +
                 [f"Pipe: {PIPE_TEXT[pipe_mode(state)]}"], col[2], y)
    rig = [f"{TEMP_KINDS[i['kind']][1]}{': ' + i['label'] if i.get('label') else ''}"
           for i in temp["items"] if i["kind"] not in ("valve", "lotorq", "text")]
    rig += [f"Line{' ' + ln['label'] if ln.get('label') else ''}: {_name(net, state, ln['a'])} -> "
            f"{_name(net, state, ln['b'])} ({ln.get('rating', '15k')})" for ln in temp["lines"]]
    y3 = section("Temporary rig-up", rig, col[2], y3)
    y3 = section("Pumps running", [_name(net, state, p) for p in state.get("pumps", [])], col[2], y3)
    general = state_notes(net, state)
    if general:
        y3 = section("Warnings", general, col[2], y3)
    if notes:
        section("Notes", notes.splitlines(), col[2], y3)

    # traced paths: valves passed in flow order with their state
    y4 = y
    c.setFont("Helvetica-Bold", 11)
    c.drawString(col[3], y4, "Flow paths")
    y4 -= 16
    if not paths:
        c.setFont("Helvetica", 9)
        c.drawString(col[3] + 8, y4, "-")
    gnodes = graph[0]
    for p, i in zip(paths, infos):
        path_title(p, i, col[3], y4)
        y4 -= 12
        c.setFont("Helvetica", 9)
        states = [f"{_name(net, state, v)} ({'open' if passable(gnodes[v], state) else 'CLOSED'})" for v in i["valves"]]
        for line in wrap_list(states, 60) or ["no valves"]:
            c.drawString(col[3] + 8, y4, _t(line))
            y4 -= 11
        if i["closed_inside"]:
            c.setFillColor(HexColor("#b45309"))
            c.drawString(col[3] + 8, y4, _t("Passes closed: " + ", ".join(_name(net, state, n) for n in i["closed_inside"])))
            c.setFillColor(DARK)
            y4 -= 11
        for w in warnings.get(p["id"], []):
            c.setFillColor(HexColor("#b45309"))
            for line in _wrap(w, 70).split("\n"):
                c.drawString(col[3] + 8, y4, _t(line))
                y4 -= 11
            c.setFillColor(DARK)
        y4 -= 8
    c.showPage()
    c.save()
    return buf.getvalue()