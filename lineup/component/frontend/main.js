"use strict";

// ---------------------------------------------------------------- Streamlit bridge
const SL = {
  send(type, data) {
    window.parent.postMessage(Object.assign({ isStreamlitMessage: true, type }, data || {}), "*");
  },
  ready() { this.send("streamlit:componentReady", { apiVersion: 1 }); },
  height(h) { this.send("streamlit:setFrameHeight", { height: h }); },
  value(v) { this.send("streamlit:setComponentValue", { value: v, dataType: "json" }); },
};

const SVGNS = "http://www.w3.org/2000/svg";
const OPEN = "#22b14c";
const CLOSED = "#e02424";
const HOSE = "#8e24aa";
const WARN = "#ff8c00";
let PALETTE = [];     // the ten path colours, from NET.path_colors

let NET = null;       // network from Python
let ST = null;        // current line-up state
let G = null;         // active graph for ST: {nodes, edges, emap, adj}
let lastNonce = null;
let DEFAULT = null;   // default (reset) state from Python
let frameH = 0;
let view = null;      // svg viewBox {x, y, w, h}
let degree = {};
// mode: valves | manual | auto | temp.  In temp mode: tool, draft (line being drawn), sel (selected temp item/line)
const ui = { mode: "valves", terms: [], msg: null, active: null, undo: null, tool: "select", draft: null, sel: null };
let WARN_BY_PATH = new Map();   // path id -> conflict warnings (see pathWarnings)

const svg = document.getElementById("svg");
const panel = document.getElementById("panel");

window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || d.type !== "streamlit:render") return;
  const a = d.args;
  NET = a.network;
  DEFAULT = a.default_state;
  PALETTE = NET.path_colors.map((c) => c.hex);
  computeDegree();
  drawLineupButtons();
  if (a.height !== frameH) {
    frameH = a.height;
    document.getElementById("app").style.height = frameH + "px";
    SL.height(frameH);
  }
  const load = a.load;
  if (load && load.nonce !== lastNonce) {
    lastNonce = load.nonce;
    ST = normalize(load.state, a.default_state);
    Object.assign(ui, { terms: [], msg: null, undo: null, draft: null, sel: null, tool: "select",
      active: ST.paths.length ? ST.paths[0].id : null });
    if (!view) fit();
    render();
    emit();
  } else if (!ST) {
    ST = normalize(null, a.default_state);
    fit();
    render();
    emit();
  }
});
SL.ready();

function normalize(state, def) {
  const s = JSON.parse(JSON.stringify(def));
  if (!state) return s;
  Object.assign(s.valves, state.valves || {});
  s.pipe = state.pipe || (state.pipe_in_hole ? "drilling" : "none");
  s.temp = migrateTemp(state);
  s.pumps = (state.pumps || []).filter((p) => NET.nodes[p] && NET.nodes[p].type === "pump");
  s.paths = (state.paths || []).map((p, i) => ({
    id: p.id || "F" + (i + 1), name: p.name || "Path " + (i + 1), color: p.color || PALETTE[i % PALETTE.length],
    arrows: p.arrows !== false, steps: (p.steps || []).filter((x) => x && x.e && x.from),
    start: p.start || null, reversed: !!p.reversed, std: p.std || null, expect: p.expect || [],
  }));
  return s;
}

// warnings go along so the PDF can print them
function emit() { SL.value({ state: ST, warnings: Object.fromEntries(WARN_BY_PATH) }); }

function changed() { render(); emit(); }

// ---------------------------------------------------------------- graph (mirror of lineup/solver.py)
// pipe mode: none | drilling (string made up to the top drive) | hangoff (string hung off in the BOP)
const pipeMode = (st) => st.pipe || "none";

function condOk(cond, st) {
  const m = pipeMode(st);
  switch (cond) {
    case "drill": return m === "drilling";
    case "notd": return m !== "drilling";
    case "pipe": return m !== "none";
    case "hang": return m === "hangoff";
    default: return true;
  }
}

// is there drill pipe in the bore at this height?
function pipeAt(y) {
  const m = pipeMode(ST);
  return m === "drilling" || (m === "hangoff" && y >= NET.pipe.hang_top - 0.5);
}

function active(n, st) { return !n || condOk(n.cond, st); }

// ---------------------------------------------------------------- temporary rig-up (mirror of lineup/solver.py)
// st.temp = {items, lines}. Items: valve (Lo-Torq) | choke | check | tee | cross | cap | text, placed at
// x/y with orientation o ("h"/"v") or rotation r. Valves can have a size (1, 1.5, 2).
// Lines join connection points and items through optional bend points.
const TEMP_KINDS = {
  valve: { type: "valve", name: "Lo-Torq valve" },
  choke: { type: "valve", name: "Choke valve" },
  check: { type: "check", name: "Check valve" },
  filter: { type: "junction", name: "Filter" },
  tank: { type: "vessel", name: "Tank" },
  tee: { type: "junction", name: "T-piece" },
  cross: { type: "junction", name: "4-way piece" },
  cap: { type: "cap", name: "Blind cap" },
  text: { type: null, name: "Text" },
};

// older saves had st.hoses (cp -> cp, optional valve in the middle); ids are kept so saved paths still work
function migrateTemp(state) {
  if (state.temp) {
    // older saves had a separate Lo-Torq valve; it is the same as a valve
    const items = (state.temp.items || []).map((i) => (i.kind === "lotorq" ? { ...i, kind: "valve" } : i));
    return { items: items.filter((i) => TEMP_KINDS[i.kind]), lines: state.temp.lines || [] };
  }
  const items = [], lines = [];
  for (const h of state.hoses || []) {
    const a = NET.nodes[h.a], b = NET.nodes[h.b];
    if (!a || !b) continue;
    const rating = h.rating || "15k";
    if (h.valve) {
      const vid = h.id + "_V";
      items.push({ id: vid, kind: "valve", x: snap((a.x + b.x) / 2), y: snap((a.y + b.y) / 2),
        o: Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? "h" : "v", label: h.label || "" });
      lines.push({ id: h.id + "a", a: h.a, b: vid, pts: [], label: "", rating });
      lines.push({ id: h.id + "b", a: vid, b: h.b, pts: [], label: "", rating });
    } else {
      lines.push({ id: h.id, a: h.a, b: h.b, pts: [], label: h.label || "", rating });
    }
  }
  return { items, lines };
}

const snap = (v) => Math.round(v / 5) * 5;

function tempItem(st, id) { return st.temp.items.find((i) => i.id === id); }

// T-pieces and 4-ways have a port at the end of each arm; lines attach to a port (line.pa / line.pb).
// Port positions are relative to the part before rotation; a T's stem points down at angle 0.
const ARM = 14;
// A check valve has two: port 0 is the inlet, port 1 the outlet (flow runs from 0 to 1 only).
const PORTS = { tee: [[-ARM, 0], [ARM, 0], [0, ARM]], cross: [[-ARM, 0], [ARM, 0], [0, -ARM], [0, ARM]],
  check: [[-10, 0], [10, 0]], filter: [[-12, 0], [12, 0]] };
const VALVE_KINDS = ["valve", "choke", "check"];
const SIZED_KINDS = [...VALVE_KINDS, "filter", "tank"];
const SIZES = [[1, "Normal"], [1.5, "Large"], [2, "Extra large"]];
const sizeOf = (it) => it.size || 1;

// rotation of a temporary part in degrees (T-pieces turn in 90° steps; older saves only have o: "h" / "v")
const partAngle = (it) => it.r ?? (it.o === "v" ? -90 : 0);

function portPos(it, k) {
  const z = sizeOf(it), a = partAngle(it) * Math.PI / 180;
  const [px, py] = PORTS[it.kind][k].map((v) => v * z);
  return [Math.round(it.x + px * Math.cos(a) - py * Math.sin(a)), Math.round(it.y + px * Math.sin(a) + py * Math.cos(a))];
}

function nearestPort(it, x, y) {
  let best = 0, bd = Infinity;
  PORTS[it.kind].forEach((_, k) => { const [px, py] = portPos(it, k), d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = k; } });
  return best;
}

// where a line ends on a node or temporary part (a port if the part has ports)
function endPos(id, port) {
  const it = tempItem(ST, id);
  return it && PORTS[it.kind] && port != null ? portPos(it, port) : posOf(id);
}

// port of a temporary line where it meets node nid (undefined if the line is not fitted to a port)
function portAt(e, nid) {
  const l = e && e.line && ST.temp.lines.find((x) => x.id === e.line);
  return l ? (l.a === nid ? l.pa : l.pb) : undefined;
}

// may flow pass node nid coming in through edge inE (null at a start) and leaving through outE?
// Only check valves say no: in through the outlet or out through the inlet.
function checkAllows(nid, inE, outE) {
  const n = G.nodes[nid];
  if (!n || n.kind !== "check") return true;
  return !(inE && portAt(inE, nid) === 1) && portAt(outE, nid) !== 0;
}

function tempNode(it) {
  return { id: it.id, type: TEMP_KINDS[it.kind].type, kind: it.kind, temp: true, x: it.x, y: it.y, o: it.o,
    label: it.label || TEMP_KINDS[it.kind].name };
}

// a temporary line is only connected while both its ends exist in the current pipe mode
function lineActive(l, net, st) {
  const ok = (id) => (net.nodes[id] ? active(net.nodes[id], st) : !!tempItem(st, id) && tempItem(st, id).kind !== "text");
  return ok(l.a) && ok(l.b);
}

function buildGraph(net, st) {
  const nodes = Object.assign({}, net.nodes);
  let edges = net.edges.filter((e) => condOk(e.cond, st));
  if (pipeMode(st) === "drilling") {
    for (const n of Object.values(net.nodes)) {
      if (n.type === "ram" && n.string && st.valves[n.id] === "closed") {
        const s = n.string, below = stringBelow(net, s);
        edges = edges.filter((e) => !(e.r === "string" && ((e.a === s && e.b === below) || (e.a === below && e.b === s))));
        edges.push({ id: "cut_" + n.id, a: s, b: n.above, r: "virtual", segs: [] });
      }
    }
  }
  for (const it of st.temp.items) if (it.kind !== "text") nodes[it.id] = tempNode(it);
  for (const l of st.temp.lines) {
    if (lineActive(l, net, st)) edges.push({ id: l.id, a: l.a, b: l.b, r: l.rating || "15k", segs: [], line: l.id });
  }
  const emap = {}, adj = {};
  for (const id in nodes) adj[id] = [];
  for (const e of edges) { emap[e.id] = e; adj[e.a].push(e); adj[e.b].push(e); }
  return { nodes, edges, emap, adj };
}

function stringBelow(net, s) {
  const y = net.nodes[s].y;
  let best = null;
  for (const e of net.edges) {
    if (e.r !== "string" || (e.a !== s && e.b !== s)) continue;
    const o = e.a === s ? e.b : e.a, oy = net.nodes[o].y;
    if (oy > y && (best === null || oy < net.nodes[best].y)) best = o;
  }
  return best;
}

function passable(n, st) {
  const v = st.valves[n.id];
  switch (n.type) {
    case "valve": return v === "open";
    case "ram":
      if (n.kind === "pipe") return !(v === "closed" && pipeMode(st) !== "none");
      if (n.kind === "shear_ns") return true;
      return v !== "closed";
    default: return !n.block;   // block: a dead end such as the downlink skid
  }
}

const other = (e, n) => (e.a === n ? e.b : e.a);

function pathInfo(g, st, path) {
  const steps = path.steps.filter((s) => g.emap[s.e]);
  const info = { start: null, end: null, valves: [], closed_inside: [], closed_ends: [], inactive: path.steps.length - steps.length };
  if (!steps.length) return info;
  const seq = [];
  for (const s of steps) seq.push(s.from, other(g.emap[s.e], s.from));
  info.start = seq[0];
  info.end = seq[seq.length - 1];
  const order = [...new Set(seq)];
  info.valves = order.filter((n) => ["valve", "ram"].includes(g.nodes[n].type));
  for (const n of info.valves) {
    if (!passable(g.nodes[n], st)) (n === info.start || n === info.end ? info.closed_ends : info.closed_inside).push(n);
  }
  return info;
}

function notes(net, st) {
  const out = [];
  for (const l of st.temp.lines) {
    if (!lineActive(l, net, st)) {
      const inactiveEnd = [l.a, l.b].some((id) => net.nodes[id] && !active(net.nodes[id], st));
      out.push(`Temporary line ${l.label || l.id} is disconnected - ` + (inactiveEnd
        ? "the top drive open end is not available while the string is made up to it."
        : "one of its ends no longer exists."));
    }
  }
  const m = pipeMode(st);
  for (const n of Object.values(net.nodes)) {
    if (n.type !== "ram" || st.valves[n.id] !== "closed") continue;
    if (n.kind === "pipe" && m === "none") out.push(`${n.label} closed with no pipe in hole - will not seal.`);
    if ((n.kind === "shear" || n.kind === "shear_ns") && m === "drilling") out.push(`${n.label} closed with pipe in hole - pipe is sheared.`);
    if (n.kind === "shear_ns") out.push(`${n.label} is non-sealing - does not hold pressure.`);
  }
  return out;
}

// ---------------------------------------------------------------- geometry
function polyLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

function posOf(id) {
  const n = NET.nodes[id] || tempItem(ST, id);
  return n ? [n.x, n.y] : null;
}

// Straight segments: start, bend points, end. Without bends a simple elbow (across, then up/down).
function linePoints(l) {
  const a = endPos(l.a, l.pa), b = endPos(l.b, l.pb);
  const pts = [a, ...(l.pts || [])];
  const last = pts[pts.length - 1];
  if (last[0] !== b[0] && last[1] !== b[1]) pts.push((l.pts || []).length ? [b[0], last[1]] : [b[0], a[1]]);
  pts.push(b);
  return pts;
}

// polyline of an edge, running from e.a to e.b (null for virtual edges)
function edgePoints(e) {
  if (e.line) return linePoints(ST.temp.lines.find((l) => l.id === e.line));
  if (!e.segs || !e.segs.length) return null;
  return [].concat(...e.segs);
}

function edgeLength(e) {
  const p = edgePoints(e);
  return p ? Math.max(1, polyLen(p)) : 1;
}

// ---------------------------------------------------------------- tracing
function activePath(create) {
  let p = ST.paths.find((x) => x.id === ui.active);
  if (!p && create) p = newPath();
  return p;
}

function newPath() {
  const n = Math.max(0, ...ST.paths.map((p) => parseInt(p.id.slice(1)) || 0)) + 1;
  const p = { id: "F" + n, name: "Path " + n, color: PALETTE[(n - 1) % PALETTE.length], arrows: true, steps: [],
    start: null, reversed: false };
  ST.paths.push(p);
  ui.active = p.id;
  return p;
}

function stepTo(s) { const e = G.emap[s.e]; return e ? other(e, s.from) : null; }

// Number of traced pipes touching each node of a path.
function pathDegree(p) {
  const deg = new Map();
  for (const s of p.steps) {
    const e = G.emap[s.e];
    if (!e) continue;
    deg.set(e.a, (deg.get(e.a) || 0) + 1);
    deg.set(e.b, (deg.get(e.b) || 0) + 1);
  }
  return deg;
}

// Give every pipe of a path a consistent direction: flow runs away from p.start through
// the traced pipes (breadth first), and p.reversed flips the whole path. Separate pieces
// of a path each run from one of their own ends.
function orient(p) {
  const act = p.steps.filter((s) => G.emap[s.e]), inact = p.steps.filter((s) => !G.emap[s.e]);
  if (!act.length) { p.steps = inact; return; }
  const adj = new Map();
  for (const s of act) {
    const e = G.emap[s.e];
    for (const n of [e.a, e.b]) { if (!adj.has(n)) adj.set(n, []); adj.get(n).push(e); }
  }
  const deg = (n) => (adj.get(n) || []).length;
  // current directions, as they were before any reversal (roots are chosen un-reversed)
  const current = new Map(act.map((s) => [s.e, p.reversed ? other(G.emap[s.e], s.from) : s.from]));
  // steps flowing away from root, breadth first
  const bfs = (root) => {
    const seenE = new Set(), seenN = new Set([root]), q = [root], out = [];
    while (q.length) {
      const n = q.shift();
      for (const e of adj.get(n)) {
        if (seenE.has(e.id)) continue;
        seenE.add(e.id);
        out.push({ e: e.id, from: n });
        const m = other(e, n);
        if (!seenN.has(m)) { seenN.add(m); q.push(m); }
      }
    }
    return out;
  };
  const done = new Set();
  let steps = [], firstRoot = null;
  for (const s of act) {
    if (done.has(s.e)) continue;
    const whole = bfs(G.emap[s.e].a);
    const nodes = new Set(whole.flatMap((x) => [G.emap[x.e].a, G.emap[x.e].b]));
    if ([...nodes].some((n) => deg(n) > 2) || ![...nodes].some((n) => deg(n) === 1)) {
      // a branched piece (several pumps joining, a split) or a loop has no single start: keep its directions
      const piece = whole.map((x) => ({ e: x.e, from: current.get(x.e) }));
      piece.forEach((x) => done.add(x.e));
      steps = steps.concat(piece);
      if (firstRoot === null) firstRoot = piece[0].from;
      continue;
    }
    // the root of each connected piece is one of its ends: the path start if it is an end of
    // this piece, otherwise the end that keeps most of the current directions
    const ends = [...nodes].filter((n) => deg(n) === 1);
    let root;
    if (p.start && nodes.has(p.start) && deg(p.start) === 1) {
      root = p.start;
    } else {
      let best = -1;
      for (const c of ends.length ? ends : [...nodes]) {
        const score = bfs(c).filter((x) => current.get(x.e) === x.from).length;
        if (score > best) { best = score; root = c; }
      }
    }
    const piece = bfs(root);
    piece.forEach((x) => done.add(x.e));
    steps = steps.concat(piece);
    if (firstRoot === null) firstRoot = root;
  }
  if (!p.start || !adj.has(p.start) || deg(p.start) !== 1) p.start = firstRoot;
  if (p.reversed) steps = steps.reverse().map((s) => ({ e: s.e, from: other(G.emap[s.e], s.from) }));
  p.steps = steps.concat(inact);
}

// manual tracing: click a pipe to add it to the active path (or remove it again)
function toggleStep(eid) {
  const p = activePath(true);
  const e = G.emap[eid];
  const i = p.steps.findIndex((s) => s.e === eid);
  if (i >= 0) {
    p.steps.splice(i, 1);
    if (e && (e.a === p.start || e.b === p.start)) {
      // the start pipe was removed: the path now starts where that pipe joined it
      const o = other(e, p.start);
      p.start = pathDegree(p).has(o) ? o : null;
    }
    orient(p);
    return changed();
  }
  if (!e) return;
  if (p.steps.length === 1) {
    // second click: the first pipe is taken to flow into this one
    const f = G.emap[p.steps[0].e];
    const shared = [f.a, f.b].find((n) => n === e.a || n === e.b);
    if (shared) p.start = other(f, shared);
  } else if (p.start && (e.a === p.start || e.b === p.start) && pathDegree(p).get(p.start) === 1) {
    // extending the path beyond its start: the start moves to the new end
    p.start = other(e, p.start);
  }
  if (!p.steps.length) { p.start = null; p.reversed = false; }
  // a pipe added to the side of the path flows away from it
  const deg = pathDegree(p);
  p.steps.push({ e: eid, from: deg.has(e.b) && !deg.has(e.a) ? e.b : e.a });
  orient(p);
  changed();
}

function reversePath(p) {
  // flip every pipe first, so orient() sees the directions that match the new flag (branched paths
  // and loops keep the directions they are given; a simple path is re-run from its start)
  p.steps = p.steps.map((s) => (G.emap[s.e] ? { e: s.e, from: other(G.emap[s.e], s.from) } : s)).reverse();
  p.reversed = !p.reversed;
  orient(p);
}

// ---------------------------------------------------------------- start -> end line-up
// Route costs are in drawing pixels. The penalties steer the route without forcing big detours.
const CLOSED_VALVE_COST = 300;   // prefer routes through valves that are already open
const OTHER_PATH_COST = 400;     // per pipe: stay clear of other paths when there is a sensible alternative
const BORE_COST = 150;           // per node: don't detour through the BOP bore / riser

// pipes and nodes used by other paths than `skip` (a path or a Set of paths): id -> [path names]
function usedByPaths(skip) {
  const nodes = new Map(), edges = new Map();
  const add = (m, k, name) => { if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(name)) m.get(k).push(name); };
  for (const p of ST.paths) {
    if (skip instanceof Set ? skip.has(p) : p === skip) continue;
    for (const s of p.steps) {
      const e = G.emap[s.e];
      if (!e) continue;
      add(edges, e.id, p.name);
      add(nodes, e.a, p.name);
      add(nodes, e.b, p.name);
    }
  }
  return { nodes, edges };
}

// Cheapest route from start nodes to end nodes. Closed valves may be passed (they will be
// opened) but cost extra; rams are never operated, so a closed ram blocks the route.
function lineupRoute(starts, ends, used) {
  const dist = {}, prev = {}, done = new Set(), frontier = new Set();
  for (const s of starts) { dist[s] = 0; frontier.add(s); }
  while (frontier.size) {
    let cur = null;
    for (const n of frontier) if (cur === null || dist[n] < dist[cur]) cur = n;
    frontier.delete(cur);
    done.add(cur);
    if (ends.has(cur)) {
      const steps = [];
      for (let n = cur; prev[n]; n = prev[n].n) steps.unshift({ e: prev[n].e.id, from: prev[n].n });
      return { end: cur, start: steps.length ? steps[0].from : cur, steps };
    }
    for (const e of G.adj[cur]) {
      const nxt = other(e, cur), node = G.nodes[nxt];
      if (done.has(nxt)) continue;
      if (!checkAllows(cur, prev[cur] && prev[cur].e, e)) continue;   // not backwards through a check valve
      let d = dist[cur] + edgeLength(e);
      if (!ends.has(nxt)) {
        if (node.type === "pump" || node.type === "outlet") continue;
        if (node.type !== "valve" && !passable(node, ST)) continue;   // closed ram, dead end
        if (node.type === "valve" && !passable(node, ST)) d += CLOSED_VALVE_COST;
        if (node.type === "bore" || node.type === "string" || node.type === "ram") d += BORE_COST;
      }
      if (used.edges.has(e.id)) d += OTHER_PATH_COST;
      if (dist[nxt] === undefined || d < dist[nxt]) { dist[nxt] = d; prev[nxt] = { n: cur, e }; frontier.add(nxt); }
    }
  }
  return null;
}

function termNodes(t) {
  if (t.kind === "node") return [t.id];
  const e = G.emap[t.id];
  return [e.a, e.b];
}

function termName(t) {
  if (t.kind === "node") return nodeName(t.id);
  const e = G.emap[t.id];
  return `pipe ${nodeName(e.a)} – ${nodeName(e.b)}`;
}

const isOpenEnd = (n) => n.type === "outlet" || n.type === "vessel" ||
  (n.type === "cp" && n.open && !ST.temp.lines.some((l) => lineActive(l, NET, ST) && (l.a === n.id || l.b === n.id)));

// Find the route and set up the valves for it: open closed valves along the route and close
// the first valve on every branch leaving it. Valves another path runs through are left alone.
function traceLineup(a, b, path) {
  const used = usedByPaths(path);
  const r = lineupRoute(termNodes(a), new Set(termNodes(b)), used);
  if (!r) return { error: `${termName(a)} and ${termName(b)} are not connected (a closed ram may be in the way).` };
  const steps = r.steps;
  if (a.kind === "edge" && !steps.some((s) => s.e === a.id)) steps.unshift({ e: a.id, from: other(G.emap[a.id], r.start) });
  if (b.kind === "edge" && !steps.some((s) => s.e === b.id)) steps.push({ e: b.id, from: r.end });

  const route = [steps.length ? steps[0].from : r.start, ...steps.map(stepTo)];
  const first = route[0], last = route[route.length - 1];
  const onRoute = new Set(route), routeEdges = new Set(steps.map((s) => s.e));
  const out = { steps, opened: [], closed: [], kept: [], leaks: [], warnings: [] };
  const endsAgainst = new Map();   // closed valves other paths end against
  for (const p of ST.paths) {
    if (p === path) continue;
    const i = pathInfo(G, ST, p);
    for (const n of i.closed_ends) endsAgainst.set(n, p.name);
  }

  const sharedWith = new Set();
  for (const n of route.slice(1, -1)) {
    const node = G.nodes[n];
    if (node.type === "valve" && !passable(node, ST)) {
      ST.valves[n] = "open";
      out.opened.push(n);
      if (endsAgainst.has(n)) out.warnings.push(`Opened ${nodeName(n)}, which path "${endsAgainst.get(n)}" ends against.`);
    }
    for (const name of used.nodes.get(n) || []) sharedWith.add(name);
  }
  for (const name of sharedWith) out.warnings.push(`The route shares pipework with path "${name}".`);
  isolate(route, routeEdges, onRoute, new Set([first, last]), used, out);
  return out;
}

// Walk every branch leaving the route until the first valve and close it, unless another path
// runs through it. `stop`: nodes that count as the route; `ends`: valves not to look past.
function isolate(route, routeEdges, stop, ends, used, out) {
  const seen = new Set(stop);
  for (const n of route) {
    const node = G.nodes[n];
    if (ends.has(n) && (node.type === "valve" || node.type === "ram")) continue;  // don't look past an end valve
    for (const e of G.adj[n]) {
      if (routeEdges.has(e.id)) continue;
      const todo = [other(e, n)];
      while (todo.length) {
        const m = todo.pop();
        if (seen.has(m)) continue;
        seen.add(m);
        const mn = G.nodes[m];
        if (mn.type === "valve") {
          if (passable(mn, ST)) {
            if (used.nodes.has(m)) {
              out.kept.push(m);
              out.warnings.push(`Left ${nodeName(m)} open - path "${used.nodes.get(m).join('", "')}" runs through it, so the two paths are connected.`);
            } else {
              ST.valves[m] = "closed";
              out.closed.push(m);
            }
          }
          continue;
        }
        if (!passable(mn, ST)) continue;   // closed ram, dead end
        if (mn.type === "pump") continue;
        if (isOpenEnd(mn)) { out.leaks.push(m); continue; }
        for (const e2 of G.adj[m]) if (!routeEdges.has(e2.id)) todo.push(other(e2, m));
      }
    }
  }
}

function pickTerm(t) {
  if (suppressClick) return;
  ui.terms.push(t);
  ui.msg = null;
  if (ui.terms.length < 2) return render();
  const [a, b] = ui.terms;
  ui.terms = [];
  const p = activePath(true);
  const before = snapshot();
  const r = traceLineup(a, b, p);
  if (r.error) {
    ui.msg = { kind: "error", lines: [r.error] };
    return render();
  }
  ui.undo = before;
  ui.last = r;
  p.steps = r.steps;
  p.start = r.steps.length ? r.steps[0].from : null;
  p.reversed = false;
  orient(p);
  const names = (ids) => ids.map(nodeName).join(", ");
  const lines = [`Traced "${p.name}": ${termName(a)} → ${termName(b)}.`];
  lines.push(r.opened.length ? `Opened: ${names(r.opened)}` : "No valves had to be opened.");
  if (r.closed.length) lines.push(`Closed to isolate: ${names(r.closed)}`);
  if (r.leaks.length) lines.push(`Cannot be isolated with a valve - also open to: ${names(r.leaks)}`);
  ui.msg = { kind: r.warnings.length || r.leaks.length ? "warn" : "ok", lines, warnings: r.warnings };
  changed();
}

// what a trace, a standard line-up or a reset can change, for Undo
const snapshot = () => JSON.stringify({ valves: ST.valves, paths: ST.paths, pipe: ST.pipe, temp: ST.temp, pumps: ST.pumps });

function undoTrace() {
  if (!ui.undo) return;
  Object.assign(ST, JSON.parse(ui.undo));
  if (!ST.paths.some((p) => p.id === ui.active)) ui.active = ST.paths.length ? ST.paths[0].id : null;
  ui.undo = null;
  ui.msg = { kind: "ok", lines: ["Undone - everything is back as it was."] };
  changed();
}

// back to normal: all valves closed, rams open, no pipe, pumps off, no flow paths, no temporary rig-up
function resetAll() {
  const before = snapshot();
  ST = normalize(null, DEFAULT);
  Object.assign(ui, { terms: [], draft: null, sel: null, active: null, undo: before,
    msg: { kind: "ok", lines: ["Reset: all valves closed, rams open, no pipe, pumps off, flow paths and temporary rig-up removed."] } });
  changed();
}

// ---------------------------------------------------------------- standard line-ups (NET.lineups)
function drawLineupButtons() {
  const box = document.getElementById("lineups");
  if (box.childElementCount) return;
  for (const [id, L] of Object.entries(NET.lineups || {})) {
    const b = document.createElement("button");
    b.dataset.lineup = id;
    b.title = L.title || "";
    b.textContent = L.label;
    box.appendChild(b);
  }
}

// Replace the standard paths of the line-up's group with its paths, open its valves and close
// the first valve on every branch leaving them. Rams are never operated.
function applyLineup(id) {
  const L = NET.lineups[id];
  const before = snapshot();
  const pipeChanged = L.pipe && L.pipe !== pipeMode(ST);
  if (L.pipe) ST.pipe = L.pipe;
  ST.paths = ST.paths.filter((p) => p.std !== L.group);
  G = buildGraph(NET, ST);

  const made = [];
  for (const d of L.paths) {
    const steps = [];
    for (const r of d.routes) {
      for (let i = 1; i < r.length; i++) {
        const e = G.adj[r[i - 1]] && G.adj[r[i - 1]].find((x) => other(x, r[i - 1]) === r[i]);
        if (!e) {
          Object.assign(ST, JSON.parse(before));
          ui.msg = { kind: "error", lines: [`${L.label}: no pipe between ${nodeName(r[i - 1])} and ${nodeName(r[i])}.`] };
          return render();
        }
        steps.push({ e: e.id, from: r[i - 1] });
      }
    }
    const p = newPath();
    Object.assign(p, { name: d.name, color: d.color, std: L.group, steps, start: d.routes[0][0], reversed: false,
      expect: d.open_to || [] });
    made.push({ p, d });
  }

  const out = { opened: [], closed: [], kept: [], leaks: [], warnings: [] };
  const open = (v) => { if (ST.valves[v] !== "open") { ST.valves[v] = "open"; out.opened.push(v); } };
  const stop = new Set(), routeEdges = new Set(), ends = new Set();
  for (const { p, d } of made) {
    for (const s of p.steps) { const e = G.emap[s.e]; stop.add(e.a); stop.add(e.b); routeEdges.add(e.id); }
    for (const r of d.routes) { ends.add(r[0]); ends.add(r[r.length - 1]); }
    (d.open || [...new Set(d.routes.flat())].filter((n) => G.nodes[n].type === "valve")).forEach(open);
  }
  const route = [...stop];
  // gauge valves: opened, but not part of a path, and the isolation stops at them
  const gauges = new Set(L.gauges || []);
  gauges.forEach(open);
  gauges.forEach((v) => stop.add(v));
  // valves the other line-ups of this group open (route and gauge valves) are closed again when this
  // line-up does not use them, unless a path outside the line-up runs through them
  const used = usedByPaths(new Set(made.map((m) => m.p)));
  for (const lu of Object.values(NET.lineups)) {
    if (lu.group !== L.group) continue;
    const theirs = [...(lu.gauges || []), ...lu.paths.flatMap((d) => d.open || d.routes.flat())];
    for (const v of new Set(theirs)) {
      if (NET.nodes[v].type !== "valve" || stop.has(v) || used.nodes.has(v) || ST.valves[v] !== "open") continue;
      ST.valves[v] = "closed";
      out.closed.push(v);
    }
  }
  isolate(route, routeEdges, stop, ends, used, out);
  if (gauges.size) out.gaugeNames = [...gauges];
  const expected = new Set(L.paths.flatMap((d) => d.open_to || []));
  out.leaks = out.leaks.filter((n) => !expected.has(n));

  ui.undo = before;
  ui.active = made[0].p.id;
  const names = (ids) => ids.map(nodeName).join(", ");
  const lines = [`Line-up "${L.label}" applied.`];
  if (pipeChanged) lines.push(`Pipe set to: ${document.querySelector(`#pipe option[value="${L.pipe}"]`).textContent.toLowerCase()}.`);
  lines.push(out.opened.length ? `Opened: ${names(out.opened)}` : "No valves had to be opened.");
  if (out.gaugeNames) lines.push(`Open for gauge reading: ${names(out.gaugeNames)}`);
  if (out.closed.length) lines.push(`Closed to isolate: ${names(out.closed)}`);
  if (out.leaks.length) lines.push(`Cannot be isolated with a valve - also open to: ${names(out.leaks)}`);
  ui.msg = { kind: out.warnings.length || out.leaks.length ? "warn" : "ok", lines, warnings: out.warnings };
  changed();
}

// ---------------------------------------------------------------- conflict checks between paths
// For each path: pipes it shares with other paths (same or opposite direction), other paths it
// is connected to through open valves, and outlets it is open to besides its own end.
function pathWarnings() {
  const out = new Map();
  const dirs = new Map();   // edge -> [{path, from}]
  const nodesOf = new Map();
  for (const p of ST.paths) {
    const ns = new Set();
    for (const s of p.steps) {
      const e = G.emap[s.e];
      if (!e) continue;
      ns.add(e.a); ns.add(e.b);
      if (!dirs.has(e.id)) dirs.set(e.id, []);
      dirs.get(e.id).push({ p, from: s.from });
    }
    nodesOf.set(p.id, ns);
    out.set(p.id, { against: new Set(), shares: new Set(), connected: new Set(), leaks: new Set(), checks: new Set() });
    for (const s of p.steps) {
      const e = G.emap[s.e];
      if (!e) continue;
      const to = other(e, s.from);
      if ((G.nodes[s.from].kind === "check" && portAt(e, s.from) === 0) || (G.nodes[to].kind === "check" && portAt(e, to) === 1)) {
        out.get(p.id).checks.add(nodeName(G.nodes[s.from].kind === "check" ? s.from : to));
      }
    }
  }
  // paths of the same standard line-up (drilling + boost) are meant to meet, so they don't warn about each other
  const sameLineup = (p, q) => !!p.std && p.std === q.std;
  for (const list of dirs.values()) {
    for (const x of list) for (const y of list) {
      if (x.p === y.p || sameLineup(x.p, y.p)) continue;
      out.get(x.p.id)[x.from === y.from ? "shares" : "against"].add(y.p.name);
    }
  }
  for (const p of ST.paths) {
    const own = nodesOf.get(p.id), w = out.get(p.id);
    if (!own.size) continue;
    const ownEdges = new Set(p.steps.map((s) => s.e));
    const seen = new Set(own);
    const todo = [...own].filter((n) => passable(G.nodes[n], ST));
    while (todo.length) {
      const n = todo.pop();
      for (const e of G.adj[n]) {
        if (ownEdges.has(e.id)) continue;
        const m = other(e, n);
        if (seen.has(m)) continue;
        seen.add(m);
        const mn = G.nodes[m];
        if (ST.paths.some((q) => q !== p && sameLineup(p, q) && nodesOf.get(q.id).has(m))) continue;
        const hit = ST.paths.find((q) => q !== p && nodesOf.get(q.id).has(m));
        if (hit) { w.connected.add(hit.name); continue; }
        if (!passable(mn, ST) || mn.type === "pump") continue;
        if (isOpenEnd(mn)) { if (!(p.expect || []).includes(m)) w.leaks.add(nodeName(m)); continue; }
        todo.push(m);
      }
    }
  }
  const msgs = new Map();
  for (const p of ST.paths) {
    const w = out.get(p.id), list = [];
    for (const q of w.against) list.push(`Flows against path "${q}" in a shared pipe.`);
    for (const q of w.connected) if (!w.against.has(q)) list.push(`Connected to path "${q}" through open valves.`);
    for (const q of w.shares) if (!w.against.has(q)) list.push(`Shares pipe with path "${q}".`);
    if (w.leaks.size) list.push(`Also open to: ${[...w.leaks].join(", ")}.`);
    for (const c of w.checks) list.push(`Flows the wrong way through ${c} - a check valve only lets flow through in its arrow direction.`);
    msgs.set(p.id, list);
  }
  return msgs;
}

// ---------------------------------------------------------------- drawing helpers
function el(tag, attrs, parent, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function pathD(pts) { return pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" "); }

function trim(pts, d) {
  const p = pts.map((q) => q.slice());
  const cut = (p, d) => {
    while (p.length > 1 && d > 0) {
      const [x0, y0] = p[0], [x1, y1] = p[1], L = Math.hypot(x1 - x0, y1 - y0);
      if (L <= d) { p.shift(); d -= L; } else { p[0] = [x0 + (x1 - x0) * d / L, y0 + (y1 - y0) * d / L]; d = 0; }
    }
  };
  cut(p, d); p.reverse(); cut(p, d); p.reverse();
  return p;
}

// every broken line (dash, dot, dashdot, temporary lines) uses the same dash-dot pattern
const DASHDOT = "14 4 3 4";
function dash(style) { return style ? DASHDOT : null; }

function multiText(parent, x, y, s, attrs) {
  const lines = String(s).split("\n");
  const size = attrs["font-size"] || 10;
  const t = el("text", Object.assign({ x, y: y - (lines.length - 1) * size * 0.55 }, attrs), parent);
  lines.forEach((ln, i) => el("tspan", { x, dy: i ? size * 1.1 : 0 }, t, ln));
  return t;
}

function wrap(s, maxChars) {
  const words = String(s).split(" "), lines = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > maxChars) { lines.push(cur); cur = w; }
    else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

function nodeName(id) {
  const n = NET.nodes[id];
  if (n) return (n.name || n.label || id).replace(/\n/g, " ");
  const it = tempItem(ST, id);
  return it ? it.label || `${TEMP_KINDS[it.kind].name} (temp.)` : id;
}

function computeDegree() {
  degree = {};
  for (const e of NET.edges) {
    if (e.cond) continue;
    degree[e.a] = (degree[e.a] || 0) + 1;
    degree[e.b] = (degree[e.b] || 0) + 1;
  }
}

function labelPos(n, off) {
  switch (n.lp) {
    case "l": return { x: n.x - off, y: n.y + 4, a: "end" };
    case "t": return { x: n.x, y: n.y - off + 2, a: "middle" };
    case "tr": return { x: n.x - 4, y: n.y - off + 2, a: "start" };
    case "b": return { x: n.x, y: n.y + off + 8, a: "middle" };
    default: return { x: n.x + off, y: n.y + 4, a: "start" };
  }
}

// arrows along a polyline (pts in flow direction); dx shifts them sideways, e.g. into the annulus
function drawArrows(g, pts, color, dx = 0, scale = 1) {
  const L = polyLen(pts);
  if (L < 28) return;
  const n = Math.max(1, Math.round(L / 150));
  for (let k = 0; k < n; k++) {
    let d = L * (k + 0.5) / n;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], s = Math.hypot(x1 - x0, y1 - y0);
      if (d <= s || i === pts.length - 1) {
        const t = s ? Math.min(1, d / s) : 0;
        const ang = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
        el("polygon", { points: "-6,-5 7,0 -6,5", fill: color, stroke: "#fff", "stroke-width": 0.8,
          transform: `translate(${x0 + (x1 - x0) * t + dx},${y0 + (y1 - y0) * t}) rotate(${ang}) scale(${scale})`, "pointer-events": "none" }, g);
        break;
      }
      d -= s;
    }
  }
}

// ---------------------------------------------------------------- render
function render() {
  G = buildGraph(NET, ST);
  const C = NET.colors;
  svg.innerHTML = "";
  applyView();

  // colour of each traced pipe (a later path wins where paths share a pipe)
  const colorOf = new Map();
  const infos = new Map();
  for (const p of ST.paths) {
    for (const s of p.steps) if (G.emap[s.e]) colorOf.set(s.e, p.color);
    infos.set(p.id, pathInfo(G, ST, p));
  }
  const warn = new Set([...infos.values()].flatMap((i) => i.closed_inside));
  WARN_BY_PATH = pathWarnings();
  const tracing = ui.mode === "manual" || ui.mode === "auto";

  const gDecor = el("g", {}, svg);
  for (const d of NET.decor) drawDecor(d, gDecor);

  const gEdges = el("g", { fill: "none", "stroke-linejoin": "round" }, svg);
  const P = NET.pipe;
  const visible = NET.edges.filter((e) => condOk(e.cond, ST));
  const annulus = (e) => e.r === "bore" && pipeAt(NET.nodes[e.a].y) && pipeAt(NET.nodes[e.b].y);
  const normal = visible.filter((e) => !e.over && e.r !== "bore" && e.r !== "string");
  const over = visible.filter((e) => e.over);
  const bores = visible.filter((e) => e.r === "bore");
  const strings = visible.filter((e) => e.r === "string");

  const drawLine = (e, g) => {
    for (const seg of e.segs) {
      el("path", { d: pathD(seg), stroke: colorOf.get(e.id) || C[e.r] || "#333", "stroke-width": 3,
        "stroke-dasharray": dash(e.style) }, g);
    }
  };
  for (const e of normal) drawLine(e, gEdges);
  for (const e of over) {
    for (const seg of e.segs) el("path", { d: pathD(trim(seg, 12)), stroke: "#fff", "stroke-width": 11 }, gEdges);
    drawLine(e, gEdges);
  }
  // bore / annulus, then the drill pipe on top as a hollow tube (walls + its own inside channel)
  for (const e of bores) for (const seg of e.segs) el("path", { d: pathD(seg), stroke: "#444", "stroke-width": P.bore + 4 }, gEdges);
  for (const e of bores) for (const seg of e.segs) el("path", { d: pathD(seg), stroke: colorOf.get(e.id) || "#fff", "stroke-width": P.bore }, gEdges);
  for (const e of strings) {
    for (const seg of e.segs) {
      el("path", { d: pathD(seg), stroke: "#111", "stroke-width": P.od }, gEdges);
      el("path", { d: pathD(seg), stroke: colorOf.get(e.id) || "#fff", "stroke-width": P.id }, gEdges);
    }
  }
  for (const e of visible) for (const t of e.tags || []) {
    el("text", { x: t.x, y: t.y, "font-size": 9, "text-anchor": t.anchor || "start", fill: "#555" }, gEdges, t.s);
  }

  drawTempLines(colorOf);

  // flow direction arrows
  const gArrows = el("g", {}, svg);
  for (const p of ST.paths) {
    if (!p.arrows) continue;
    for (const s of p.steps) {
      const e = G.emap[s.e];
      const pts = e && edgePoints(e);
      if (!pts) continue;
      const fwd = s.from === e.a ? pts : pts.slice().reverse();
      if (annulus(e)) {
        // flow outside the pipe: an arrow on each side of it
        const off = (P.od + (P.bore - P.od) / 2) / 2;
        drawArrows(gArrows, fwd, p.color, -off, 0.7);
        drawArrows(gArrows, fwd, p.color, off, 0.7);
      } else {
        drawArrows(gArrows, fwd, p.color, 0, e.r === "string" ? 0.75 : 1);
      }
    }
  }

  // invisible wide hit areas so pipes can be clicked while tracing
  if (tracing) {
    const gHit = el("g", { fill: "none" }, svg);
    for (const e of G.edges) {
      const pts = edgePoints(e);
      if (!pts) continue;
      const hit = el("path", { d: pathD(pts), stroke: "transparent", "stroke-width": e.r === "bore" ? P.bore : 12,
        class: "clickable", "pointer-events": "stroke" }, gHit);
      el("title", {}, hit, `Pipe ${nodeName(e.a)} – ${nodeName(e.b)}`);
      hit.addEventListener("click", () => onEdgeClick(e.id));
    }
  }

  const gNodes = el("g", { "font-family": "Arial, Helvetica, sans-serif" }, svg);
  for (const n of Object.values(NET.nodes)) drawNode(n, gNodes, warn);
  drawTempItems(warn);

  // start point marker while tracing start -> end
  for (const t of ui.terms) {
    const pts = t.kind === "node" ? [posOf(t.id)] : edgePoints(G.emap[t.id]);
    if (!pts || !pts[0]) continue;
    const m = pts[Math.floor(pts.length / 2)];
    el("circle", { cx: m[0], cy: m[1], r: 15, fill: "none", stroke: "#1e6fff", "stroke-width": 3, "stroke-dasharray": "4 3",
      class: "cp-pick", "pointer-events": "none" }, svg);
  }

  renderPanel(infos);
  document.getElementById("pipe").value = pipeMode(ST);
  for (const b of document.querySelectorAll("#toolbar [data-mode]")) b.classList.toggle("active", b.dataset.mode === ui.mode);
}

function drawDecor(d, g) {
  if (d.t === "text") {
    el("text", { x: d.x, y: d.y, "font-size": d.size, "text-anchor": d.anchor, "font-weight": d.weight, fill: d.color,
      "font-family": "Arial, Helvetica, sans-serif" }, g, d.s);
  } else if (d.t === "rect") {
    el("rect", { x: d.x, y: d.y, width: d.w, height: d.h, fill: d.fill, stroke: d.stroke, "stroke-dasharray": d.dash }, g);
  } else if (d.t === "bop") {
    const [rx, ry, rw, rh] = d.riser;
    el("rect", { x: rx - 3, y: ry, width: rw + 6, height: rh, fill: "#cfd4da", stroke: "#444" }, g);
    el("rect", { x: d.x, y: d.y, width: d.w, height: d.h, rx: 6, fill: "#cfd4da", stroke: "#444", "stroke-width": 1.5 }, g);
  }
}

// click on a node: pick it as a trace end point, toggle it, or pick it for a hose
function onNodeClick(id) {
  if (suppressClick) return;
  if (ui.mode === "auto") return pickTerm({ kind: "node", id });
  const n = G.nodes[id];
  if (ui.mode === "temp") { if (n && n.type === "cp") onTempTarget(id); return; }
  if (n && (n.type === "valve" || n.type === "ram")) toggleValve(id);
  if (n && n.type === "pump") togglePump(id);
}

// running pumps are only a visual aid - they do not affect any flow path
function togglePump(id) {
  ST.pumps = ST.pumps.includes(id) ? ST.pumps.filter((p) => p !== id) : [...ST.pumps, id];
  changed();
}

function onEdgeClick(id) {
  if (suppressClick) return;
  if (ui.mode === "manual") return toggleStep(id);
  if (ui.mode === "auto") return pickTerm({ kind: "edge", id });
}

function clickable(grp, id) {
  grp.setAttribute("class", "clickable");
  grp.addEventListener("click", () => onNodeClick(id));
}

function drawNode(n, g, warn) {
  if (!active(n, ST)) return;
  const pickable = ui.mode === "auto";
  switch (n.type) {
    case "valve": return drawValve(n, g, warn.has(n.id), ST.valves[n.id] === "open");
    case "ram": return drawRam(n, g, warn.has(n.id));
    case "pump": return drawPump(n, g);
    case "outlet": {
      const grp = el("g", {}, g);
      el("circle", { cx: n.x, cy: n.y, r: 5, fill: "#777", stroke: "#333" }, grp);
      const p = labelPos(n, 9);
      multiText(grp, p.x, p.y, n.label, { "text-anchor": p.a, "font-size": 9.5, fill: "#444" });
      if (pickable) clickable(grp, n.id);
      return;
    }
    case "vessel": case "buffer": {
      const [x, y, w, h] = n.rect;
      const grp = el("g", {}, g);
      el("rect", { x, y, width: w, height: h, rx: n.radius ?? (n.type === "vessel" ? Math.min(w, h) / 2.5 : 2),
        fill: "#eceff1", stroke: "#333", "stroke-width": 1.5 }, grp);
      if (n.label) {
        if (h > w * 2) {
          el("text", { x: 0, y: 0, transform: `translate(${x + w / 2 + 3},${y + h / 2}) rotate(-90)`, "text-anchor": "middle",
            "font-size": 10, "font-weight": "bold" }, grp, n.label);
        } else if (h > 40) {
          multiText(grp, x + w / 2, y + h / 2 + 3, wrap(n.label, 9), { "text-anchor": "middle", "font-size": 9, "font-weight": "bold" });
        } else {
          el("text", { x: x + w / 2, y: y + h / 2 + 3, "text-anchor": "middle", "font-size": 8, fill: "#555" }, grp, n.label);
        }
      }
      if (pickable) clickable(grp, n.id);
      return;
    }
    case "box": {
      const grp = el("g", {}, g);
      el("rect", { x: n.x - n.w / 2, y: n.y - n.h / 2, width: n.w, height: n.h, fill: n.fill, stroke: "#333", "stroke-width": 1.2 }, grp);
      if (n.label) multiText(grp, n.x, n.y + 3, wrap(n.label, Math.max(4, Math.floor(n.w / 6))),
        { "text-anchor": "middle", "font-size": n.w < 30 ? 12 : 8.5, "font-weight": "bold" });
      if (pickable) clickable(grp, n.id);
      return;
    }
    case "cp": {
      const picking = ui.mode === "temp" && ui.tool !== "select" && ui.tool !== "text";
      const picked = ui.draft && ui.draft.a === n.id;
      const grp = el("g", {}, g);
      el("circle", { cx: n.x, cy: n.y, r: picking ? 9 : 6, fill: picked ? HOSE : "#fff",
        stroke: HOSE, "stroke-width": 2.5, class: picking ? "cp-pick" : "" }, grp);
      el("title", {}, grp, `Connection point: ${n.label}${n.open ? " (open end)" : ""}`);
      const p = labelPos(n, 10);
      el("text", { x: p.x, y: p.y, "text-anchor": p.a, "font-size": 8.5, fill: HOSE }, grp, n.label);
      if (picking || pickable) clickable(grp, n.id);
      return;
    }
    case "junction":
      if ((degree[n.id] || 0) >= 3) el("circle", { cx: n.x, cy: n.y, r: 3.2, fill: "#222" }, g);
      return;
    default: return;
  }
}

function drawValve(n, g, warned, open, angle) {
  const rot = angle !== undefined ? angle : (n.o === "v" ? -90 : 0);
  const grp = el("g", { transform: `translate(${n.x},${n.y}) rotate(${rot})`, class: "clickable" }, g);
  const action = ui.mode === "auto" ? "click to use as trace point" : "click to toggle";
  el("title", {}, grp, `${n.temp ? "Temporary valve" : n.choke ? "Choke" : "Valve"} ${n.label || n.id}: ${open ? "OPEN" : "CLOSED"}${n.auto ? " (auto)" : ""} - ${action}`);
  el("rect", { x: -13, y: -10, width: 26, height: 20, fill: "transparent" }, grp);
  if (warned) el("circle", { r: 13, fill: "none", stroke: WARN, "stroke-width": 3 }, grp);
  if (n.auto) {
    el("line", { x1: 0, y1: 0, x2: 0, y2: -12, stroke: "#333", "stroke-width": 1.2 }, grp);
    el("rect", { x: -5, y: -19, width: 10, height: 8, fill: "#fff", stroke: "#333", "stroke-width": 1.2 }, grp);
  }
  const fill = open ? OPEN : CLOSED;
  const stroke = n.temp ? HOSE : "#222";
  el("polygon", { points: "-10,-7 0,0 -10,7", fill, stroke, "stroke-width": 1.3, "stroke-linejoin": "round" }, grp);
  el("polygon", { points: "10,-7 0,0 10,7", fill, stroke, "stroke-width": 1.3, "stroke-linejoin": "round" }, grp);
  if (n.choke) {
    // choke: diagonal arrow through the valve
    el("line", { x1: -12, y1: 10, x2: 9, y2: -8, stroke: "#222", "stroke-width": 1.6 }, grp);
    el("polygon", { points: "13,-11 4,-8.5 10,-2", fill: "#222" }, grp);
  }
  grp.addEventListener("click", () => onNodeClick(n.id));
  if (n.label && !n.hide && angle === undefined) {
    // the actuator sits on top of horizontal valves and on the left of vertical ones
    const p = labelPos(n, n.auto && n.lp === (n.o === "v" ? "l" : "t") ? 24 : 13);
    el("text", { x: p.x, y: p.y, "text-anchor": p.a, "font-size": 10, "font-weight": "bold", fill: "#333" }, g, n.label);
  }
}

function drawRam(n, g, warned) {
  const closed = ST.valves[n.id] === "closed";
  const half = 48, stub = 20, h = n.kind === "annular" ? 16 : 10;
  const grp = el("g", { class: "clickable" }, g);
  el("title", {}, grp, `${n.label}: ${closed ? "CLOSED" : "OPEN"} - ${ui.mode === "auto" ? "click to use as trace point" : "click to toggle"}`);
  el("rect", { x: n.x - half - 6, y: n.y - 11, width: 2 * half + 12, height: 22, fill: "transparent" }, grp);
  const st = { fill: closed ? CLOSED : OPEN, stroke: "#222", "stroke-width": closed ? 2 : 1 };
  const aroundPipe = pipeAt(n.y) && !n.kind.startsWith("shear");  // shear rams cut the pipe instead
  if (closed && aroundPipe) {
    const w = half - NET.pipe.od / 2;
    el("rect", Object.assign({ x: n.x - half, y: n.y - h / 2, width: w, height: h }, st), grp);
    el("rect", Object.assign({ x: n.x + half - w, y: n.y - h / 2, width: w, height: h }, st), grp);
    if (warned) el("rect", { x: n.x - half - 3, y: n.y - h / 2 - 3, width: 2 * half + 6, height: h + 6, fill: "none", stroke: WARN, "stroke-width": 2.5 }, grp);
  } else if (closed) {
    el("rect", Object.assign({ x: n.x - half, y: n.y - h / 2, width: 2 * half, height: h }, st), grp);
    if (warned) el("rect", { x: n.x - half - 3, y: n.y - h / 2 - 3, width: 2 * half + 6, height: h + 6, fill: "none", stroke: WARN, "stroke-width": 2.5 }, grp);
  } else {
    el("rect", Object.assign({ x: n.x - half, y: n.y - h / 2, width: stub, height: h }, st), grp);
    el("rect", Object.assign({ x: n.x + half - stub, y: n.y - h / 2, width: stub, height: h }, st), grp);
  }
  el("text", { x: n.x + 66, y: n.y + 4, "font-size": 10, "font-weight": closed ? "bold" : "normal", fill: closed ? "#b00" : "#333" },
    grp, n.label + (closed ? " (closed)" : ""));
  grp.addEventListener("click", () => onNodeClick(n.id));
}

function drawPump(n, g) {
  const on = ST.pumps.includes(n.id);
  const fill = on ? "#1aa64a" : "#3b5ba5";
  const grp = el("g", {}, g);
  el("title", {}, grp, `${n.label.replace("\n", " ")}: ${on ? "RUNNING" : "stopped"} - ` +
    (ui.mode === "auto" ? "click to use as trace point" : "click to start/stop (visual only)"));
  if (n.shape === "rect") {
    el("rect", { x: n.x - 28, y: n.y - 18, width: 56, height: 36, rx: 4, fill, stroke: "#1b2a4a", "stroke-width": 1.5 }, grp);
    if (on) el("rect", { x: n.x - 32, y: n.y - 22, width: 64, height: 44, rx: 6, fill: "none", stroke: "#1aa64a", "stroke-width": 2.5, "stroke-dasharray": "6 4" }, grp);
  } else {
    el("circle", { cx: n.x, cy: n.y, r: 24, fill, stroke: "#1b2a4a", "stroke-width": 1.5 }, grp);
    if (on) el("circle", { cx: n.x, cy: n.y, r: 29, fill: "none", stroke: "#1aa64a", "stroke-width": 2.5, "stroke-dasharray": "6 4", class: "running-ring" }, grp);
  }
  multiText(grp, n.x, n.y + 4, n.label, { "text-anchor": "middle", "font-size": n.shape === "rect" ? 8 : 10, "font-weight": "bold", fill: "#fff" });
  if (ui.mode === "auto" || ui.mode === "valves" || ui.mode === "manual") clickable(grp, n.id);
}

// ---------------------------------------------------------------- temporary rig-up: drawing
const haloText = (g, x, y, s, attrs) => el("text", Object.assign({ x, y, "font-size": 10, "font-weight": "bold", fill: HOSE,
  stroke: "#fff", "stroke-width": 3, "paint-order": "stroke", "font-family": "Arial, sans-serif" }, attrs), g, s);

// middle of the longest segment, for placing a line label
function lineLabelPos(pts) {
  let best = 0, at = [pts[0][0], pts[0][1]], horiz = true;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], L = Math.hypot(x1 - x0, y1 - y0);
    if (L > best) { best = L; at = [(x0 + x1) / 2, (y0 + y1) / 2]; horiz = Math.abs(x1 - x0) >= Math.abs(y1 - y0); }
  }
  return { at, horiz };
}

let lineLabels = [];   // drawn on top of everything by drawTempItems

function drawTempLines(colorOf) {
  lineLabels = [];
  const g = el("g", { fill: "none" }, svg);
  for (const l of ST.temp.lines) {
    if (!lineActive(l, NET, ST)) continue;
    const pts = linePoints(l);
    const sel = ui.mode === "temp" && ui.sel === l.id;
    if (sel) el("path", { d: pathD(pts), stroke: "#1e6fff", "stroke-width": 9, opacity: 0.35, "stroke-linejoin": "round" }, g);
    const p = el("path", { d: pathD(pts), stroke: colorOf.get(l.id) || HOSE, "stroke-width": 3, "stroke-dasharray": DASHDOT,
      "stroke-linejoin": "round" }, g);
    el("title", {}, p, `Temporary line${l.label ? " " + l.label : ""}: ${nodeName(l.a)} → ${nodeName(l.b)} (${l.rating || "15k"})`);
    if (l.label) {
      const { at, horiz } = lineLabelPos(pts);
      lineLabels.push([at[0] + (horiz ? 0 : 7), at[1] + (horiz ? -7 : 4), l.label, horiz ? "middle" : "start"]);
    }
    if (ui.mode === "temp") {
      const hit = el("path", { d: pathD(pts), stroke: "transparent", "stroke-width": 12, class: "clickable", "pointer-events": "stroke" }, g);
      hit.addEventListener("click", () => { if (!suppressClick) { ui.sel = l.id; render(); } });
    }
  }
  // line being drawn
  if (ui.draft) {
    const pts = [endPos(ui.draft.a, ui.draft.pa), ...ui.draft.pts];
    if (pts.length > 1) el("path", { d: pathD(pts), stroke: HOSE, "stroke-width": 3, "stroke-dasharray": DASHDOT, opacity: 0.7 }, g);
    for (const q of ui.draft.pts) el("circle", { cx: q[0], cy: q[1], r: 3.5, fill: HOSE }, g);
  }
}

function drawTempItems(warn) {
  const g = el("g", { "font-family": "Arial, Helvetica, sans-serif" }, svg);
  for (const [x, y, s, anchor] of lineLabels) haloText(g, x, y, s, { "text-anchor": anchor, "pointer-events": "none" });
  for (const it of ST.temp.items) {
    const grp = el("g", { "data-temp": it.id, class: "clickable" }, g);
    const sel = ui.mode === "temp" && ui.sel === it.id;
    const rot = partAngle(it);
    const name = TEMP_KINDS[it.kind].name;
    const ports = PORTS[it.kind];
    if (it.kind === "text") {
      const t = haloText(grp, it.x, it.y, it.label || "Text", { "font-size": 11 });
      if (sel) {
        try { const b = t.getBBox(); el("rect", { x: b.x - 3, y: b.y - 2, width: b.width + 6, height: b.height + 4, fill: "none", stroke: "#1e6fff", "stroke-dasharray": "3 2" }, grp); } catch (e) { /* not laid out */ }
      }
    } else {
      const z = sizeOf(it);
      const body = el("g", { transform: `translate(${it.x},${it.y}) rotate(${rot}) scale(${z})` }, grp);
      if (it.kind === "tank") el("rect", { x: -24, y: -19, width: 48, height: 38, fill: "transparent" }, body);
      else if (ports) el("rect", { x: -ARM - 5, y: -ARM - 5, width: 2 * ARM + 10, height: 2 * ARM + 10, fill: "transparent" }, body);
      else el("rect", { x: -13, y: -11, width: 26, height: 22, fill: "transparent" }, body);
      if (sel) el("circle", { r: ports ? ARM + 5 : 15, fill: "none", stroke: "#1e6fff", "stroke-width": 2, "stroke-dasharray": "3 2" }, body);
      if (it.kind === "valve" || it.kind === "choke") {
        const open = ST.valves[it.id] === "open", fill = open ? OPEN : CLOSED;
        if (warn.has(it.id)) el("circle", { r: 13, fill: "none", stroke: WARN, "stroke-width": 3 }, body);
        el("polygon", { points: "-10,-7 0,0 -10,7", fill, stroke: HOSE, "stroke-width": 1.5, "stroke-linejoin": "round" }, body);
        el("polygon", { points: "10,-7 0,0 10,7", fill, stroke: HOSE, "stroke-width": 1.5, "stroke-linejoin": "round" }, body);
        if (it.kind === "valve") el("circle", { r: 3.5, fill: "#fff", stroke: "#222", "stroke-width": 1.3 }, body);   // Lo-Torq
        else {   // choke: diagonal arrow through the valve
          el("line", { x1: -12, y1: 10, x2: 9, y2: -8, stroke: "#222", "stroke-width": 1.6 }, body);
          el("polygon", { points: "13,-11 4,-8.5 10,-2", fill: "#222" }, body);
        }
        el("title", {}, grp, `${name} ${it.label || ""}: ${open ? "OPEN" : "CLOSED"}`);
      } else if (it.kind === "filter") {
        // diamond with a dashed screen across, a port marker at each end in rig-up mode
        el("polygon", { points: "-12,0 0,-9 12,0 0,9", fill: "#fff", stroke: HOSE, "stroke-width": 1.8, "stroke-linejoin": "round" }, body);
        el("line", { x1: 0, y1: -9, x2: 0, y2: 9, stroke: HOSE, "stroke-width": 1.4, "stroke-dasharray": "2.5 2" }, body);
        if (ui.mode === "temp") for (const [px, py] of ports) el("circle", { cx: px, cy: py, r: 2.6, fill: "#fff", stroke: HOSE, "stroke-width": 1.3 }, body);
        el("title", {}, grp, name + (it.label ? " " + it.label : ""));
      } else if (it.kind === "tank") {
        el("rect", { x: -20, y: -15, width: 40, height: 30, rx: 3, fill: "#eceff1", stroke: HOSE, "stroke-width": 2 }, body);
        el("title", {}, grp, (it.label || name) + " (temporary tank)");
      } else if (it.kind === "check") {
        // inlet half outlined, outlet half filled, arrow in the flow direction
        el("polygon", { points: "-10,-7 0,0 -10,7", fill: "#fff", stroke: HOSE, "stroke-width": 1.5, "stroke-linejoin": "round" }, body);
        el("polygon", { points: "10,-7 0,0 10,7", fill: HOSE, stroke: HOSE, "stroke-width": 1.5, "stroke-linejoin": "round" }, body);
        el("path", { d: "M-7 -12 H5 M2 -15 L7 -12 L2 -9", fill: "none", stroke: "#222", "stroke-width": 1.4 }, body);
        if (ui.mode === "temp") for (const [px, py] of ports) el("circle", { cx: px, cy: py, r: 2.6, fill: "#fff", stroke: HOSE, "stroke-width": 1.3 }, body);
        el("title", {}, grp, `${name} ${it.label || ""}: flow in the arrow direction only` + (ui.mode === "temp" ? " - Rotate turns it" : ""));
      } else if (ports) {
        // drawn as the fitting itself: one arm per port, a port marker at each arm end in rig-up mode
        el("path", { d: ports.map(([px, py]) => `M0 0 L${px} ${py}`).join(" "), stroke: HOSE, "stroke-width": 5 }, body);
        el("rect", { x: -4, y: -4, width: 8, height: 8, fill: HOSE }, body);
        if (ui.mode === "temp") {
          for (const [px, py] of ports) el("circle", { cx: px, cy: py, r: 3.2, fill: "#fff", stroke: HOSE, "stroke-width": 1.6 }, body);
        }
        el("title", {}, grp, name + (it.label ? " " + it.label : "") + (ui.mode === "temp" ? " - click an arm end to connect there" : ""));
      } else if (it.kind === "cap") {
        el("rect", { x: -3, y: -9, width: 6, height: 18, fill: HOSE, stroke: "#222", "stroke-width": 1 }, body);
        el("title", {}, grp, name + (it.label ? " " + it.label : ""));
      }
      if (it.kind === "tank") {
        el("text", { x: it.x, y: it.y + 3.5 * sizeOf(it), "text-anchor": "middle", "font-size": 9 * sizeOf(it), "font-weight": "bold",
          fill: "#222", "pointer-events": "none" }, grp, it.label || "TANK");
      } else if (it.label) {
        const off = (it.kind === "tee" || it.kind === "cross" ? ARM + 8 : 15) * z;
        if (!ports && it.o === "v") haloText(grp, it.x + off, it.y + 4, it.label, {});
        else haloText(grp, it.x, it.y - off, it.label, { "text-anchor": "middle" });
      }
    }
    grp.addEventListener("click", (ev) => onTempItemClick(it.id, ev));
    grp.addEventListener("pointerdown", (ev) => {
      if (ui.mode !== "temp" || ui.tool !== "select" || ev.button !== 0) return;
      ev.stopPropagation();   // drag the part instead of panning
      itemDrag = { id: it.id, x: ev.clientX, y: ev.clientY, ix: it.x, iy: it.y, moved: false };
    });
  }
}

// ---------------------------------------------------------------- temporary rig-up: editing
const tempThing = (id) => tempItem(ST, id) || ST.temp.lines.find((l) => l.id === id);

function nextId(prefix, list) {
  return prefix + (Math.max(0, ...list.filter((x) => x.id.startsWith(prefix)).map((x) => parseInt(x.id.slice(prefix.length)) || 0)) + 1);
}

// attachTo / port: the connection point or part (and its port) the new part is fitted to
function addItem(kind, x, y, attachTo, port) {
  const it = { id: nextId("X", ST.temp.items), kind, x: snap(x), y: snap(y), o: "h", label: kind === "text" ? "Label" : "" };
  if (PORTS[kind]) it.r = 0;
  if (attachTo) {
    const [ax, ay] = endPos(attachTo, port);
    // fitted on the arm of a T / 4-way: continue outwards along that arm (u); on a connection point: to the right
    const pit = tempItem(ST, attachTo), onArm = !!(pit && PORTS[pit.kind] && port != null);
    const L = onArm ? Math.hypot(ax - pit.x, ay - pit.y) || 1 : 1;
    const u = onArm ? [(ax - pit.x) / L, (ay - pit.y) / L] : [1, 0];
    if (PORTS[kind]) {
      // a T / 4-way / check valve is turned so port 0 (first arm, inlet) faces back onto the attach point
      const reach = Math.hypot(...PORTS[kind][0]) + (onArm ? 0 : 8);   // clear of a connection point's ring
      Object.assign(it, { x: Math.round(ax + u[0] * reach), y: Math.round(ay + u[1] * reach),
        r: (Math.round(Math.atan2(u[1], u[0]) * 180 / Math.PI) + 360) % 360 });
    } else {
      // a tank sits clear of what it is fitted to, with a short line to it
      const off = kind === "tank" ? 34 : onArm ? (kind === "cap" ? 3 : 11) : 0;
      Object.assign(it, { x: Math.round(ax + u[0] * off), y: Math.round(ay + u[1] * off) });
      if (Math.abs(u[1]) > Math.abs(u[0])) it.o = "v";
    }
  }
  ST.temp.items.push(it);
  if (it.kind === "valve" || it.kind === "choke") ST.valves[it.id] = "closed";
  if (attachTo && kind !== "text") {
    const l = { id: nextId("L", ST.temp.lines), a: attachTo, b: it.id, pts: [], label: "", rating: "15k" };
    if (port != null) l.pa = port;
    if (PORTS[kind]) l.pb = 0;
    ST.temp.lines.push(l);
  }
  ui.sel = it.id;
  ui.tool = "select";
  changed();
}

// a connection point or temporary part (port: which arm of a T / 4-way) was clicked in temp mode
function onTempTarget(id, port) {
  if (suppressClick) return;
  const tool = ui.tool;
  if (tool === "line") {
    if (!ui.draft) { ui.draft = { a: id, pa: port, pts: [] }; return render(); }
    if (id === ui.draft.a && port === ui.draft.pa && !ui.draft.pts.length) return;
    const l = { id: nextId("L", ST.temp.lines), a: ui.draft.a, b: id, pts: ui.draft.pts, label: "", rating: "15k" };
    if (ui.draft.pa != null) l.pa = ui.draft.pa;
    if (port != null) l.pb = port;
    ST.temp.lines.push(l);
    ui.draft = null;
    ui.sel = l.id;
    return changed();
  }
  if (tool === "select") { ui.sel = tempItem(ST, id) ? id : null; return render(); }
  if (tool === "text") return;
  addItem(tool, 0, 0, id, port);
}

function onTempItemClick(id, ev) {
  if (suppressClick) return;
  if (ui.mode === "temp") {
    const it = tempItem(ST, id);
    if (it.kind === "text" || ui.tool === "select") { ui.sel = id; return render(); }
    return onTempTarget(id, PORTS[it.kind] && ev ? nearestPort(it, ...toSvg(ev.clientX, ev.clientY)) : undefined);
  }
  const it = tempItem(ST, id);
  if (it.kind === "text") return;
  if (ui.mode === "auto") return pickTerm({ kind: "node", id });
  if (it.kind === "valve" || it.kind === "choke") toggleValve(id);
}

// click on empty drawing area
function onBackgroundClick(x, y) {
  if (ui.mode !== "temp") return;
  if (ui.tool === "line") {
    if (!ui.draft) return;
    // bends snap so every segment is horizontal or vertical
    const prev = ui.draft.pts.length ? ui.draft.pts[ui.draft.pts.length - 1] : posOf(ui.draft.a);
    const dx = Math.abs(x - prev[0]), dy = Math.abs(y - prev[1]);
    ui.draft.pts.push(dx >= dy ? [snap(x), prev[1]] : [prev[0], snap(y)]);
    return render();
  }
  if (ui.tool === "select") { ui.sel = null; return render(); }
  if (ui.tool === "cap") return;   // caps only go on a connection point or part
  addItem(ui.tool, x, y, null);
}

function deleteTemp(id) {
  if (!id) return;
  const it = tempItem(ST, id);
  if (it) {
    ST.temp.items = ST.temp.items.filter((x) => x.id !== id);
    ST.temp.lines = ST.temp.lines.filter((l) => l.a !== id && l.b !== id);
    delete ST.valves[id];
  } else {
    ST.temp.lines = ST.temp.lines.filter((l) => l.id !== id);
  }
  ui.sel = null;
  changed();
}

function tempPanel() {
  let h = `<div class="sec"><h4>Temporary rig-up</h4>`;
  if (ui.mode === "temp") {
    const tools = [["select", "Select / move"], ["line", "Line / hose"], ["valve", "Lo-Torq"], ["check", "Check valve"],
      ["choke", "Choke valve"], ["filter", "Filter"], ["tank", "Tank"], ["tee", "T-piece"], ["cross", "4-way"], ["cap", "Blind cap"], ["text", "Text"]];
    h += `<div class="tools">${tools.map(([k, n]) => `<button class="small ${ui.tool === k ? "on" : ""}" data-tool="${k}">${n}</button>`).join("")}</div>`;
    h += `<div class="muted" style="margin:4px 0">${TOOL_HELP[ui.tool]}</div>`;
    if (ui.draft) {
      h += `<div class="form">Line from <b>${esc(nodeName(ui.draft.a))}</b>, ${ui.draft.pts.length} bend(s) - click the end point.
        <div class="row"><button class="small" data-act="t-cancel">Cancel line</button></div></div>`;
    }
    const s = ui.sel && tempThing(ui.sel);
    if (s) {
      const isLine = !!s.a;
      const kind = isLine ? "Line" : TEMP_KINDS[s.kind].name;
      h += `<div class="form"><b>${kind}</b>${isLine ? `: ${esc(nodeName(s.a))} → ${esc(nodeName(s.b))}` : ""}
        <label>Label <input type="text" data-tlabel value="${esc(s.label || "")}" placeholder="shown on the drawing"></label>`;
      if (isLine) {
        h += `<label>Rating <select data-trating>${["lp", "7.5k", "10k", "15k"].map((r) =>
          `<option value="${r}" ${r === (s.rating || "15k") ? "selected" : ""}>${r === "lp" ? "Low pressure" : r.toUpperCase() + " psi"}</option>`).join("")}</select></label>`;
      }
      if (!isLine && SIZED_KINDS.includes(s.kind)) {
        h += `<label>Size <select data-tsize>${SIZES.map(([v, n]) =>
          `<option value="${v}" ${v === sizeOf(s) ? "selected" : ""}>${n}</option>`).join("")}</select></label>`;
      }
      h += `<div class="row">`;
      if (!isLine && (s.kind === "valve" || s.kind === "choke")) {
        h += `<button class="small" data-act="t-toggle">${ST.valves[s.id] === "open" ? "Close" : "Open"}</button>`;
      }
      if (!isLine && !["text", "cross", "tank"].includes(s.kind)) h +=`<button class="small" data-act="t-rotate">Rotate</button>`;
      if (isLine && (s.pts || []).length) h += `<button class="small" data-act="t-straight">Remove bends</button>`;
      h += `<button class="small" data-act="t-delete">Delete</button></div></div>`;
    }
  }
  const items = ST.temp.items, lines = ST.temp.lines;
  if (!items.length && !lines.length) {
    h += `<div class="muted">Nothing rigged.${ui.mode === "temp" ? "" : ' Use "Temporary rig-up" in the toolbar.'}</div>`;
  } else {
    const row = (id, txt, sub) => `<div class="hose ${ui.sel === id && ui.mode === "temp" ? "selrow" : ""}" ${ui.mode === "temp" ? `data-tsel="${id}"` : ""}>
      <span class="name">${txt}${sub ? `<br><span class="muted">${sub}</span>` : ""}</span></div>`;
    h += items.map((it) => row(it.id, `<b>${esc(TEMP_KINDS[it.kind].name)}</b> ${esc(it.label || "")}`,
      it.kind === "valve" || it.kind === "choke" ? (ST.valves[it.id] === "open" ? "open" : "closed") : "")).join("");
    h += lines.map((l) => row(l.id, `<b>Line</b> ${esc(l.label || "")}`,
      `${esc(nodeName(l.a))} → ${esc(nodeName(l.b))}, ${l.rating || "15k"}${lineActive(l, NET, ST) ? "" : " (disconnected)"}`)).join("");
  }
  return h + `</div>`;
}

// ---------------------------------------------------------------- panel
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

const HELP = {
  valves: "Click valves and rams to open or close them. Click a pump to show it running (visual only).",
  manual: "Click pipes to add them to the selected path; click a traced pipe again to remove it. Flow runs from where you start clicking; use Reverse to flip it.",
  auto: "Click a start point, then an end point (pump, valve, outlet, connection point or any pipe). The valves are set for you: closed valves on the route are opened and branches off it are closed. Rams are never operated.",
  temp: "Rig up temporary equipment. Pick a tool, then click on the drawing. Parts placed on a purple connection point " +
    "are attached to it. Drag parts to move them. Select a part or line to label, rotate or delete it.",
};

const TOOL_HELP = {
  select: "Click a temporary part or line to edit it. Drag parts to move them.",
  line: "Click where the line starts (connection point, temporary part or the arm end of a T / 4-way), click empty spots for bends, then click where it ends. Backspace removes the last bend, Esc cancels.",
  valve: "Click to place a Lo-Torq valve.",
  check: "Click to place a check valve. Flow only passes in its arrow direction; Rotate turns it. Lines connect to its inlet or outlet end.",
  choke: "Click to place a choke valve.",
  filter: "Click to place a filter. Lines connect to either end; Rotate turns it.",
  tank: "Click to place a temporary tank. Flow can end in it, like the trip tank.", tee: "Click to place a T-piece. Lines connect at the end of each arm; Rotate turns the stem.",
  cross: "Click to place a 4-way piece. Lines connect at the end of each arm.",
  cap: "Click a connection point or the arm of a T-piece / 4-way to cap it.", text: "Click to place a label.",
};

function valveChip(id) {
  const n = G.nodes[id];
  const open = n && passable(n, ST);
  return `<span class="vchip" style="border-color:${open ? OPEN : CLOSED}">${esc(nodeName(id))}</span>`;
}

function renderPanel(infos) {
  let h = `<div class="sec help">${HELP[ui.mode]}`;
  if (ui.mode === "auto") h += `<br><b>${ui.terms.length ? "Start: " + esc(termName(ui.terms[0])) + " - now click the end point." : "Click the start point."}</b>`;
  h += `</div>`;
  if (ui.msg) {
    const cls = { error: "closedsys", warn: "warnmsg", ok: "okmsg" }[ui.msg.kind];
    h += `<div class="sec ${cls}">${ui.msg.lines.map((l) => `<div>${esc(l)}</div>`).join("")}` +
      (ui.msg.warnings || []).map((w) => `<div class="note">${esc(w)}</div>`).join("") +
      (ui.undo ? `<div class="row"><button class="small" data-act="undo">↶ Undo</button></div>` : "") + `</div>`;
  }

  h += `<div class="sec"><h4>Flow paths <button class="small" data-act="new-path">+ New path</button></h4>`;
  if (!ST.paths.length) h += `<div class="muted">No paths yet. Use "Trace manually" or "Trace start → end".</div>`;
  for (const p of ST.paths) {
    const i = infos.get(p.id);
    h += `<div class="path ${p.id === ui.active ? "sel" : ""}" data-sel="${p.id}" style="border-left-color:${p.color}">
      <div class="row">
        <span class="dot" style="background:${p.color}"></span>
        <input type="text" class="pname" value="${esc(p.name)}" data-name="${p.id}">
      </div>`;
    if (p.id === ui.active) {
      h += `<div class="swatches">${NET.path_colors.map((c) => `<button class="sw ${c.hex === p.color ? "on" : ""}"
        style="background:${c.hex}" data-pcolor="${p.id}" data-hex="${c.hex}" title="${c.name}"></button>`).join("")}</div>`;
    }
    h += `
      <div class="row">
        <label title="Show flow direction arrows"><input type="checkbox" data-arrows="${p.id}" ${p.arrows ? "checked" : ""}> Arrows</label>
        <button class="small" data-rev="${p.id}" title="Reverse flow direction">⇄ Reverse</button>
        <button class="small" data-clear="${p.id}" title="Remove all traced pipes from this path">Clear</button>
        <button class="small" data-delp="${p.id}" title="Delete path">✕</button>
      </div>`;
    if (i.start) {
      h += `<div class="pinfo">${esc(nodeName(i.start))} → ${esc(nodeName(i.end))}</div>`;
      if (i.valves.length) h += `<div class="chips">${i.valves.map(valveChip).join("")}</div>`;
      if (i.closed_inside.length) h += `<div class="note">Passes closed: ${i.closed_inside.map((n) => esc(nodeName(n))).join(", ")}</div>`;
      if (i.closed_ends.length) h += `<div class="muted">Ends against closed: ${i.closed_ends.map((n) => esc(nodeName(n))).join(", ")}</div>`;
    } else {
      h += `<div class="muted">Empty - trace some pipe.</div>`;
    }
    for (const w of WARN_BY_PATH.get(p.id) || []) h += `<div class="note">${esc(w)}</div>`;
    if (i.inactive) h += `<div class="muted">${i.inactive} pipe(s) not available in this line-up (pipe mode / temporary line removed).</div>`;
    h += `</div>`;
  }
  h += `</div>`;

  const nts = notes(NET, ST);
  if (nts.length) h += `<div class="sec">${nts.map((n) => `<div class="note">${esc(n)}</div>`).join("")}</div>`;

  h += tempPanel();

  h += `<div class="sec legend"><h4>Legend</h4>
     <div><span class="ln" style="background:#1a1a1a"></span>Pipe</div>
     <div><span class="ln dashdot"></span>Kill / choke / boost / CMT line</div>
     <div><span class="ln dashdot temp"></span>Temporary line</div>
     <div>${bowtie(OPEN)}Open valve</div><div>${bowtie(CLOSED)}Closed valve</div>
     <div>${bowtie(CLOSED, false, true)}Choke</div>
     <div>${bowtie(CLOSED, true)}Closed valve inside a traced path</div></div>`;
  panel.innerHTML = h;
}

function bowtie(fill, ring, choke) {
  return `<svg class="bt" viewBox="-14 -12 28 24">${ring ? `<circle r="9" fill="none" stroke="${WARN}" stroke-width="2.5"/>` : ""}
    <polygon points="-10,-7 0,0 -10,7" fill="${fill}" stroke="#222"/><polygon points="10,-7 0,0 10,7" fill="${fill}" stroke="#222"/>
    ${choke ? `<line x1="-12" y1="10" x2="9" y2="-8" stroke="#222" stroke-width="1.6"/><polygon points="13,-11 4,-8.5 10,-2" fill="#222"/>` : ""}</svg>`;
}

const findPath = (id) => ST.paths.find((p) => p.id === id);

panel.addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-act],[data-rev],[data-clear],[data-delp],[data-sel],[data-tool],[data-tsel],[data-pcolor]");
  if (!t) return;
  const d = t.dataset;
  if (d.pcolor) { findPath(d.pcolor).color = d.hex; return changed(); }
  if (d.tool) { ui.tool = d.tool; ui.draft = null; return render(); }
  if (d.tsel) { ui.sel = d.tsel; return render(); }
  if (d.act === "t-delete") return deleteTemp(ui.sel);
  if (d.act === "t-rotate") {
    const it = tempItem(ST, ui.sel);
    if (PORTS[it.kind]) it.r = (partAngle(it) + 90 + 360) % 360;   // T: stem down, left, up, right
    else it.o = it.o === "h" ? "v" : "h";
    return changed();
  }
  if (d.act === "t-toggle") return toggleValve(ui.sel);
  if (d.act === "t-straight") { ST.temp.lines.find((l) => l.id === ui.sel).pts = []; return changed(); }
  if (d.act === "t-cancel") { ui.draft = null; return render(); }
  if (d.rev) { reversePath(findPath(d.rev)); return changed(); }
  if (d.clear) { Object.assign(findPath(d.clear), { steps: [], start: null, reversed: false }); return changed(); }
  if (d.delp) {
    ST.paths = ST.paths.filter((p) => p.id !== d.delp);
    if (ui.active === d.delp) ui.active = ST.paths.length ? ST.paths[ST.paths.length - 1].id : null;
    return changed();
  }
  if (d.act === "undo") return undoTrace();
  if (d.act === "new-path") {
    newPath();
    if (ui.mode === "valves") ui.mode = "manual";
    return changed();
  }
  // clicking anywhere else on a path card selects it (but not while using its inputs)
  if (d.sel && !ev.target.closest("input,button,label") && ui.active !== d.sel) { ui.active = d.sel; render(); }
});

panel.addEventListener("change", (ev) => {
  const d = ev.target.dataset;
  if (d.name) { findPath(d.name).name = ev.target.value.trim() || findPath(d.name).name; return changed(); }
  if (d.arrows) { findPath(d.arrows).arrows = ev.target.checked; return changed(); }
  if (d.tlabel !== undefined) { tempThing(ui.sel).label = ev.target.value; return changed(); }
  if (d.trating !== undefined) { tempThing(ui.sel).rating = ev.target.value; return changed(); }
  if (d.tsize !== undefined) { tempThing(ui.sel).size = Number(ev.target.value); return changed(); }
});

panel.addEventListener("focusin", (ev) => {
  const card = ev.target.closest("[data-sel]");
  if (card) ui.active = card.dataset.sel;
});

// ---------------------------------------------------------------- actions
function toggleValve(id) {
  if (suppressClick) return;
  ST.valves[id] = ST.valves[id] === "open" ? "closed" : "open";
  forgetUndo();
  changed();
}

// "Undo this trace" only applies until the valves are changed by hand
function forgetUndo() {
  ui.undo = null;
  ui.msg = null;
}

function setMode(m) {
  ui.mode = ui.mode === m && m !== "valves" ? "valves" : m;
  Object.assign(ui, { terms: [], msg: null, draft: null, sel: null, tool: "select" });
  if ((ui.mode === "manual" || ui.mode === "auto") && !activePath(false)) {
    ui.active = ST.paths.length ? ST.paths[ST.paths.length - 1].id : null;
  }
  render();
}

document.getElementById("pipe").addEventListener("change", (ev) => { ST.pipe = ev.target.value; forgetUndo(); changed(); });

document.getElementById("toolbar").addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  if (b.dataset.mode) return setMode(b.dataset.mode);
  if (b.dataset.lineup) return applyLineup(b.dataset.lineup);
  switch (b.dataset.act) {
    case "close-valves":
      for (const id in ST.valves) if (NET.nodes[id]?.type !== "ram") ST.valves[id] = "closed";
      forgetUndo();
      return changed();
    case "reset": return resetAll();
    case "open-rams":
      for (const id in ST.valves) if (NET.nodes[id]?.type === "ram") ST.valves[id] = "open";
      forgetUndo();
      return changed();
    case "zoom-in": return zoomAt(view.x + view.w / 2, view.y + view.h / 2, 1 / 1.3);
    case "zoom-out": return zoomAt(view.x + view.w / 2, view.y + view.h / 2, 1.3);
    case "fit": fit(); return applyView();
  }
});

window.addEventListener("keydown", (ev) => {
  if (ev.target.closest && ev.target.closest("input,select,textarea")) return;
  if (ev.key === "Escape") {
    if (ui.draft) { ui.draft = null; return render(); }
    if (ui.mode !== "valves") setMode("valves");
  }
  if (ui.mode === "temp" && (ev.key === "Backspace" || ev.key === "Delete")) {
    ev.preventDefault();
    if (ui.draft) { ui.draft.pts.pop(); return render(); }   // undo the last bend point
    if (ui.sel) deleteTemp(ui.sel);
  }
});

// ---------------------------------------------------------------- pan / zoom
function bounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const n of Object.values(NET.nodes)) add(n.x, n.y);
  for (const e of NET.edges) for (const s of e.segs) for (const p of s) add(p[0], p[1]);
  for (const d of NET.decor) { add(d.x, d.y); if (d.w) add(d.x + d.w, d.y + d.h); }
  return { x: x0 - 30, y: y0 - 30, w: x1 - x0 + 60, h: y1 - y0 + 60 };
}

function fit() {
  const b = bounds();
  const W = svg.clientWidth || 1000, H = svg.clientHeight || 700;
  const s = Math.max(b.w / W, b.h / H);
  view = { w: W * s, h: H * s, x: b.x - (W * s - b.w) / 2, y: b.y - (H * s - b.h) / 2 };
}

function applyView() {
  if (!view) return;
  const W = svg.clientWidth || 1000, H = svg.clientHeight || 700;
  view.h = view.w * H / W;
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
}

function toSvg(cx, cy) {
  const r = svg.getBoundingClientRect();
  return [view.x + (cx - r.left) * view.w / r.width, view.y + (cy - r.top) * view.h / r.height];
}

function zoomAt(px, py, k) {
  const nw = Math.min(8000, Math.max(150, view.w * k)), s = nw / view.w;
  view.x = px - (px - view.x) * s;
  view.y = py - (py - view.y) * s;
  view.w = nw;
  applyView();
}

svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [px, py] = toSvg(e.clientX, e.clientY);
  zoomAt(px, py, Math.exp(e.deltaY * 0.0015));
}, { passive: false });

let drag = null, itemDrag = null, suppressClick = false;
svg.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
});
// clicks on empty drawing area (not on a valve, pipe, part ...)
svg.addEventListener("click", (e) => {
  if (suppressClick || e.target.closest(".clickable")) return;
  const [x, y] = toSvg(e.clientX, e.clientY);
  onBackgroundClick(x, y);
});
window.addEventListener("pointermove", (e) => {
  if (itemDrag) {
    // moving a temporary part
    const dx = e.clientX - itemDrag.x, dy = e.clientY - itemDrag.y;
    if (!itemDrag.moved && Math.hypot(dx, dy) < 4) return;
    itemDrag.moved = true;
    const r = svg.getBoundingClientRect(), it = tempItem(ST, itemDrag.id);
    it.x = snap(itemDrag.ix + dx * view.w / r.width);
    it.y = snap(itemDrag.iy + dy * view.h / r.height);
    render();
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  drag.moved = true;
  svg.classList.add("panning");
  const r = svg.getBoundingClientRect();
  view.x = drag.vx - dx * view.w / r.width;
  view.y = drag.vy - dy * view.h / r.height;
  applyView();
});
window.addEventListener("pointerup", () => {
  if (itemDrag && itemDrag.moved) { ui.sel = itemDrag.id; emit(); }
  if ((drag && drag.moved) || (itemDrag && itemDrag.moved)) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
  drag = null;
  itemDrag = null;
  svg.classList.remove("panning");
});
window.addEventListener("resize", applyView);
