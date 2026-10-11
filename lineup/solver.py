"""Graph helpers and traced-path summaries.

Mirrors buildGraph / passable / pathInfo / notes in component/frontend/main.js -
keep the two in sync. Path tracing itself (manual and start -> end) happens in the
browser; Python only needs to describe a saved path for the PDF.
"""

from __future__ import annotations

import math


def pipe_mode(state: dict) -> str:
    """'none', 'drilling' or 'hangoff' (older saves used the boolean pipe_in_hole)."""
    return state.get("pipe") or ("drilling" if state.get("pipe_in_hole") else "none")


def cond_ok(cond: str | None, state: dict) -> bool:
    m = pipe_mode(state)
    return {"drill": m == "drilling", "notd": m != "drilling", "pipe": m != "none",
            "hang": m == "hangoff"}.get(cond, True)


def active(node: dict | None, state: dict) -> bool:
    """Does this node exist in the current pipe mode?"""
    return node is None or cond_ok(node.get("cond"), state)


# Temporary rig-up: state["temp"] = {"items": [...], "lines": [...]} (see migrateTemp in main.js).
TEMP_KINDS = {
    "valve": ("valve", "Valve"),
    "tee": ("junction", "T-piece"),
    "cross": ("junction", "4-way piece"),
    "cap": ("cap", "Blind cap"),
    "text": (None, "Text"),
}


def _snap(v: float) -> int:
    return int(round(v / 5) * 5)


def temp_of(net: dict, state: dict) -> dict:
    """Temporary items and lines; converts the older state["hoses"] format (ids kept)."""
    if "temp" in state:
        t = state["temp"] or {}
        # older saves had a separate Lo-Torq valve; it is the same as a valve
        items = [{**i, "kind": "valve"} if i.get("kind") == "lotorq" else i for i in t.get("items", [])]
        return {"items": [i for i in items if i.get("kind") in TEMP_KINDS], "lines": t.get("lines", [])}
    items, lines = [], []
    for h in state.get("hoses", []):
        a, b = net["nodes"].get(h["a"]), net["nodes"].get(h["b"])
        if not a or not b:
            continue
        rating = h.get("rating", "15k")
        if h.get("valve"):
            vid = h["id"] + "_V"
            items.append({"id": vid, "kind": "valve", "x": _snap((a["x"] + b["x"]) / 2), "y": _snap((a["y"] + b["y"]) / 2),
                          "o": "h" if abs(b["x"] - a["x"]) >= abs(b["y"] - a["y"]) else "v", "label": h.get("label", "")})
            lines.append({"id": h["id"] + "a", "a": h["a"], "b": vid, "pts": [], "label": "", "rating": rating})
            lines.append({"id": h["id"] + "b", "a": vid, "b": h["b"], "pts": [], "label": "", "rating": rating})
        else:
            lines.append({"id": h["id"], "a": h["a"], "b": h["b"], "pts": [], "label": h.get("label", ""), "rating": rating})
    return {"items": items, "lines": lines}


def temp_item(temp: dict, iid: str) -> dict | None:
    return next((i for i in temp["items"] if i["id"] == iid), None)


# T-pieces and 4-ways: a port at the end of each arm (line["pa"] / line["pb"]). Mirrors PORTS in main.js.
ARM = 14
PORTS = {"tee": [(-ARM, 0), (ARM, 0), (0, ARM)], "cross": [(-ARM, 0), (ARM, 0), (0, -ARM), (0, ARM)]}


def part_angle(it: dict) -> float:
    """Rotation of a temporary part in degrees (older saves only have o: 'h' / 'v')."""
    r = it.get("r")
    return r if r is not None else (-90 if it.get("o") == "v" else 0)


def port_pos(it: dict, k: int) -> tuple[int, int]:
    px, py = PORTS[it["kind"]][k]
    a = math.radians(part_angle(it))
    return (round(it["x"] + px * math.cos(a) - py * math.sin(a)), round(it["y"] + px * math.sin(a) + py * math.cos(a)))


def temp_node(it: dict) -> dict:
    ntype, name = TEMP_KINDS[it["kind"]]
    return {"id": it["id"], "type": ntype, "kind": it["kind"], "temp": True, "x": it["x"], "y": it["y"],
            "o": it.get("o", "h"), "label": it.get("label") or name}


def line_active(line: dict, net: dict, state: dict, temp: dict) -> bool:
    """A temporary line is connected while both ends exist in the current pipe mode."""
    def ok(i):
        if i in net["nodes"]:
            return active(net["nodes"][i], state)
        it = temp_item(temp, i)
        return bool(it) and it["kind"] != "text"
    return ok(line["a"]) and ok(line["b"])


def build_graph(net: dict, state: dict):
    """Return (nodes, edges) active for this state, including temporary hoses
    and the shear-ram string cuts."""
    nodes = dict(net["nodes"])
    valves = state.get("valves", {})
    edges = [e for e in net["edges"] if cond_ok(e.get("cond"), state)]

    if pipe_mode(state) == "drilling":
        # A closed shear ram cuts the string: the string above opens into the
        # bore just above the ram, the string below is no longer connected.
        for n in net["nodes"].values():
            if n["type"] == "ram" and n.get("string") and valves.get(n["id"]) == "closed":
                s = n["string"]
                below = _string_below(net, s)
                edges = [e for e in edges if not (e.get("r") == "string" and {e["a"], e["b"]} == {s, below})]
                edges.append({"id": f"cut_{n['id']}", "a": s, "b": n["above"], "r": "virtual", "segs": []})

    temp = temp_of(net, state)
    for it in temp["items"]:
        if it["kind"] != "text":
            nodes[it["id"]] = temp_node(it)
    for line in temp["lines"]:
        if line_active(line, net, state, temp):
            edges.append({"id": line["id"], "a": line["a"], "b": line["b"], "r": line.get("rating", "15k"),
                          "segs": [], "line": line["id"]})
    return nodes, edges


def _string_below(net: dict, s: str) -> str | None:
    """The string node directly below string node `s` (larger y)."""
    y = net["nodes"][s]["y"]
    best = None
    for e in net["edges"]:
        if e.get("r") != "string" or s not in (e["a"], e["b"]):
            continue
        other = e["b"] if e["a"] == s else e["a"]
        oy = net["nodes"][other]["y"]
        if oy > y and (best is None or oy < net["nodes"][best]["y"]):
            best = other
    return best


def passable(node: dict, state: dict) -> bool:
    """Can fluid flow through this node?"""
    t = node["type"]
    st = state.get("valves", {}).get(node["id"])
    if t == "valve":
        return st == "open"
    if t == "ram":
        closed = st == "closed"
        kind = node["kind"]
        if kind == "pipe":  # a hung-off string also runs through all pipe rams
            return not (closed and pipe_mode(state) != "none")
        if kind == "shear_ns":
            return True
        return not closed
    return not node.get("block")  # block: a dead end such as the downlink skid


def path_info(net: dict, state: dict, path: dict) -> dict:
    """Start/end, valves passed and closed valves on a traced path."""
    nodes, edges = build_graph(net, state)
    emap = {e["id"]: e for e in edges}
    steps = [s for s in path.get("steps", []) if s["e"] in emap]
    info = {"start": None, "end": None, "valves": [], "closed_inside": [], "closed_ends": [],
            "inactive": len(path.get("steps", [])) - len(steps)}
    if not steps:
        return info
    seq = []
    for s in steps:
        e = emap[s["e"]]
        seq += [s["from"], e["b"] if s["from"] == e["a"] else e["a"]]
    info["start"], info["end"] = seq[0], seq[-1]
    order = list(dict.fromkeys(seq))
    info["valves"] = [n for n in order if nodes[n]["type"] in ("valve", "ram")]
    for n in info["valves"]:
        if not passable(nodes[n], state):
            info["closed_ends" if n in (info["start"], info["end"]) else "closed_inside"].append(n)
    return info


def notes(net: dict, state: dict) -> list[str]:
    out = []
    temp = temp_of(net, state)
    for line in temp["lines"]:
        if not line_active(line, net, state, temp):
            inactive_end = any(i in net["nodes"] and not active(net["nodes"][i], state) for i in (line["a"], line["b"]))
            why = ("the top drive open end is not available while the string is made up to it." if inactive_end
                   else "one of its ends no longer exists.")
            out.append(f"Temporary line {line.get('label') or line['id']} is disconnected - {why}")
    valves = state.get("valves", {})
    mode = pipe_mode(state)
    for n in net["nodes"].values():
        if n["type"] != "ram" or valves.get(n["id"]) != "closed":
            continue
        if n["kind"] == "pipe" and mode == "none":
            out.append(f"{n['label']} closed with no pipe in hole - will not seal.")
        if n["kind"] in ("shear", "shear_ns") and mode == "drilling":
            out.append(f"{n['label']} closed with pipe in hole - pipe is sheared.")
        if n["kind"] == "shear_ns":
            out.append(f"{n['label']} is non-sealing - does not hold pressure.")
    return out
