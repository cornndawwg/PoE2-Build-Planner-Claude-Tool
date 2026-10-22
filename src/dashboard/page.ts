// The dashboard page: one self-contained HTML document (no outside requests). It streams events
// from /events and posts the player's answers and comments to /action.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function dashboardPage(session: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Build Lab — ${esc(session)}</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--panel2:#1d212a;--line:#2a2f3a;--text:#e6e3dc;--muted:#9ea3ad;--accent:#d6a756;--accent2:#f0c77a;--ok:#6cc08b;--warn:#e07a5f;--blue:#6ea8ff;--purple:#b48ef0}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding-bottom:96px}
header{position:sticky;top:0;z-index:5;background:rgba(15,17,21,.95);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header h1{font-size:17px;margin:0;flex:1;min-width:200px}
header h1 small{color:var(--muted);font-weight:500;margin-left:8px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--warn);display:inline-block}
.dot.live{background:var(--ok)}
.badge{font-size:12px;border-radius:999px;padding:2px 10px;background:var(--panel2);border:1px solid var(--line);color:var(--muted)}
.badge.waiting{background:#3a3222;border-color:var(--accent);color:var(--accent2)}
main{max-width:1250px;margin:0 auto;padding:16px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:16px}
h2{font-size:14px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);margin:4px 0 10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px}
.card .head{display:flex;gap:8px;align-items:baseline;justify-content:space-between}
.card .title{font-weight:650}
.card .time{color:var(--muted);font-size:12px;white-space:nowrap}
.card p{margin:6px 0 0;color:#cfccc4;white-space:pre-wrap}
.kind{font-size:11px;font-weight:700;border-radius:6px;padding:1px 7px;margin-right:6px;text-transform:uppercase;letter-spacing:.4px}
.k-thought{background:#26304a;color:var(--blue)}.k-plan{background:#2b2540;color:var(--purple)}.k-question{background:#3a3222;color:var(--accent2)}
.k-decision{background:#1f3326;color:var(--ok)}.k-status{background:var(--panel2);color:var(--muted)}
.k-test,.k-compare,.k-optimize,.k-character,.k-upgrades{background:#2a2420;color:var(--accent)}
.card.question{border-color:#5a4a2a}
.answers{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--text);padding:6px 12px}
button:hover{border-color:#4a5262}
button.primary{background:var(--accent);border-color:var(--accent);color:#1a1408;font-weight:650}
button.small{padding:3px 9px;font-size:13px}
button.chosen{outline:2px solid var(--ok)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:8px}
.stat{background:var(--panel2);border-radius:8px;padding:6px 9px}
.stat .k{display:block;color:var(--muted);font-size:12px}
.stat .v{font-weight:700;font-size:16px}
.bar{height:6px;border-radius:3px;background:#2a2f3a;margin-top:4px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent)}
.bar.ehp i{background:var(--blue)}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:14px}
th,td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:var(--ok)}.neg{color:var(--warn)}
.verdict{font-size:12px;font-weight:700;border-radius:999px;padding:1px 8px;color:#111}
.v-comfortable,.v-on-track{background:var(--ok)}.v-workable{background:#b9d36c}.v-borderline,.v-rough{background:#e8b04a}.v-not-yet,.v-not-realistic-yet{background:var(--warn)}
.actions{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;align-items:center}
.sent{color:var(--ok);font-size:13px}
.board{position:sticky;top:64px}
.empty{color:var(--muted);font-style:italic}
footer{position:fixed;bottom:0;left:0;right:0;background:rgba(15,17,21,.97);border-top:1px solid var(--line);padding:10px 16px}
footer form{max-width:1250px;margin:0 auto;display:flex;gap:8px}
footer input{flex:1;min-width:0;font:inherit;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--text)}
.hint{max-width:1250px;margin:4px auto 0;color:var(--muted);font-size:12px}
@media (max-width:900px){main{grid-template-columns:1fr}.board{position:static}}
</style>
</head>
<body>
<header>
  <span class="dot" id="dot" title="connection"></span>
  <h1 id="session">${esc(session)}<small>Build Lab</small></h1>
  <span class="badge" id="waiting">No messages waiting</span>
</header>
<main>
  <section>
    <h2>Claude's thinking</h2>
    <div id="thoughts"><p class="empty">Claude's reasoning, plans and questions will appear here.</p></div>
  </section>
  <section>
    <div class="board card" id="board"><h2>Best so far</h2><p class="empty">Tested builds are ranked here.</p></div>
    <h2>Tests</h2>
    <div id="tests"><p class="empty">Every calculation Claude runs appears here as it happens.</p></div>
  </section>
</main>
<footer>
  <form id="msg"><input id="msgText" placeholder="Tell Claude something (e.g. &quot;I'd rather not play melee&quot;)" maxlength="2000" autocomplete="off"><button class="primary" type="submit">Send</button></form>
  <div class="hint">Claude reads your messages and choices before its next step.</div>
</footer>
<script>
(function () {
  var key = new URLSearchParams(location.search).get("k");
  var thoughts = document.getElementById("thoughts");
  var tests = document.getElementById("tests");
  var board = document.getElementById("board");
  var waitingEl = document.getElementById("waiting");
  var ranked = [];
  var seen = {};

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmt(n) { return n == null || isNaN(n) ? "—" : Math.round(n).toLocaleString("en-US"); }
  function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z]+/g, "-"); }
  function time(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch (e) { return ""; } }
  function pctClass(s) { return /^\\+/.test(s) ? "pos" : /^-/.test(s) ? "neg" : ""; }

  function send(action, after) {
    fetch("/action?k=" + encodeURIComponent(key), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) })
      .then(function (r) { if (after) after(r.ok); })
      .catch(function () { if (after) after(false); });
  }
  function setWaiting(n) {
    waitingEl.textContent = n ? n + " message" + (n > 1 ? "s" : "") + " waiting for Claude" : "No messages waiting";
    waitingEl.className = "badge" + (n ? " waiting" : "");
  }

  function card(ev) {
    var c = el("div", "card " + ev.kind);
    var head = el("div", "head");
    var t = el("div", "title");
    t.appendChild(el("span", "kind k-" + ev.kind, ev.kind));
    t.appendChild(document.createTextNode(ev.title));
    head.appendChild(t);
    head.appendChild(el("span", "time", time(ev.time)));
    c.appendChild(head);
    if (ev.text) c.appendChild(el("p", "", ev.text));
    return c;
  }

  function feedback(c, ev, labels) {
    var row = el("div", "actions");
    var note = el("span", "sent");
    labels.forEach(function (l) {
      var b = el("button", "small", l[0]);
      b.onclick = function () {
        var text = l[1] === "comment" ? prompt("Your comment on \\"" + ev.title + "\\":") : null;
        if (l[1] === "comment" && !text) return;
        send({ type: l[1], eventId: ev.id, text: text || undefined }, function (ok) { note.textContent = ok ? "Sent" : "Couldn't send"; if (ok) b.classList.add("chosen"); });
      };
      row.appendChild(b);
    });
    row.appendChild(note);
    c.appendChild(row);
  }

  function statBox(label, value, sub, frac, cls) {
    var s = el("div", "stat");
    s.appendChild(el("span", "k", label));
    s.appendChild(el("span", "v", value));
    if (sub) s.appendChild(el("span", "k", sub));
    if (frac != null) { var b = el("div", "bar " + (cls || "")); var i = el("i"); i.style.width = Math.max(2, Math.min(100, frac * 100)) + "%"; b.appendChild(i); s.appendChild(b); }
    return s;
  }

  function table(headers, rows) {
    var t = el("table"); var tr = el("tr");
    headers.forEach(function (h) { tr.appendChild(el("th", "", h)); });
    t.appendChild(tr);
    rows.forEach(function (r) {
      var row = el("tr");
      r.forEach(function (cell, i) { var td = el("td", i > 0 && /^[+\\-]?[\\d.,%]+$/.test(String(cell)) ? "num " + pctClass(String(cell)) : "", cell == null ? "—" : String(cell)); row.appendChild(td); });
      t.appendChild(row);
    });
    return t;
  }

  function renderTest(ev) {
    var c = card(ev); var d = ev.data || {};
    var maxClear = Math.max.apply(null, ranked.map(function (r) { return r.clear || 0; }).concat([d.clearDps || 1]));
    var maxEhp = Math.max.apply(null, ranked.map(function (r) { return r.ehp || 0; }).concat([d.ehp || 1]));
    var stats = el("div", "stats");
    stats.appendChild(statBox("Clear DPS", fmt(d.clearDps), d.rareSeconds != null ? "rare in " + d.rareSeconds + " s" : "", (d.clearDps || 0) / maxClear));
    stats.appendChild(statBox("Boss DPS", fmt(d.bossDps), d.bossSeconds != null ? "boss in " + d.bossSeconds + " s" : ""));
    stats.appendChild(statBox("Effective HP", fmt(d.ehp), "life " + fmt(d.life) + " · ES " + fmt(d.es), (d.ehp || 0) / maxEhp, "ehp"));
    stats.appendChild(statBox("Boss hits", d.hitsFromBoss == null ? "—" : String(d.hitsFromBoss), "survived"));
    c.appendChild(stats);
    if (d.goal) { var g = el("p"); g.appendChild(el("span", "verdict v-" + slug(d.goal.status), d.goal.status)); g.appendChild(document.createTextNode(" " + d.goal.message)); c.appendChild(g); }
    else if (d.verdict) { var v = el("p"); v.appendChild(el("span", "verdict v-" + slug(d.verdict.overall), d.verdict.overall)); v.appendChild(document.createTextNode(" for " + d.verdict.content + (d.verdict.weakPoint ? " — weak point: " + d.verdict.weakPoint : ""))); c.appendChild(v); }
    if (d.gaps && d.gaps.length) c.appendChild(el("p", "", "Could add: " + d.gaps.join(" ")));
    feedback(c, ev, [["Keep this", "keep"], ["Drop this", "drop"], ["Comment", "comment"]]);
    return c;
  }

  function renderCompare(ev) {
    var c = card(ev); var d = ev.data || {};
    c.appendChild(table(["Variant", "Clear DPS", "Boss DPS", "Boss hits", "vs first"], (d.rows || []).map(function (r) {
      return [r.label, fmt(r.clearDps), fmt(r.bossDps), r.hitsFromBoss, r.vsFirst ? r.vsFirst.bossDps : ""];
    })));
    if (d.best) c.appendChild(el("p", "", "Best for clearing: " + d.best.clearing + " · bossing: " + d.best.bossing + " · survival: " + d.best.survival));
    feedback(c, ev, [["Comment", "comment"]]);
    return c;
  }

  function renderOptimize(ev) {
    var c = card(ev); var d = ev.data || {};
    c.appendChild(table(["Change", "Boss DPS", "Clear DPS", "Effective HP"], (d.damage || []).slice(0, 8).map(function (x) { return [x.change, x.bossDps, x.clearDps, x.effectiveHp]; })));
    if (d.combined) c.appendChild(el("p", "", "All the best picks together: boss " + d.combined.bossDps + ", clear " + d.combined.clearDps + ", effective HP " + d.combined.effectiveHp));
    feedback(c, ev, [["Apply these", "keep"], ["Not these", "drop"], ["Comment", "comment"]]);
    return c;
  }

  function renderUpgrades(ev) {
    var c = card(ev); var d = ev.data || {};
    c.appendChild(table(["Slot", "Look for", "Damage", "Effective HP"], (d.topUpgrades || []).map(function (u) { return [u.slot, u.mod, u.damage, u.effectiveHp]; })));
    feedback(c, ev, [["Comment", "comment"]]);
    return c;
  }

  function renderCharacter(ev) {
    var c = card(ev); var d = ev.data || {}; var n = d.numbers || {};
    var stats = el("div", "stats");
    stats.appendChild(statBox("Clear DPS", fmt(n.clear && n.clear.dps)));
    stats.appendChild(statBox("Boss DPS", fmt(n.boss && n.boss.dps)));
    stats.appendChild(statBox("Effective HP", fmt(n.defence && n.defence.effectiveHp)));
    c.appendChild(stats);
    (d.audit || []).forEach(function (a) { c.appendChild(el("p", "", "• " + a)); });
    return c;
  }

  function renderThought(ev) {
    var c = card(ev);
    if (ev.kind === "question" && ev.options && ev.options.length) {
      var row = el("div", "answers"); var note = el("span", "sent");
      ev.options.forEach(function (o) {
        var b = el("button", "", o);
        b.onclick = function () { send({ type: "answer", eventId: ev.id, text: o }, function (ok) { note.textContent = ok ? "Sent — Claude will see it next step" : "Couldn't send"; if (ok) { row.querySelectorAll("button").forEach(function (x) { x.classList.remove("chosen"); }); b.classList.add("chosen"); } }); };
        row.appendChild(b);
      });
      var other = el("button", "", "Something else…");
      other.onclick = function () { var t = prompt(ev.title); if (t) send({ type: "answer", eventId: ev.id, text: t }, function (ok) { note.textContent = ok ? "Sent" : "Couldn't send"; }); };
      row.appendChild(other); row.appendChild(note); c.appendChild(row);
    } else if (ev.kind === "plan" || ev.kind === "decision") {
      feedback(c, ev, [["Sounds good", "keep"], ["Not this", "drop"], ["Comment", "comment"]]);
    }
    return c;
  }

  function rank(ev) {
    var d = ev.data || {};
    if (ev.kind !== "test" || !d.clearDps) return;
    ranked.push({ id: ev.id, title: ev.title, clear: d.clearDps, boss: d.bossDps, ehp: d.ehp, hits: d.hitsFromBoss });
    drawBoard();
  }
  var sortBy = "boss";
  function drawBoard() {
    board.innerHTML = "";
    var h = el("h2", "", "Best so far");
    board.appendChild(h);
    var tabs = el("div", "actions");
    [["boss", "Boss DPS"], ["clear", "Clear DPS"], ["ehp", "Effective HP"]].forEach(function (t) {
      var b = el("button", "small" + (sortBy === t[0] ? " chosen" : ""), t[1]);
      b.onclick = function () { sortBy = t[0]; drawBoard(); };
      tabs.appendChild(b);
    });
    board.appendChild(tabs);
    var top = ranked.slice().sort(function (a, b) { return (b[sortBy] || 0) - (a[sortBy] || 0); }).slice(0, 6);
    if (!top.length) { board.appendChild(el("p", "empty", "Tested builds are ranked here.")); return; }
    board.appendChild(table(["Build", "Boss DPS", "Clear DPS", "Eff. HP", "Boss hits"], top.map(function (r) { return [r.title, fmt(r.boss), fmt(r.clear), fmt(r.ehp), r.hits]; })));
  }

  function add(ev) {
    if (seen[ev.id]) return; seen[ev.id] = true;
    var isTest = ["test", "compare", "optimize", "character", "upgrades"].indexOf(ev.kind) >= 0;
    var target = isTest ? tests : thoughts;
    var empty = target.querySelector(".empty"); if (empty) empty.remove();
    var c = ev.kind === "test" ? renderTest(ev) : ev.kind === "compare" ? renderCompare(ev) : ev.kind === "optimize" ? renderOptimize(ev)
      : ev.kind === "upgrades" ? renderUpgrades(ev) : ev.kind === "character" ? renderCharacter(ev) : renderThought(ev);
    target.insertBefore(c, target.firstChild);
    rank(ev);
  }

  function connect() {
    var dot = document.getElementById("dot");
    var es = new EventSource("/events?k=" + encodeURIComponent(key));
    es.onopen = function () { dot.className = "dot live"; };
    es.onerror = function () { dot.className = "dot"; };
    es.onmessage = function (m) {
      var msg = JSON.parse(m.data);
      if (msg.type === "hello") { document.getElementById("session").firstChild.nodeValue = msg.session; msg.events.forEach(add); setWaiting(msg.waiting); }
      else if (msg.type === "event") add(msg.event);
      else if (msg.type === "action") setWaiting(msg.waiting);
      else if (msg.type === "read") setWaiting(0);
      else if (msg.type === "session") document.getElementById("session").firstChild.nodeValue = msg.title;
    };
  }

  document.getElementById("msg").onsubmit = function (e) {
    e.preventDefault();
    var input = document.getElementById("msgText"); var text = input.value.trim();
    if (!text) return;
    send({ type: "message", text: text }, function (ok) { if (ok) input.value = ""; });
  };
  drawBoard();
  connect();
})();
</script>
</body>
</html>`;
}
