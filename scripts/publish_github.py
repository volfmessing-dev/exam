#!/usr/bin/env python3
"""
Publish the current repository to GitHub using a Personal Access Token.

Requirements:
- git repo with at least one commit on branch `main`
- env:
  - GITHUB_TOKEN (required) : Fine-grained PAT with access to the target repo.
  - GITHUB_REPO  (required) : repo name (e.g. gosy-trainer)
  - GITHUB_OWNER (optional) : user/org (if omitted, resolved from /user endpoint)
  - GITHUB_PRIVATE (optional): "true" to create a private repo if it doesn't exist

This script:
- resolves owner (if needed)
- creates the repo if missing
- sets/updates `origin` to https://github.com/{owner}/{repo}.git (without token)
- pushes `main` using a temporary HTTP Authorization header (token isn't stored in git config)
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request


def die(msg: str) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(1)


def env(name: str) -> str | None:
    v = os.environ.get(name)
    if v is None:
        return None
    v = v.strip()
    return v or None


def gh_api(token: str, method: str, path: str, body: dict | None = None) -> dict:
    url = f"https://api.github.com{path}"
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "codex-cli",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            payload = {"message": raw.decode("utf-8", "replace")}
        payload["status"] = e.code
        raise
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def capture(cmd: list[str]) -> str:
    return subprocess.check_output(cmd, text=True).strip()


def main() -> int:
    token = env("GITHUB_TOKEN")
    repo = env("GITHUB_REPO")
    owner = env("GITHUB_OWNER")
    private = (env("GITHUB_PRIVATE") or "").lower() in ("1", "true", "yes", "y")

    if not token:
        die("Missing env GITHUB_TOKEN")
    if not repo:
        die("Missing env GITHUB_REPO (e.g. gosy-trainer)")

    # Verify git repo + branch
    try:
        capture(["git", "rev-parse", "--is-inside-work-tree"])
    except Exception:
        die("Not a git repository")

    branch = capture(["git", "branch", "--show-current"])
    if branch != "main":
        die(f"Current branch is '{branch}', expected 'main'")

    owner_is_self = False
    if not owner:
        try:
            me = gh_api(token, "GET", "/user")
        except urllib.error.HTTPError as e:
            die(f"Failed to resolve /user (HTTP {e.code}). Check token.")
        owner = me.get("login")
        if not owner:
            die("Failed to resolve GITHUB_OWNER from /user")
        owner_is_self = True
    else:
        # Best effort: detect whether the target owner equals the current user.
        try:
            me = gh_api(token, "GET", "/user")
            owner_is_self = (me.get("login") == owner)
        except Exception:
            owner_is_self = False

    # Check existence, create if missing
    exists = True
    try:
        gh_api(token, "GET", f"/repos/{owner}/{repo}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            exists = False
        else:
            die(f"GitHub API error checking repo: HTTP {e.code}")

    if not exists:
        try:
            if owner_is_self:
                gh_api(
                    token,
                    "POST",
                    "/user/repos",
                    {"name": repo, "private": private, "auto_init": False},
                )
            else:
                gh_api(
                    token,
                    "POST",
                    f"/orgs/{owner}/repos",
                    {"name": repo, "private": private, "auto_init": False},
                )
        except urllib.error.HTTPError as e:
            die(f"Failed to create repo {owner}/{repo} (HTTP {e.code}).")

    origin_url = f"https://github.com/{owner}/{repo}.git"

    # Configure origin (without token)
    has_origin = True
    try:
        capture(["git", "remote", "get-url", "origin"])
    except Exception:
        has_origin = False

    if has_origin:
        run(["git", "remote", "set-url", "origin", origin_url])
    else:
        run(["git", "remote", "add", "origin", origin_url])

    # Push with temporary auth header (token isn't stored in .git/config)
    basic = base64.b64encode(f"x-access-token:{token}".encode("utf-8")).decode("ascii")
    extra = f"Authorization: Basic {basic}"
    run(
        [
            "git",
            "-c",
            f"http.https://github.com/.extraheader={extra}",
            "push",
            "-u",
            "origin",
            "main",
        ]
    )

    print(f"Pushed to {origin_url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
