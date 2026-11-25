"""scripts/ecr_trace.py and the notes it reads, offline: a stand-in for the real adb,
screen trees written by hand, no phone."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import ecr_trace as tracer  # noqa: E402

LOGIN = """<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node text="" resource-id="" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
    <node text="Sign in" resource-id="app:id/title" class="android.widget.TextView" clickable="false" bounds="[40,200][1040,320]" />
    <node text="" resource-id="app:id/password" class="android.widget.EditText" clickable="true" bounds="[40,400][1040,520]" />
    <node text="Sign in" resource-id="app:id/submit" class="android.widget.Button" clickable="true" bounds="[40,600][1040,720]" />
    <node text="" content-desc="Help" resource-id="" class="android.widget.ImageButton" clickable="true" bounds="[940,40][1040,140]" />
    <node text="Costs ${price}" resource-id="app:id/promo" class="android.widget.TextView" bounds="[40,800][1040,900]" />
  </node>
</hierarchy>
"""
PERSONA = {"id": "anna", "profile": "Retired teacher.", "goal": "Create an account.", "locale": "en-GB",
           "device": {"name": "Small phone, Android 11", "font_scale": 1.3, "theme": "light"}}
NOW = "2026-11-25T12:00:00Z"


class Build(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        (self.dir / "01.xml").write_text(LOGIN, encoding="utf-8")
        self.screen = f"0\tscreen\t{self.dir / '01.xml'}\t1080\t2400"

    def actions(self, *lines):
        trace, values, skipped = tracer.build([self.screen, *lines], PERSONA, "com.example.todo", NOW)
        return [s["action"] for s in trace["steps"][1:]], values, skipped

    def test_first_step_launches_the_app_from_a_clean_state(self):
        trace, _, _ = tracer.build([], PERSONA, "com.example.todo", NOW)
        self.assertEqual(trace["steps"][0]["action"], {"kind": "launchApp", "appId": "com.example.todo", "clearState": True})
        self.assertEqual(trace["schema"], "ecr.trace/0")
        self.assertEqual(trace["id"], "anna-20261125T120000")
        self.assertEqual(trace["persona"]["context"], {"platform": "android", "device": "Small phone, Android 11", "fontScale": 1.3, "theme": "light"})

    def test_tap_is_stored_by_name_with_an_index_when_the_name_is_not_unique(self):
        actions, _, _ = self.actions("1\tadb\tshell\tinput\ttap\t500\t660", "1\tadb\tshell\tinput\ttap\t990\t90")
        self.assertEqual(actions, [
            {"kind": "tapOn", "target": {"text": "Sign in", "index": 1}},   # the button, not the title
            {"kind": "tapOn", "target": {"text": "Help"}},                  # a content description is a name
        ])

    def test_tap_without_a_name_falls_back_to_the_id_then_to_a_point(self):
        actions, _, _ = self.actions("1\tadb\tshell\tinput\ttap\t500\t460", "1\tadb\tshell\tinput tap 540 1800",
                                     "1\tadb\tshell\tinput\ttap\t500\t850")
        self.assertEqual(actions, [
            {"kind": "tapOn", "target": {"id": "app:id/password"}},
            {"kind": "tapOn", "target": {"point": "50%,75%"}},              # the command given as one string
            {"kind": "tapOn", "target": {"id": "app:id/promo"}},            # a name with ${ cannot be replayed as text
        ])

    def test_typed_text_never_reaches_the_trace(self):
        trace, values, _ = tracer.build([self.screen, "0\ttype\tS3cret-pass", "0\ttype\tanna@example.com", "0\ttype\tS3cret-pass"],
                                        PERSONA, "com.example.todo", NOW)
        self.assertEqual(values, {"TEXT_1": "S3cret-pass", "TEXT_2": "anna@example.com"})
        self.assertEqual([p["name"] for p in trace["params"]], ["TEXT_1", "TEXT_2"])
        self.assertTrue(all(p["secret"] for p in trace["params"]))
        stored = json.dumps(trace)
        self.assertNotIn("S3cret-pass", stored)
        self.assertNotIn("anna@example.com", stored)
        self.assertEqual([s["action"] for s in trace["steps"][1:3]],
                         [{"kind": "eraseText"}, {"kind": "inputText", "text": {"param": "TEXT_1"}}])

    def test_swipes_and_keys(self):
        actions, _, skipped = self.actions(
            "1\tadb\tshell\tinput\tswipe\t500\t1800\t500\t600\t400", "1\tadb\tshell\tinput\tswipe\t900\t1000\t100\t1010\t400",
            "1\tadb\tshell\tinput\tkeyevent\tKEYCODE_BACK", "1\tadb\tshell\tinput\tkeyevent\t66",
            "1\tadb\tshell\tinput\tkeyevent\tKEYCODE_VOLUME_UP")
        self.assertEqual(actions, [{"kind": "swipe", "direction": "UP"}, {"kind": "swipe", "direction": "LEFT"},
                                   {"kind": "pressKey", "key": "Back"}, {"kind": "pressKey", "key": "Enter"}])
        self.assertEqual(len(skipped), 1)

    def test_a_tap_uses_the_last_screen_seen_before_it(self):
        other = self.dir / "02.xml"
        other.write_text(LOGIN.replace('text="Sign in" resource-id="app:id/submit"', 'text="Create account" resource-id="app:id/submit"'), encoding="utf-8")
        actions, _, _ = self.actions("1\tadb\tshell\tinput\ttap\t500\t660", f"0\tscreen\t{other}\t1080\t2400",
                                     "1\tadb\tshell\tinput\ttap\t500\t660")
        self.assertEqual([a["target"] for a in actions], [{"text": "Sign in", "index": 1}, {"text": "Create account"}])

    def test_each_step_says_what_was_seen_for_tools_that_show_the_path(self):
        trace, _, _ = tracer.build([self.screen, "1\tadb\tshell\tinput\ttap\t500\t660", "0\ttype\thello",
                                    "1\tadb\tshell\tinput\tswipe\t500\t1800\t500\t600\t400", "1\tadb\tshell\tinput\ttap\t540\t1800"],
                                   PERSONA, "com.example.todo", NOW)
        self.assertNotIn("evidence", trace)   # no screenshot after the last action: the last screen is unknown
        after, _, _ = tracer.build([self.screen, "1\tadb\tshell\tinput\ttap\t500\t660", self.screen.replace("01.xml", "02.xml")],
                                   PERSONA, "com.example.todo", NOW)
        self.assertEqual(after["evidence"], {"lastScreen": "02"})
        seen = [s.get("evidence") for s in trace["steps"]]
        self.assertEqual(seen, [
            None,                                                                                          # launchApp: no screen yet
            {"screen": "01", "point": [500, 660], "bounds": [40, 600, 1040, 720], "size": [1080, 2400]},
            {"screen": "01"}, {"screen": "01"},                                                            # eraseText, inputText
            {"screen": "01", "from": [500, 1800], "to": [500, 600], "size": [1080, 2400]},
            {"screen": "01", "point": [540, 1800], "size": [1080, 2400]},                                  # no element: no bounds
        ])

    def test_an_unreadable_screen_or_line_does_not_stop_the_trace(self):
        (self.dir / "bad.xml").write_text("<hierarchy><node", encoding="utf-8")
        trace, _, _ = tracer.build([f"0\tscreen\t{self.dir / 'bad.xml'}\t1080\t2400", "garbage", "1\tadb\tshell\tinput\ttap\t540\t1200"],
                                   PERSONA, "com.example.todo", NOW)
        self.assertEqual(trace["steps"][1]["action"], {"kind": "tapOn", "target": {"point": "50%,50%"}})


class EndToEnd(unittest.TestCase):
    """The pass-through adb and type.py write the notes, trace.py reads them."""

    def test_notes_are_taken_and_the_real_adb_still_runs(self):
        work = Path(tempfile.mkdtemp())
        results = work / "results" / "anna"
        results.mkdir(parents=True)
        (results / "01.xml").write_text(LOGIN, encoding="utf-8")
        real = work / "real-adb"
        real.write_text('#!/usr/bin/env bash\necho "$*" >> "$FAKE_ADB_CALLS"\n')
        real.chmod(0o755)
        log = results / "actions.tsv"
        log.write_text(f"0\tscreen\t{results / '01.xml'}\t1080\t2400\n", encoding="utf-8")
        env = dict(os.environ, PATH=f"{ROOT / 'scripts/android/shim'}:{os.environ['PATH']}", ECR_REAL_ADB=str(real),
                   ECR_ACTION_LOG=str(log), FAKE_ADB_CALLS=str(work / "calls"))
        run = lambda *cmd: subprocess.run(cmd, env=env, cwd=ROOT, check=True, capture_output=True, text=True)  # noqa: E731
        run("adb", "shell", "input", "tap", "500", "460")
        run("python3", "scripts/android/type.py", "S3cret pass")
        run("adb", "shell", "input tap 500 660")
        run("adb", "logcat", "-d")                      # not an input: runs, is not noted
        run("adb", "shell", "input", "keyevent", "KEYCODE_BACK")

        calls = (work / "calls").read_text().splitlines()
        self.assertEqual(calls[0], "shell input tap 500 460")
        self.assertIn("shell input text S3cret%spass", calls)   # the real adb got every command, typing included
        self.assertIn("logcat -d", calls)
        self.assertEqual(len(log.read_text().splitlines()), 5)   # screen, tap, type, tap, key: the 42 keys of type.py are one note

        (work / "personas.json").write_text(json.dumps([PERSONA]))
        out = run("python3", "scripts/ecr_trace.py", str(results), "--persona", "anna", "--app-id", "com.example.todo",
                  "--personas", str(work / "personas.json"), "--now", NOW).stdout
        self.assertIn("6 steps, 1 typed texts kept apart, 0 commands left out", out)
        trace = json.loads((results / "trace.json").read_text())
        self.assertEqual([s["action"]["kind"] for s in trace["steps"]],
                         ["launchApp", "tapOn", "eraseText", "inputText", "tapOn", "pressKey"])
        self.assertEqual(json.loads((results / "trace.params.json").read_text()), {"TEXT_1": "S3cret pass"})
        self.assertNotIn("S3cret", (results / "trace.json").read_text())

    def test_no_notes_writes_nothing_and_does_not_fail(self):
        work = Path(tempfile.mkdtemp())
        run = subprocess.run(["python3", "scripts/ecr_trace.py", str(work), "--persona", "anna", "--app-id", "x"],
                             cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0)
        self.assertFalse((work / "trace.json").exists())


if __name__ == "__main__":
    unittest.main()
