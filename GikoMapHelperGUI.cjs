// GikoMapHelper GUI - local web page that drives GikoMapHelper.cjs. Needs only Node.js.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, exec } = require("child_process");

const CLI = path.join(__dirname, "GikoMapHelper.cjs");
const TOKEN = crypto.randomBytes(16).toString("hex");
const CORNERS = ["left", "top", "right", "bottom"];
const SAFE_NAME = /^[\w.\- ]+$/;

function cli(args, staged) {
    return new Promise(resolve => {
        const env = staged ? { ...process.env, FIT_REPO: STAGE, FIT_NOBACKUP: "1" } : process.env;
        const child = execFile(process.execPath, [CLI, ...args], { timeout: 120000, maxBuffer: 20e6, windowsHide: true, env }, (err, stdout, stderr) => {
            resolve({ ok: !err, out: stdout, err: stderr });
        });
        child.stdin.end();
    });
}

// All edits go to a temp copy of the room; nothing touches the real files until Save.
const STAGE = path.join(require("os").tmpdir(), "gikostage-" + process.pid);
const stages = {};
const rmStage = d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* best effort */ } };
process.on("exit", () => rmStage(STAGE));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(0));
try {
    const tmp = path.dirname(STAGE);
    for (const d of fs.readdirSync(tmp)) if (d.startsWith("gikostage-") && Date.now() - fs.statSync(path.join(tmp, d)).mtimeMs > 864e5) rmStage(path.join(tmp, d));
} catch (e) { /* ignore */ }
let repoInfoCache = null;
async function repoInfo() {
    if (!repoInfoCache) { const r = await cli(["--info"]); repoInfoCache = JSON.parse(r.out); }
    return repoInfoCache;
}
function roomFiles(root, L, room) {
    const m = {};
    const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = rel + "/" + e.name; e.isDirectory() ? walk(p, r) : (m[r] = p); } };
    const rd = path.join(root, ...L.rooms, room);
    if (fs.existsSync(rd)) walk(rd, "rooms/" + room);
    const t = path.join(root, ...L.code, room + ".ts");
    if (fs.existsSync(t)) m["code/" + room + ".ts"] = t;
    return m;
}
const hashes = m => { const o = {}; for (const k in m) o[k] = crypto.createHash("md5").update(fs.readFileSync(m[k])).digest("hex"); return o; };
const sameMap = (a, b) => { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every(k => a[k] === b[k]); };
function stageDirty(ri, room) { const st = stages[room]; return !!st && !sameMap(st.base, hashes(roomFiles(STAGE, ri.layout, room))); }
async function ensureStage(room, resync) {
    const ri = await repoInfo(), L = ri.layout;
    if (stages[room] && (!resync || stageDirty(ri, room))) return ri;
    fs.rmSync(path.join(STAGE, ...L.rooms, room), { recursive: true, force: true });
    fs.mkdirSync(path.join(STAGE, ...L.code), { recursive: true });
    fs.mkdirSync(path.join(STAGE, ...L.rooms), { recursive: true });
    const real = roomFiles(ri.repo, L, room);
    for (const rel in real) {
        const dest = path.join(STAGE, ...(rel.startsWith("code/") ? L.code.concat(rel.slice(5)) : L.rooms.concat(rel.slice(6).split("/"))));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(real[rel], dest);
    }
    const lang = path.join(ri.repo, ...L.lang), sl = path.join(STAGE, ...L.lang);
    if (fs.existsSync(lang)) { fs.mkdirSync(path.dirname(sl), { recursive: true }); fs.copyFileSync(lang, sl); }
    stages[room] = { base: hashes(roomFiles(STAGE, L, room)) };
    return ri;
}
function commitStage(ri, room) {
    const L = ri.layout, st = roomFiles(STAGE, L, room), real = roomFiles(ri.repo, L, room), rh = hashes(real), sh = hashes(st);
    const home = require("os").homedir();
    const desktop = [path.join(home, "Desktop"), path.join(home, "OneDrive", "Desktop")].find(d => fs.existsSync(d)) || home;
    const bdir = path.join(desktop, "GikoBackups", room, new Date().toISOString().replace(/[:.]/g, "-"));
    const out = [];
    for (const rel in st) {
        if (rh[rel] === sh[rel]) continue;
        const dest = rel.startsWith("code/") ? path.join(ri.repo, ...L.code, rel.slice(5)) : path.join(ri.repo, ...L.rooms, ...rel.slice(6).split("/"));
        if (fs.existsSync(dest)) { fs.mkdirSync(bdir, { recursive: true }); fs.copyFileSync(dest, path.join(bdir, path.basename(dest))); }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(st[rel], dest);
        out.push(path.basename(dest));
    }
    stages[room].base = sh;
    return out.length ? "Saved to files: " + out.join(", ") + " (backups: " + bdir + ")" : "No file changes to save.";
}

function send(res, code, type, body) {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
}
const bgArgs = bg => (bg && SAFE_NAME.test(bg) && bg.toLowerCase().endsWith(".svg") ? ["--bg=" + bg] : []);
const json = (res, code, obj) => send(res, code, "application/json", JSON.stringify(obj));

function readBody(req) {
    return new Promise((resolve, reject) => {
        let b = "";
        req.on("data", d => { b += d; if (b.length > 1e5) { req.destroy(); reject(new Error("too big")); } });
        req.on("end", () => resolve(b));
    });
}

let lastPing = Date.now(), pageSeen = false, byeAt = 0;
setInterval(() => {
    const now = Date.now();
    const gone = byeAt ? now - byeAt > 4000 : now - lastPing > (pageSeen ? 150000 : 60000);
    if (gone) { console.log("Page closed, shutting down."); process.exit(0); }
}, 1000);

async function handle(req, res) {
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return send(res, 403, "text/plain", "Forbidden");
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", PAGE.replace("__TOKEN__", TOKEN));
    if (url.searchParams.get("t") !== TOKEN && req.headers["x-token"] !== TOKEN) return send(res, 403, "text/plain", "Forbidden");

    if (url.pathname === "/api/ping") { lastPing = Date.now(); pageSeen = true; byeAt = 0; return json(res, 200, { ok: true }); }
    if (url.pathname === "/api/bye") { byeAt = Date.now(); return json(res, 200, { ok: true }); }
    if (url.pathname === "/api/rooms") {
        const r = await cli(["--info"]);
        return r.ok ? send(res, 200, "application/json", r.out) : json(res, 500, { error: r.err || r.out });
    }
    const room = url.searchParams.get("room");
    if (url.pathname === "/api/info") {
        if (!room || !SAFE_NAME.test(room)) return json(res, 400, { error: "bad room" });
        await ensureStage(room, true);
        const r = await cli([room, "--info", ...bgArgs(url.searchParams.get("bg"))], true);
        return r.ok ? send(res, 200, "application/json", r.out) : json(res, 500, { error: r.err || r.out });
    }
    if (url.pathname === "/api/open") {
        if (!room || !SAFE_NAME.test(room)) return json(res, 400, { error: "bad room" });
        const r = await cli([room, "--info"]);
        let info; try { info = JSON.parse(r.out); } catch (e) { return json(res, 500, { error: "no info" }); }
        if (!fs.existsSync(info.folder)) return json(res, 404, { error: "folder missing" });
        const opener = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
        execFile(opener, [info.folder], () => {});
        return json(res, 200, { ok: true, folder: info.folder });
    }
    if (url.pathname === "/api/svg") {
        const file = url.searchParams.get("file");
        if (!room || !SAFE_NAME.test(room) || !file || !file.split("/").every(p => SAFE_NAME.test(p) && p !== "..") || !file.toLowerCase().endsWith(".svg")) return json(res, 400, { error: "bad name" });
        const info = await cli(["--info"]);
        let repo; try { repo = JSON.parse(info.out); } catch (e) { return json(res, 500, { error: "no repo" }); }
        if (!repo.rooms.some(r => r.id === room)) return json(res, 404, { error: "no room" });
        await ensureStage(room, false);
        const dir = ["static/rooms", "public/rooms"].map(d => path.join(STAGE, d, room)).find(d => fs.existsSync(d));
        const f = dir && path.join(dir, file);
        if (!f || !fs.existsSync(f)) return json(res, 404, { error: "missing" });
        return send(res, 200, "image/svg+xml", fs.readFileSync(f));
    }
    if (url.pathname === "/api/char") {
        const info = await cli(["--info"]);
        let repo; try { repo = JSON.parse(info.out); } catch (e) { return json(res, 500, { error: "no repo" }); }
        const c = url.searchParams.get("c") === "hungry_giko" ? "hungry_giko" : "giko";
        const f = ["static", "public"].map(d => path.join(repo.repo, d, "characters", c, url.searchParams.get("pose") === "sitting" ? "front-sitting.svg" : "front-standing.svg")).find(p => fs.existsSync(p));
        if (!f) return json(res, 404, { error: "missing" });
        return send(res, 200, "image/svg+xml", fs.readFileSync(f));
    }
    if (url.pathname === "/api/run" && req.method === "POST") {
        let p; try { p = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: "bad json" }); }
        if (!p.room || !SAFE_NAME.test(p.room)) return json(res, 400, { error: "bad room" });
        let sel;
        if (p.action === "crop") sel = "background.svg";
        else if (p.action === "all") sel = "all";
        else if (p.action === "grid") { if (!CORNERS.includes(p.corner)) return json(res, 400, { error: "bad corner" }); sel = "grid:" + p.corner; }
        else if (p.action === "save") {
            const q = p.props || {};
            if (![q.id, q.group, q.spawn].every(v => typeof v === "string" && SAFE_NAME.test(v))) return json(res, 400, { error: "id, group and spawnpoint may only contain letters, digits, spaces, dots, dashes and underscores" });
            if (!Number.isInteger(q.slots) || q.slots < 0 || q.slots > 999) return json(res, 400, { error: "bad stream slots" });
            if (!Number.isFinite(p.ox) || !Number.isFinite(p.oy)) return json(res, 400, { error: "bad grid coordinates" });
            const nv = v => v === null || Number.isFinite(v);
            if (!Array.isArray(p.objs) || !p.objs.every(o => Array.isArray(o) && o.length === 5 && Number.isInteger(o[0]) && o.slice(1).every(nv))) return json(res, 400, { error: "bad object values" });
            const tl = a => Array.isArray(a) && a.length < 5000 && a.every(t => Array.isArray(t) && t.length === 2 && t.every(Number.isInteger));
            if (!tl(p.sit) || !tl(p.blocked)) return json(res, 400, { error: "bad sit/blocked tiles" });
            if (!Array.isArray(p.forbidden) || p.forbidden.length > 5000 || !p.forbidden.every(t => Array.isArray(t) && t.length === 4 && t.every(Number.isInteger))) return json(res, 400, { error: "bad forbidden movements" });
            sel = "props";
        }
        else if (p.action === "dupobj") { if (!Array.isArray(p.rm) || p.rm.length !== 1 || !Number.isInteger(p.rm[0]) || p.rm[0] < 0) return json(res, 400, { error: "bad object" }); sel = "props"; }
        else if (p.action === "rmobj") { if (!Array.isArray(p.rm) || p.rm.length !== 1 || !Number.isInteger(p.rm[0]) || p.rm[0] < 0) return json(res, 400, { error: "bad object" }); sel = "props"; }
        else if (p.action === "addobj") { if (!Array.isArray(p.add) || !p.add.length || p.add.length > 500 || !p.add.every(n => typeof n === "string" && SAFE_NAME.test(n) && n.toLowerCase().endsWith(".svg"))) return json(res, 400, { error: "nothing selected to add" }); sel = "props"; }
        else if (p.action === "manual") { if (!Number.isFinite(p.ox) || !Number.isFinite(p.oy)) return json(res, 400, { error: "bad coordinates" }); sel = "grid:manual"; }
        else if (p.action === "object") { if (!p.object || !SAFE_NAME.test(p.object)) return json(res, 400, { error: "bad object" }); sel = p.object; }
        else return json(res, 400, { error: "bad action" });
        const args = [p.room, sel];
        if (p.action === "save") args.push("--origin=" + p.ox + "," + p.oy, "--objs=" + JSON.stringify(p.objs), "--id=" + p.props.id, "--group=" + p.props.group, "--spawn=" + p.props.spawn, "--slots=" + p.props.slots, "--anon=" + (p.props.anon ? "true" : "false"), "--sit=" + JSON.stringify(p.sit), "--blocked=" + JSON.stringify(p.blocked), "--forbidden=" + JSON.stringify(p.forbidden));
        if (p.action === "dupobj") args.push("--dupobj=" + p.rm[0]);
        if (p.action === "rmobj") args.push("--rmobj=" + JSON.stringify(p.rm));
        if (p.action === "addobj") args.push("--addobj=" + JSON.stringify(p.add));
        if (p.action === "manual") args.push("--origin=" + p.ox + "," + p.oy);
        args.push(...bgArgs(p.bg));
        if (p.keepShapes) args.push("--keep-shapes");
        if (p.write) args.push("--write");
        await ensureStage(p.room, false);
        const r = await cli(args, true);
        if (p.action === "addobj" && p.write && r.ok) {
            for (const n of p.add) {
                const f = await cli([p.room, n, ...bgArgs(p.bg), ...(p.keepShapes ? ["--keep-shapes"] : []), "--write"], true);
                r.out += "\n" + (f.out + (f.err ? "\n" + f.err : "")).trim();
            }
        }
        let output = (r.out + (r.err ? "\n" + r.err : "")).trim();
        if (p.write && r.ok) {
            output = output.replace(/Done\. Backup: .*/g, "").trim();
            output += "\n" + (p.action === "save" ? commitStage(await repoInfo(), p.room) : "Staged only. Press Save to write this to the files.");
        }
        return json(res, 200, { ok: r.ok, output: output.trim() });
    }
    send(res, 404, "text/plain", "Not found");
}

const server = http.createServer((req, res) => handle(req, res).catch(e => json(res, 500, { error: String(e.message || e) })));
server.listen(0, "127.0.0.1", () => {
    const url = "http://127.0.0.1:" + server.address().port + "/";
    console.log("GikoMapHelper GUI running at " + url);
    console.log("Close this window to stop it.");
    const opener = process.platform === "win32" ? 'start "" "' + url + '"' : process.platform === "darwin" ? 'open "' + url + '"' : 'xdg-open "' + url + '"';
    exec(opener, () => {});
});

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>GikoMapHelper</title>
<style>
body{font:14px system-ui,sans-serif;margin:0;background:#1e1e24;color:#e8e8ee;display:flex;height:100vh}
#side{width:340px;padding:14px;overflow:auto;background:#26262e;box-sizing:border-box}
#main{flex:1;display:flex;flex-direction:column;min-width:0}
h1{font-size:18px;margin:0 0 10px}h2{font-size:13px;margin:16px 0 6px;color:#9aa}
select,button{font:inherit;padding:7px 10px;border-radius:5px;border:1px solid #444;background:#34343e;color:#eee}
button{cursor:pointer;margin:2px 2px 2px 0}button:hover{background:#44444f}
button.primary{background:#3b6ee0;border-color:#3b6ee0}button.primary:hover{background:#4a7cf0}
button:disabled{opacity:.4;cursor:default}
button.sel{outline:2px solid #3b6ee0}
select{width:100%}.row{display:flex;flex-wrap:wrap;gap:2px}
small{color:#9aa;display:block;margin:3px 0}
.card{border:1px solid #445;border-radius:6px;padding:6px;margin:4px 0}
#view{flex:1;overflow:auto;background:#111}
canvas{display:block;margin:10px}
#zoomBar{position:sticky;top:6px;left:6px;height:0;z-index:5;overflow:visible;white-space:nowrap}
#zoomBar>*{vertical-align:top;display:inline-block;margin-right:3px;background:#26262eee;color:#fff;border:1px solid #556;border-radius:4px;padding:2px 8px}
#zoomBar small{border:0;color:#bcc}
#log{height:110px;flex:none;margin:0;padding:10px;background:#0d0d10;color:#cfe;overflow:auto;white-space:pre-wrap;font:12px Consolas,monospace;border-top:1px solid #333}
#saveBar{position:sticky;bottom:-14px;margin:14px -14px -14px;padding:10px 14px;background:#26262e;border-top:1px solid #444}
#apply{display:none;margin:0 0 8px;padding:8px;background:#3a3320;border-radius:5px}
#side input:not([type=checkbox]):not([type=number]){font:inherit;padding:5px 8px;border-radius:5px;border:1px solid #444;background:#34343e;color:#eee;min-width:0}
input[type=number]{font:inherit;padding:5px 4px 5px 8px;border-radius:5px;border:1px solid #444;background:#34343e;color:#eee}
input[type=number]::-webkit-inner-spin-button{opacity:1;height:30px;width:22px;cursor:pointer}
.objrow{margin:4px 0;padding:5px 8px;background:#2c2c36;border-radius:5px}
.objrow summary{cursor:pointer;font-weight:600;word-break:break-all}
.objrow .f{display:grid;grid-template-columns:1fr auto auto;gap:4px 6px;align-items:center;margin-top:6px}
.objrow input{width:56px}
.objrow .pv{display:block;width:100%;height:110px;object-fit:contain;margin-top:6px;background:#1a1a20;border-radius:4px}
.legend span{margin-right:12px}
</style></head><body>
<div id="side">
<h1>GikoMapHelper</h1>
<div class="row"><select id="room" style="flex:1;width:auto;min-width:0"></select><button id="openFolder" title="Open this room's folder">Open folder</button></div>
<div class="row" id="bgRow"><select id="bgSel" title="Which .svg in the room folder is used as the background" style="flex:1;width:auto;min-width:0"></select></div>
<h2>Room settings</h2>
<div style="display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center">
<span>ID</span><input id="pId"><span>Group</span><input id="pGroup"><span>Spawnpoint</span><select id="pSpawn"></select>
<span>Stream slots</span><input type="number" id="pSlots" min="0" max="999">
<span>Forced anonymous</span><label><input type="checkbox" id="pAnon"> <span id="pAnonTxt">false</span></label></div>
<small>Changing the ID only edits it inside the room's .ts (the file and rooms.ts are not renamed).</small>
<h2>Grid</h2>
<label><input type="checkbox" id="showGrid" checked> Show grid</label>
<small>Manual origin (originCoordinates):</small>
<div class="row">X <input type="number" id="ox" step="1" style="width:80px"> Y <input type="number" id="oy" step="1" style="width:80px"></div>
<div class="row"><button id="resetOrigin">Reset</button></div>
<h2>Objects</h2>
<small><b>Tile depth</b> (tile X/Y): the grid tile that decides when characters are drawn in front of or behind the object; shown as a yellow dot in the middle of that tile on the map while the object is expanded. <b>Offset</b> (X/Y): where the picture sits on the map, in pixels.</small>
<label><input type="checkbox" id="dragObj"> Drag the expanded object on the map to position it (for objects that have no shapes in the background)</label>
<div id="objList"></div>
<h2>Walls</h2>
<small>Walls mode: hover an edge between two tiles and click to cycle: none, blocked both ways, one way only (arrow sits inside the tile you stand on and points the way you cannot walk), the other way, none. Tile clicking is off while it is on.</small>
<div class="row"><button id="wallBtn">Walls mode</button></div>
<h2>Test character</h2>
<small>Adds a Giko you can drag around the map (or set by tile) to check how objects overlap it. Characters are drawn like an object on their own tile, in front of objects on the same tile. Not saved.</small>
<div class="row"><button id="chBtn" data-c="giko">Add Giko</button><button id="chBtn2" data-c="hungry_giko">Add Hungry Giko</button></div>
<div class="row" id="chRow" style="display:none">Tile X <input type="number" id="chx" step="1" style="width:70px"> Y <input type="number" id="chy" step="1" style="width:70px"></div>
<h2>Align Grid</h2>
<small>Click a corner to snap the grid to that point of the floor outline. It updates the X/Y fields above; press Save to keep it.</small>
<div class="row" id="corners">
<button data-corner="left" class="sel">Left</button><button data-corner="top">Top</button><button data-corner="right">Right</button><button data-corner="bottom">Bottom</button><button id="pickPt" title="Click the selected corner's point on the map">Pick</button></div>
<h2>Other</h2>
<small>Fit all objects: aligns each object's offset to where that object is drawn in background.svg (if it is there).</small>
<div class="row"><button data-act="crop">Crop background</button><button data-act="all">Fit all objects</button></div>
<small>Fit one object: same as above, for a single object.</small><select id="obj"></select>
<div class="row"><button data-act="object">Fit this object</button></div>
<small>Add objects: svg files in the room folder that aren't objects on the map yet. Tick the ones to add (all are ticked by default), then press Add. Then use Fit all objects to position them.</small>
<div id="addList"></div><div class="row"><button data-act="addobj">Add selected</button></div>
<h2>Options</h2>
<label><input type="checkbox" id="remove"> Remove fitted shapes from background.svg</label>
<small>Every action first shows a preview. Nothing changes until you press Apply. Backups go to Desktop/GikoBackups.</small>
<div id="saveBar"><div id="apply">Previewing: <b id="applyName"></b><br><button class="primary" id="doApply">Apply</button><button id="cancel">Cancel</button></div>
<button class="primary" data-act="save" style="width:100%;padding:10px;margin:0">Save</button></div>
</div>
<div id="main"><div id="view"><div id="zoomBar"><button id="zOut" title="Zoom out">-</button><span id="zPct">100%</span><button id="zIn" title="Zoom in">+</button><button id="zReset">Fit</button><small>Ctrl+wheel to zoom</small></div><canvas id="cv"></canvas></div>
<pre id="log">Ready.</pre></div>
<script>
const T="__TOKEN__";
const $=id=>document.getElementById(id);
let picking=false,bg="",info=null,corner="left",pending=null,img=null,objImgs=[];
const api=(p,opt)=>fetch(p+(p.includes("?")?"&":"?")+"t="+T,opt).then(r=>r.json());
const log=t=>{$("log").textContent=t;$("log").scrollTop=0};
async function init(){
  const d=await api("/api/rooms");
  if(d.error){log(d.error);return}
  $("room").innerHTML=d.rooms.map(r=>'<option value="'+r.id+'">'+r.name+(r.name!==r.id?" ("+r.id+")":"")+'</option>').join("");
  $("room").onchange=()=>{bg="";picking=false;setPick();load()};load();
}
async function load(){
  pending=null;$("apply").style.display="none";
  info=await api("/api/info?room="+encodeURIComponent($("room").value)+(bg?"&bg="+encodeURIComponent(bg):""));
  if(info.error){log(info.error);return}
  $("bgSel").innerHTML=(info.svgs||[]).map(f=>"<option"+(f===info.bg?" selected":"")+">"+f+"</option>").join("");
  {const used=new Set((info.entries||[]).map(e=>e.url));$("addList").innerHTML=info.objects.filter(o=>!used.has(o)).map(o=>'<label style="display:block"><input type="checkbox" checked value="'+o+'"> '+o+'</label>').join("")||"<small>Every svg in this folder is already an object.</small>"}
  $("obj").innerHTML=info.objects.map(o=>"<option>"+o+"</option>").join("");
  log("Loaded "+info.name+(info.bg?" (background: "+info.bg+").":". "+(info.gridError||"No background svg."))+(info.bg?"":""));
  img=new Image();img.onload=draw;if(info.bg)img.src="/api/svg?room="+encodeURIComponent(info.roomId)+"&file="+encodeURIComponent(info.bg)+"&t="+T+"&r="+Date.now();
  const num=(v,id)=>v==null?'<input disabled placeholder="-">':'<input type="number" step="1" data-k="'+id+'" value="'+v+'">';
  $("objList").innerHTML=(info.entries||[]).map(e=>'<details class="objrow" data-i="'+e.i+'"><summary>'+e.url+'</summary><img class="pv" loading="lazy" src="/api/svg?room='+encodeURIComponent(info.roomId)+'&file='+encodeURIComponent(e.url)+'&t='+T+'"><div class="f"><span>Tile depth</span>'+num(e.tx,"tx")+num(e.ty,"ty")+'<span>Offset</span>'+num(e.ox,"ox")+num(e.oy,"oy")+'</div><button class="dup" data-i="'+e.i+'">Duplicate this object</button><button class="rm" data-i="'+e.i+'">Remove this object</button></details>').join("")||"<small>No objects in this room's .ts.</small>";
  $("objList").querySelectorAll("button.dup").forEach(b=>b.onclick=async()=>{rmIdx=[Number(b.dataset.i)];await run("dupobj",false);pending="dupobj";$("applyName").textContent="Duplicate "+b.parentNode.querySelector("summary").textContent;$("apply").style.display="block"});
  $("objList").querySelectorAll("button.rm").forEach(b=>b.onclick=async()=>{rmIdx=[Number(b.dataset.i)];await run("rmobj",false);pending="rmobj";$("applyName").textContent="Remove "+b.parentNode.querySelector("summary").textContent;$("apply").style.display="block"});
  $("objList").querySelectorAll("input").forEach(i=>i.oninput=()=>info&&draw());
  $("objList").querySelectorAll("details").forEach(d=>d.ontoggle=()=>info&&draw());
  const cache={},ld=u=>{if(!cache[u]){const i=new Image();i.onload=draw;i.src="/api/svg?room="+encodeURIComponent(info.roomId)+"&file="+encodeURIComponent(u)+"&t="+T+"&r="+Date.now();cache[u]=i}return cache[u]};
  objImgs=(info.entries||[]).map(e=>({i:ld(e.url),idx:e.i,fr:e.anim?Array.from({length:e.anim.amount},(_,n)=>ld(e.anim.prefix+(n+1)+e.anim.suffix)):null,delay:e.anim?e.anim.delay:0}));
  clearInterval(animTimer);frame=0;
  if(objImgs.some(o=>o.fr))animTimer=setInterval(()=>{frame++;if(info)draw()},Math.max(40,Math.min(...objImgs.filter(o=>o.fr).map(o=>o.delay))));
  const pr=info.props||{};$("pId").value=pr.id||"";$("pGroup").value=pr.group||"";$("pSlots").value=pr.streamSlotCount==null?"":pr.streamSlotCount;$("pAnon").checked=!!pr.forcedAnonymous;$("pAnonTxt").textContent=String(!!pr.forcedAnonymous);
  $("pSpawn").innerHTML=[...new Set([...(pr.doors||[]),pr.spawnPoint].filter(Boolean))].map(d=>"<option"+(d===pr.spawnPoint?" selected":"")+">"+d+"</option>").join("");
  if(info.grid){$("ox").value=info.grid.origin.x;$("oy").value=info.grid.origin.y}
  walls=((pr.forbidden||[]).map(m=>[m.xFrom,m.yFrom,m.xTo,m.yTo]));hover=null;
  tileState={};(pr.sit||[]).forEach(t=>tileState[t.x+","+t.y]=1);(pr.blocked||[]).forEach(t=>tileState[t.x+","+t.y]=2);
  draw();
}
let animTimer=0,frame=0,zoom=1;
function setZoom(z,e){
  z=Math.max(0.5,Math.min(8,z));if(z===zoom||!info)return;
  const v=$("view"),cv=$("cv"),r=cv.getBoundingClientRect(),px=e?e.clientX:v.getBoundingClientRect().left+v.clientWidth/2,py=e?e.clientY:v.getBoundingClientRect().top+v.clientHeight/2,fx=(px-r.left)/r.width,fy=(py-r.top)/r.height;
  zoom=z;$("zPct").textContent=Math.round(z*100)+"%";draw();
  const r2=cv.getBoundingClientRect();v.scrollLeft+=r2.left+fx*r2.width-px;v.scrollTop+=r2.top+fy*r2.height-py;
}
$("view").addEventListener("wheel",e=>{if(!e.ctrlKey)return;e.preventDefault();setZoom(zoom*(e.deltaY<0?1.15:1/1.15),e)},{passive:false});
$("zIn").onclick=()=>setZoom(zoom*1.25);$("zOut").onclick=()=>setZoom(zoom/1.25);$("zReset").onclick=()=>setZoom(1);
function draw(){
  const cv=$("cv"),vb=info.viewBox;
  if(!vb){cv.width=cv.height=1;return}
  const s=Math.min(Math.min(2,Math.max(1,($("view").clientWidth-30)/vb.w))*zoom,8000/vb.w,8000/vb.h);
  cv.width=vb.w*s;cv.height=vb.h*s;const c=cv.getContext("2d");
  c.fillStyle="#fff";c.fillRect(0,0,cv.width,cv.height);
  if(img&&img.complete&&img.naturalWidth)c.drawImage(img,0,0,cv.width,cv.height);
  const tv=(row,k)=>parseFloat((row.querySelector("[data-k="+k+"]")||{}).value);
  const ord=objImgs.map(o=>{const row=$("objList").querySelector('[data-i="'+o.idx+'"]');return {o,row,tx:row?tv(row,"tx"):NaN,ty:row?tv(row,"ty"):NaN,u:0}});
  const gx=Number($("ox").value),gy=Number($("oy").value),gg=info.grid;
  if(chOn&&gg&&chImg.complete&&chImg.naturalWidth&&Number.isFinite(gx+gy)){const tx=Number($("chx").value),ty=Number($("chy").value);ord.push({ch:1,tx,ty,u:1})}
  const diag=!!(info.props&&info.props.diagonal);
  ord.sort((a,b)=>((a.tx-a.ty)||0)-((b.tx-b.ty)||0)||(diag?(b.tx||0)-(a.tx||0):0)||a.u-b.u||(a.o&&b.o?a.o.idx-b.o.idx:0));
  ord.forEach(({o,row,ch,tx,ty})=>{
    if(o&&o.fr)o={i:o.fr[frame%o.fr.length]};
    if(ch){const im=tileState[tx+","+ty]===1&&chSit.complete&&chSit.naturalWidth?chSit:chImg,w=im.naturalWidth/2*s,h=im.naturalHeight/2*s,px=(gx+gg.bw/2*(tx+ty))*s,py=(gy+gg.bh/2*(tx-ty))*s;c.drawImage(im,px+gg.bw/2*s-w/2,py-h,w,h);return}
    if(!row||!o.i.complete||!o.i.naturalWidth)return;
    const x=parseFloat(row.querySelector('[data-k=ox]')&&row.querySelector('[data-k=ox]').value),y=parseFloat(row.querySelector('[data-k=oy]')&&row.querySelector('[data-k=oy]').value);
    if(Number.isFinite(x)&&Number.isFinite(y))c.drawImage(o.i,x*s,y*s,o.i.naturalWidth*s,o.i.naturalHeight*s);
  });
  const g=info.grid;if(!g)return;
  const v=(ox,oy,i,j)=>[(ox+g.bw/2*(i+j))*s,(oy-g.bh/2+g.bh/2*(i-j))*s];
  const mx=Number($("ox").value),my=Number($("oy").value);
  if(Number.isFinite(mx)&&Number.isFinite(my)){
    c.strokeStyle="#e22";c.lineWidth=3;
    const edge=(f,t)=>{
      if(t[0]!==f[0]&&t[1]===f[1]){const e=Math.max(f[0],t[0]);return [v(mx,my,e,f[1]),v(mx,my,e,f[1]+1)]}
      if(t[1]!==f[1]&&t[0]===f[0]){const e=Math.max(f[1],t[1]);return [v(mx,my,f[0],e),v(mx,my,f[0]+1,e)]}
      return [v(mx,my,f[0]+.5,f[1]+.5),v(mx,my,t[0]+.5,t[1]+.5)];
    };
    const line=(e,col)=>{c.strokeStyle=col;c.beginPath();c.moveTo(e[0][0],e[0][1]);c.lineTo(e[1][0],e[1][1]);c.stroke()};
    walls.forEach(w=>{
      const f=[w[0],w[1]],t=[w[2],w[3]],e=edge(f,t);line(e,"#e22");
      if(!walls.some(o=>o[0]===w[2]&&o[1]===w[3]&&o[2]===w[0]&&o[3]===w[1])){
        const m=[(e[0][0]+e[1][0])/2,(e[0][1]+e[1][1])/2],p=v(mx,my,f[0]+.5,f[1]+.5),q=v(mx,my,t[0]+.5,t[1]+.5);
        let dx=q[0]-p[0],dy=q[1]-p[1];const L=Math.hypot(dx,dy)||1;dx/=L;dy/=L;m[0]-=dx*14*s;m[1]-=dy*14*s;
        c.fillStyle="#e22";c.beginPath();c.moveTo(m[0]+dx*9*s,m[1]+dy*9*s);c.lineTo(m[0]-dx*4*s-dy*6*s,m[1]-dy*4*s+dx*6*s);c.lineTo(m[0]-dx*4*s+dy*6*s,m[1]-dy*4*s-dx*6*s);c.closePath();c.fill();
      }
    });
    if(hover){c.lineWidth=5;c.globalAlpha=.6;line(edge(hover.a,hover.b),"#f99");c.globalAlpha=1}
  }
  if(Number.isFinite(mx)&&Number.isFinite(my))$("objList").querySelectorAll("details[open]").forEach(r=>{
    const tx=parseFloat((r.querySelector("[data-k=tx]")||{}).value),ty=parseFloat((r.querySelector("[data-k=ty]")||{}).value);
    if(!Number.isFinite(tx)||!Number.isFinite(ty))return;
    const q=v(mx,my,tx+.5,ty+.5);
    c.fillStyle="#fc0";c.strokeStyle="#000";c.lineWidth=2;c.beginPath();c.arc(q[0],q[1],6*s,0,7);c.fill();c.stroke();
  });
  if(!$("showGrid").checked)return;
  const draw1=(ox,oy,col)=>{
    c.strokeStyle=col;c.lineWidth=1;c.globalAlpha=.55;c.beginPath();
    for(let i=0;i<=g.sx;i++){const a=v(ox,oy,i,0),b=v(ox,oy,i,g.sy);c.moveTo(a[0],a[1]);c.lineTo(b[0],b[1])}
    for(let j=0;j<=g.sy;j++){const a=v(ox,oy,0,j),b=v(ox,oy,g.sx,j);c.moveTo(a[0],a[1]);c.lineTo(b[0],b[1])}
    c.stroke();c.globalAlpha=1;c.lineWidth=2;c.beginPath();
    [[0,0],[g.sx,0],[g.sx,g.sy],[0,g.sy]].forEach((p,n)=>{const q=v(ox,oy,p[0],p[1]);n?c.lineTo(q[0],q[1]):c.moveTo(q[0],q[1])});
    c.closePath();c.stroke();
  };
  if(Number.isFinite(mx)&&Number.isFinite(my)){
    draw1(mx,my,"#2b2");
    const poly=(i,j,col)=>{c.strokeStyle=col;c.lineWidth=3;c.beginPath();[[0,0],[1,0],[1,1],[0,1]].forEach((p,n)=>{const q=v(mx,my,i+p[0],j+p[1]);n?c.lineTo(q[0],q[1]):c.moveTo(q[0],q[1])});c.closePath();c.stroke()};
    for(const k in tileState){const [i,j]=k.split(",").map(Number);poly(i,j,tileState[k]===1?"#fc0":"#e22")}
    doorTiles().forEach(d=>poly(d.x,d.y,"#2c2"));
    c.font="bold "+Math.max(8,Math.round(10*s))+"px sans-serif";c.textAlign="center";c.textBaseline="middle";c.lineJoin="round";c.lineWidth=3;
    for(let i=0;i<g.sx;i++)for(let j=0;j<g.sy;j++){const q=v(mx,my,i+.5,j+.5),t=i+","+j;c.strokeStyle="#000";c.strokeText(t,q[0],q[1]);c.fillStyle="#fff";c.fillText(t,q[0],q[1])}
  }
}
document.querySelectorAll("#corners button[data-corner]").forEach(b=>b.onclick=()=>{
  corner=b.dataset.corner;
  const k=info&&info.grid&&info.grid.corners&&info.grid.corners[corner];
  if(k){$("ox").value=k.ox;$("oy").value=k.oy}else log("Floor can't be detected automatically here. Press Pick, then click the floor's "+corner+" point on the map.");
  document.querySelectorAll("#corners button[data-corner]").forEach(x=>x.classList.toggle("sel",x===b));
  if(info)draw();
});
const loupe=document.createElement("canvas");loupe.width=loupe.height=140;
loupe.style.cssText="position:fixed;display:none;width:140px;height:140px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 6px #000;pointer-events:none;z-index:9";
document.body.appendChild(loupe);
function setPick(){$("pickPt").classList.toggle("sel",picking);$("cv").style.cursor=picking?"crosshair":"";if(!picking)loupe.style.display="none"}
$("pickPt").onclick=()=>{picking=!picking;setPick();if(picking)log("Pick mode on: click the floor's "+corner+" point on the map. Press Pick again to stop.")};
$("cv").onmousemove=e=>{
  if(wallMode&&!picking){const h=edgeAt(e),k=x=>x?x.a+"|"+x.b:"";if(k(h)!==k(hover)){hover=h;draw()}return}
  if(!picking)return;
  const cv=$("cv"),r=cv.getBoundingClientRect(),k=cv.width/r.width,x=(e.clientX-r.left)*k,y=(e.clientY-r.top)*k,z=5,h=140/z;
  const c=loupe.getContext("2d");c.fillStyle="#fff";c.fillRect(0,0,140,140);c.imageSmoothingEnabled=false;
  c.drawImage(cv,x-h/2,y-h/2,h,h,0,0,140,140);
  c.strokeStyle="#f0f";c.lineWidth=1;c.beginPath();c.moveTo(70,0);c.lineTo(70,140);c.moveTo(0,70);c.lineTo(140,70);c.stroke();
  loupe.style.display="block";loupe.style.left=Math.min(e.clientX+20,innerWidth-150)+"px";loupe.style.top=Math.max(e.clientY-160,4)+"px";
};
$("cv").onmouseleave=()=>{loupe.style.display="none";if(hover){hover=null;if(info)draw()}};
let rmIdx=[],chOn=null,chDrag=false,tileState={},walls=[],wallMode=false,hover=null;const chImg=new Image(),chSit=new Image();chImg.onload=chSit.onload=()=>info&&draw();
const doorTiles=()=>(info&&info.props&&info.props.doorTiles)||[];
function tileAt(e){
  const g=info&&info.grid;if(!g)return null;
  const r=$("cv").getBoundingClientRect(),sc=r.width/info.viewBox.w,X=(e.clientX-r.left)/sc,Y=(e.clientY-r.top)/sc;
  const u=(X-Number($("ox").value))/(g.bw/2),v=(Y-Number($("oy").value)+g.bh/2)/(g.bh/2);
  return [Math.floor((u+v)/2),Math.floor((u-v)/2)];
}
[$("chBtn"),$("chBtn2")].forEach(b=>b.onclick=()=>{
  const c=b.dataset.c;chOn=chOn===c?null:c;
  $("chBtn").textContent=chOn==="giko"?"Remove Giko":"Add Giko";$("chBtn2").textContent=chOn==="hungry_giko"?"Remove Hungry Giko":"Add Hungry Giko";
  $("chRow").style.display=chOn?"flex":"none";
  if(chOn){chImg.src="/api/char?c="+c+"&t="+T;chSit.src="/api/char?c="+c+"&pose=sitting&t="+T;const g=info&&info.grid;if(g&&!$("chx").value){$("chx").value=Math.floor(g.sx/2);$("chy").value=Math.floor(g.sy/2)}if(!g)log("No grid for this room yet, so the character can't be placed. Set the grid X/Y first.")}
  if(info)draw();
});
$("chx").oninput=$("chy").oninput=()=>info&&draw();
function edgeAt(e){
  const g=info&&info.grid;if(!g)return null;
  const r=$("cv").getBoundingClientRect(),sc=r.width/info.viewBox.w,X=(e.clientX-r.left)/sc,Y=(e.clientY-r.top)/sc;
  const u=(X-Number($("ox").value))/(g.bw/2),v=(Y-Number($("oy").value)+g.bh/2)/(g.bh/2),p=(u+v)/2,q=(u-v)/2;
  const ep=Math.round(p),eq=Math.round(q),dp=Math.abs(p-ep),dq=Math.abs(q-eq);
  if(Math.min(dp,dq)>.25)return null;
  if(dp<=dq){const j=Math.floor(q);return ep>=1&&ep<g.sx&&j>=0&&j<g.sy?{a:[ep-1,j],b:[ep,j]}:null}
  const i=Math.floor(p);return eq>=1&&eq<g.sy&&i>=0&&i<g.sx?{a:[i,eq-1],b:[i,eq]}:null;
}
function cycleWall(h){
  const has=(f,t)=>walls.findIndex(w=>w[0]===f[0]&&w[1]===f[1]&&w[2]===t[0]&&w[3]===t[1]);
  const ab=has(h.a,h.b)>=0,ba=has(h.b,h.a)>=0;
  walls=walls.filter(w=>!((w[0]===h.a[0]&&w[1]===h.a[1]&&w[2]===h.b[0]&&w[3]===h.b[1])||(w[0]===h.b[0]&&w[1]===h.b[1]&&w[2]===h.a[0]&&w[3]===h.a[1])));
  const add=(f,t)=>walls.push([f[0],f[1],t[0],t[1]]);
  if(!ab&&!ba){add(h.a,h.b);add(h.b,h.a)}else if(ab&&ba)add(h.a,h.b);else if(ab)add(h.b,h.a);
}
$("wallBtn").onclick=()=>{wallMode=!wallMode;hover=null;$("wallBtn").classList.toggle("sel",wallMode);$("cv").style.cursor=wallMode?"pointer":"";if(info)draw()};
function chMove(e){
  const g=info&&info.grid;if(!chOn||picking||!g)return;
  const t=tileAt(e);
  $("chx").value=Math.max(0,Math.min(g.sx-1,t[0]));$("chy").value=Math.max(0,Math.min(g.sy-1,t[1]));draw();
}
let objDrag=null;
function openRow(){return $("dragObj").checked?$("objList").querySelector("details[open]"):null}
$("cv").onmousedown=e=>{
  if(picking)return;
  const dr=openRow();if(dr&&info){const ix=dr.querySelector("[data-k=ox]"),iy=dr.querySelector("[data-k=oy]");if(ix&&iy){const r=$("cv").getBoundingClientRect();objDrag={r,sc:r.width/info.viewBox.w,x:e.clientX,y:e.clientY,ox:Number(ix.value)||0,oy:Number(iy.value)||0,ix,iy};e.preventDefault();return}}
  if(wallMode){const h=edgeAt(e);if(h){cycleWall(h);hover=h;draw()}return}
  if(chOn){chDrag=true;chMove(e);e.preventDefault();return}
  const g=info&&info.grid,t=tileAt(e);if(!g||!t||t[0]<0||t[1]<0||t[0]>=g.sx||t[1]>=g.sy||doorTiles().some(d=>d.x===t[0]&&d.y===t[1]))return;
  const k=t.join(","),n=((tileState[k]||0)+1)%3;n?tileState[k]=n:delete tileState[k];draw();
};
addEventListener("mousemove",e=>{if(chDrag)chMove(e);if(objDrag){const d=objDrag;d.ix.value=Math.round((d.ox+(e.clientX-d.x)/d.sc)*100)/100;d.iy.value=Math.round((d.oy+(e.clientY-d.y)/d.sc)*100)/100;draw()}});
addEventListener("mouseup",()=>{chDrag=false;objDrag=null});
$("cv").onclick=e=>{
  if(!picking||!info||!info.grid)return;
  const g=info.grid,r=$("cv").getBoundingClientRect(),sc=r.width/info.viewBox.w;
  const px=(e.clientX-r.left)/sc,py=(e.clientY-r.top)/sc;
  const ij={left:[0,0],top:[0,g.sy],right:[g.sx,g.sy],bottom:[g.sx,0]}[corner];
  $("ox").value=Math.round((px-g.bw/2*(ij[0]+ij[1]))*100)/100;
  $("oy").value=Math.round((py+g.bh/2-g.bh/2*(ij[0]-ij[1]))*100)/100;
  log("Grid "+corner+" corner set to the clicked point. Adjust with the X/Y arrows if needed, then Save grid to file.");
  draw();
};
$("pAnon").onchange=()=>{$("pAnonTxt").textContent=String($("pAnon").checked)};
$("showGrid").onchange=()=>info&&draw();
["ox","oy"].forEach(id=>$(id).oninput=()=>info&&draw());
$("resetOrigin").onclick=()=>{if(info&&info.grid){$("ox").value=info.grid.origin.x;$("oy").value=info.grid.origin.y;draw()}};
$("bgSel").onchange=()=>{bg=$("bgSel").value;load()};
$("openFolder").onclick=async()=>{const d=await api("/api/open?room="+encodeURIComponent($("room").value));log(d.error?d.error:"Opened "+d.folder)};
async function run(act,write){
  const objVal=(row,k)=>{const e=row.querySelector("[data-k="+k+"]");return e&&e.value!==""?Number(e.value):null};
  const objs=[...$("objList").querySelectorAll(".objrow")].map(r=>[Number(r.dataset.i),objVal(r,"tx"),objVal(r,"ty"),objVal(r,"ox"),objVal(r,"oy")]);
  const body={objs,forbidden:walls.map(t=>t.slice()),sit:Object.keys(tileState).filter(k=>tileState[k]===1).map(k=>k.split(",").map(Number)),blocked:Object.keys(tileState).filter(k=>tileState[k]===2).map(k=>k.split(",").map(Number)),props:{id:$("pId").value.trim(),group:$("pGroup").value.trim(),spawn:$("pSpawn").value,slots:parseInt($("pSlots").value,10),anon:$("pAnon").checked},bg,ox:Number($("ox").value),oy:Number($("oy").value),room:$("room").value,action:act,corner,object:$("obj").value,rm:rmIdx,add:[...document.querySelectorAll("#addList input:checked")].map(i=>i.value),keepShapes:!$("remove").checked,write};
  log("Running...");document.querySelectorAll("button").forEach(b=>b.disabled=true);
  const d=await api("/api/run",{method:"POST",headers:{"X-Token":T},body:JSON.stringify(body)});
  document.querySelectorAll("button").forEach(b=>b.disabled=false);
  log(d.error||d.output||"(no output)");return d.error||d.output||"";
}
document.querySelectorAll("button[data-act]").forEach(b=>b.onclick=async()=>{
  if(!info)return;
  const act=b.dataset.act;
  if(act==="save"){const m=await run(act,true);await load();log(m);return}
  if(["crop","all","object","addobj"].includes(act)){const m=await run(act,true);await load();log(m);return}
  await run(act,false);pending=act;$("applyName").textContent=b.textContent;$("apply").style.display="block";
});
$("cancel").onclick=()=>{pending=null;$("apply").style.display="none";log("Cancelled. Nothing changed.")};
$("doApply").onclick=async()=>{
  if(!pending)return;const act=pending;pending=null;$("apply").style.display="none";
  await run(act,true);await load();
};
setInterval(()=>api("/api/ping").catch(()=>{}),3000);
addEventListener("pagehide",()=>navigator.sendBeacon("/api/bye?t="+T));
init();
</script></body></html>`;
