"""Line-up Planner - COSL Innovator.

Run locally:   streamlit run Planner.py
"""

import json
import uuid
from datetime import datetime
from pathlib import Path

import streamlit as st

from lineup.component import lineup_canvas
from lineup.network import NETWORK, default_state
from lineup.pdf import build_pdf
from lineup.storage import get_store, slug

st.set_page_config(page_title="Line-up Planner", page_icon="🛢️", layout="wide")
st.markdown("<style>.block-container{padding-top:2.6rem;padding-bottom:0}</style>", unsafe_allow_html=True)

ss = st.session_state
ss.setdefault("load", None)
ss.setdefault("name", "")
ss.setdefault("notes", "")
ss.setdefault("author", "")
store = get_store(st.secrets, Path(__file__).parent / "lineups")


def _apply(doc: dict):
    ss.load = {"nonce": uuid.uuid4().hex, "state": doc.get("state")}
    ss.name = doc.get("name", "")
    ss.notes = doc.get("notes", "")


def _new():
    _apply({"name": "", "notes": "", "state": default_state()})


def _refresh_saved():
    """The saved list is cached per session (with GitHub storage every listing is a web request)."""
    try:
        ss.saved = store.list()
        ss.saved_error = None
    except Exception as e:  # noqa: BLE001
        ss.saved, ss.saved_error = [], str(e)


def _load_saved():
    try:
        _apply(store.load(ss.saved_pick))
        ss.flash = ("success", f"Loaded '{ss.saved_pick}'.")
    except Exception as e:  # noqa: BLE001
        ss.flash = ("error", f"Could not load: {e}")


def _upload():
    f = ss.get("uploader")
    if f is None:
        return
    try:
        _apply(json.load(f))
        ss.flash = ("success", f"Opened {f.name}.")
    except Exception as e:  # noqa: BLE001
        ss.flash = ("error", f"Not a valid line-up file: {e}")


# ---------------------------------------------------------------- canvas
st.markdown(f"#### {NETWORK['rig']} — Line-up Planner")
value = lineup_canvas(NETWORK, default_state(), ss.load, height=ss.get("height", 820), key="canvas")
state = (value or {}).get("state") or (ss.load or {}).get("state") or default_state()
path_warnings = (value or {}).get("warnings") or {}


def _doc() -> dict:
    return {"name": ss.name, "rig": NETWORK["rig"], "notes": ss.notes,
            "saved_at": datetime.now().isoformat(timespec="seconds"), "state": state}


# ---------------------------------------------------------------- sidebar
with st.sidebar:
    st.subheader("Line-up")
    if "flash" in ss:
        kind, msg = ss.pop("flash")
        getattr(st, kind)(msg)

    st.text_input("Name", key="name", placeholder="e.g. Cross circ. down kill up choke")
    st.text_area("Notes", key="notes", height=90)
    st.text_input("Prepared by", key="author")

    c1, c2 = st.columns(2)
    if c1.button("💾 Save", width="stretch", disabled=not ss.name.strip()):
        try:
            key = store.save(ss.name, _doc())
            st.success(f"Saved as '{key}'.")
            _refresh_saved()
        except Exception as e:  # noqa: BLE001
            st.error(f"Save failed: {e}")
    c2.button("🆕 New", width="stretch", on_click=_new)

    st.download_button(
        "🖨️ PDF print-out", width="stretch", type="primary",
        data=build_pdf(NETWORK, state, ss.name, ss.notes, ss.author, path_warnings),
        file_name=f"{slug(ss.name or 'lineup')}.pdf", mime="application/pdf",
    )

    st.divider()
    h1, h2 = st.columns([4, 1], vertical_alignment="center")
    h1.subheader("Saved line-ups")
    h2.button("↻", help="Refresh the list", on_click=_refresh_saved)
    if "saved" not in ss:
        _refresh_saved()
    saved = ss.saved
    if ss.saved_error:
        st.error(f"Could not list saved line-ups: {ss.saved_error}")
    if saved:
        st.selectbox("Saved", saved, key="saved_pick", label_visibility="collapsed")
        c1, c2 = st.columns(2)
        c1.button("📂 Load", width="stretch", on_click=_load_saved)
        if c2.button("🗑️ Delete", width="stretch"):
            ss.confirm_delete = ss.saved_pick
        if ss.get("confirm_delete"):
            st.warning(f"Delete '{ss.confirm_delete}'?")
            d1, d2 = st.columns(2)
            if d1.button("Yes, delete", width="stretch"):
                try:
                    store.delete(ss.confirm_delete)
                    ss.flash = ("success", f"Deleted '{ss.confirm_delete}'.")
                except Exception as e:  # noqa: BLE001
                    ss.flash = ("error", f"Delete failed: {e}")
                ss.confirm_delete = None
                _refresh_saved()
                st.rerun()
            if d2.button("Cancel", width="stretch"):
                ss.confirm_delete = None
                st.rerun()
    else:
        st.caption("No saved line-ups yet.")
    st.caption(f"Storage: {store.label}")

    with st.expander("File import / export"):
        st.download_button("⬇️ Download as file", width="stretch",
                           data=json.dumps(_doc(), indent=2),
                           file_name=f"{slug(ss.name or 'lineup')}.json", mime="application/json")
        st.file_uploader("Open line-up file", type="json", key="uploader", on_change=_upload)

    with st.expander("Display"):
        st.slider("Canvas height", 500, 1400, 820, 20, key="height")
