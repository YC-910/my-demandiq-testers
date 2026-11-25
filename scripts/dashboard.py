"""The paths of the testers, on your machine: watch them, comment them, edit them.

Usage: python3 scripts/dashboard.py <collected run dir> [--port 8765] [--ecr <explore-compile-replay clone>]
       python3 scripts/dashboard.py --demo

Opens a page on http://127.0.0.1:8765 that shows each tester's path step by step
(the screenshot before each action, where the finger landed, a heat map of the taps),
on a timeline you can edit: reorder, delete or add steps, change a target, add a check,
comment a step. Run it on the folder that scripts/collect.sh wrote (runs/<run id>).

Every path is a trace.json in the Explore-Compile-Replay format
(https://github.com/pierridotite/explore-compile-replay). Saving writes the trace back,
still valid, and keeps the explored one as trace.explored.json the first time.
Comments go to trace.notes.json, next to it. With --ecr, the page can also check a
trace and compile it to a Maestro flow with the real ECR command (Node 22.18+).

The results are private: the server listens on 127.0.0.1 only, and never serves
trace.params.json (the texts the agent typed).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import webbrowser
import xml.etree.ElementTree as ET
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PAGE = Path(__file__).resolve().parent.parent / "dashboard"
STATIC = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
          "/style.css": ("style.css", "text/css")}
SCREEN = re.compile(r"^(\d{1,4})\.(png|svg)$")
MEDIA = {"png": "image/png", "svg": "image/svg+xml"}
NOTES_SCHEMA = "mobile-agent-testers.notes/0"
SAME_SCREEN = 0.6   # Jaccard similarity above which two screenshots show the same screen


# ---------- reading a run ----------

def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def screen_elements(xml_path):
    """Named elements of a saved screen tree: label, id, bounds, clickable. The system bars are left out."""
    try:
        root = ET.parse(xml_path).getroot()
    except (ET.ParseError, OSError):
        return []
    out = []
    for n in root.iter("node"):
        if (n.get("package") or "") == "com.android.systemui":
            continue
        b = re.findall(r"-?\d+", n.get("bounds", ""))
        label = (n.get("text") or "").strip() or (n.get("content-desc") or "").strip()
        rid = (n.get("resource-id") or "").strip()
        if len(b) != 4 or not (label or rid):
            continue
        out.append({"label": label[:120], "id": rid, "bounds": [int(v) for v in b],
                    "clickable": n.get("clickable") == "true"})
    return out


def tokens(elements):
    """What identifies a screen: its ids (the same in every language) and the names of its controls."""
    found = set()
    for e in elements:
        if e["id"]:
            found.add("id:" + e["id"])
        # a control's name, unless it is only a number or a time, which changes from one visit to the next
        if e["clickable"] and e["label"] and len(e["label"]) <= 40 and e["label"].strip("0123456789 :.,%"):
            found.add("label:" + e["label"])
    return found


def similarity(a, b):
    """Jaccard similarity of two screens. On ids alone when both have a few: ids do not change
    with the language, so the same screen in French and in Japanese still matches."""
    ids_a, ids_b = {t for t in a if t.startswith("id:")}, {t for t in b if t.startswith("id:")}
    if len(ids_a) >= 3 and len(ids_b) >= 3:
        a, b = ids_a, ids_b
    return len(a & b) / len(a | b) if a and b else 0.0


def title_of(elements):
    """A short name for a screen: its top-most text that is not a control."""
    texts = [e for e in elements if e["label"] and not e["clickable"] and 2 <= len(e["label"]) <= 40]
    texts.sort(key=lambda e: (e["bounds"][1], e["bounds"][0]))
    return texts[0]["label"] if texts else ""


def group_screens(personas):
    """Gives each screenshot a group: screenshots of the same screen, by any tester, share it.
    A heat map adds up the taps of a group."""
    groups = []   # [tokens of the first screenshot, titles seen, count]
    for p in personas:
        for nn, screen in sorted(p["screens"].items()):
            toks = screen.pop("_tokens")
            best, score = None, 0.0
            for i, g in enumerate(groups):
                s = similarity(toks, g[0])
                if s > score:
                    best, score = i, s
            if best is None or score < SAME_SCREEN:
                groups.append([toks, Counter(), 0])
                best = len(groups) - 1
            groups[best][2] += 1
            if screen["title"]:
                groups[best][1][screen["title"]] += 1
            screen["group"] = f"g{best + 1}"
    return {f"g{i + 1}": {"title": (g[1].most_common(1)[0][0] if g[1] else ""), "count": g[2]}
            for i, g in enumerate(groups)}


def find_traces(root):
    """Every trace.json under a collected run, or a single results dir."""
    root = Path(root)
    found = [p for p in sorted(root.rglob("trace.json")) if "node_modules" not in p.parts]
    return found


def load_run(root):
    root = Path(root)
    personas = []
    for trace_path in find_traces(root):
        folder = trace_path.parent
        trace = read_json(trace_path)
        if not isinstance(trace, dict):
            continue
        screens = {}
        for f in sorted(folder.iterdir()):
            m = SCREEN.match(f.name)
            if not m:
                continue
            elements = screen_elements(folder / f"{m.group(1)}.xml")
            screens[m.group(1)] = {"file": f.name, "elements": elements, "title": title_of(elements),
                                   "_tokens": tokens(elements)}
        notes = read_json(folder / "trace.notes.json") or {"schema": NOTES_SCHEMA, "steps": {}}
        report = folder / "report.md"
        personas.append({
            "key": folder.relative_to(root).as_posix() if folder != root else ".",
            "trace": trace,
            "notes": notes,
            "findings": read_json(folder / "findings.json"),
            "report": report.read_text(encoding="utf-8", errors="replace") if report.exists() else "",
            "screens": screens,
            "edited": (folder / "trace.explored.json").exists(),
        })
    groups = group_screens(personas)
    return {"run": root.resolve().name, "personas": personas, "groups": groups}


# ---------- checking and writing ----------

def check_trace(trace):
    """The checks that keep a trace usable even without ECR at hand. ECR checks the rest."""
    problems = []
    if not isinstance(trace, dict):
        return ["the trace is not a JSON object"]
    if trace.get("schema") != "ecr.trace/0":
        problems.append('schema must be "ecr.trace/0"')
    steps = trace.get("steps")
    if not isinstance(steps, list) or not steps:
        return problems + ["a trace needs at least one step"]
    ids = [s.get("id") if isinstance(s, dict) else None for s in steps]
    if any(not isinstance(i, str) or not i for i in ids):
        problems.append("every step needs an id")
    elif len(set(ids)) != len(ids):
        problems.append("two steps have the same id")
    for s in steps:
        if not isinstance(s, dict) or not isinstance(s.get("action"), dict) or not s["action"].get("kind"):
            problems.append(f"step {s.get('id') if isinstance(s, dict) else '?'} has no action")
    first = steps[0].get("action", {}) if isinstance(steps[0], dict) else {}
    if trace.get("adapter", {}).get("id") == "mobile-maestro" and first.get("kind") != "launchApp":
        problems.append("the first step of a mobile trace must be launchApp")
    return problems


def write_atomic(path, data):
    path = Path(path)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def ecr_command(ecr, *args):
    """Runs the ECR command of a local clone. Returns (exit code, output)."""
    cli = Path(ecr) / "packages" / "cli" / "src" / "main.ts"
    node = shutil.which("node")
    if not node or not cli.exists():
        return 2, f"ECR not found: needs node and {cli}"
    try:
        r = subprocess.run([node, str(cli), *args], cwd=ecr, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return 2, "ECR took more than 60 s"
    return r.returncode, (r.stdout + r.stderr).strip()


def ecr_adapter(ecr):
    return str(Path(ecr) / "packages" / "adapter-maestro" / "src" / "index.ts")


# ---------- the server ----------

class App:
    def __init__(self, root, ecr=None):
        self.root = Path(root).resolve()
        self.ecr = str(Path(ecr).resolve()) if ecr else None
        self.lock = threading.Lock()

    def folder(self, key):
        """The results dir of a persona, only if it holds a trace and sits inside the run."""
        folder = (self.root / key).resolve() if key and key != "." else self.root
        if folder != self.root and self.root not in folder.parents:
            return None
        return folder if (folder / "trace.json").exists() else None


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "mobile-agent-testers-dashboard"

        def log_message(self, *args):   # paths can hold app names: keep the terminal quiet
            pass

        def send(self, code, body, kind="application/json"):
            data = body if isinstance(body, bytes) else (json.dumps(body, ensure_ascii=False) if kind == "application/json" else body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", kind + ("; charset=utf-8" if not kind.startswith("image/png") else ""))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            url = urlparse(self.path)
            q = parse_qs(url.query)
            if url.path in STATIC:
                name, kind = STATIC[url.path]
                return self.send(200, (PAGE / name).read_bytes(), kind)
            if url.path == "/api/run":
                with app.lock:
                    run = load_run(app.root)
                run["ecr"] = bool(app.ecr)
                return self.send(200, run)
            if url.path == "/api/screen":
                folder = app.folder(q.get("persona", [""])[0])
                name = q.get("name", [""])[0]
                m = SCREEN.match(name)
                if not folder or not m or not (folder / name).is_file():
                    return self.send(404, {"error": "no such screen"})
                return self.send(200, (folder / name).read_bytes(), MEDIA[m.group(2)])
            return self.send(404, {"error": "not found"})

        def do_POST(self):
            # A page of another site cannot send this header without the browser asking first.
            if self.headers.get("X-Dashboard") != "1" or "application/json" not in (self.headers.get("Content-Type") or ""):
                return self.send(403, {"error": "refused"})
            url = urlparse(self.path)
            folder = app.folder(parse_qs(url.query).get("persona", [""])[0])
            if not folder:
                return self.send(404, {"error": "no such persona"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"null")
            except ValueError:
                return self.send(400, {"error": "not JSON"})
            if url.path == "/api/notes":
                if not isinstance(body, dict) or not isinstance(body.get("steps"), dict):
                    return self.send(400, {"error": "notes need a steps object"})
                body["schema"] = NOTES_SCHEMA
                with app.lock:
                    write_atomic(folder / "trace.notes.json", body)
                return self.send(200, {"ok": True})
            if url.path in ("/api/trace", "/api/compile", "/api/validate"):
                problems = check_trace(body)
                if problems:
                    return self.send(422, {"ok": False, "problems": problems})
                if url.path == "/api/trace":
                    return self.save(folder, body)
                return self.compile(body, url.path == "/api/compile")
            return self.send(404, {"error": "not found"})

        def save(self, folder, trace):
            with app.lock:
                if app.ecr:
                    code, out = self.with_temp_trace(trace, lambda p, _: ecr_command(app.ecr, "validate", p, "--adapter", ecr_adapter(app.ecr)))
                    if code != 0:
                        return self.send(422, {"ok": False, "problems": [out]})
                explored = folder / "trace.explored.json"
                if not explored.exists():
                    shutil.copyfile(folder / "trace.json", explored)
                write_atomic(folder / "trace.json", trace)
            return self.send(200, {"ok": True, "checkedByEcr": bool(app.ecr)})

        def compile(self, trace, want_flow):
            if not app.ecr:
                return self.send(501, {"ok": False, "problems": ["Start the dashboard with --ecr <clone of explore-compile-replay>"]})

            def run(path, out_dir):
                if not want_flow:
                    return ecr_command(app.ecr, "validate", path, "--adapter", ecr_adapter(app.ecr))
                code, out = ecr_command(app.ecr, "compile", path, "--adapter", ecr_adapter(app.ecr), "--out", out_dir)
                flows = sorted(Path(out_dir).glob("*.yaml"))
                return code, (flows[0].read_text(encoding="utf-8") if code == 0 and flows else out)
            code, out = self.with_temp_trace(trace, run)
            return self.send(200 if code == 0 else 422, {"ok": code == 0, "output": out})

        @staticmethod
        def with_temp_trace(trace, fn):
            with tempfile.TemporaryDirectory(prefix="dashboard-") as tmp:
                path = Path(tmp) / "trace.json"
                path.write_text(json.dumps(trace, ensure_ascii=False), encoding="utf-8")
                out_dir = Path(tmp) / "out"
                out_dir.mkdir()
                return fn(str(path), str(out_dir))

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("run", nargs="?", help="a collected run (runs/<run id>) or one results dir")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--ecr", help="a clone of explore-compile-replay, to check and compile with the real command")
    parser.add_argument("--demo", action="store_true", help="open a made-up run, to try the page")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)

    if args.demo:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import dashboard_demo
        root = dashboard_demo.write(Path(tempfile.mkdtemp(prefix="dashboard-demo-")))
    elif args.run:
        root = Path(args.run)
    else:
        parser.error("give a run dir (runs/<run id>), or --demo")
    if not root.is_dir():
        parser.error(f"{root} is not a folder")
    count = len(find_traces(root))
    if not count:
        print(f"No trace.json under {root}. Traces come from Android testers (scripts/ecr_trace.py).")
        return 1
    if args.ecr and not (Path(args.ecr) / "packages" / "cli" / "src" / "main.ts").exists():
        parser.error(f"{args.ecr} is not a clone of explore-compile-replay")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(App(root, args.ecr)))
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"{count} paths. Dashboard: {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
