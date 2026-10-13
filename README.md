# Line-up Planner – COSL Innovator

Interactive line-up tool for the standpipe manifold, pump room, choke & kill manifold and BOP.

- **Operate valves** – click valves and rams to open/close them; click a pump to show it running (visual only).
- **Trace manually** – click pipes to build a flow path in its own colour, with flow-direction arrows and a reverse button.
- **Trace start → end** – pick a start and an end point; the route is traced and the valves are set for it
  (closed valves on the route opened, branches leaving it closed). Undo is available. Rams are never operated.
- **Warnings** when paths conflict (shared pipe, flowing against each other, connected through open valves,
  open to an outlet) and when a path passes a closed valve.
- **Standard line-ups** – toolbar buttons for *Drilling*, *Drilling + boost*, *Tripping* and *Choke line-up*. Drilling
  (with or without boost) and tripping replace each other; the choke line-up can be added on its own. Defined in
  `LINEUPS` in `lineup/network.py`.
- **Reset all** – back to normal (valves closed, rams open, no pipe, pumps off, no paths, no rig-up); Undo available.
- Paths use ten fixed, easy-to-tell-apart colours.
- **Pipe modes** – no pipe, string on top drive, or string hung off (open top just above the UPR).
- **Diverter / top of riser** – flowline, trip tank (trip flow) and fill-up lines, each with a valve, and a trip tank pump.
- **Temporary rig-up** – temporary lines (straight segments), Lo-Torq valves, check valves (flow in the arrow
  direction only), choke valves, filters, tanks, T-pieces, 4-way pieces, blind caps and free text labels, attached to the purple
  connection points. Valves, filters and tanks can be drawn larger.
- Line-ups can be **saved / loaded**, downloaded as a file, and printed to **PDF** – choose which parts of the
  drawing to print (pump room, standpipe manifold, choke & kill manifold, BOP).

## Run locally

```
pip install -r requirements.txt
streamlit run Planner.py
```

## Deploy on Streamlit Community Cloud

1. Push this folder to a **private** GitHub repository (the drawing data describes the rig).
2. Go to <https://share.streamlit.io>, sign in with GitHub and choose **Create app → Deploy a public app from GitHub**
   (works for private repos too). Pick the repo, branch `main` and main file `Planner.py`.
3. In the app's **Settings → Sharing**, keep it private and invite the people who should use it.
4. **Saving line-ups:** Streamlit Cloud wipes its disk when the app restarts, so add this to the app's
   **Settings → Secrets** to save line-ups as files in the repo instead (see `.streamlit/secrets.example.toml`):

   ```toml
   [github]
   token = "github_pat_..."   # fine-grained token: this repo only, Contents = Read and write
   repo = "your-user/your-repo"
   branch = "main"
   folder = "lineups"
   ```

   Without it, "Download as file" / "Open line-up file" still work.

## Editing the rig drawing

Everything about the rig is in [lineup/network.py](lineup/network.py): valve positions, pipes, outlets
and connection points (`cp(...)`), plus the standard line-ups (`LINEUPS`).

Path tracing runs in the browser (`lineup/component/frontend/main.js`). The graph rules
(`buildGraph`, `passable`, `pathInfo`, temporary rig-up) are mirrored in `lineup/solver.py` for the
PDF and tests and must stay in sync. Pipe ids are `<node>~<node>`, so saved paths survive edits
elsewhere in the drawing.

## Tests

```
python -m pytest tests
```
