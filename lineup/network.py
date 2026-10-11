"""Network description for COSL Innovator: standpipe manifold, pump room,
choke & kill manifold and BOP, all on one canvas.

Everything the tool knows about the rig lives here. The model is a graph:

* nodes   - valves, rams, pumps, outlets, connection points, junctions, boxes
* edges   - pipe between two nodes, drawn as a polyline through `via` points

A valve or ram is a node: flow passes through it only when it is open.
Coordinates are canvas pixels (x right, y down).

Node types
  valve     open/close valve. auto=True draws an actuator box, choke=True the choke arrow.
  ram       BOP element in the bore. kind: annular | pipe | shear | shear_ns
            (shear_ns = casing shear, cuts pipe but does not seal)
  pump      mud pump / cement unit (a natural start point for a traced path)
  outlet    where flow leaves the system (overboard, tanks, flowline, well)
  vessel    pass-through vessel that also counts as an outlet (poorboy, stripping tank)
  cp        connection point (blind/blank end) where temporary hoses can be rigged
  box       labelled pass-through box (STP#1, kelly hose, C / K blocks ...); block=True: dead end, passes no flow
  buffer    pass-through vessel drawn as a rectangle (buffer tanks, manifold headers)
  junction  plain pipe junction
  bore      node in the BOP bore / riser
  string    node on the drill string (only active with pipe in hole)

Edge ratings: "lp", "7.5k", "10k", "15k", "bore", "string".
Pipe modes (state["pipe"]): "none", "drilling" (string made up to the top drive) or
"hangoff" (string hung off in the BOP, open top just above the UPR, bottom in the well).
Nodes/edges with a cond only exist in some modes:
  drill  pipe made up to the top drive        notd  top drive NOT connected to pipe
  pipe   any pipe in the BOP (drilling/hangoff) hang  string hung off
Edges with over=True are drawn last with a gap, so they visibly cross over other lines.
"""

from __future__ import annotations

NODES: dict[str, dict] = {}
EDGES: list[dict] = []
DECOR: list[dict] = []


def _node(nid, ntype, x, y, **kw):
    if nid in NODES:
        raise ValueError(f"duplicate node id {nid}")
    NODES[nid] = {"id": nid, "type": ntype, "x": x, "y": y, **kw}
    return nid


def valve(nid, x, y, o="v", label=None, auto=False, lp=None, hide=False, **kw):
    """o: orientation of the pipe through the valve ('v' or 'h'). lp: label side l/r/t/b.
    hide=True keeps the label for lists/PDF but does not draw it on the canvas."""
    return _node(nid, "valve", x, y, o=o, label=nid if label is None else label, auto=auto, hide=hide,
                 lp=lp or ("r" if o == "v" else "t"), **kw)


def junction(nid, x, y):
    return _node(nid, "junction", x, y)


def box(nid, x, y, label, w=70, h=26, fill="#ffffff", **kw):
    return _node(nid, "box", x, y, label=label, w=w, h=h, fill=fill, **kw)


def buffer(nid, x, y, label, rect, **kw):
    return _node(nid, "buffer", x, y, label=label, rect=rect, **kw)


def outlet(nid, x, y, label, lp="r", **kw):
    return _node(nid, "outlet", x, y, label=label, lp=lp, **kw)


def vessel(nid, x, y, label, rect, **kw):
    return _node(nid, "vessel", x, y, label=label, rect=rect, **kw)


def cp(nid, x, y, label, lp="l", **kw):
    """open=True: an open end (flow leaves here) unless a temporary hose is connected.
    name: longer name for lists and the PDF when the drawn label is short (e.g. "1502")."""
    return _node(nid, "cp", x, y, label=label, lp=lp, **kw)


def pump(nid, x, y, label, shape="circle"):
    return _node(nid, "pump", x, y, label=label, shape=shape)


def ram(nid, y, kind, label, **kw):
    return _node(nid, "ram", BORE_X, y, kind=kind, label=label, **kw)


def bore(nid, y, label):
    return _node(nid, "bore", BORE_X, y, label=label)


def edge(a, b, *via, r="15k", style=None, over=False, cond=None, segs=None, tags=None):
    if a not in NODES or b not in NODES:
        raise KeyError(f"edge {a}-{b} references unknown node")
    pa, pb = NODES[a], NODES[b]
    # stable id from the end points, so saved paths survive edits to the drawing
    eid = f"{a}~{b}"
    if any(x["id"] == eid for x in EDGES):
        raise ValueError(f"duplicate edge {eid}")
    e = {"id": eid, "a": a, "b": b, "r": r}
    if segs is not None:
        e["segs"] = segs          # explicit polylines ([] = not drawn)
    else:
        e["segs"] = [[[pa["x"], pa["y"]], *[list(p) for p in via], [pb["x"], pb["y"]]]]
    if style:
        e["style"] = style
    if over:
        e["over"] = True
    if cond:
        e["cond"] = cond
    if tags:
        e["tags"] = tags
    EDGES.append(e)
    return e["id"]


def chain(*ids, r="15k"):
    for a, b in zip(ids, ids[1:]):
        edge(a, b, r=r)


def text(x, y, s, size=11, anchor="start", weight="normal", color="#333"):
    DECOR.append({"t": "text", "x": x, "y": y, "s": s, "size": size,
                  "anchor": anchor, "weight": weight, "color": color})


def rect(x, y, w, h, stroke="#999", fill="none", dash=None):
    DECOR.append({"t": "rect", "x": x, "y": y, "w": w, "h": h,
                  "stroke": stroke, "fill": fill, "dash": dash})


SP = "7.5k"

# ---------------------------------------------------------------- standpipe manifold
cp("CP_61", 180, 215, "Blind above 61", lp="l")
valve("61", 180, 265)
junction("SP_A", 180, 325)
valve("60", 140, 325, o="h")
valve("STP_BO", 80, 460, label="STP bleed off", lp="l", choke=True)
junction("FL_J", 80, 576)
outlet("BLEED_OFF", 80, 610, "BLEED OFF (FLOWLINE)", lp="b")
valve("57", 180, 400)
junction("SP_L", 180, 445)
valve("50", 180, 500)
box("STP1", 180, 560, "STP#1 GREEN", w=54, h=30, fill="#7ac943")
junction("J52", 235, 445)
valve("52", 235, 490)
valve("51", 235, 530)
box("BOOSTER", 235, 592, "BOOSTER", w=50, h=20)
valve("55", 265, 445, o="h", lp="b")
junction("SP_TM", 298, 325)
valve("59", 298, 345)
# cross between 59 and 56: both branches leave on the left (downlink skid, then the rig-up point)
junction("SP_X", 298, 368)
junction("SP_X2", 298, 390)
valve("56", 298, 415)
junction("SP_M", 298, 445)
valve("53", 298, 500)
box("CHOKE_MANIF", 298, 560, "CHOKE MANIF.", w=48, h=30)
cp("CP_SPX", 255, 410, "1502", lp="b", name="1502 between 59 and 56")
valve("LT", 115, 470, label="LT")
# dead end while not downlinking: holds standpipe pressure for the gauges, passes no flow
box("DOWNLINK", 115, 576, "DOWNLINK SKID", w=56, h=42, block=True)
junction("SP_RT", 350, 325)
valve("58", 350, 385)
junction("SP_R", 350, 445)
valve("54", 350, 500)
box("STP2", 350, 560, "STP#2 YELLOW", w=48, h=30, fill="#ffef3a")
valve("62", 350, 272)
valve("63", 350, 237)
junction("YP", 350, 205)
cp("CP_YP", 312, 205, "Y-piece 2\" 1502 (cementing)")
box("SERVICE_LOOP", 350, 150, "SERVICE LOOP / KELLY HOSE", w=110, h=30)

edge("CP_61", "61", r=SP)
edge("61", "SP_A", r=SP)
edge("SP_A", "60", r=SP)
edge("60", "STP_BO", (80, 325), r=SP)
edge("STP_BO", "FL_J", r=SP)
edge("FL_J", "BLEED_OFF", r=SP)
edge("SP_A", "57", r=SP)
edge("57", "SP_L", r=SP)
edge("SP_L", "50", r=SP)
edge("50", "STP1", r=SP)
edge("SP_L", "J52", r=SP)
edge("J52", "55", r=SP)
edge("55", "SP_M", r=SP)
edge("J52", "52", r=SP)
edge("52", "51", r=SP)
edge("51", "BOOSTER", r=SP)
edge("SP_A", "SP_TM", r=SP)
edge("SP_TM", "SP_RT", r=SP)
edge("SP_TM", "59", r=SP)
edge("59", "SP_X", r=SP)
edge("SP_X", "SP_X2", r=SP)
edge("SP_X2", "56", r=SP)
edge("SP_X2", "CP_SPX", (255, 390), r=SP)
edge("SP_X", "LT", (115, 368), r=SP, over=True)
edge("LT", "DOWNLINK", r=SP)
edge("DOWNLINK", "FL_J", r=SP)  # downlink skid drains to the flowline with the bleed-off
edge("56", "SP_M", r=SP)
edge("SP_M", "SP_R", r=SP)
edge("SP_M", "53", r=SP)
edge("53", "CHOKE_MANIF", r=SP)
edge("SP_RT", "58", r=SP)
edge("58", "SP_R", r=SP)
edge("SP_R", "54", r=SP)
edge("54", "STP2", r=SP)
edge("SP_RT", "62", r=SP)
edge("62", "63", r=SP)
edge("63", "YP", r=SP)
edge("YP", "SERVICE_LOOP", r=SP)
edge("YP", "CP_YP", r=SP)
text(375, 300, "STANDPIPE MANIFOLD", 13, weight="bold")

# ---------------------------------------------------------------- pump room
# Each pump: discharge valve, then one valve up to the STP#1 header (H1) and one
# to the STP#2 header (H2). HEX #3 also feeds the shear line through P10.
# Confirmed: P8, P13, P14 go to standpipe 1; P9, P12, P15 to standpipe 2. No other valves.
PR = 70  # the pump room sits this far below its original layout, clear of the manifolds
junction("H1_A", 125, 665 + PR)
junction("H1_B", 180, 665 + PR)
junction("H1_C", 275, 665 + PR)
junction("H1_E", 465, 665 + PR)
junction("H2_A", 175, 700 + PR)
junction("H2_B", 325, 700 + PR)
junction("H2_S", 350, 700 + PR)
junction("H2_C", 515, 700 + PR)
chain("H1_A", "H1_B", "H1_C", "H1_E", r=SP)
chain("H2_A", "H2_B", "H2_S", "H2_C", r=SP)
edge("STP1", "H1_B", r=SP)
edge("STP2", "H2_S", r=SP, over=True)

# Between each pump and its discharge valve a line branches out through a pop-off
# and a bleed-off valve in parallel, joins again and goes to the active pit.
# side: which side of the pump the branch is drawn on (-1 left, +1 right).
for pid, label, x, dv, lv, rv, dest, side in [
    ("HEX3", "HEX #3", 150, "P7", "P8", "P9", "ACTIVE\nMIX", -1),
    ("HEX2", "HEX #2", 300, "P11", "P13", "P12", "ACTIVE\nSUCTION", 1),
    ("HEX1", "HEX #1", 490, "P16", "P14", "P15", "ACTIVE\nSUCTION", 1),
]:
    n = label[-1]
    pump(pid, x, 990 + PR, label)
    valve(dv, x, 840 + PR)
    junction(f"J_{pid}", x, 800 + PR)
    junction(f"J_{pid}_L", x - 25, 800 + PR)
    junction(f"J_{pid}_R", x + 25, 800 + PR)
    valve(lv, x - 25, 745 + PR, lp="l" if pid != "HEX2" else "r")
    valve(rv, x + 25, 750 + PR)
    junction(f"PD_{pid}", x, 900 + PR)
    junction(f"PDA_{pid}", x + 20 * side, 900 + PR)
    valve(f"PO_{pid}", x + 40 * side, 885 + PR, o="h", label=f"Pop-off #{n}", lp="t")
    valve(f"BO_{pid}", x + 40 * side, 915 + PR, o="h", label=f"Bleed-off #{n}", lp="b")
    junction(f"PDB_{pid}", x + 60 * side, 900 + PR)
    outlet(f"OUT_{pid}", x + 75 * side, 900 + PR, dest, lp="r" if side > 0 else "l")
    edge(pid, f"PD_{pid}", r=SP)
    edge(f"PD_{pid}", dv, r=SP)
    edge(f"PD_{pid}", f"PDA_{pid}", r=SP)
    edge(f"PDA_{pid}", f"PO_{pid}", (x + 20 * side, 885 + PR), r=SP)
    edge(f"PO_{pid}", f"PDB_{pid}", (x + 60 * side, 885 + PR), r=SP)
    edge(f"PDA_{pid}", f"BO_{pid}", (x + 20 * side, 915 + PR), r=SP)
    edge(f"BO_{pid}", f"PDB_{pid}", (x + 60 * side, 915 + PR), r=SP)
    edge(f"PDB_{pid}", f"OUT_{pid}", r=SP)
    edge(dv, f"J_{pid}", r=SP)
    edge(f"J_{pid}", f"J_{pid}_L", r=SP)
    edge(f"J_{pid}", f"J_{pid}_R", r=SP)
    edge(f"J_{pid}_L", lv, r=SP)
    edge(f"J_{pid}_R", rv, r=SP)

edge("P8", "H1_A", r=SP)
edge("P9", "H2_A", r=SP)
edge("P13", "H1_C", r=SP, over=True)
edge("P12", "H2_B", r=SP)
edge("P14", "H1_E", r=SP, over=True)
edge("P15", "H2_C", r=SP)

valve("P10", 90, 800 + PR, o="h", lp="b")
junction("SH", 55, 800 + PR)
valve("ACTMIX_V", 55, 760 + PR, label="Act mix valve", hide=True)
outlet("ACTMIX", 55, 725 + PR, "ACT MIX", lp="t")
valve("STORE1_V", 55, 840 + PR, label="Store 1 valve", hide=True)
outlet("STORE1", 55, 878 + PR, "STORE 1", lp="l")
cp("CP_SHEAR", 22, 800 + PR, "Shear line blank", lp="tr")
edge("J_HEX3_L", "P10", r=SP)
edge("P10", "SH", r=SP)
edge("SH", "ACTMIX_V", r=SP)
edge("ACTMIX_V", "ACTMIX", r=SP)
edge("SH", "STORE1_V", r=SP)
edge("STORE1_V", "STORE1", r=SP)
edge("SH", "CP_SHEAR", r=SP)
text(20, 690 + PR, "SHEAR LINE", 10, weight="bold")
text(330, 1035 + PR, "PUMP ROOM", 13, weight="bold")

# ---------------------------------------------------------------- choke & kill manifold
vessel("POORBOY", 590, 280, "POOR BOY DEGASSER", rect=[565, 110, 50, 340])
text(590, 98, "VENT TO DERRICK", 9, anchor="middle")
buffer("BUF_L", 895, 202, "LHS BUFFER", rect=[800, 190, 190, 24])
buffer("BUF_R", 1117, 202, "RHS BUFFER", rect=[1060, 190, 115, 24])
valve("45", 740, 202, o="h", auto=True)
valve("21", 1025, 202, o="h")
edge("BUF_L", "45", r="10k")
edge("45", "POORBOY", r="lp", tags=[{"x": 665, "y": 196, "s": "N10"}])
edge("BUF_L", "21", r="10k")
edge("21", "BUF_R", r="10k")

buffer("LH", 780, 401, "", rect=[680, 392, 200, 18])
buffer("RH", 1077, 401, "", rect=[1035, 392, 85, 18])
valve("9", 957, 401, o="h", auto=True)
edge("LH", "9")
edge("9", "RH")

# choke side (left column)
valve("11", 730, 345)
valve("15", 730, 275, auto=True)
valve("40", 730, 240, auto=True, label="40 (AC#1)", choke=True)
valve("18", 765, 222, o="h")
edge("LH", "11", (730, 401))
edge("11", "15")
edge("15", "40")
edge("40", "18", (730, 222), r="10k")
edge("18", "BUF_L", (805, 222), (805, 202), r="10k")
# 10 ends in a temporary tie-in point (not connected to the 11 - 15 line)
valve("10", 690, 360, lp="l")
cp("CP_10", 690, 318, "1502", lp="l", name="1502 above 10")
edge("LH", "10", (690, 401))
edge("10", "CP_10")

# middle column
valve("12", 865, 345)
valve("16", 865, 302)
valve("MCH", 865, 270, label="Manual choke", hide=True, choke=True)  # manual choke, no number
valve("19", 865, 238)
edge("LH", "12", (865, 401))
edge("12", "16")
edge("16", "MCH")
edge("MCH", "19")
edge("19", "BUF_L", (865, 202), r="10k")
valve("42", 825, 268, auto=True)
outlet("PORT_OB", 825, 330, "PORT O/B", lp="b")
edge("BUF_L", "42", (825, 202), r="10k")
edge("42", "PORT_OB", r="10k", tags=[{"x": 830, "y": 305, "s": "N8"}])

# kill side (right column)
valve("13", 1050, 345)
valve("17", 1050, 275, auto=True)
valve("41", 1050, 240, auto=True, label="41 (AC#2)", lp="l", choke=True)
valve("20", 1085, 224, o="h", lp="b")
edge("RH", "13", (1050, 401))
edge("13", "17")
edge("17", "41")
edge("41", "20", (1050, 224), r="10k")
edge("20", "BUF_R", (1110, 224), (1110, 202), r="10k")
# 14 ends in a temporary tie-in point (not connected to the 13 - 17 line)
valve("14", 1098, 360)
cp("CP_14", 1098, 318, "1502", lp="r", name="1502 above 14")
edge("RH", "14", (1098, 401))
edge("14", "CP_14")
valve("43", 1155, 268, auto=True)
outlet("STB_OB", 1155, 330, "STB O/B", lp="b")
edge("BUF_R", "43", (1155, 202), r="10k")
edge("43", "STB_OB", r="10k", tags=[{"x": 1160, "y": 305, "s": "N7"}])
valve("44", 1200, 202, o="h", auto=True)
vessel("STRIP", 1270, 240, "STRIPPING TANK 0.9 m3", rect=[1235, 195, 70, 90])
valve("ST_V", 1270, 312, auto=True, label="Stripping tank outlet", hide=True)
edge("BUF_R", "44", r="10k")
edge("44", "STRIP", r="lp", tags=[{"x": 1212, "y": 194, "s": "N9"}])
edge("STRIP", "ST_V", r="lp")

# glycol injection points (usable as hose connection points)
cp("CP_GLY1", 760, 428, "Glycol inj. #1", lp="b")
cp("CP_GLY2", 1095, 428, "Glycol inj. #2", lp="b")
edge("LH", "CP_GLY1", (760, 401))
edge("RH", "CP_GLY2", (1095, 401))

# C / K blocks and cross-over
valve("7", 805, 445, lp="l")
box("C", 805, 490, "C", w=26, h=24)
valve("8", 1050, 445)
box("K", 1050, 490, "K", w=26, h=24)
edge("LH", "7", (805, 401))
edge("7", "C")
edge("RH", "8", (1050, 401))
edge("8", "K")
valve("4", 850, 490, o="h", lp="b")
box("B1", 910, 490, "", w=18, h=18)
valve("5", 945, 490, o="h", lp="b")
box("B2", 980, 490, "", w=18, h=18)
text(980, 474, "CMT MANIFOLD", 7, anchor="middle")
valve("6", 1015, 490, o="h", lp="b")
chain("C", "4", "B1", "5", "B2", "6", "K")
valve("1", 870, 440, o="h")
valve("2", 910, 463)
edge("1", "2", (910, 440))
edge("2", "B1")
valve("3", 980, 535, lp="l")
edge("B2", "3")

# standpipe -> choke manifold (53 -> 1)
edge("CHOKE_MANIF", "1", (298, 630), (840, 630), (840, 440), r=SP, style="dashdot", over=True)

# test line: CMT unit -> C1 -> C3 -> C4 -> valve 3. C2 and C5 are blind ends.
pump("CMT_TEST", 710, 940, "CMT UNIT\nTEST LINE", shape="rect")
valve("C1", 710, 535)
junction("J_T", 710, 492)
valve("C2", 710, 462)
cp("CP_C2", 710, 436, "1502", lp="l", name="1502 at C2")
valve("C5", 678, 492, o="h")
cp("CP_C5", 654, 492, "1502", lp="t", name="1502 at C5")
valve("C3", 734, 492, o="h", lp="b")
valve("C4", 756, 492, o="h")
edge("CMT_TEST", "C1")
edge("C1", "J_T")
edge("J_T", "C2")
edge("C2", "CP_C2")
edge("J_T", "C5")
edge("C5", "CP_C5")
edge("J_T", "C3")
edge("C3", "C4")
edge("C4", "3", (772, 492), (772, 600), (980, 600), style="dash", over=True)

# cement line: CMT unit -> C6 -> blind end
pump("CMT_CMT", 650, 940, "CMT UNIT\nCMT LINE", shape="rect")
valve("C6", 636, 522, o="h", lp="b")
cp("CP_C6", 612, 522, "1502", lp="l", name="1502 at C6")
edge("CMT_CMT", "C6", (650, 522))
edge("C6", "CP_C6")

# trip tank: fed from the poorboy and the stripping tank
vessel("TRIP_TANK", 960, 810, "TRIP TANK", rect=[880, 765, 160, 90], radius=4)
edge("ST_V", "TRIP_TANK", (1270, 372), (1195, 372), (1195, 810), r="lp", over=True)

# poorboy outlets (liquid seal)
junction("PB_J", 560, 575)
valve("PB_FL", 530, 545, o="h", auto=True, label="Poorboy to flowline", hide=True)
outlet("FLOWLINE", 500, 545, "TO FLOWLINE", lp="l")
valve("PB_TT", 530, 575, o="h", auto=True, label="Poorboy to trip tank", hide=True, lp="b")
edge("POORBOY", "PB_J", (590, 600), (575, 615), (560, 600), r="lp")
edge("PB_J", "PB_FL", (560, 545), r="lp")
edge("PB_FL", "FLOWLINE", r="lp")
edge("PB_J", "PB_TT", r="lp")
edge("PB_TT", "TRIP_TANK", (505, 575), (505, 650), (900, 650), (900, 810), r="lp", over=True,
     tags=[{"x": 515, "y": 645, "s": "TO TRIP TANK"}])

# moonpool isolation valves and routes to the BOP
valve("MP_ISO_C", 805, 685, label="Moonpool iso (choke)")
valve("MP_ISO_K", 1050, 680, label="Moonpool iso (kill)")
edge("C", "MP_ISO_C")
edge("K", "MP_ISO_K")
text(745, 105, "CHOKE & KILL MANIFOLD", 13, weight="bold")

# ---------------------------------------------------------------- BOP
BORE_X = 1490
KILL_X = 1320
CHOKE_X = 1660

DECOR.append({"t": "bop", "x": BORE_X - 60, "y": 545, "w": 120, "h": 550,
              "riser": [BORE_X - 25, 440, 50, 105]})
text(BORE_X, 1160, "BOP", 13, anchor="middle", weight="bold")
text(KILL_X - 8, 400, "KILL", 11, anchor="end", weight="bold")
text(CHOKE_X + 8, 412, "CHOKE", 11, weight="bold")

# top drive: kelly hoses -> top drive -> auto (upper) IBOP -> manual (lower) IBOP -> saver sub.
# When drilling the saver sub connects to the drill string; otherwise it is an open end.
box("TDS", BORE_X, 160, "TOP DRIVE", w=90, h=34)
valve("IBOP_A", BORE_X, 215, auto=True, label="Auto IBOP")
valve("IBOP_M", BORE_X, 260, label="Manual IBOP")
junction("TD_SUB", BORE_X, 300)
cp("TD_OPEN", BORE_X, 325, "Top drive open end", lp="r", cond="notd", open=True)
chain("TDS", "IBOP_A", "IBOP_M", "TD_SUB")
edge("TD_SUB", "TD_OPEN", cond="notd")

bore("RISER_TOP", 450, "Riser top")
outlet("BELL", 1435, 450, "RISER → FLOWLINE", lp="l")
bore("BOOST_IN", 500, "Riser at boost inlet")
ram("UA", 565, "annular", "Upper annular")
bore("K_UP", 610, "Bore at upper kill outlet")
ram("LA", 660, "annular", "Lower annular")
bore("B_LA", 700, "Bore above BSR")
ram("BSR", 730, "shear", "BSR", string="S_BSR", above="B_LA")
bore("C_UP", 770, "Bore at upper choke outlet")
ram("CSR", 810, "shear_ns", "CSR", string="S_CSR", above="C_UP")
bore("K_MID", 850, "Bore at middle kill outlet")
HANG_TOP = 872  # top of a hung-off string, just above the UPR
bore("B_HANG", HANG_TOP, "Bore above UPR")
ram("UPR", 900, "pipe", "UPR")
ram("MPR", 940, "pipe", "MPR")
bore("C_LOW", 980, "Bore at lower choke outlet")
ram("LPR", 1015, "pipe", "LPR")
bore("K_LOW", 1050, "Bore at lower kill outlet")
bore("WELLHEAD", 1090, "Wellhead")
outlet("WELL", BORE_X, 1125, "WELL (below BOP)", lp="r")
chain("RISER_TOP", "BOOST_IN", "UA", "K_UP", "LA", "B_LA", "BSR", "C_UP", "CSR",
      "K_MID", "B_HANG", "UPR", "MPR", "C_LOW", "LPR", "K_LOW", "WELLHEAD", "WELL", r="bore")
edge("RISER_TOP", "BELL", r="lp")

# drill string (inside of the pipe). The bore nodes above are the annulus around it.
_node("S_BSR", "string", BORE_X, 730, label="Drill pipe at BSR")
_node("S_CSR", "string", BORE_X, 810, label="Drill pipe at CSR")
_node("S_HANG", "string", BORE_X, HANG_TOP, label="Drill pipe top (hung off)")
_node("S_BIT", "string", BORE_X, 1110, label="Bit")
edge("TD_SUB", "S_BSR", r="string", cond="drill")
edge("S_BSR", "S_CSR", r="string", cond="drill")
edge("S_CSR", "S_HANG", r="string", cond="drill")
edge("S_HANG", "S_BIT", r="string", cond="pipe")
edge("S_BIT", "WELL", r="string", cond="pipe")
edge("S_HANG", "B_HANG", r="virtual", cond="hang", segs=[])  # open top of a hung-off string
PIPE = {"hang_top": HANG_TOP, "od": 14, "id": 9, "bore": 30}

# kill line + failsafes (outer valve on the line side, inner on the bore side)
junction("KL_TOP", KILL_X, 410)
junction("KL_UP", KILL_X, 610)
junction("KL_MID", KILL_X, 850)
junction("KL_LOW", KILL_X, 1050)
chain("KL_TOP", "KL_UP", "KL_MID", "KL_LOW")
for tap, inner, outer, y in [("K_UP", "IB", "OB", 610), ("K_MID", "UIK", "UOK", 850),
                             ("K_LOW", "LIK", "LOK", 1050)]:
    valve(inner, 1405, y, o="h", lp="t")
    valve(outer, 1365, y, o="h", lp="t")
    edge(tap, inner)
    edge(inner, outer)
    edge(outer, f"KL_{tap[2:]}")

junction("CL_TOP", CHOKE_X, 420)
junction("CL_UP", CHOKE_X, 770)
junction("CL_LOW", CHOKE_X, 980)
chain("CL_TOP", "CL_UP", "CL_LOW")
for tap, inner, outer, y in [("C_UP", "UIC", "UOC", 770), ("C_LOW", "LIC", "LOC", 980)]:
    valve(inner, 1575, y, o="h", lp="t")
    valve(outer, 1615, y, o="h", lp="t")
    edge(tap, inner)
    edge(inner, outer)
    edge(outer, f"CL_{tap[2:]}")

# kill, choke and boost lines between the manifolds and the BOP are drawn dotted
edge("MP_ISO_K", "KL_TOP", (1050, 710), (1250, 710), (1250, 410), style="dot")
edge("MP_ISO_C", "CL_TOP", (805, 1185), (1720, 1185), (1720, 420), style="dot")

# kelly hose from the standpipe to the top drive, routed over the top of the drawing
edge("SERVICE_LOOP", "TDS", (350, 55), (1440, 55), (1440, 160), r=SP,
     tags=[{"x": 700, "y": 50, "s": "KELLY HOSE"}])

# boost line: 51 -> booster -> mud boost valve -> riser, routed under the drawing
valve("MBV", 1550, 500, o="h", label="Mud boost valve", lp="b")
edge("BOOSTER", "MBV", (235, 1220), (1760, 1220), (1760, 395), (1590, 395), (1590, 500),
     r=SP, over=True, style="dot", tags=[{"x": 1000, "y": 1214, "s": "BOOST LINE (from 51)"}])
edge("MBV", "BOOST_IN", r=SP)

# ---------------------------------------------------------------- path colours
# The ten colours a flow path can have (no free colour picker).
PATH_COLORS = [
    {"name": "Green", "hex": "#00a651"},
    {"name": "Blue", "hex": "#1e6fff"},
    {"name": "Orange", "hex": "#ff8c00"},
    {"name": "Purple", "hex": "#9c27b0"},
    {"name": "Red", "hex": "#e02424"},
    {"name": "Cyan", "hex": "#00bcd4"},
    {"name": "Pink", "hex": "#ff5fc0"},
    {"name": "Brown", "hex": "#8d5524"},
    {"name": "Yellow", "hex": "#f2c200"},
    {"name": "Grey", "hex": "#7f8c8d"},
]
_COLOR = {c["name"]: c["hex"] for c in PATH_COLORS}

# ---------------------------------------------------------------- standard line-ups
# Applied from the toolbar. Each path is a list of routes; a route is a chain of node ids in
# flow order. Feeder routes come first and the main route (ending where the flow leaves) last,
# so the path reads pump -> outlet. "open" lists the valves the line-up opens (default: every valve on the routes);
# branches leaving the paths are closed at their first valve. "gauges": valves opened only so the
# gauges read pressure; they are not part of a path (no arrows) and are left open by the isolation.
# Applying a line-up replaces the earlier standard paths of the same group, so drilling is either
# with or without boost; gauge valves of the other line-ups in the group are closed again.
_STRING_AND_ANNULUS = [
    "YP", "SERVICE_LOOP", "TDS", "IBOP_A", "IBOP_M", "TD_SUB",
    "S_BSR", "S_CSR", "S_HANG", "S_BIT", "WELL",
    "WELLHEAD", "K_LOW", "LPR", "C_LOW", "MPR", "UPR", "B_HANG", "K_MID", "CSR", "C_UP",
    "BSR", "B_LA", "LA", "K_UP", "UA", "BOOST_IN", "RISER_TOP", "BELL",
]
_KELLY = ["SP_RT", "62", "63"]

LINEUPS = {
    "drill": {
        "label": "Drilling", "group": "drill", "pipe": "drilling",
        "title": "Normal drilling: all mud pumps up both standpipes, top drive, string, annulus, flowline",
        "gauges": ["59", "56", "LT"],
        "paths": [{
            "name": "Drilling", "color": _COLOR["Green"],
            "routes": [
                ["HEX2", "PD_HEX2", "P11", "J_HEX2", "J_HEX2_L", "P13", "H1_C", "H1_B"],
                ["J_HEX2", "J_HEX2_R", "P12", "H2_B"],
                ["HEX1", "PD_HEX1", "P16", "J_HEX1", "J_HEX1_L", "P14", "H1_E", "H1_C"],
                ["J_HEX1", "J_HEX1_R", "P15", "H2_C", "H2_S"],
                ["J_HEX3", "J_HEX3_R", "P9", "H2_A", "H2_B", "H2_S", "STP2", "54", "SP_R", "58", "SP_RT"],
                ["HEX3", "PD_HEX3", "P7", "J_HEX3", "J_HEX3_L", "P8", "H1_A", "H1_B", "STP1", "50", "SP_L",
                 "57", "SP_A", "SP_TM", *_KELLY, *_STRING_AND_ANNULUS],
            ],
        }],
    },
    "drill_boost": {
        "label": "Drilling + boost", "group": "drill", "pipe": "drilling",
        "title": "Drilling with boost: HEX #1 and #2 up standpipe 2 to the string, HEX #3 up standpipe 1 and down the boost line",
        "gauges": ["59", "56"],
        "paths": [{
            "name": "Drilling", "color": _COLOR["Green"],
            "routes": [
                ["HEX1", "PD_HEX1", "P16", "J_HEX1", "J_HEX1_R", "P15", "H2_C", "H2_S"],
                ["HEX2", "PD_HEX2", "P11", "J_HEX2", "J_HEX2_R", "P12", "H2_B", "H2_S", "STP2", "54", "SP_R",
                 "58", *_KELLY, *_STRING_AND_ANNULUS],
            ],
        }, {
            "name": "Boost", "color": _COLOR["Yellow"],
            "routes": [
                ["HEX3", "PD_HEX3", "P7", "J_HEX3", "J_HEX3_L", "P8", "H1_A", "H1_B", "STP1", "50", "SP_L",
                 "J52", "52", "51", "BOOSTER", "MBV", "BOOST_IN"],
            ],
        }],
    },
    "choke": {
        "label": "Choke line-up", "group": "choke",
        "title": "Choke lined up for drilling: choke isolation, 7, 11, 15, 18 and 45 open",
        "paths": [{
            "name": "Choke line-up", "color": _COLOR["Purple"],
            "routes": [["CL_TOP", "MP_ISO_C", "C", "7", "LH", "11", "15", "40", "18", "BUF_L", "45", "POORBOY"]],
            "open": ["MP_ISO_C", "7", "11", "15", "18", "45"],
        }],
    },
}

# ---------------------------------------------------------------- legend
LEGEND = [{"r": "15k", "label": "Pipe"}]

# all pipe is drawn black; the rating is kept on each edge for reference
RATING_COLORS = {
    "lp": "#1a1a1a",
    "7.5k": "#1a1a1a",
    "10k": "#1a1a1a",
    "15k": "#1a1a1a",
    "bore": "#ffffff",
    "string": "#1a1a1a",
}

NETWORK = {
    "rig": "COSL Innovator",
    "nodes": NODES,
    "edges": EDGES,
    "decor": DECOR,
    "legend": LEGEND,
    "colors": RATING_COLORS,
    "pipe": PIPE,
    "path_colors": PATH_COLORS,
    "lineups": LINEUPS,
}


def default_state() -> dict:
    """All valves closed, all rams open, pipe out of hole, no hoses, no traced paths.

    paths: [{"id", "name", "color", "arrows": bool, "steps": [{"e": edge id, "from": node id}]}]
    Steps are in flow order; "from" is the end of the pipe the flow enters at."""
    valves = {}
    for n in NODES.values():
        if n["type"] == "valve":
            valves[n["id"]] = "closed"
        elif n["type"] == "ram":
            valves[n["id"]] = "open"
    return {"valves": valves, "pipe": "none", "temp": {"items": [], "lines": []}, "paths": [], "pumps": []}
