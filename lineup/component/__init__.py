"""Bidirectional Streamlit component that draws the rig and lets the user operate it.

The frontend is plain HTML/JS (no build step) in ./frontend. It owns the live
line-up state and sends it back as {"state": ..., "result": ...} on every change.
To replace its state (e.g. when loading a saved line-up) pass `load` with a new nonce.
"""

from pathlib import Path

import streamlit.components.v1 as components

_component = components.declare_component(
    "lineup_canvas", path=str(Path(__file__).parent / "frontend")
)


def lineup_canvas(network: dict, default_state: dict, load: dict | None, height: int = 820, key=None):
    return _component(network=network, default_state=default_state, load=load,
                      height=height, key=key, default=None)
