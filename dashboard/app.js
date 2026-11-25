// The paths of the testers: a preview, a timeline, an inspector. No framework, no build step.
// Every value read from a run is put in the page as text, never as HTML.
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- the mobile vocabulary of ECR (packages/adapter-maestro), checked in the page ----------

const KINDS = {
  launchApp: { cls: "launch", label: "Launch app" },
  tapOn: { cls: "tap", label: "Tap" },
  longPressOn: { cls: "tap", label: "Long press" },
  inputText: { cls: "type", label: "Type" },
  eraseText: { cls: "type", label: "Erase text" },
  pressKey: { cls: "key", label: "Press key" },
  swipe: { cls: "swipe", label: "Swipe" },
  scrollUntilVisible: { cls: "swipe", label: "Scroll until visible" },
  hideKeyboard: { cls: "key", label: "Hide keyboard" },
};
const KEYS = ["Enter", "Backspace", "Home", "Back"];
const DIRECTIONS = ["UP", "DOWN", "LEFT", "RIGHT"];
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const POINT = /^\d{1,3}%,\d{1,3}%$/;
const isParam = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.param === "string";
const hasTarget = (kind) => ["tapOn", "longPressOn", "scrollUntilVisible"].includes(kind);

function checkText(text, params, where, out) {
  if (isParam(text)) {
    if (!PARAM_NAME.test(text.param)) out.push(`${where}: "${text.param}" is not a parameter name`);
    else if (!params.includes(text.param)) out.push(`${where}: parameter ${text.param} is not declared`);
  } else if (typeof text !== "string" || text === "") out.push(`${where}: empty text`);
  else if (text.includes("${")) out.push(`${where}: a text cannot contain "\${"`);
}

function checkSelector(sel, params, where, out, allowPoint = true) {
  if (!sel || typeof sel !== "object") return out.push(`${where}: no target`);
  const modes = ["id", "text", "point"].filter((k) => k in sel);
  if (modes.length !== 1) return out.push(`${where}: give one of text, id${allowPoint ? " or point" : ""}`);
  const extra = Object.keys(sel).filter((k) => k !== modes[0] && k !== "index");
  if (extra.length) out.push(`${where}: unknown field ${extra.join(", ")}`);
  if (modes[0] === "point") {
    if (!allowPoint) out.push(`${where}: a check needs an element, not a point`);
    else if (!POINT.test(sel.point)) out.push(`${where}: a point is written 50%,75%`);
    if ("index" in sel) out.push(`${where}: a point takes no index`);
  } else if (modes[0] === "id") {
    if (typeof sel.id !== "string" || !sel.id) out.push(`${where}: empty id`);
    else if (sel.id.includes("${")) out.push(`${where}: an id cannot contain "\${"`);
  } else checkText(sel.text, params, where, out);
  if ("index" in sel && !(Number.isInteger(sel.index) && sel.index >= 0)) out.push(`${where}: the index must be 0 or more`);
}

function checkAction(a, params) {
  const out = [];
  if (!a || !KINDS[a.kind]) return [`unknown action ${a && a.kind}`];
  const allowed = { launchApp: ["appId", "clearState"], tapOn: ["target"], longPressOn: ["target"], inputText: ["text"],
    eraseText: ["characters"], pressKey: ["key"], swipe: ["direction"], scrollUntilVisible: ["target", "direction"], hideKeyboard: [] }[a.kind];
  const extra = Object.keys(a).filter((k) => k !== "kind" && !allowed.includes(k));
  if (extra.length) out.push(`unknown field ${extra.join(", ")}`);
  switch (a.kind) {
    case "launchApp":
      if (!/^[A-Za-z0-9._-]+$/.test(a.appId || "")) out.push("the app id is not valid");
      if ("clearState" in a && typeof a.clearState !== "boolean") out.push("clearState is true or false");
      break;
    case "tapOn": case "longPressOn": checkSelector(a.target, params, "target", out); break;
    case "scrollUntilVisible":
      checkSelector(a.target, params, "target", out, false);
      if ("direction" in a && !DIRECTIONS.includes(a.direction)) out.push("unknown direction");
      break;
    case "inputText": checkText(a.text, params, "text", out); break;
    case "eraseText": if ("characters" in a && !(Number.isInteger(a.characters) && a.characters > 0)) out.push("characters must be 1 or more"); break;
    case "pressKey": if (!KEYS.includes(a.key)) out.push("unknown key"); break;
    case "swipe": if (!DIRECTIONS.includes(a.direction)) out.push("unknown direction"); break;
  }
  return out;
}

function checkTrace(trace) {
  const byStep = {}, global = [];
  const params = (trace.params || []).map((p) => p.name);
  const ids = new Set(), oracleIds = new Set();
  trace.steps.forEach((step, i) => {
    const out = checkAction(step.action, params);
    if (!step.id) out.push("no id");
    else if (ids.has(step.id)) out.push(`id ${step.id} is used twice`);
    ids.add(step.id);
    if (i === 0 && step.action.kind !== "launchApp") global.push("The first step must be Launch app: it names the app.");
    for (const o of step.checkpoints || []) {
      if (oracleIds.has(o.id)) out.push(`check ${o.id} is used twice`);
      oracleIds.add(o.id);
      if ("observed" in o && !["held", "failed"].includes(o.observed)) out.push(`check ${o.id}: observed is held or failed`);
      if (!o.check || !["visible", "notVisible"].includes(o.check.kind)) out.push(`check ${o.id}: unknown kind`);
      else checkSelector(o.check.target, params, `check ${o.id}`, out, false);
    }
    if (out.length) byStep[step.id || `#${i}`] = out;
  });
  return { byStep, global, count: Object.values(byStep).flat().length + global.length };
}

function describeSelector(sel) {
  if (!sel) return "?";
  const idx = Number.isInteger(sel.index) ? ` #${sel.index + 1}` : "";
  if ("text" in sel) return (isParam(sel.text) ? `‹${sel.text.param}›` : `“${sel.text || "…"}”`) + idx;
  if ("id" in sel) return `#${String(sel.id).split("/").pop()}${idx}`;
  if ("point" in sel) return `point ${sel.point}`;
  return "?";
}

function describe(a) {
  switch (a.kind) {
    case "launchApp": return a.clearState ? "Launch app (clean)" : "Launch app";
    case "tapOn": return `Tap ${describeSelector(a.target)}`;
    case "longPressOn": return `Long press ${describeSelector(a.target)}`;
    case "inputText": return `Type ${isParam(a.text) ? `‹${a.text.param}›` : `“${a.text}”`}`;
    case "eraseText": return a.characters ? `Erase ${a.characters} chars` : "Erase text";
    case "pressKey": return a.key === "Back" ? "Back" : `Key ${a.key}`;
    case "swipe": return `Swipe ${String(a.direction).toLowerCase()}`;
    case "scrollUntilVisible": return `Scroll to ${describeSelector(a.target)}`;
    case "hideKeyboard": return "Hide keyboard";
    default: return a.kind;
  }
}

// ---------- Maestro flow, compiled in the page ----------
// Mirrors compileToMaestro of ECR's packages/adapter-maestro, to preview the flow and its
// source map. The authoritative compile is `ecr compile` (button "Compile with ECR").

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}
async function hashTrace(trace) {
  if (!crypto.subtle) return "(hash needs a secure page)";
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(trace)));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const q = (s) => JSON.stringify(s);
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();
const plainText = (t) => q(isParam(t) ? `\${${t.param}}` : t);
const matchedText = (t) => (isParam(t) ? q(`\${${t.param}}`) : q(String(t).replace(/[\\^$.|?*+()[\]{}]/g, "\\$&")));
function selectorLines(sel) {
  if ("point" in sel) return [`    point: ${q(sel.point)}`];
  const first = "id" in sel ? `    id: ${q(sel.id)}` : `    text: ${matchedText(sel.text)}`;
  return sel.index === undefined ? [first] : [first, `    index: ${sel.index}`];
}
function actionLines(a) {
  switch (a.kind) {
    case "launchApp": return a.clearState === undefined ? ["- launchApp"] : ["- launchApp:", `    clearState: ${a.clearState}`];
    case "tapOn": case "longPressOn": return [`- ${a.kind}:`, ...selectorLines(a.target)];
    case "inputText": return [`- inputText: ${plainText(a.text)}`];
    case "eraseText": return [a.characters === undefined ? "- eraseText" : `- eraseText: ${a.characters}`];
    case "pressKey": return [a.key === "Back" ? "- back" : `- pressKey: ${a.key}`];
    case "swipe": return ["- swipe:", `    direction: ${a.direction}`];
    case "scrollUntilVisible": return ["- scrollUntilVisible:", "    element:", ...selectorLines(a.target).map((l) => `  ${l}`),
      ...(a.direction === undefined ? [] : [`    direction: ${a.direction}`])];
    case "hideKeyboard": return ["- hideKeyboard"];
  }
  return [];
}
async function compileFlow(trace) {
  const declared = (trace.params || []).map((p) => p.name);
  const lines = [
    "# Compiled by Explore-Compile-Replay: https://github.com/pierridotite/explore-compile-replay",
    `# Trace: ${oneLine(trace.id)}`,
    `# Trace hash: sha256:${await hashTrace(trace)}`,
    "# Do not edit by hand. Change the trace and compile again.",
    declared.length === 0 ? "# Run: maestro test <this file>" : `# Run: maestro test ${declared.map((n) => `-e ${n}=<value>`).join(" ")} <this file>`,
    `appId: ${trace.steps[0].action.appId}`,
    `name: ${q(oneLine(`${trace.persona.id}: ${trace.persona.goal}`))}`,
    "---",
  ];
  const map = {};
  for (const step of trace.steps) {
    const start = lines.length + 1;
    lines.push(`# Step ${oneLine(step.id)}${step.intent === undefined ? "" : `: ${oneLine(step.intent)}`}`);
    lines.push(...actionLines(step.action));
    for (const o of [...(step.checkpoints || []), ...(trace.invariants || [])]) {
      lines.push(`# Oracle ${oneLine(o.id)}`);
      if (o.observed === "failed") lines.push("# Known bug: this check was false when the trace was recorded. It fails until the bug is fixed.");
      lines.push(`- ${o.check.kind === "visible" ? "assertVisible" : "assertNotVisible"}:`, ...selectorLines(o.check.target));
    }
    map[step.id] = [start, lines.length];
  }
  lines.push("");
  return { text: lines.join("\n"), map, file: `${trace.id.replace(/[^A-Za-z0-9._-]/g, "-")}.flow.yaml` };
}

// ---------- state ----------

const S = {
  data: null, key: null, ws: {}, sel: {}, playing: false, timer: null, speed: 1,
  heat: "me", zoom: 112, tab: "step", picking: null, ecrFlow: null, lastCoalesce: null,
};
const persona = (key = S.key) => S.data.personas.find((p) => p.key === key);
function ws(key = S.key) {
  if (!S.ws[key]) {
    const p = persona(key);
    const notes = p.notes && typeof p.notes === "object" ? clone(p.notes) : {};
    notes.steps = notes.steps && typeof notes.steps === "object" ? notes.steps : {};
    notes.trace = Array.isArray(notes.trace) ? notes.trace : [];
    S.ws[key] = { trace: clone(p.trace), notes, undo: [], redo: [] };
    S.ws[key].saved = snapshot(S.ws[key]);
  }
  return S.ws[key];
}
const snapshot = (w) => JSON.stringify({ trace: w.trace, notes: w.notes });
const dirty = (w) => snapshot(w) !== w.saved;
const tr = () => ws().trace;
const steps = () => tr().steps;
const endPos = () => (tr().evidence && tr().evidence.lastScreen ? steps().length : steps().length - 1);
const cur = () => Math.min(S.sel[S.key] || 0, endPos());

function edit(fn, opts = {}) {
  const w = ws();
  const now = Date.now();
  const coalesce = opts.coalesce && S.lastCoalesce && S.lastCoalesce.key === opts.coalesce && now - S.lastCoalesce.at < 1200;
  if (!coalesce) { w.undo.push(snapshot(w)); w.redo = []; if (w.undo.length > 200) w.undo.shift(); }
  S.lastCoalesce = opts.coalesce ? { key: opts.coalesce, at: now } : null;
  fn(w);
  S.ecrFlow = null;
  render(opts.inspector === false ? { inspector: false } : {});
}
function undoRedo(from, to) {
  const w = ws();
  if (!w[from].length) return;
  w[to].push(snapshot(w));
  const s = JSON.parse(w[from].pop());
  w.trace = s.trace; w.notes = s.notes;
  S.lastCoalesce = null; S.ecrFlow = null;
  render();
}

// ---------- what each position shows ----------

const screenInfo = (nn, key = S.key) => (nn ? persona(key).screens[nn] : null);
function shownScreen(i, trace = tr()) {
  if (i >= trace.steps.length) return { nn: trace.evidence && trace.evidence.lastScreen, end: true };
  for (let j = i; j >= 0; j--) {
    const ev = trace.steps[j].evidence;
    if (ev && ev.screen) return { nn: ev.screen, inherited: j !== i };
  }
  return { nn: null };
}
const screenUrl = (key, nn) => {
  const s = screenInfo(nn, key);
  return s ? `/api/screen?persona=${encodeURIComponent(key)}&name=${encodeURIComponent(s.file)}` : null;
};
const groupTitle = (g) => (g && S.data.groups[g] && S.data.groups[g].title) || "";
/** The name of a screenshot: its own title (in the tester's language), else the title of its group. */
const screenTitle = (info, nn) => (info && (info.title || groupTitle(info.group))) || `Screen ${nn}`;

/** Taps and swipes on every screenshot of a group, in [0, 1] of the screen. */
function heatPoints(group) {
  const pts = [];
  const keys = S.heat === "all" ? S.data.personas.map((p) => p.key) : [S.key];
  for (const key of keys) {
    const trace = S.ws[key] ? S.ws[key].trace : persona(key).trace;
    for (const step of trace.steps) {
      const ev = step.evidence;
      if (!ev || !ev.screen || !Array.isArray(ev.size)) continue;
      const s = screenInfo(ev.screen, key);
      if (!s || s.group !== group) continue;
      const [w, hgt] = ev.size;
      if (Array.isArray(ev.point)) pts.push({ x: ev.point[0] / w, y: ev.point[1] / hgt, key, weight: 1 });
      if (Array.isArray(ev.from) && Array.isArray(ev.to)) {
        for (let t = 0; t <= 1; t += 0.2) pts.push({ x: (ev.from[0] + (ev.to[0] - ev.from[0]) * t) / w, y: (ev.from[1] + (ev.to[1] - ev.from[1]) * t) / hgt, key, weight: 0.35 });
      }
    }
  }
  return pts;
}

// ---------- rendering ----------

function render(opts = {}) {
  renderTop();
  renderPersonas();
  renderPreview();
  renderTimeline();
  if (opts.inspector !== false) renderTab();
  else if (S.tab === "flow") renderFlow();
}

function renderTop() {
  const w = ws();
  $("#undo").disabled = !w.undo.length;
  $("#redo").disabled = !w.redo.length;
  const anyDirty = S.data.personas.some((p) => S.ws[p.key] && dirty(S.ws[p.key]));
  const st = $("#status");
  if (!st.classList.contains("error") || anyDirty) {
    st.className = "status" + (anyDirty ? " dirty" : "");
    st.textContent = anyDirty ? "Unsaved changes" : st.dataset.saved || "";
  }
  $("#save").disabled = !anyDirty;
  $("#ecr-compile").classList.toggle("on", S.tab === "flow");
}

function renderPersonas() {
  const list = $("#personas");
  list.replaceChildren(...S.data.personas.map((p) => {
    const w = S.ws[p.key];
    const t = w ? w.trace : p.trace;
    const ctx = (t.persona && t.persona.context) || {};
    const issues = (p.findings && p.findings.issues) || [];
    const score = p.findings && p.findings.score;
    return h("li", {}, h("button", { "aria-current": String(p.key === S.key), onclick: () => selectPersona(p.key) },
      h("span", { class: "name" }, h("span", {}, t.persona.id), h("span", {},
        w && dirty(w) ? h("span", { class: "badge edited" }, "unsaved") : p.edited ? h("span", { class: "badge" }, "edited") : null)),
      h("span", { class: "meta" }, [ctx.device, t.persona.locale].filter(Boolean).join(" · ")),
      h("span", { class: "meta" }, `${t.steps.length} steps · ${issues.length} findings${score !== undefined ? ` · ${score}/10` : ""}`)));
  }));
  const p = persona();
  const issues = (p.findings && p.findings.issues) || [];
  $("#finding-count").textContent = issues.length;
  $("#findings").replaceChildren(...(issues.length ? issues.map((iss) => h("li", {}, h("button", {
    onclick: () => { const i = firstStepOn(iss.screens); if (i >= 0) select(i); },
    title: (iss.screens || []).length ? `Screenshots ${iss.screens.join(", ")}` : "",
  }, h("span", { class: "title" }, h("span", { class: `dot sev-${iss.severity}` }), iss.title),
  h("span", { class: "meta" }, [iss.severity, iss.screen].filter(Boolean).join(" · "))))) : [h("li", { class: "meta" }, "No findings.json for this tester.")]));
}

function firstStepOn(screens) {
  if (!Array.isArray(screens)) return -1;
  const set = new Set(screens.map(String));
  const i = steps().findIndex((s) => s.evidence && set.has(s.evidence.screen));
  if (i >= 0) return i;
  return tr().evidence && set.has(tr().evidence.lastScreen) ? steps().length : -1;
}

function renderPreview() {
  const t = tr(), i = cur(), step = t.steps[i];
  const shown = shownScreen(i);
  const info = screenInfo(shown.nn);
  const img = $("#shot"), launch = $("#launch");
  const ctx = t.persona.context || {};
  $("#persona-card").replaceChildren(h("b", {}, t.persona.id), h("br"), t.persona.goal || "",
    h("br"), [ctx.device, t.persona.locale, ctx.fontScale && ctx.fontScale !== 1 ? `text ×${ctx.fontScale}` : null, ctx.theme].filter(Boolean).join(" · "));

  const size = (step && step.evidence && step.evidence.size) || sizeOfRun();
  $("#phone").style.aspectRatio = `${size[0]} / ${size[1]}`;
  if (info) {
    const url = screenUrl(S.key, shown.nn);
    if (img.getAttribute("src") !== url) img.src = url;
    img.hidden = false; launch.classList.remove("on");
  } else {
    img.hidden = true; img.removeAttribute("src");
    launch.classList.add("on");
    launch.replaceChildren(h("div", {}, h("strong", {}, step && step.action.kind === "launchApp" ? "Launch the app" : "No screenshot"),
      step && step.action.kind === "launchApp" ? `${step.action.appId}${step.action.clearState ? ", from a clean state" : ""}` : "This step was added by hand."));
  }
  const pts = info ? heatPoints(info.group) : [];
  const testers = new Set(pts.map((p) => p.key)).size;
  const cap = $("#screen-caption");
  cap.replaceChildren();
  if (info) {
    cap.append(h("b", {}, screenTitle(info, shown.nn)), ` · screenshot ${shown.nn}`);
    if (shown.inherited) cap.append(" · no screenshot of its own");
    if (shown.end) cap.append(" · after the last step");
    if (S.heat !== "off") cap.append(` · ${pts.filter((p) => p.weight === 1).length} taps by ${testers} tester${testers === 1 ? "" : "s"} on this screen`);
  }
  requestAnimationFrame(() => { drawHeat(pts); drawOverlay(step, shown, size); });
}

function sizeOfRun() {
  for (const s of steps()) if (s.evidence && Array.isArray(s.evidence.size)) return s.evidence.size;
  return [1080, 2400];
}

const RAMP = (() => {
  const stops = [[0, [30, 60, 255, 0]], [0.25, [30, 140, 255, 150]], [0.5, [40, 220, 160, 200]], [0.75, [250, 220, 50, 230]], [1, [255, 60, 60, 250]]];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0);
    for (let c = 0; c < 4; c++) lut[i * 4 + c] = c0[c] + (c1[c] - c0[c]) * f;
  }
  return lut;
})();

function drawHeat(pts) {
  const canvas = $("#heat");
  const box = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(box.width * dpr));
  canvas.height = Math.max(1, Math.round(box.height * dpr));
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (S.heat === "off" || !pts.length || $("#shot").hidden) return;
  const r = canvas.width * 0.09;
  for (const p of pts) {
    const x = p.x * canvas.width, y = p.y * canvas.height;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(0,0,0,${0.55 * p.weight})`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (!a) continue;
    d[i] = RAMP[a * 4]; d[i + 1] = RAMP[a * 4 + 1]; d[i + 2] = RAMP[a * 4 + 2]; d[i + 3] = RAMP[a * 4 + 3];
  }
  g.putImageData(img, 0, 0);
}

function drawOverlay(step, shown, size) {
  const svg = $("#overlay");
  svg.setAttribute("viewBox", `0 0 ${size[0]} ${size[1]}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.replaceChildren();
  const unit = size[0] / 360;
  const info = screenInfo(shown.nn);
  if (S.picking && info) {
    for (const el of info.elements) {
      const [x1, y1, x2, y2] = el.bounds;
      const r = svgEl("rect", { x: x1, y: y1, width: x2 - x1, height: y2 - y1, class: "pick-el", fill: "rgba(79,140,255,0.06)", stroke: "rgba(79,140,255,0.5)", "stroke-width": unit });
      svg.append(r);
    }
    return;
  }
  const ev = step && !shown.inherited && !shown.end ? step.evidence : null;
  if (!ev) return;
  if (Array.isArray(ev.bounds)) {
    const [x1, y1, x2, y2] = ev.bounds;
    svg.append(svgEl("rect", { x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 4 * unit, fill: "rgba(79,140,255,0.12)", stroke: "#4f8cff", "stroke-width": 1.5 * unit, "stroke-dasharray": `${5 * unit} ${3 * unit}` }));
  }
  if (Array.isArray(ev.point)) {
    const [x, y] = ev.point;
    const ring = svgEl("circle", { cx: x, cy: y, r: 9 * unit, fill: "rgba(255,255,255,0.25)", stroke: "#fff", "stroke-width": 2 * unit });
    const pulse = svgEl("circle", { cx: x, cy: y, r: 9 * unit, fill: "none", stroke: "#fff", "stroke-width": 1.5 * unit });
    pulse.append(svgEl("animate", { attributeName: "r", from: 9 * unit, to: 26 * unit, dur: "0.9s", repeatCount: "indefinite" }),
      svgEl("animate", { attributeName: "opacity", from: "0.9", to: "0", dur: "0.9s", repeatCount: "indefinite" }));
    svg.append(pulse, ring);
  }
  if (Array.isArray(ev.from) && Array.isArray(ev.to)) {
    const defs = svgEl("defs");
    const m = svgEl("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 6, refY: 5, markerWidth: 4, markerHeight: 4, orient: "auto-start-reverse" });
    m.append(svgEl("path", { d: "M0,0 L10,5 L0,10 z", fill: "#f5a524" }));
    defs.append(m);
    svg.append(defs, svgEl("line", { x1: ev.from[0], y1: ev.from[1], x2: ev.to[0], y2: ev.to[1], stroke: "#f5a524", "stroke-width": 6 * unit, "stroke-linecap": "round", "marker-end": "url(#arrow)" }),
      svgEl("circle", { cx: ev.from[0], cy: ev.from[1], r: 8 * unit, fill: "#f5a524" }));
  }
}

// ---------- timeline ----------

function renderTimeline() {
  const t = tr(), n = t.steps.length, px = S.zoom, last = endPos();
  const slots = last + 1;
  const width = slots * px + 40;
  const content = $("#tl-content");
  content.style.width = `${width}px`;
  const check = checkTrace(t);

  $("#ruler").replaceChildren(...Array.from({ length: slots }, (_, i) =>
    h("div", { class: "tick", style: `left:${i * px}px;width:${px}px`, title: i < n ? `Step ${t.steps[i].id}` : "After the last step" }, i < n ? String(i + 1) : "end")));

  // screens: one clip per run of steps that show the same screenshot
  const segs = [];
  for (let i = 0; i < slots; i++) {
    const s = shownScreen(i);
    const prev = segs[segs.length - 1];
    if (prev && prev.nn === s.nn) prev.to = i; else segs.push({ nn: s.nn, from: i, to: i });
  }
  $("#track-screens").replaceChildren(...segs.map((seg) => {
    const info = screenInfo(seg.nn);
    const url = info ? screenUrl(S.key, seg.nn) : null;
    return h("div", {
      class: "clip screen", style: `left:${seg.from * px + 2}px;width:${(seg.to - seg.from + 1) * px - 4}px;${url ? `background-image:url("${url}")` : ""}`,
      title: info ? `${screenTitle(info, seg.nn)} · screenshot ${seg.nn}` : "Launch", onclick: () => select(seg.from),
    }, h("span", {}, info ? screenTitle(info, seg.nn) : "Launch"));
  }));

  // actions
  const sel = cur();
  $("#track-actions").replaceChildren(...t.steps.map((step, i) => {
    const k = KINDS[step.action.kind] || { cls: "launch" };
    const bad = check.byStep[step.id];
    const clip = h("div", {
      class: `clip action ${k.cls}${i === sel ? " sel" : ""}${bad ? " invalid" : ""}`,
      style: `left:${i * px + 2}px;width:${px - 4}px`, title: `${step.id}: ${describe(step.action)}${step.intent ? `\n${step.intent}` : ""}${bad ? `\n⚠ ${bad.join("\n⚠ ")}` : ""}`,
      "data-i": i,
    }, h("span", { class: "t" }, describe(step.action)));
    clip.addEventListener("pointerdown", (e) => startDrag(e, clip, i));
    return clip;
  }), ...(last >= n ? [h("div", { class: "clip launch", style: `left:${n * px + 2}px;width:${px - 4}px;${sel === n ? "box-shadow:0 0 0 2px #fff inset" : ""}`, onclick: () => select(n) }, "Final screen")] : []));

  $("#track-checks").replaceChildren(...t.steps.flatMap((step, i) => (step.checkpoints || []).length
    ? [h("div", { class: `marker check${step.checkpoints.some((o) => o.observed === "failed") ? " bug" : ""}`, style: `left:${i * px + 4}px`, title: step.checkpoints.map(describeCheck).join("\n"), onclick: () => select(i) }, `✓ ${step.checkpoints.length}`)] : []));

  const notes = ws().notes;
  $("#track-notes").replaceChildren(...t.steps.flatMap((step, i) => {
    const list = (notes.steps[step.id] || []).filter((c) => !c.resolved);
    return list.length ? [h("div", { class: "marker note", style: `left:${i * px + 4}px`, title: list.map((c) => c.text).join("\n"), onclick: () => select(i) }, `✎ ${list.length}`)] : [];
  }), ...(notes.trace.filter((c) => !c.resolved).length && last >= n
    ? [h("div", { class: "marker note", style: `left:${n * px + 4}px`, onclick: () => select(n) }, `✎ ${notes.trace.filter((c) => !c.resolved).length}`)] : []));

  const issues = (persona().findings && persona().findings.issues) || [];
  const taken = [];
  $("#track-findings").replaceChildren(...issues.flatMap((iss) => {
    const set = new Set((iss.screens || []).map(String));
    const hit = [];
    for (let i = 0; i < slots; i++) if (set.has(String(shownScreen(i).nn)) && !shownScreen(i).inherited) hit.push(i);
    if (!hit.length) return [];
    let from = hit[0];
    while (taken.includes(from) && from < hit[hit.length - 1]) from++;
    taken.push(from);
    const span = Math.max(1, hit[hit.length - 1] - from + 1);
    return [h("div", { class: `marker finding sev-${iss.severity}`, style: `left:${from * px + 4}px;max-width:${span * px - 8}px`, title: `${iss.severity}: ${iss.title}`, onclick: () => select(from) }, iss.title)];
  }));

  const ph = $("#playhead");
  ph.style.left = `${sel * px + px / 2}px`;
  const scroll = $("#tl-scroll");
  const x = sel * px;
  if (x < scroll.scrollLeft || x + px > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 3);
}

function startDrag(e, clip, i) {
  if (e.button !== 0) return;
  const px = S.zoom, n = steps().length, x0 = e.clientX;
  let dragging = false, target = i, line = null;
  clip.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const dx = ev.clientX - x0;
    if (!dragging && Math.abs(dx) > 5 && i > 0) { dragging = true; clip.classList.add("dragging"); }
    if (!dragging) return;
    clip.style.transform = `translateX(${dx}px)`;
    target = Math.min(n - 1, Math.max(1, Math.round(i + dx / px)));
    if (!line) { line = h("div", { class: "drop-line" }); $("#track-actions").append(line); }
    line.style.left = `${(target > i ? target + 1 : target) * px - 1}px`;
  };
  const up = () => {
    clip.removeEventListener("pointermove", move);
    clip.removeEventListener("pointerup", up);
    clip.removeEventListener("pointercancel", up);
    if (line) line.remove();
    if (dragging && target !== i) {
      edit((w) => { const [s] = w.trace.steps.splice(i, 1); w.trace.steps.splice(target, 0, s); });
      select(target);
    } else { clip.style.transform = ""; clip.classList.remove("dragging"); select(i); }
  };
  clip.addEventListener("pointermove", move);
  clip.addEventListener("pointerup", up);
  clip.addEventListener("pointercancel", up);
}

function select(i) {
  S.sel[S.key] = Math.max(0, Math.min(i, endPos()));
  if (S.picking) stopPicking();
  render();
}

// ---------- inspector ----------

function renderTab() {
  for (const name of ["step", "flow", "report"]) {
    $(`#tab-${name}`).hidden = S.tab !== name;
    document.querySelector(`.tabs [data-tab=${name}]`).classList.toggle("on", S.tab === name);
  }
  if (S.tab === "step") renderStep();
  if (S.tab === "flow") renderFlow();
  if (S.tab === "report") renderReport();
}

function field(label, control, hint) {
  return h("label", { class: "field" }, h("span", {}, label), control, hint ? h("span", { class: "hint" }, hint) : null);
}
function select_(options, value, onchange, attrs = {}) {
  return h("select", { ...attrs, onchange: (e) => onchange(e.target.value) },
    ...options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
}

function textEditor(value, params, onchange, label) {
  const mode = isParam(value) ? "param" : "literal";
  const kids = [select_([["literal", "Text"], ...(params.length ? [["param", "Parameter"]] : [])], mode, (m) =>
    onchange(m === "param" ? { param: params[0] } : ""), { class: "fit", style: "width:110px" })];
  if (mode === "param") kids.push(select_(params.map((p) => [p, p]), value.param, (p) => onchange({ param: p })));
  else kids.push(h("input", { type: "text", value: value || "", oninput: (e) => onchange(e.target.value, true) }));
  return field(label, h("div", { class: "row" }, ...kids),
    mode === "param" ? "Its value is given at replay (-e NAME=...). The dashboard never shows typed texts." : null);
}

function selectorEditor(sel, params, onchange, allowPoint = true) {
  sel = sel || { text: "" };
  const mode = "id" in sel ? "id" : "point" in sel ? "point" : "text";
  const modes = [["text", "By name"], ["id", "By id"], ...(allowPoint ? [["point", "By position"]] : [])];
  const box = h("div", {});
  box.append(field("Find the element", select_(modes, mode, (m) => {
    const keep = Number.isInteger(sel.index) && m !== "point" ? { index: sel.index } : {};
    onchange(m === "id" ? { id: "", ...keep } : m === "point" ? { point: "50%,50%" } : { text: "", ...keep });
  }), mode === "point" ? "A position breaks on another screen size. Prefer a name or an id." : null));
  if (mode === "text") box.append(textEditor(sel.text, params, (v, typing) => onchange({ ...sel, text: v }, typing), "Name shown on screen"));
  if (mode === "id") box.append(field("Resource id", h("input", { type: "text", value: sel.id, oninput: (e) => onchange({ ...sel, id: e.target.value }, true) })));
  if (mode === "point") box.append(field("Position (x%,y%)", h("input", { type: "text", value: sel.point, oninput: (e) => onchange({ point: e.target.value }, true) })));
  if (mode !== "point") box.append(field("Index, when several elements share it", h("input", {
    type: "number", min: 0, value: Number.isInteger(sel.index) ? sel.index : "", placeholder: "only one",
    oninput: (e) => { const v = e.target.value === "" ? undefined : Number(e.target.value); const next = { ...sel }; if (v === undefined) delete next.index; else next.index = v; onchange(next, true); },
  })));
  return box;
}

function elementSelector(el, elements, allowPoint, size) {
  if (el.label && !el.label.includes("${") && el.label.length <= 80 && !el.label.includes("\n")) {
    const same = elements.filter((e) => e.label === el.label);
    return same.length > 1 ? { text: el.label, index: same.indexOf(el) } : { text: el.label };
  }
  if (el.id) {
    const same = elements.filter((e) => e.id === el.id);
    return same.length > 1 ? { id: el.id, index: same.indexOf(el) } : { id: el.id };
  }
  if (!allowPoint) return null;
  const [x1, y1, x2, y2] = el.bounds;
  return { point: `${Math.round(50 * (x1 + x2) / size[0])}%,${Math.round(50 * (y1 + y2) / size[1])}%` };
}

function startPicking(apply, allowPoint) {
  const info = screenInfo(shownScreen(cur()).nn);
  if (!info || !info.elements.length) { flash("No screen tree for this screenshot: type the name instead.", true); return; }
  S.picking = { apply, allowPoint };
  $("#phone").classList.add("pick");
  $("#picking").hidden = false;
  renderPreview();
}
function stopPicking() {
  S.picking = null;
  $("#phone").classList.remove("pick");
  $("#picking").hidden = true;
}

function renderStep() {
  const box = $("#tab-step");
  const t = tr(), i = cur(), n = t.steps.length;
  const params = (t.params || []).map((p) => p.name);
  box.replaceChildren();
  if (i >= n) {
    box.append(h("div", { class: "step-head" }, h("span", { class: "kind k-launch" }, "Final screen")),
      h("p", { class: "hint" }, "What the app showed after the last step. Comments here are about the whole path."),
      commentsBox(null));
    return;
  }
  const step = t.steps[i];
  const k = KINDS[step.action.kind] || { cls: "launch", label: step.action.kind };
  const errors = (checkTrace(t).byStep[step.id] || []).concat(i === 0 ? checkTrace(t).global : []);
  const set = (fn, typing) => edit((w) => fn(w.trace.steps[i]), typing ? { coalesce: `${step.id}:${typing}`, inspector: false } : {});

  box.append(h("div", { class: "step-head" }, h("span", { class: `kind k-${k.cls}` }, k.label), h("span", { class: "id" }, step.id), h("span", { class: "hint", style: "margin:0 0 0 auto" }, `Step ${i + 1} of ${n}`)));
  if (errors.length) box.append(h("div", { class: "errors" }, h("strong", {}, "Not valid yet"), h("ul", {}, ...errors.map((e) => h("li", {}, e)))));

  box.append(field("Intent: why the persona did this", h("textarea", {
    rows: 2, placeholder: "Why this step? For example: looks for the sign-up form", oninput: (e) => set((s) => { if (e.target.value) s.intent = e.target.value; else delete s.intent; }, "intent"),
  }, step.intent || ""), "Kept in the flow as a comment. Never used to replay."));

  const action = step.action;
  const actionBox = h("div", { class: "box" }, h("h3", {}, "Action"));
  if (i > 0) {
    actionBox.append(field("Kind", select_(Object.entries(KINDS).filter(([kk]) => kk !== "launchApp").map(([kk, v]) => [kk, v.label]), action.kind, (kind) =>
      set((s) => { s.action = defaultAction(kind, s.action); }))));
  }
  const setAction = (patch, typing) => set((s) => { Object.assign(s.action, patch); for (const key of Object.keys(patch)) if (patch[key] === undefined) delete s.action[key]; }, typing ? "action" : false);
  switch (action.kind) {
    case "launchApp":
      actionBox.append(field("App id", h("input", { type: "text", value: action.appId, oninput: (e) => setAction({ appId: e.target.value }, true) })),
        h("label", { class: "row", style: "gap:8px" }, h("input", { type: "checkbox", class: "fit", checked: !!action.clearState, onchange: (e) => setAction({ clearState: e.target.checked }) }), "Start from a clean state (clears the app's data)"));
      break;
    case "tapOn": case "longPressOn": case "scrollUntilVisible": {
      const allowPoint = action.kind !== "scrollUntilVisible";
      actionBox.append(selectorEditor(action.target, params, (target, typing) => setAction({ target }, typing), allowPoint),
        h("button", { onclick: () => startPicking((el, info, size) => { const s = elementSelector(el, info.elements, allowPoint, size); if (s) setAction({ target: s }); }, allowPoint) }, "Pick on the screen"));
      if (action.kind === "scrollUntilVisible") actionBox.append(field("Direction", select_([["", "Default (down)"], ...DIRECTIONS.map((d) => [d, d.toLowerCase()])], action.direction || "", (d) => setAction({ direction: d || undefined }))));
      break;
    }
    case "inputText": actionBox.append(textEditor(action.text, params, (text, typing) => setAction({ text }, typing), "Text")); break;
    case "eraseText": actionBox.append(field("Characters to erase", h("input", { type: "number", min: 1, value: action.characters || "", placeholder: "all (Maestro default)", oninput: (e) => setAction({ characters: e.target.value ? Number(e.target.value) : undefined }, true) }))); break;
    case "pressKey": actionBox.append(field("Key", select_(KEYS.map((kk) => [kk, kk]), action.key, (key) => setAction({ key })))); break;
    case "swipe": actionBox.append(field("Direction", select_(DIRECTIONS.map((d) => [d, d.toLowerCase()]), action.direction, (direction) => setAction({ direction })))); break;
  }
  box.append(actionBox);

  // checks
  const checks = step.checkpoints || [];
  const checkBox = h("div", { class: "box" }, h("h3", {}, "Checks after this step", h("span", { class: "hint", style: "margin:0" }, "assertVisible / assertNotVisible")));
  checkBox.append(h("ul", { class: "list" }, ...checks.map((o, j) => h("li", {},
    h("span", { class: "grow" }, describeCheck(o), h("span", { class: "when" }, o.id)),
    h("button", { title: o.observed === "failed" ? "The bug is fixed: keep this check as a guard" : "This check was false while exploring: it records a bug, and the flow stays red until it is fixed",
      onclick: () => set((s) => { if (o.observed === "failed") delete s.checkpoints[j].observed; else s.checkpoints[j].observed = "failed"; }) }, o.observed === "failed" ? "Fixed" : "Is a bug"),
    h("button", { title: "Visible / not visible", onclick: () => set((s) => { s.checkpoints[j].check.kind = o.check.kind === "visible" ? "notVisible" : "visible"; }) }, "Flip"),
    h("button", { class: "danger", onclick: () => set((s) => { s.checkpoints.splice(j, 1); }) }, "Remove")))));
  if (!checks.length) checkBox.append(h("p", { class: "hint" }, "No check: replayed, this step only fails when its target is gone. A check turns the path into a test of what the tester saw."));
  checkBox.append(h("p", { class: "hint" }, "A finding becomes a test: say what should (or should not) be on screen, then mark it “Is a bug”. The flow fails until the bug is fixed, then the check stays as a guard."));
  checkBox.append(h("div", { class: "row" },
    h("button", { onclick: () => {
      const after = shownScreen(i + 1);
      if (after.nn && after.nn !== shownScreen(i).nn) select(i + 1 <= endPos() ? i + 1 : i);
      startPicking((el, info) => { const target = elementSelector(el, info.elements, false); if (target) edit((w) => addCheck(w.trace, i, target)); select(i); }, false);
    } }, "Pick what must be visible"),
    h("button", { onclick: () => edit((w) => addCheck(w.trace, i, { text: "" })) }, "Add by name")));
  if (checks.length) checks.forEach((o, j) => checkBox.append(h("details", {}, h("summary", { class: "hint" }, `Edit ${o.id}`),
    selectorEditor(o.check.target, params, (target, typing) => set((s) => { s.checkpoints[j].check.target = target; }, typing ? `check${j}` : false), false))));
  box.append(checkBox);

  box.append(commentsBox(step.id));

  const ev = step.evidence;
  box.append(h("div", { class: "box" }, h("h3", {}, "Seen while exploring"),
    ev ? h("p", { class: "hint", style: "margin:0" }, [
      ev.screen ? `Screenshot ${ev.screen}` : null,
      Array.isArray(ev.point) ? `finger at ${ev.point.join(", ")}` : null,
      Array.isArray(ev.from) ? `swipe ${ev.from.join(",")} → ${ev.to.join(",")}` : null,
      Array.isArray(ev.size) ? `screen ${ev.size.join("×")}` : null].filter(Boolean).join(" · ") + ". Kept as explored: ECR never uses it to replay.")
      : h("p", { class: "hint", style: "margin:0" }, i === 0 ? "The app was launched." : "Added by hand: nothing was seen.")));

  if (i > 0) box.append(h("div", { class: "row" },
    h("button", { onclick: () => duplicateStep(i) }, "Duplicate"),
    h("button", { onclick: () => insertStep(i) }, "Add after"),
    h("button", { class: "danger", onclick: () => deleteStep(i) }, "Delete")));
}

/** A comment says what is wrong after a step. Pick the element that should not be there (an error, a button
 * under the keyboard): it becomes a "not visible" check marked as a known bug, red until the bug is fixed.
 * For something missing from the screen, flip it to "visible" and type its name. */
function commentToCheck(stepId) {
  const i = steps().findIndex((st) => st.id === stepId);
  if (i < 0) return;
  const after = shownScreen(i + 1);
  if (after.nn && after.nn !== shownScreen(i).nn && i + 1 <= endPos()) select(i + 1);
  startPicking((el, info) => {
    const target = elementSelector(el, info.elements, false);
    if (target) edit((w) => { addCheck(w.trace, i, target); const o = w.trace.steps[i].checkpoints[w.trace.steps[i].checkpoints.length - 1]; o.check.kind = "notVisible"; o.observed = "failed"; });
    select(i);
  }, false);
}

function describeCheck(o) {
  return `${o.observed === "failed" ? "Known bug · " : ""}${o.check.kind === "visible" ? "Visible" : "Not visible"}: ${describeSelector(o.check.target)}`;
}

function addCheck(trace, i, target) {
  const step = trace.steps[i];
  step.checkpoints = step.checkpoints || [];
  const used = new Set(trace.steps.flatMap((s) => (s.checkpoints || []).map((o) => o.id)));
  let k = 1; while (used.has(`${step.id}-check${k}`)) k++;
  step.checkpoints.push({ id: `${step.id}-check${k}`, check: { kind: "visible", target } });
}

function defaultAction(kind, prev) {
  const target = prev && prev.target ? clone(prev.target) : { text: "" };
  switch (kind) {
    case "tapOn": case "longPressOn": return { kind, target };
    case "scrollUntilVisible": return { kind, target: "point" in target ? { text: "" } : target };
    case "inputText": return { kind, text: "" };
    case "eraseText": return { kind };
    case "pressKey": return { kind, key: "Back" };
    case "swipe": return { kind, direction: "UP" };
    default: return { kind };
  }
}

function newId(trace) {
  const used = new Set(trace.steps.map((s) => s.id));
  let k = trace.steps.length + 1;
  while (used.has(`s${k}`)) k++;
  return `s${k}`;
}
function insertStep(i) {
  edit((w) => { w.trace.steps.splice(i + 1, 0, { id: newId(w.trace), action: { kind: "tapOn", target: { text: "" } }, checkpoints: [] }); });
  select(i + 1);
  startPicking((el, info, size) => { const s = elementSelector(el, info.elements, true, size); if (s) edit((w) => { w.trace.steps[i + 1].action.target = s; }); }, true);
}
function duplicateStep(i) {
  if (i === 0) return;
  edit((w) => { const copy = clone(w.trace.steps[i]); copy.id = newId(w.trace); delete copy.evidence; copy.checkpoints = []; w.trace.steps.splice(i + 1, 0, copy); });
  select(i + 1);
}
function deleteStep(i) {
  if (i === 0 || i >= steps().length) return;
  edit((w) => { const [s] = w.trace.steps.splice(i, 1); delete w.notes.steps[s.id]; });
  select(Math.min(i, steps().length - 1));
}

function commentsBox(stepId) {
  const w = ws();
  const list = stepId ? w.notes.steps[stepId] || [] : w.notes.trace;
  const mutate = (fn) => edit((ww) => {
    if (stepId) { ww.notes.steps[stepId] = ww.notes.steps[stepId] || []; fn(ww.notes.steps[stepId]); if (!ww.notes.steps[stepId].length) delete ww.notes.steps[stepId]; }
    else fn(ww.notes.trace);
  });
  const input = h("textarea", { rows: 2, placeholder: "What should change here? (Ctrl+Enter)" });
  const add = () => {
    const text = input.value.trim();
    if (!text) return;
    mutate((l) => l.push({ id: `c${Date.now().toString(36)}`, text, at: new Date().toISOString(), resolved: false }));
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); } });
  return h("div", { class: "box" }, h("h3", {}, "Comments", h("span", { class: "hint", style: "margin:0" }, "saved in trace.notes.json")),
    h("ul", { class: "list" }, ...list.map((c, j) => h("li", { class: c.resolved ? "resolved" : "" },
      h("span", { class: "grow" }, c.text, h("span", { class: "when" }, new Date(c.at).toLocaleString())),
      stepId ? h("button", { title: "Pick what should have been on screen: it becomes a check marked as a known bug", onclick: () => commentToCheck(stepId) }, "Make a test") : null,
      h("button", { onclick: () => mutate((l) => { l[j].resolved = !l[j].resolved; }) }, c.resolved ? "Reopen" : "Resolve"),
      h("button", { class: "danger", onclick: () => mutate((l) => l.splice(j, 1)) }, "Delete")))),
    input, h("div", { class: "row", style: "margin-top:6px" }, h("span"), h("button", { class: "fit", onclick: add }, "Comment")));
}

async function renderFlow() {
  const box = $("#tab-flow");
  const t = tr();
  const check = checkTrace(t);
  const token = (S.flowToken = (S.flowToken || 0) + 1);
  if (check.count) {
    box.replaceChildren(h("div", { class: "errors" }, `Fix the ${check.count} problem${check.count > 1 ? "s" : ""} shown in red on the timeline to compile this path.`));
    return;
  }
  const flow = await compileFlow(t);
  if (token !== S.flowToken) return;
  const step = t.steps[cur()];
  const range = step ? flow.map[step.id] : null;
  const pre = h("pre", { class: "flow" }, ...flow.text.split("\n").slice(0, -1).map((line, j) =>
    h("span", { class: `${range && j + 1 >= range[0] && j + 1 <= range[1] ? "hl" : ""}${line.startsWith("#") ? " c" : ""}` }, line || " ")));
  const bar = h("div", { class: "flow-bar" },
    h("button", { onclick: () => navigator.clipboard && navigator.clipboard.writeText(flow.text).then(() => flash("Flow copied")) }, "Copy"),
    h("button", { onclick: () => download(flow.file, flow.text) }, "Download"),
    S.data.ecr ? h("button", { class: "primary", onclick: () => compileWithEcr(flow.text) }, "Compile with ECR") : null);
  const note = h("p", { class: "hint" }, S.data.ecr
    ? "Preview compiled in the page. “Compile with ECR” runs the real command and compares."
    : "Preview compiled in the page, as ECR's Maestro adapter does. Start the dashboard with --ecr <clone> to check it with the real command.");
  box.replaceChildren(bar, note);
  if (S.ecrFlow) box.append(h("p", { class: S.ecrFlow.ok ? "hint" : "errors" }, S.ecrFlow.message));
  box.append(pre);
  const hl = pre.querySelector(".hl");
  if (hl) hl.scrollIntoView({ block: "center" });
}

async function compileWithEcr(preview) {
  const res = await post("/api/compile", tr());
  if (!res.ok) S.ecrFlow = { ok: false, message: (res.body.problems || [res.body.output]).join("\n") };
  else S.ecrFlow = { ok: true, message: res.body.output === preview ? "ECR compiled it: same flow as the preview." : "ECR compiled it, and its flow differs from the preview: trust ECR's." };
  renderFlow();
}

function renderReport() {
  const p = persona();
  const box = $("#tab-report");
  box.replaceChildren();
  if (!p.report) { box.append(h("p", { class: "hint" }, "No report.md for this tester.")); return; }
  const out = h("div", { class: "report" });
  let list = null;
  const inline = (text) => {
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((s) => s.startsWith("**") && s.endsWith("**") ? h("strong", {}, s.slice(2, -2)) : s.startsWith("`") && s.endsWith("`") ? h("code", {}, s.slice(1, -1)) : s);
  };
  for (const raw of p.report.split("\n")) {
    const line = raw.trimEnd();
    const m = line.match(/^(#{1,3})\s+(.*)/);
    if (!/^\s*[-*]\s+/.test(line)) list = null;
    if (m) out.append(h(`h${m[1].length}`, {}, ...inline(m[2])));
    else if (/^\s*[-*]\s+/.test(line)) { if (!list) { list = h("ul"); out.append(list); } list.append(h("li", {}, ...inline(line.replace(/^\s*[-*]\s+/, "")))); }
    else if (line) out.append(h("p", {}, ...inline(line)));
  }
  box.append(out);
}

// ---------- saving ----------

async function post(url, body) {
  try {
    const r = await fetch(`${url}?persona=${encodeURIComponent(S.key)}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Dashboard": "1" }, body: JSON.stringify(body) });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, status: 0, body: { problems: ["The dashboard server does not answer. Is it still running?"] } };
  }
}

async function save() {
  const keys = S.data.personas.map((p) => p.key).filter((k) => S.ws[k] && dirty(S.ws[k]));
  const back = S.key;
  for (const key of keys) {
    S.key = key;
    const w = ws(key);
    const saved = JSON.parse(w.saved);
    const check = checkTrace(w.trace);
    if (check.count) { S.key = back; return flash(`${persona(key).trace.persona.id}: fix ${check.count} problem${check.count > 1 ? "s" : ""} before saving`, true); }
    if (JSON.stringify(saved.trace) !== JSON.stringify(w.trace)) {
      const r = await post("/api/trace", w.trace);
      if (!r.ok) { S.key = back; return flash((r.body.problems || ["Not saved"]).join(" "), true); }
      persona(key).trace = clone(w.trace);
      persona(key).edited = true;
    }
    if (JSON.stringify(saved.notes) !== JSON.stringify(w.notes)) {
      const r = await post("/api/notes", w.notes);
      if (!r.ok) { S.key = back; return flash("Comments not saved", true); }
      persona(key).notes = clone(w.notes);
    }
    w.saved = snapshot(w);
  }
  S.key = back;
  $("#status").dataset.saved = `Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${S.data.ecr ? " · checked by ECR" : ""}`;
  flash($("#status").dataset.saved);
}

function flash(text, error = false) {
  const st = $("#status");
  st.className = `status${error ? " error" : ""}`;
  st.textContent = text;
  renderTop();
  if (error) setTimeout(() => { st.classList.remove("error"); renderTop(); }, 6000);
}

function download(name, text) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/yaml" })), download: name });
  document.body.append(a); a.click(); a.remove();
}

// ---------- playback and controls ----------

function play(on = !S.playing) {
  S.playing = on;
  clearInterval(S.timer);
  $("#play").textContent = on ? "❚❚" : "▶";
  $("#play").setAttribute("aria-label", on ? "Pause" : "Play");
  if (!on) return;
  if (cur() >= endPos()) select(0);
  S.timer = setInterval(() => { if (cur() >= endPos()) play(false); else select(cur() + 1); }, 1100 / S.speed);
}

function selectPersona(key) {
  if (S.picking) stopPicking();
  S.key = key;
  ws(key);
  S.ecrFlow = null;
  render();
}

function wire() {
  $("#first").onclick = () => select(0);
  $("#prev").onclick = () => select(cur() - 1);
  $("#next").onclick = () => select(cur() + 1);
  $("#last").onclick = () => select(endPos());
  $("#play").onclick = () => play();
  $("#speed").onchange = (e) => { S.speed = Number(e.target.value); if (S.playing) play(true); };
  for (const b of document.querySelectorAll("[data-heat]")) b.onclick = () => { S.heat = b.dataset.heat; heatButtons(); renderPreview(); };
  heatButtons();
  for (const b of document.querySelectorAll("[data-tab]")) b.onclick = () => { S.tab = b.dataset.tab; render(); };
  $("#zoom").oninput = (e) => { S.zoom = Number(e.target.value); renderTimeline(); };
  $("#undo").onclick = () => undoRedo("undo", "redo");
  $("#redo").onclick = () => undoRedo("redo", "undo");
  $("#save").onclick = save;
  $("#add-step").onclick = () => insertStep(Math.min(cur(), steps().length - 1));
  $("#dup-step").onclick = () => duplicateStep(cur());
  $("#del-step").onclick = () => deleteStep(cur());

  const ruler = $("#ruler");
  const scrub = (e) => { const x = e.clientX - ruler.getBoundingClientRect().left; select(Math.floor(x / S.zoom)); };
  ruler.addEventListener("pointerdown", (e) => { ruler.setPointerCapture(e.pointerId); scrub(e); ruler.onpointermove = scrub; });
  ruler.addEventListener("pointerup", () => { ruler.onpointermove = null; });

  const overlay = $("#overlay");
  const pointAt = (e) => {
    const r = overlay.getBoundingClientRect();
    const vb = overlay.viewBox.baseVal;
    return [(e.clientX - r.left) / r.width * vb.width, (e.clientY - r.top) / r.height * vb.height, [vb.width, vb.height]];
  };
  const hit = (e) => {
    const info = screenInfo(shownScreen(cur()).nn);
    if (!info) return null;
    const [x, y] = pointAt(e);
    const under = info.elements.filter((el) => el.bounds[0] <= x && x <= el.bounds[2] && el.bounds[1] <= y && y <= el.bounds[3]);
    under.sort((a, b) => (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) - (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]));
    const named = under.filter((el) => el.label || el.id);
    return named.length ? { el: named[0], info } : null;
  };
  overlay.addEventListener("pointermove", (e) => {
    if (!S.picking) return;
    const found = hit(e);
    for (const r of overlay.querySelectorAll(".pick-el")) r.setAttribute("fill", "rgba(79,140,255,0.06)");
    if (found) {
      const idx = found.info.elements.indexOf(found.el);
      const r = overlay.querySelectorAll(".pick-el")[idx];
      if (r) r.setAttribute("fill", "rgba(79,140,255,0.35)");
      overlay.setAttribute("aria-label", found.el.label || found.el.id);
      $("#picking").textContent = `Pick “${found.el.label || found.el.id}”`;
    }
  });
  overlay.addEventListener("click", (e) => {
    if (!S.picking) return;
    const found = hit(e);
    if (!found) return;
    const { apply } = S.picking;
    stopPicking();
    apply(found.el, found.info, pointAt(e)[2]);
  });

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
    if (typing) { if (e.key === "Escape") e.target.blur(); return; }
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); undoRedo(e.shiftKey ? "redo" : "undo", e.shiftKey ? "undo" : "redo"); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); undoRedo("redo", "undo"); return; }
    if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateStep(cur()); return; }
    if (e.key === "Escape" && S.picking) { stopPicking(); renderPreview(); return; }
    if (e.key === " ") { e.preventDefault(); play(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); select(cur() + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); select(cur() - 1); }
    else if (e.key === "Home") select(0);
    else if (e.key === "End") select(endPos());
    else if (e.key === "Delete" || e.key === "Backspace") deleteStep(cur());
  });
  window.addEventListener("resize", () => renderPreview());
  window.addEventListener("beforeunload", (e) => {
    if (S.data && S.data.personas.some((p) => S.ws[p.key] && dirty(S.ws[p.key]))) { e.preventDefault(); e.returnValue = ""; }
  });
}

function heatButtons() {
  for (const b of document.querySelectorAll("[data-heat]")) b.setAttribute("aria-checked", String(b.dataset.heat === S.heat));
}

async function start() {
  try {
    const r = await fetch("/api/run");
    S.data = await r.json();
  } catch (e) {
    $("#loading").textContent = "Could not read the run. Is the dashboard server running?";
    return;
  }
  if (!S.data.personas.length) { $("#loading").textContent = "No trace.json in this run."; return; }
  $("#run-name").textContent = S.data.run;
  document.title = `Tester paths · ${S.data.run}`;
  S.key = S.data.personas[0].key;
  wire();
  render();
  $("#loading").hidden = true;
}

start();
