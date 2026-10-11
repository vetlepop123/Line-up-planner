from collections import deque

from lineup.network import NETWORK, default_state
from lineup.pdf import build_pdf
from lineup.solver import build_graph, notes, passable, path_info

NODES = NETWORK["nodes"]


def lineup(*open_valves, pipe="none", closed_rams=(), hoses=None, temp=None, paths=()):
    """hoses: the old saved format (converted on load); temp: the current {"items", "lines"} format."""
    st = default_state()
    for v in open_valves:
        assert v in st["valves"], v
        st["valves"][v] = "open"
    for r in closed_rams:
        st["valves"][r] = "closed"
    st["pipe"] = pipe
    if hoses is not None:
        del st["temp"]
        st["hoses"] = list(hoses)
    if temp is not None:
        st["temp"] = temp
    st["paths"] = list(paths)
    return st


def steps(*nodes_in_order):
    """Path steps following the given node sequence (edges must exist in either direction)."""
    ids = {e["id"] for e in NETWORK["edges"]}
    out = []
    for a, b in zip(nodes_in_order, nodes_in_order[1:]):
        eid = f"{a}~{b}" if f"{a}~{b}" in ids else f"{b}~{a}"
        assert eid in ids, (a, b)
        out.append({"e": eid, "from": a})
    return out


def test_edges_reference_known_nodes_and_ids_are_unique():
    ids = [e["id"] for e in NETWORK["edges"]]
    assert len(ids) == len(set(ids))
    for e in NETWORK["edges"]:
        assert e["a"] in NODES and e["b"] in NODES


def test_pipe_rams_only_seal_on_pipe():
    st = lineup(closed_rams=["MPR"])
    assert passable(NODES["MPR"], st)
    st["pipe"] = "drilling"
    assert not passable(NODES["MPR"], st)
    assert any("will not seal" in n for n in notes(NETWORK, lineup(closed_rams=["MPR"])))


def test_path_info_lists_valves_and_closed_ones():
    path = {"steps": steps("HEX1", "PD_HEX1", "P16", "J_HEX1", "J_HEX1_L", "P14", "H1_E")}
    info = path_info(NETWORK, lineup("P16"), path)
    assert info["start"] == "HEX1" and info["end"] == "H1_E"
    assert info["valves"] == ["P16", "P14"]
    assert info["closed_inside"] == ["P14"]


def test_path_ending_against_closed_valve_is_not_a_warning():
    path = {"steps": steps("HEX1", "PD_HEX1", "P16")}
    info = path_info(NETWORK, lineup(), path)
    assert info["closed_inside"] == [] and info["closed_ends"] == ["P16"]


def test_string_steps_inactive_without_pipe():
    path = {"steps": steps("TD_SUB", "S_BSR")}
    assert path_info(NETWORK, lineup(), path)["inactive"] == 1
    assert path_info(NETWORK, lineup(pipe="drilling"), path)["inactive"] == 0


def test_old_hoses_convert_and_disconnect_with_pipe_in_hole():
    hose = {"id": "T1", "a": "TD_OPEN", "b": "CP_C2", "label": "TD hose", "valve": True}
    nodes, edges = build_graph(NETWORK, lineup(hoses=[hose]))
    assert {"T1a", "T1b"} <= {e["id"] for e in edges}   # same ids as before, so saved paths still work
    assert nodes["T1_V"]["type"] == "valve"
    st = lineup(pipe="drilling", hoses=[hose])
    _, edges = build_graph(NETWORK, st)
    assert "T1a" not in {e["id"] for e in edges}
    assert any("disconnected" in n for n in notes(NETWORK, st))


# C6 end -> Lo-Torq -> T-piece -> line to Y-piece; T-piece's third leg is blind capped
RIG = {
    "items": [
        {"id": "X1", "kind": "lotorq", "x": 560, "y": 522, "o": "h", "label": "LT-1"},
        {"id": "X2", "kind": "tee", "x": 520, "y": 470, "o": "h", "label": ""},
        {"id": "X3", "kind": "cap", "x": 520, "y": 440, "o": "v", "label": ""},
        {"id": "X4", "kind": "text", "x": 600, "y": 600, "o": "h", "label": "Cement hose rigged 10/10"},
    ],
    "lines": [
        {"id": "L1", "a": "CP_C6", "b": "X1", "pts": [], "label": "", "rating": "15k"},
        {"id": "L2", "a": "X1", "b": "X2", "pts": [[520, 522]], "label": "", "rating": "15k"},
        {"id": "L3", "a": "X2", "b": "X3", "pts": [], "label": "", "rating": "15k"},
        {"id": "L4", "a": "X2", "b": "CP_YP", "pts": [], "label": "2in chiksan", "rating": "15k"},
    ],
}


def test_temporary_rig_up_parts_in_the_graph():
    st = lineup("C6", temp=RIG)
    nodes, edges = build_graph(NETWORK, st)
    assert nodes["X1"]["type"] == "valve" and nodes["X2"]["type"] == "junction" and nodes["X3"]["type"] == "cap"
    assert "X4" not in nodes   # text is only a label
    assert {"L1", "L2", "L3", "L4"} <= {e["id"] for e in edges}
    seen = reachable(st, "C6")
    assert "X1" not in seen   # Lo-Torq closed
    st["valves"]["X1"] = "open"
    assert {"X2", "X3", "CP_YP", "SERVICE_LOOP"} <= reachable(st, "C6")


def test_closed_bsr_cuts_the_string():
    _, edges = build_graph(NETWORK, lineup(pipe="drilling", closed_rams=["BSR"]))
    ids = {e["id"] for e in edges}
    assert "cut_BSR" in ids and "S_BSR~S_CSR" not in ids


def test_pdf_builds_with_paths_and_hoses():
    hose = {"id": "T1", "a": "CP_C6", "b": "CP_YP", "label": "Cement hose", "rating": "15k", "valve": True}
    path = {"id": "F1", "name": "Down kill", "color": "#00b050", "arrows": True,
            "steps": steps("HEX1", "PD_HEX1", "P16") + [{"e": "T1a", "from": "CP_C6"}]}
    for mode in ("none", "drilling", "hangoff"):
        for kw in ({"hoses": [hose]}, {"temp": RIG}):
            st = lineup("P16", pipe=mode, closed_rams=["UPR"], paths=[path], **kw)
            st["pumps"] = ["HEX1", "CMT_TEST"]
            pdf = build_pdf(NETWORK, st, "Test", warnings={"F1": ["Connected to path \"B\" through open valves."]})
            assert pdf.startswith(b"%PDF")


def reachable(st, start):
    """Nodes fluid can reach from `start` through open valves."""
    nodes, edges = build_graph(NETWORK, st)
    seen, todo = {start}, deque([start])
    while todo:
        n = todo.popleft()
        for e in edges:
            if n in (e["a"], e["b"]):
                m = e["b"] if n == e["a"] else e["a"]
                if m not in seen and passable(nodes[m], st):
                    seen.add(m)
                    todo.append(m)
    return seen


def test_hang_off_circulation_down_choke_in_pipe_up_lower_kill():
    # down the choke line, in the upper choke outlet, down the hung-off pipe, up the annulus, out the lower kill
    st = lineup("UOC", "UIC", "LIK", "LOK", pipe="hangoff", closed_rams=["UPR"])
    assert {"C_UP", "B_HANG", "S_HANG", "S_BIT", "WELL", "K_LOW", "KL_LOW"} <= reachable(st, "CL_UP")
    # the closed UPR seals around the pipe, so the only way down is through the pipe
    st["valves"]["MPR"] = "closed"
    st["valves"]["LPR"] = "closed"
    seen = reachable(st, "CL_UP")
    assert "K_LOW" in seen and "C_LOW" not in seen  # annulus between UPR and LPR is isolated


def test_hang_off_top_drive_is_open_ended_and_shears_do_not_cut():
    st = lineup(pipe="hangoff", closed_rams=["BSR"])
    _, edges = build_graph(NETWORK, st)
    ids = {e["id"] for e in edges}
    assert "TD_SUB~TD_OPEN" in ids and "TD_SUB~S_BSR" not in ids
    assert "cut_BSR" not in ids and "S_HANG~B_HANG" in ids
    assert not any("sheared" in n for n in notes(NETWORK, st))


def test_old_saves_with_pipe_in_hole_still_work():
    st = default_state()
    del st["pipe"]
    st["pipe_in_hole"] = True
    _, edges = build_graph(NETWORK, st)
    assert "TD_SUB~S_BSR" in {e["id"] for e in edges}


def test_standard_lineups_follow_pipes_and_open_their_routes():
    colors = {c["hex"] for c in NETWORK["path_colors"]}
    assert len(colors) == 10
    for lid, lu in NETWORK["lineups"].items():
        assert all(NODES[v]["type"] == "valve" for v in lu.get("gauges", [])), lid
        for d in lu["paths"]:
            assert d["color"] in colors, lid
            route_steps = [s for r in d["routes"] for s in steps(*r)]
            valves = {n for r in d["routes"] for n in r if NODES[n]["type"] == "valve"}
            st = lineup(*d.get("open", valves), pipe=lu.get("pipe", "none"))
            info = path_info(NETWORK, st, {"steps": route_steps})
            assert info["inactive"] == 0, lid
            # the choke line-up leaves auto choke 40 as it is
            assert info["closed_inside"] == (["40"] if lid == "choke" else []), lid


def test_downlink_skid_is_a_dead_end():
    st = lineup("59", "56", "LT", "STP_BO")
    seen = reachable(st, "SP_X")
    assert "LT" in seen and "DOWNLINK" not in seen and "BLEED_OFF" not in seen


def test_pump_valves_feed_the_confirmed_standpipes():
    for v, stp in [("P8", "STP1"), ("P13", "STP1"), ("P14", "STP1"),
                   ("P9", "STP2"), ("P12", "STP2"), ("P15", "STP2")]:
        seen = reachable(lineup(v), v)
        assert stp in seen and ({"STP1", "STP2"} - {stp}).isdisjoint(seen), v
