"""scripts/dashboard.py, offline: the demo run, the screen groups, what the server serves and writes."""
import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import dashboard  # noqa: E402
import dashboard_demo  # noqa: E402


class Run(unittest.TestCase):
    def setUp(self):
        self.root = dashboard_demo.write(Path(tempfile.mkdtemp()))
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_every_tester_of_the_demo_has_a_valid_path(self):
        run = dashboard.load_run(self.root)
        self.assertEqual(sorted(p["trace"]["persona"]["id"] for p in run["personas"]), ["anna", "kenji", "lucas"])
        for p in run["personas"]:
            self.assertEqual(dashboard.check_trace(p["trace"]), [])
            self.assertTrue(p["screens"])
            self.assertTrue(all("_tokens" not in s for s in p["screens"].values()))
            self.assertIn("lastScreen", p["trace"]["evidence"])

    def test_the_same_screen_in_two_languages_is_one_group(self):
        run = dashboard.load_run(self.root)
        by = {p["trace"]["persona"]["id"]: p for p in run["personas"]}
        self.assertEqual(by["anna"]["screens"]["01"]["group"], by["lucas"]["screens"]["01"]["group"])   # English and French welcome
        self.assertNotEqual(by["anna"]["screens"]["01"]["group"], by["anna"]["screens"]["02"]["group"])
        self.assertEqual(run["groups"][by["anna"]["screens"]["02"]["group"]]["title"], "Create your account")

    def test_typed_texts_never_reach_the_page(self):
        for p in dashboard.load_run(self.root)["personas"]:
            self.assertNotIn("S3cret-pass", json.dumps(p))

    def test_check_trace(self):
        trace = json.loads(next(self.root.rglob("trace.json")).read_text())
        self.assertEqual(dashboard.check_trace(trace), [])
        broken = json.loads(json.dumps(trace))
        broken["steps"][2]["id"] = broken["steps"][1]["id"]
        self.assertIn("two steps have the same id", dashboard.check_trace(broken))
        moved = json.loads(json.dumps(trace))
        moved["steps"].reverse()
        self.assertIn("the first step of a mobile trace must be launchApp", dashboard.check_trace(moved))
        self.assertEqual(dashboard.check_trace([]), ["the trace is not a JSON object"])


class Server(unittest.TestCase):
    def setUp(self):
        self.root = dashboard_demo.write(Path(tempfile.mkdtemp()))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.anna = self.root / "android-anna" / "results" / "anna"
        (self.anna / "trace.params.json").write_text('{"TEXT_1": "S3cret-pass"}')
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), dashboard.make_handler(dashboard.App(self.root)))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def post(self, path, body, header=True):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", **({"X-Dashboard": "1"} if header else {})})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_the_page_and_the_run(self):
        self.assertEqual(self.get("/")[0], 200)
        self.assertEqual(self.get("/app.js")[0], 200)
        code, body = self.get("/api/run")
        self.assertEqual(code, 200)
        self.assertEqual(len(json.loads(body)["personas"]), 3)
        self.assertNotIn(b"S3cret-pass", body)

    def test_only_screenshots_are_served(self):
        key = "android-anna/results/anna"
        self.assertEqual(self.get(f"/api/screen?persona={key}&name=01.svg")[0], 200)
        for name in ("trace.params.json", "trace.json", "../../../anna/01.svg", "report.md"):
            self.assertEqual(self.get(f"/api/screen?persona={key}&name={name}")[0], 404, name)
        self.assertEqual(self.get("/api/screen?persona=../../etc&name=01.png")[0], 404)
        self.assertEqual(self.get("/trace.params.json")[0], 404)

    def test_saving_keeps_the_explored_trace_once(self):
        key = "android-anna/results/anna"
        explored = json.loads((self.anna / "trace.json").read_text())
        edited = json.loads(json.dumps(explored))
        edited["steps"][1]["intent"] = "Starts"
        del edited["steps"][2]
        self.assertEqual(self.post(f"/api/trace?persona={key}", edited), (200, {"ok": True, "checkedByEcr": False}))
        self.assertEqual(json.loads((self.anna / "trace.json").read_text()), edited)
        self.assertEqual(json.loads((self.anna / "trace.explored.json").read_text()), explored)
        edited["steps"][1]["intent"] = "Starts again"
        self.post(f"/api/trace?persona={key}", edited)
        self.assertEqual(json.loads((self.anna / "trace.explored.json").read_text()), explored)   # still the explored one

    def test_a_broken_trace_is_not_written(self):
        key = "android-anna/results/anna"
        before = (self.anna / "trace.json").read_text()
        code, body = self.post(f"/api/trace?persona={key}", {"schema": "ecr.trace/0", "steps": []})
        self.assertEqual(code, 422)
        self.assertEqual((self.anna / "trace.json").read_text(), before)

    def test_notes_and_the_guard_against_other_sites(self):
        key = "android-anna/results/anna"
        notes = {"steps": {"s2": [{"id": "c1", "text": "Too small", "at": "2026-11-25T12:00:00Z", "resolved": False}]}, "trace": []}
        self.assertEqual(self.post(f"/api/notes?persona={key}", notes, header=False)[0], 403)
        self.assertFalse((self.anna / "trace.notes.json").exists())
        self.assertEqual(self.post(f"/api/notes?persona={key}", notes)[0], 200)
        saved = json.loads((self.anna / "trace.notes.json").read_text())
        self.assertEqual(saved["schema"], dashboard.NOTES_SCHEMA)
        self.assertEqual(saved["steps"]["s2"][0]["text"], "Too small")
        self.assertEqual(self.post("/api/notes?persona=../../..", notes)[0], 404)

    def test_compiling_needs_ecr(self):
        trace = json.loads((self.anna / "trace.json").read_text())
        self.assertEqual(self.post("/api/compile?persona=android-anna/results/anna", trace)[0], 501)


if __name__ == "__main__":
    unittest.main()
