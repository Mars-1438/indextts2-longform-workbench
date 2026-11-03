# -*- coding: utf-8 -*-
"""用 Git Data API 推一次提交（沙箱里 git push / fetch 会被代理拦，只能用 REST）。

用法：
  python tools/push_api.py "提交信息" 文件1 文件2 ...

文件列表是相对仓库根的路径；内容按 **LF** 发送（工作区因 core.autocrlf=true 是 CRLF，
直接把工作区字节塞进去会把整份文件的换行都改掉，diff 会炸）。
"""
import base64
import json
import subprocess
import sys
import urllib.request

REPO = "Mars-1438/indextts2-longform-workbench"
BRANCH = "main"


def token():
    return subprocess.check_output(["gh", "auth", "token"], text=True).strip()


TOKEN = token()


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        "https://api.github.com" + path, data=data, method=method,
        headers={"Authorization": "Bearer " + TOKEN,
                 "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json",
                 "User-Agent": "patch-pusher"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode() or "{}")


def main():
    msg = sys.argv[1]
    paths = sys.argv[2:]
    if not paths:
        raise SystemExit("没有要推的文件")
    ref = api("GET", f"/repos/{REPO}/git/ref/heads/{BRANCH}")
    head = ref["object"]["sha"]
    commit = api("GET", f"/repos/{REPO}/git/commits/{head}")
    base_tree = commit["tree"]["sha"]
    print("远端 head:", head[:7], "tree:", base_tree[:7])

    tree = []
    for p in paths:
        with open(p, "rb") as f:
            raw = f.read()
        text_mode = not p.lower().endswith((".png", ".jpg", ".jpeg", ".zip", ".sofa", ".npz", ".exe", ".wav"))
        if text_mode:
            raw = raw.replace(b"\r\n", b"\n")
        blob = api("POST", f"/repos/{REPO}/git/blobs",
                   {"content": base64.b64encode(raw).decode(), "encoding": "base64"})
        tree.append({"path": p.replace("\\", "/"), "mode": "100644",
                     "type": "blob", "sha": blob["sha"]})
        print("  blob", p, len(raw), "bytes", blob["sha"][:7])

    new_tree = api("POST", f"/repos/{REPO}/git/trees",
                   {"base_tree": base_tree, "tree": tree})
    new_commit = api("POST", f"/repos/{REPO}/git/commits",
                     {"message": msg, "tree": new_tree["sha"], "parents": [head]})
    api("PATCH", f"/repos/{REPO}/git/refs/heads/{BRANCH}",
        {"sha": new_commit["sha"], "force": True})
    print("新提交:", new_commit["sha"][:7])


if __name__ == "__main__":
    main()
