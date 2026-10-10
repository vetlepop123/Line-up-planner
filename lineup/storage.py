"""Where saved line-ups live.

* GitHubStore - commits each line-up as lineups/<name>.json to the GitHub repo.
  Used when st.secrets contains a [github] section (token, repo, branch).
  This is the one to use on Streamlit Community Cloud, whose disk is wiped on restart.
* LocalStore  - plain JSON files in ./lineups. Fine when running locally.
"""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path

import requests


def slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9 _.-]+", "", name).strip().replace(" ", "_")
    return s[:80] or "lineup"


class LocalStore:
    label = "local folder (on Streamlit Cloud these are lost when the app restarts - see README)"

    def __init__(self, folder: Path):
        self.folder = folder
        self.folder.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[str]:
        return sorted(p.stem for p in self.folder.glob("*.json"))

    def load(self, name: str) -> dict:
        return json.loads((self.folder / f"{name}.json").read_text(encoding="utf-8"))

    def save(self, name: str, doc: dict) -> str:
        key = slug(name)
        (self.folder / f"{key}.json").write_text(json.dumps(doc, indent=2), encoding="utf-8")
        return key

    def delete(self, name: str) -> None:
        (self.folder / f"{name}.json").unlink(missing_ok=True)


class GitHubStore:
    label = "GitHub repository"

    def __init__(self, token: str, repo: str, branch: str = "main", folder: str = "lineups"):
        self.api = f"https://api.github.com/repos/{repo}/contents/{folder}"
        self.branch = branch
        self.headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}

    def _get(self, url, **params):
        r = requests.get(url, headers=self.headers, params={"ref": self.branch, **params}, timeout=15)
        return r

    def list(self) -> list[str]:
        r = self._get(self.api)
        if r.status_code == 404:
            return []
        r.raise_for_status()
        return sorted(f["name"][:-5] for f in r.json() if f["name"].endswith(".json"))

    def load(self, name: str) -> dict:
        r = self._get(f"{self.api}/{name}.json")
        r.raise_for_status()
        return json.loads(base64.b64decode(r.json()["content"]).decode("utf-8"))

    def _sha(self, name: str) -> str | None:
        r = self._get(f"{self.api}/{name}.json")
        return r.json()["sha"] if r.status_code == 200 else None

    def save(self, name: str, doc: dict) -> str:
        key = slug(name)
        body = {
            "message": f"Save line-up {key}",
            "content": base64.b64encode(json.dumps(doc, indent=2).encode("utf-8")).decode("ascii"),
            "branch": self.branch,
        }
        sha = self._sha(key)
        if sha:
            body["sha"] = sha
        r = requests.put(f"{self.api}/{key}.json", headers=self.headers, json=body, timeout=15)
        r.raise_for_status()
        return key

    def delete(self, name: str) -> None:
        sha = self._sha(name)
        if not sha:
            return
        r = requests.delete(f"{self.api}/{name}.json", headers=self.headers, timeout=15,
                            json={"message": f"Delete line-up {name}", "sha": sha, "branch": self.branch})
        r.raise_for_status()


def get_store(secrets, local_folder: Path):
    try:
        gh = secrets["github"]
        return GitHubStore(gh["token"], gh["repo"], gh.get("branch", "main"), gh.get("folder", "lineups"))
    except Exception:  # no secrets.toml, or no [github] section in it
        return LocalStore(local_folder)
