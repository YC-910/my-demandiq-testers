# Replay the path of a tester (experimental)

Two runs never take the same path. So when a tester finds a bug, the path that led to it is worth keeping.

Each Android tester now leaves two more files in its results, next to `report.md`:

- `trace.json`: what the agent did, step by step. A tap is stored with the name of the element that was under the finger, not with its coordinates, so the path still replays when the layout moves.
- `trace.params.json`: every text the agent typed (an e-mail, a password). The trace only holds their names, `TEXT_1`, `TEXT_2`. **Do not commit this file.**

Nothing changes for the agent: same tools, same brief. The taps are noted by a pass-through in front of `adb` ([scripts/android/shim/adb](../scripts/android/shim/adb)), and [scripts/ecr_trace.py](../scripts/ecr_trace.py) writes the trace when the agent is done.

To watch, comment and edit these paths before compiling them: [docs/dashboard.md](dashboard.md).

## From a trace to a test that reruns with no model

The trace is in the format of [Explore-Compile-Replay](https://github.com/pierridotite/explore-compile-replay), which compiles it to a [Maestro](https://maestro.dev) flow:

```bash
bash scripts/collect.sh <run id>                       # decrypts the results into runs/<run id>/
git clone https://github.com/pierridotite/explore-compile-replay && cd explore-compile-replay && pnpm install
pnpm ecr compile ../runs/<run id>/anna/trace.json --adapter packages/adapter-maestro/src/index.ts
maestro test -e TEXT_1="..." ../runs/<run id>/anna/anna-<date>.flow.yaml
```

## What it is today

- **Experimental.** The trace is written and compiles to a flow that Maestro accepts. Replaying such a flow on an emulator has not been tested yet.
- **A path, not yet a test of the bug.** The flow has no checks: it fails when a step no longer finds its target. Turning a finding of the report into a check is the next step.
- **Android only.** iOS comes next.
- An element with no name and no id is stored as a point on the screen, in percent. It breaks on another screen size.
- When several elements share a name, the trace keeps the position of the one that was tapped among them.
