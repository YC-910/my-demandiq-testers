"""Turns what an agent did on the phone into a trace that can be replayed with no model.

Usage: python3 scripts/ecr_trace.py <results dir of one persona> --persona ID --app-id ID
           [--personas personas.json] [--log actions.tsv] [--now 2026-01-01T00:00:00Z]

Reads the notes taken during the run (scripts/android/shim/adb, screen.py, type.py)
and the screen trees screen.py saved, and writes in the results dir:
- trace.json: the path, in the Explore-Compile-Replay format
  (https://github.com/pierridotite/explore-compile-replay). A tap is stored with the
  name of the element that was under it, not with its coordinates, so the path
  still replays when the layout moves.
  Each step also says what was seen (`evidence`: the screenshot before the action,
  where the finger landed, the screen size), for tools that show the path.
- trace.params.json: every text the agent typed. The trace holds only their names
  (TEXT_1, TEXT_2...), so it can be committed. This file must not be.

The trace is a path, with no checks yet: replayed, it fails when a step no longer
finds its target. Android only for now.
"""
import argparse
import datetime
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

KEYS = {"KEYCODE_BACK": "Back", "4": "Back", "KEYCODE_ENTER": "Enter", "66": "Enter",
        "KEYCODE_HOME": "Home", "3": "Home", "KEYCODE_DEL": "Backspace", "67": "Backspace"}


def read_screen(path):
    """Named elements of a saved screen tree, in document order: (label, id, x1, y1, x2, y2)."""
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError):
        return []
    nodes = []
    for n in root.iter("node"):
        b = re.findall(r"-?\d+", n.get("bounds", ""))
        if len(b) != 4:
            continue
        label = (n.get("text") or "").strip() or (n.get("content-desc") or "").strip()
        nodes.append((label, (n.get("resource-id") or "").strip(), *map(int, b)))
    return nodes


def target_at(nodes, x, y, width, height):
    """How a replay should find what was tapped: by name, else by id, else by position.
    Returns the target and the bounds of the element it names (None for a position)."""
    hits = [n for n in nodes if n[2] <= x <= n[4] and n[3] <= y <= n[5] and (n[0] or n[1])]
    hits.sort(key=lambda n: (n[4] - n[2]) * (n[5] - n[3]))   # the smallest element under the finger
    for key in (0, 1):   # a name first: it survives a refactoring better than an id
        for hit in hits:
            if not hit[key] or "${" in hit[key] or len(hit[key]) > 80 or "\n" in hit[key]:
                continue
            same = [n for n in nodes if n[key] == hit[key]]
            target = {"text" if key == 0 else "id": hit[key]}
            if len(same) > 1:
                target["index"] = same.index(hit)
            return target, list(hit[2:6])
    if width > 0 and height > 0:
        return {"point": f"{min(100, max(0, round(100 * x / width)))}%,{min(100, max(0, round(100 * y / height)))}%"}, None
    return None, None


def input_args(fields):
    """['shell', 'input', 'tap', '1', '2'] or ['shell', 'input tap 1 2'] -> ['tap', '1', '2']"""
    words = " ".join(fields[1:]).split()
    return words[1:] if words[:1] == ["input"] else []


def build(log_lines, persona, app_id, now):
    steps, params, values, skipped = [], [], {}, []
    nodes, width, height, screen, last_screen = [], 0, 0, None, None

    def add(action, **seen):
        """seen: what a tool needs to show the step (screenshot, finger, screen size). Never used to replay."""
        step = {"id": f"s{len(steps) + 1}", "action": action, "checkpoints": []}
        evidence = {key: value for key, value in dict(screen=screen, **seen).items() if value is not None}
        if width > 0 and height > 0 and ("point" in evidence or "from" in evidence):
            evidence["size"] = [width, height]
        if evidence:
            step["evidence"] = evidence
        steps.append(step)
        nonlocal last_screen
        last_screen = None   # known again at the next screenshot

    add({"kind": "launchApp", "appId": app_id, "clearState": True})
    for line in log_lines:
        fields = line.rstrip("\n").split("\t")
        if len(fields) < 3:
            continue
        kind = fields[1]
        if kind == "screen":
            nodes = read_screen(fields[2])
            screen = last_screen = Path(fields[2]).stem
            if len(fields) >= 5 and fields[3].isdigit() and fields[4].isdigit():
                width, height = int(fields[3]), int(fields[4])
        elif kind == "type":
            text = fields[2]
            if not text:
                continue
            if text not in values:
                values[text] = f"TEXT_{len(values) + 1}"
                params.append({"name": values[text], "secret": True, "description": "A text the agent typed"})
            add({"kind": "eraseText"})
            add({"kind": "inputText", "text": {"param": values[text]}})
        elif kind == "adb":
            args = input_args(fields[2:])
            if args[:1] == ["tap"] and len(args) >= 3 and args[1].lstrip("-").isdigit() and args[2].lstrip("-").isdigit():
                x, y = int(args[1]), int(args[2])
                target, bounds = target_at(nodes, x, y, width, height)
                if target:
                    add({"kind": "tapOn", "target": target}, point=[x, y], bounds=bounds)
                else:
                    skipped.append(line.strip())
            elif args[:1] == ["swipe"] and len(args) >= 5 and all(a.lstrip("-").isdigit() for a in args[1:5]):
                x1, y1, x2, y2 = map(int, args[1:5])
                if abs(x2 - x1) > abs(y2 - y1):
                    direction = "LEFT" if x2 < x1 else "RIGHT"
                else:
                    direction = "UP" if y2 < y1 else "DOWN"
                add({"kind": "swipe", "direction": direction}, **{"from": [x1, y1], "to": [x2, y2]})
            elif args[:1] == ["keyevent"] and len(args) == 2 and args[1] in KEYS:
                add({"kind": "pressKey", "key": KEYS[args[1]]})
            elif args:
                skipped.append(line.strip())

    device = persona.get("device") or {}
    context = {"platform": "android"}
    for key, name in (("name", "device"), ("font_scale", "fontScale"), ("theme", "theme")):
        if device.get(key) is not None:
            context[name] = device[key]
    who = {"id": persona["id"], "profile": persona.get("profile", ""), "goal": persona.get("goal", "")}
    if persona.get("locale"):
        who["locale"] = persona["locale"]
    who["context"] = context
    trace = {
        "schema": "ecr.trace/0",
        "id": f"{persona['id']}-{now[:19].replace(':', '').replace('-', '')}",
        "adapter": {"id": "mobile-maestro"},
        "persona": who,
        "params": params,
        "invariants": [],
        "steps": steps,
        **({"evidence": {"lastScreen": last_screen}} if last_screen else {}),
        "provenance": {"exploredAt": now, "agent": "mobile-agent-testers"},
    }
    return trace, {name: text for text, name in values.items()}, skipped


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("results")
    parser.add_argument("--persona", required=True)
    parser.add_argument("--app-id", required=True)
    parser.add_argument("--personas", default="personas.json")
    parser.add_argument("--log")
    parser.add_argument("--now")
    args = parser.parse_args(argv)

    results = Path(args.results)
    log = Path(args.log) if args.log else results / "actions.tsv"
    if not log.exists():
        print(f"trace: no notes at {log}, nothing written")
        return 0
    persona = {"id": args.persona}
    try:
        known = json.loads(Path(args.personas).read_text(encoding="utf-8"))
        persona = next((p for p in known if p.get("id") == args.persona), persona)
    except (OSError, ValueError):
        pass
    now = args.now or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    trace, values, skipped = build(log.read_text(encoding="utf-8").splitlines(), persona, args.app_id, now)
    if len(trace["steps"]) < 2:
        print("trace: the agent did nothing that can be replayed, nothing written")
        return 0
    (results / "trace.json").write_text(json.dumps(trace, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (results / "trace.params.json").write_text(json.dumps(values, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"trace: {len(trace['steps'])} steps, {len(values)} typed texts kept apart, {len(skipped)} commands left out")
    return 0


if __name__ == "__main__":
    sys.exit(main())
