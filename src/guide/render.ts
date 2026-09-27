// Renders a build guide as one self-contained, offline HTML page (no external requests).

import type { TreeNode } from "../data/types.js";
import { stripMarkup } from "../text.js";
import { nodeKind } from "../tree/tree.js";

export interface GuideSkill {
  name: string;
  availableFromLevel?: number;
  note?: string;
  supports: { name: string; tier: number; note?: string }[];
}

export interface GuideGear {
  slot: string;
  priorities: string[];
  note?: string;
}

export interface GuidePassive {
  name: string;
  kind: string;
  stats: string[];
  level?: number;
}

export interface GuidePhase {
  name: string;
  levels: [number, number];
  summary?: string;
  assessment?: string;
  skills: GuideSkill[];
  /** Notables, keystones and jewel sockets first taken in this phase. */
  keyPassives: GuidePassive[];
  pointsUsed: number;
  pointsAvailable: number;
  ascendancy: GuidePassive[];
  gear: GuideGear[];
  checklist: string[];
  switchNote?: string;
  checkWarnings: string[];
  questRewards: string[];
  buildFile?: string;
}

export interface GuideModel {
  name: string;
  className: string;
  ascendancyName?: string;
  leagueStart: boolean;
  summary: string;
  playstyle?: string;
  strengths: string[];
  weaknesses: string[];
  phases: GuidePhase[];
  notes: string[];
  generatedAt: string;
  toolVersion: string;
  /** Tree nodes to draw, with the index of the first phase that allocates each (undefined = not taken). */
  tree: { key: string; node: TreeNode; phase?: number }[];
  ascendancyTree: { key: string; node: TreeNode; phase?: number }[];
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const para = (s?: string) => (s ? s.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("") : "");
const list = (items: string[], cls = "") => (items.length ? `<ul class="${cls}">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");

const RADIUS: Record<string, number> = { keystone: 70, notable: 48, "ascendancy-notable": 60, "jewel-socket": 48 };

/** Draw a set of tree nodes and the links between them as SVG; allocated nodes get phase classes. */
function treeSvg(nodes: GuideModel["tree"], label: string): string {
  if (nodes.length === 0) return "";
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const xs = nodes.map((n) => n.node.x!);
  const ys = nodes.map((n) => n.node.y!);
  const pad = 150;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) - minX + pad;
  const h = Math.max(...ys) - minY + pad;
  const r = (v: number) => Math.round(v);

  // Untaken links and small nodes are drawn as one path each (thousands of separate elements
  // make the page slow to draw); taken, notable and keystone nodes stay separate for styling and hover.
  let backgroundEdges = "";
  const takenEdges: string[] = [];
  const seen = new Set<string>();
  for (const { key, node, phase } of nodes) {
    for (const other of node.out ?? []) {
      const o = byKey.get(other);
      if (!o) continue;
      const id = key < other ? `${key}-${other}` : `${other}-${key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const segment = `M${r(node.x!)} ${r(node.y!)}L${r(o.node.x!)} ${r(o.node.y!)}`;
      if (phase !== undefined && o.phase !== undefined) {
        takenEdges.push(`<path class="e a${Math.max(phase, o.phase)}" d="${segment}"/>`);
      } else {
        backgroundEdges += segment;
      }
    }
  }

  let backgroundNodes = "";
  const shownNodes: string[] = [];
  for (const { node, phase } of nodes) {
    const kind = nodeKind(node);
    const radius = RADIUS[kind] ?? 26;
    const x = r(node.x!);
    const y = r(node.y!);
    const important = kind === "keystone" || kind === "notable" || kind === "ascendancy-notable" || kind === "jewel-socket";
    if (phase === undefined && !important) {
      backgroundNodes += `M${x - radius} ${y}a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0`;
      continue;
    }
    const cls = `n k-${kind}${phase !== undefined ? ` a${phase}` : ""}`;
    const title = esc([node.name ?? "", ...(node.stats ?? []).map(stripMarkup)].join("\n"));
    shownNodes.push(`<circle class="${cls}" cx="${x}" cy="${y}" r="${radius}"><title>${title}</title></circle>`);
  }

  return `<svg class="tree" viewBox="${r(minX)} ${r(minY)} ${r(w)} ${r(h)}" role="img" aria-label="${esc(label)}"><path class="e" d="${backgroundEdges}"/>${takenEdges.join("")}<path class="n" d="${backgroundNodes}"/>${shownNodes.join("")}</svg>`;
}

function phaseCss(count: number): string {
  // With phase i selected, everything allocated in phases 0..i is lit; phase i itself is brightest.
  const rules: string[] = [];
  for (let i = 0; i < count; i++) {
    const earlier = Array.from({ length: i }, (_, j) => `[data-phase="${i}"] .a${j}`).join(",");
    if (earlier) rules.push(`${earlier}{fill:var(--taken);stroke:var(--taken)}`);
    rules.push(`[data-phase="${i}"] .a${i}{fill:var(--new);stroke:var(--new)}`);
  }
  return rules.join("\n");
}

function phaseHtml(p: GuidePhase, i: number): string {
  const skills = p.skills
    .map(
      (s) => `<div class="skill"><div class="skill-head"><span class="gem">${esc(s.name)}</span>${
        s.availableFromLevel !== undefined ? `<span class="tag">from level ${s.availableFromLevel}</span>` : ""
      }</div>${s.note ? `<div class="muted">${esc(s.note)}</div>` : ""}${
        s.supports.length
          ? `<ol class="supports">${s.supports
              .map((sup) => `<li><span class="support">${esc(sup.name)}</span>${sup.note ? ` <span class="muted">— ${esc(sup.note)}</span>` : ""}</li>`)
              .join("")}</ol>`
          : ""
      }</div>`,
    )
    .join("");
  const passives = p.keyPassives
    .map(
      (n) =>
        `<li><span class="pname k-${esc(n.kind)}">${esc(n.name)}</span>${n.level ? ` <span class="tag">level ${n.level}</span>` : ""}<div class="muted small">${esc(n.stats.join(" · "))}</div></li>`,
    )
    .join("");
  const asc = p.ascendancy.map((n) => `<li><span class="pname">${esc(n.name)}</span><div class="muted small">${esc(n.stats.join(" · "))}</div></li>`).join("");
  const gear = p.gear
    .map((g) => `<tr><th>${esc(g.slot)}</th><td><ol>${g.priorities.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>${g.note ? `<div class="muted small">${esc(g.note)}</div>` : ""}</td></tr>`)
    .join("");
  const checks = p.checkWarnings.length
    ? `<div class="callout warn"><strong>Checks at level ${p.levels[1]}</strong>${list(p.checkWarnings)}</div>`
    : `<div class="callout ok"><strong>Checks at level ${p.levels[1]}:</strong> skills available, attributes, Spirit and passive points all fit.</div>`;

  return `<section class="phase" id="phase-${i}" ${i === 0 ? "" : "hidden"}>
  <div class="phase-head"><h2>${esc(p.name)}</h2><span class="levels">Levels ${p.levels[0]}–${p.levels[1]}</span>${
    p.buildFile ? `<a class="button" href="${encodeURI(p.buildFile)}" download>Download Build Planner file</a>` : ""
  }</div>
  ${para(p.summary)}
  ${p.assessment ? `<div class="callout assess"><strong>Viability:</strong> ${esc(p.assessment)}</div>` : ""}
  ${checks}
  <div class="grid">
    <div class="card"><h3>Skills &amp; supports</h3>${skills || '<p class="muted">No changes this phase.</p>'}</div>
    <div class="card"><h3>Key passives <span class="muted small">(${p.pointsUsed}/${p.pointsAvailable} points)</span></h3>${passives ? `<ul class="plain">${passives}</ul>` : '<p class="muted">Small passives only this phase.</p>'}${asc ? `<h3>Ascendancy</h3><ul class="plain">${asc}</ul>` : ""}</div>
  </div>
  ${gear ? `<div class="card"><h3>Gear to look for</h3><table class="gear">${gear}</table></div>` : ""}
  <div class="grid">
    ${p.questRewards.length ? `<div class="card"><h3>Quest rewards this phase</h3>${list(p.questRewards)}</div>` : ""}
    ${p.checklist.length ? `<div class="card"><h3>Before moving on</h3>${list(p.checklist, "checks")}</div>` : ""}
  </div>
  ${p.switchNote ? `<div class="callout switch"><strong>When to switch:</strong> ${esc(p.switchNote)}</div>` : ""}
</section>`;
}

export function renderGuide(m: GuideModel): string {
  const tabs = m.phases
    .map((p, i) => `<button role="tab" data-i="${i}" aria-selected="${i === 0}">${esc(p.name)}<span>${p.levels[0]}–${p.levels[1]}</span></button>`)
    .join("");
  const title = `${m.name} — ${m.ascendancyName ?? m.className}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--panel2:#1e222b;--text:#e6e1d6;--muted:#9a978f;--accent:#d8a44a;--new:#f0b54a;--taken:#8a6a2e;--line:#2b303a;--warn:#e07b53;--ok:#6fbf73;--blue:#6ea8fe}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:28px 16px 12px;max-width:1150px;margin:auto}h1{margin:0;font-size:28px}h1 small{color:var(--accent);font-weight:600;font-size:16px;margin-left:8px}
.badges{margin-top:8px;display:flex;gap:8px;flex-wrap:wrap}.badge{background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:13px}
main{max-width:1150px;margin:auto;padding:0 16px 40px}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0;min-width:0}
h2{margin:0;font-size:22px}h3{margin:0 0 8px;font-size:16px;color:var(--accent)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.tabs{display:flex;gap:6px;overflow-x:auto;padding:4px 0;position:sticky;top:0;background:var(--bg);z-index:2;border-bottom:1px solid var(--line)}
.tabs button{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 12px;cursor:pointer;white-space:nowrap;font:inherit}
.tabs button span{display:block;font-size:12px;color:var(--muted)}.tabs button[aria-selected=true]{border-color:var(--accent);background:var(--panel2)}
.phase-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:16px 0 4px}.levels{color:var(--muted)}
.button{margin-left:auto;background:var(--accent);color:#1a1405;text-decoration:none;padding:6px 12px;border-radius:8px;font-weight:600}
.callout{border-left:4px solid var(--blue);background:var(--panel);padding:10px 14px;border-radius:6px;margin:10px 0}.callout ul{margin:6px 0 0}
.callout.warn{border-color:var(--warn)}.callout.ok{border-color:var(--ok)}.callout.switch{border-color:var(--accent)}
.skill{padding:8px 0;border-bottom:1px solid var(--line)}.skill:last-child{border:0}.skill-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.gem{font-weight:700;color:var(--blue)}.support{color:#9fd49f}.supports{margin:6px 0 0;padding-left:22px}
.tag{font-size:12px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:0 6px;color:var(--muted)}
.muted{color:var(--muted)}.small{font-size:13px}ul.plain{list-style:none;padding:0;margin:0}ul.plain li{padding:6px 0;border-bottom:1px solid var(--line)}
.pname{font-weight:600}.pname.k-keystone{color:#ff9d7a}.gear{width:100%;border-collapse:collapse}.gear th{text-align:left;vertical-align:top;width:140px;padding:8px 8px 8px 0;color:var(--accent);font-weight:600}
.gear td{padding:8px 0;border-bottom:1px solid var(--line)}.gear ol{margin:0;padding-left:20px}ul.checks{padding-left:20px}
.treewrap{position:relative;height:620px;overflow:hidden;background:#0b0d10;border:1px solid var(--line);border-radius:10px;cursor:grab;touch-action:none}
.treewrap svg{width:100%;height:100%}.tree .e{stroke:#343a45;stroke-width:14}.tree .n{fill:#2a2f38;stroke:#3a404b;stroke-width:6}
.tree .k-notable{fill:#2c3038}.tree .k-keystone{fill:#3a3027}.tree .e{fill:none}.tree path.e[class*=" a"]{stroke-width:24}
.tree .n[class*=" a"]{stroke-width:10}.zoom{position:absolute;right:10px;top:10px;display:flex;gap:6px;z-index:1}
.zoom button{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;width:32px;height:32px;cursor:pointer;font-size:18px}
.legend{display:flex;gap:14px;font-size:13px;color:var(--muted);margin:6px 0}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:middle}
.asc svg{width:100%;max-height:260px}footer{max-width:1150px;margin:auto;padding:16px;color:var(--muted);font-size:13px;border-top:1px solid var(--line)}
${phaseCss(m.phases.length)}
</style></head>
<body data-phase="0">
<header>
<h1>${esc(m.name)}<small>${esc(m.ascendancyName ? `${m.ascendancyName} (${m.className})` : m.className)}</small></h1>
<div class="badges"><span class="badge">${m.leagueStart ? "League start — full leveling plan" : "Existing character"}</span><span class="badge">${m.phases.length} phase${m.phases.length === 1 ? "" : "s"}</span><span class="badge">Made ${esc(m.generatedAt)}</span></div>
</header>
<main>
<div class="card"><h3>Overview</h3>${para(m.summary)}${m.playstyle ? `<h3>How it plays</h3>${para(m.playstyle)}` : ""}
<div class="grid">${m.strengths.length ? `<div><h3>Strengths</h3>${list(m.strengths)}</div>` : ""}${m.weaknesses.length ? `<div><h3>Weaknesses</h3>${list(m.weaknesses)}</div>` : ""}</div></div>
<nav class="tabs" role="tablist">${tabs}</nav>
${m.phases.map(phaseHtml).join("\n")}
<div class="card"><h3>Passive tree</h3><div class="legend"><span><span class="dot" style="background:var(--new)"></span>Taken this phase</span><span><span class="dot" style="background:var(--taken)"></span>Taken earlier</span><span>Hover a node for details · scroll to zoom · drag to move</span></div>
<div class="treewrap" id="treewrap"><div class="zoom"><button id="zin" aria-label="Zoom in">+</button><button id="zout" aria-label="Zoom out">−</button><button id="zreset" aria-label="Reset view">⟳</button></div>${treeSvg(m.tree, "Passive tree")}</div>
${m.ascendancyTree.length ? `<h3 style="margin-top:12px">Ascendancy</h3><div class="asc">${treeSvg(m.ascendancyTree, "Ascendancy tree")}</div>` : ""}</div>
${m.notes.length ? `<div class="card"><h3>Notes</h3>${list(m.notes)}</div>` : ""}
</main>
<footer>Made with the PoE2 Build Planner Claude tool v${esc(m.toolVersion)}. Checks are rule-based estimates, not guarantees. This product isn't affiliated with or endorsed by Grinding Gear Games in any way.</footer>
<script>
(function(){
  var tabs=document.querySelectorAll('.tabs button'),phases=document.querySelectorAll('.phase');
  function show(i){document.body.dataset.phase=i;tabs.forEach(function(t){t.setAttribute('aria-selected',t.dataset.i==i)});phases.forEach(function(p,j){p.hidden=j!=i});try{localStorage.setItem(location.pathname+':phase',i)}catch(e){}}
  tabs.forEach(function(t){t.addEventListener('click',function(){show(+t.dataset.i)})});
  try{var saved=localStorage.getItem(location.pathname+':phase');if(saved!==null&&tabs[saved])show(+saved)}catch(e){}
  var wrap=document.getElementById('treewrap'),svg=wrap&&wrap.querySelector('svg');if(!svg)return;
  var vb0=svg.getAttribute('viewBox').split(' ').map(Number),vb=vb0.slice();
  function set(){svg.setAttribute('viewBox',vb.join(' '))}
  function zoom(f,cx,cy){var nw=vb[2]*f,nh=vb[3]*f;if(nw>vb0[2]*1.5||nw<vb0[2]/40)return;vb=[cx-(cx-vb[0])*f,cy-(cy-vb[1])*f,nw,nh];set()}
  function center(){return[vb[0]+vb[2]/2,vb[1]+vb[3]/2]}
  wrap.addEventListener('wheel',function(e){e.preventDefault();var r=svg.getBoundingClientRect(),cx=vb[0]+(e.clientX-r.left)/r.width*vb[2],cy=vb[1]+(e.clientY-r.top)/r.height*vb[3];zoom(e.deltaY<0?0.8:1.25,cx,cy)},{passive:false});
  var drag=null;wrap.addEventListener('pointerdown',function(e){if(e.target.closest('button'))return;drag=[e.clientX,e.clientY];wrap.setPointerCapture(e.pointerId)});
  wrap.addEventListener('pointermove',function(e){if(!drag)return;var r=svg.getBoundingClientRect();vb[0]-=(e.clientX-drag[0])/r.width*vb[2];vb[1]-=(e.clientY-drag[1])/r.height*vb[3];drag=[e.clientX,e.clientY];set()});
  wrap.addEventListener('pointerup',function(){drag=null});
  document.getElementById('zin').onclick=function(){var c=center();zoom(0.7,c[0],c[1])};
  document.getElementById('zout').onclick=function(){var c=center();zoom(1.4,c[0],c[1])};
  document.getElementById('zreset').onclick=function(){vb=vb0.slice();set()};
})();
</script>
</body></html>`;
}
