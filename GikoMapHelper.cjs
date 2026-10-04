// Room helper. Interactive (double-click GikoMapHelper.bat) or:
//   node GikoMapHelper.cjs <room id or name> <object.svg | all | background.svg> [--write]
//
//  - object.svg / all : find where the object(s) sit in background.svg, update the offsets in
//                       static/roomcode/<room>.ts, and remove the matching shapes from background.svg
//                       so they are not drawn twice.
//  - grid:<left|top|right|bottom> : move originCoordinates so the walking grid's matching corner sits on
//                       the floor outline's extreme point in background.svg.
//  - background.svg   : crop the document size of background.svg to its content (smaller bitmap in
//                       game), and shift originCoordinates + object offsets in the .ts to match.
// Backups of every file touched are saved to <Desktop>/GikoBackups/<room>/<timestamp>/.
const fs = require("fs");
const path = require("path");
const TOL = 0.05;
const CROP_MARGIN = 2;

function ask(q) {
    process.stdout.write(q);
    const buf = Buffer.alloc(1);
    let line = "";
    while (true) {
        let n;
        try { n = fs.readSync(0, buf, 0, 1, null); } catch (e) { if (e.code === "EAGAIN") continue; if (e.code === "EOF") break; throw e; }
        if (n === 0) break;
        const c = buf.toString();
        if (c === "\n") break;
        if (c !== "\r") line += c;
    }
    return line.trim();
}

class Stop extends Error {}
function fail(msg) { throw new Stop(msg); }
function stopQuietly() { throw new Stop(); }
process.on("uncaughtException", e => {
    if (!(e instanceof Stop)) { console.error(e); process.exit(1); }
    if (e.message) { console.error(e.message); process.exit(1); }
    process.exit(0);
});

const LAYOUTS = [
    { rooms: ["static", "rooms"], code: ["static", "roomcode"], lang: ["static", "scripts", "lang", "en.js"] },   // gikopoi3
    { rooms: ["public", "rooms"], code: ["src", "backend", "rooms"], lang: ["src", "langs", "en.json5"] }          // gikopoi2
];
const layoutOf = d => !d ? null : LAYOUTS.find(l => fs.existsSync(path.join(d, ...l.rooms)) && fs.existsSync(path.join(d, ...l.code)));
const isRepo = d => !!layoutOf(d);
function findRepo() {
    if (process.env.FIT_REPO && isRepo(process.env.FIT_REPO)) return process.env.FIT_REPO;
    for (const start of [process.cwd(), __dirname]) {
        let d = path.resolve(start);
        while (true) {
            if (isRepo(d)) return d;
            const up = path.dirname(d);
            if (up === d) break;
            d = up;
        }
    }
    const saved = path.join(__dirname, "repo-path.txt");
    if (fs.existsSync(saved)) {
        const p = fs.readFileSync(saved, "utf8").trim();
        if (isRepo(p)) return p;
    }
    console.log("Couldn't find a gikopoi folder automatically (put this tool inside one, or enter the path once).");
    const p = ask("Path to the gikopoi folder: ").replace(/^"|"$/g, "");
    if (!isRepo(p)) { console.error("That doesn't look like a gikopoi folder (no static/rooms or public/rooms)."); process.exit(1); }
    fs.writeFileSync(saved, p);
    return p;
}
const REPO = findRepo();
const LAYOUT = layoutOf(REPO);
const round2 = v => Math.round(v * 100) / 100;

// ---------- path / svg helpers ----------

const PARAMS = { m: 2, l: 2, t: 2, h: 1, v: 1, c: 6, s: 4, q: 4, a: 7, z: 0 };
function parsePathPoints(d) {
    const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || [];
    const pts = [];
    let cx = 0, cy = 0, sx = 0, sy = 0, cmd = null, i = 0;
    while (i < tokens.length) {
        if (/[a-zA-Z]/.test(tokens[i])) { cmd = tokens[i++]; }
        if (!cmd) return null;
        const lc = cmd.toLowerCase(), rel = cmd === lc;
        if (!(lc in PARAMS)) return null;
        if (lc === "z") { cx = sx; cy = sy; if (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) return null; continue; }
        const n = PARAMS[lc];
        if (i + n > tokens.length) return null;
        const p = tokens.slice(i, i + n).map(Number);
        if (p.some(isNaN)) return null;
        i += n;
        const ox = rel ? cx : 0, oy = rel ? cy : 0;
        if (lc === "h") { cx = ox + p[0]; pts.push([cx, cy]); }
        else if (lc === "v") { cy = oy + p[0]; pts.push([cx, cy]); }
        else if (lc === "a") { cx = ox + p[5]; cy = oy + p[6]; pts.push([cx, cy]); }
        else {
            for (let k = 0; k < n; k += 2) pts.push([ox + p[k], oy + p[k + 1]]);
            cx = pts[pts.length - 1][0]; cy = pts[pts.length - 1][1];
            if (lc === "m") { sx = cx; sy = cy; cmd = rel ? "l" : "L"; }
        }
    }
    return pts;
}

function parseShapes(svg) {
    const out = [];
    for (const m of svg.matchAll(/<path\b[^>]*?\/?>/g)) {
        const tag = m[0];
        const d = tag.match(/\sd="([^"]+)"/);
        if (!d) continue;
        const pts = parsePathPoints(d[1]);
        if (!pts || !pts.length) continue;
        const style = (tag.match(/\sstyle="([^"]*)"/) || [])[1] || "";
        out.push({ start: m.index, end: m.index + tag.length, pts, style });
    }
    return out;
}

function matchesAt(o, b, dx, dy) {
    if (o.pts.length !== b.pts.length) return false;
    return o.pts.every((p, k) => Math.abs(b.pts[k][0] - p[0] - dx) < TOL && Math.abs(b.pts[k][1] - p[1] - dy) < TOL);
}

function rootTag(svg) {
    const m = svg.match(/<svg\b[^>]*>/);
    return m ? m[0] : null;
}

function setAttr(tag, name, value) {
    const re = new RegExp(`(\\s${name}=)"[^"]*"`);
    if (re.test(tag)) return tag.replace(re, `$1"${value}"`);
    return tag.replace(/<svg\b/, `<svg ${name}="${value}"`);
}

// document box in svg user units: {x, y, w, h}
function docBox(svg) {
    const tag = rootTag(svg);
    if (!tag) return null;
    const vb = tag.match(/\sviewBox="([^"]+)"/);
    if (vb) {
        const [x, y, w, h] = vb[1].trim().split(/[\s,]+/).map(Number);
        if ([x, y, w, h].every(isFinite)) return { x, y, w, h };
    }
    const w = parseFloat((tag.match(/\swidth="([^"]+)"/) || [])[1]);
    const h = parseFloat((tag.match(/\sheight="([^"]+)"/) || [])[1]);
    return isFinite(w) && isFinite(h) ? { x: 0, y: 0, w, h } : null;
}

// ---------- bounding box (handles transforms, <use>, <rect> etc.) ----------

function parseTransform(str) {
    let m = [1, 0, 0, 1, 0, 0];
    const mul = (a, b) => [
        a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
    for (const t of str.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
        const a = t[2].trim().split(/[\s,]+/).map(Number);
        let n = null;
        switch (t[1]) {
            case "matrix": n = a; break;
            case "translate": n = [1, 0, 0, 1, a[0], a[1] || 0]; break;
            case "scale": n = [a[0], 0, 0, a.length > 1 ? a[1] : a[0], 0, 0]; break;
            case "rotate": {
                const r = a[0] * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
                n = [c, s, -s, c, 0, 0];
                if (a.length === 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]);
                break;
            }
            case "skewX": n = [1, 0, Math.tan(a[0] * Math.PI / 180), 1, 0, 0]; break;
            case "skewY": n = [1, Math.tan(a[0] * Math.PI / 180), 0, 1, 0, 0]; break;
            default: throw new Error("unsupported transform " + t[1]);
        }
        m = mul(m, n);
    }
    return m;
}
const mulM = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];

// returns {minX,minY,maxX,maxY} or throws Error with a reason
function contentBounds(svg) {
    const NON_RENDERED = new Set(["defs", "clipPath", "mask", "symbol", "pattern", "marker", "style", "title", "desc", "metadata"]);
    if (/\sfilter=|filter:/.test(svg)) throw new Error("the svg uses filters (blur/shadows), whose size can't be measured");
    if (/<foreignObject\b/.test(svg)) throw new Error("the svg contains foreignObject");
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const add = (m, x, y) => {
        const px = m[0] * x + m[2] * y + m[4], py = m[1] * x + m[3] * y + m[5];
        box.minX = Math.min(box.minX, px); box.maxX = Math.max(box.maxX, px);
        box.minY = Math.min(box.minY, py); box.maxY = Math.max(box.maxY, py);
    };
    const addRect = (m, x, y, w, h) => { add(m, x, y); add(m, x + w, y); add(m, x, y + h); add(m, x + w, y + h); };
    const num = v => parseFloat(v);
    const stack = [{ matrix: [1, 0, 0, 1, 0, 0], skip: false }];

    for (const m of svg.matchAll(/<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:.-]*)\b([^>]*)>/g)) {
        if (m[0].startsWith("<!--")) continue;
        if (m[0].startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
        const name = m[1], attrs = {};
        for (const a of m[2].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
        const parent = stack[stack.length - 1];
        const matrix = attrs.transform ? mulM(parent.matrix, parseTransform(attrs.transform)) : parent.matrix;
        const skip = parent.skip || NON_RENDERED.has(name);
        if (!skip) {
            if (name === "path" && attrs.d) {
                const pts = parsePathPoints(attrs.d);
                if (!pts) throw new Error("couldn't parse a path");
                pts.forEach(([x, y]) => add(matrix, x, y));
            } else if (name === "rect" || name === "image") {
                addRect(matrix, num(attrs.x) || 0, num(attrs.y) || 0, num(attrs.width), num(attrs.height));
            } else if (name === "use") {
                if (!isFinite(num(attrs.width)) || !isFinite(num(attrs.height))) throw new Error("a <use> element has no width/height");
                addRect(matrix, num(attrs.x) || 0, num(attrs.y) || 0, num(attrs.width), num(attrs.height));
            } else if (name === "text") {
                const fs0 = num((attrs.style || "").match(/font-size:s*([d.]+)/)?.[1] || attrs["font-size"]) || 16;
                const content = svg.slice(m.index + m[0].length).match(/^[^<]*/)[0].trim();
                addRect(matrix, num(attrs.x) || 0, (num(attrs.y) || 0) - fs0, Math.max(1, content.length) * fs0 * 0.9, fs0 * 1.4);
            } else if (name === "circle") {
                const [cx, cy, r] = [num(attrs.cx) || 0, num(attrs.cy) || 0, num(attrs.r)];
                addRect(matrix, cx - r, cy - r, 2 * r, 2 * r);
            } else if (name === "ellipse") {
                const [cx, cy, rx, ry] = [num(attrs.cx) || 0, num(attrs.cy) || 0, num(attrs.rx), num(attrs.ry)];
                addRect(matrix, cx - rx, cy - ry, 2 * rx, 2 * ry);
            } else if (name === "line") {
                add(matrix, num(attrs.x1), num(attrs.y1)); add(matrix, num(attrs.x2), num(attrs.y2));
            } else if (name === "polygon" || name === "polyline") {
                const p = (attrs.points || "").trim().split(/[\s,]+/).map(Number);
                for (let k = 0; k + 1 < p.length; k += 2) add(matrix, p[k], p[k + 1]);
            }
        }
        if (!m[0].endsWith("/>")) stack.push({ matrix, skip });
    }
    if (!isFinite(box.minX)) throw new Error("no drawable content found");
    let maxStroke = 0;
    for (const s of svg.matchAll(/stroke-width(?::|=")\s*([\d.]+)/g)) maxStroke = Math.max(maxStroke, Number(s[1]));
    box.pad = maxStroke + CROP_MARGIN;
    return box;
}

// ---------- .ts helpers ----------

const OFFSET_ENTRY = f => {
    const file = f.replace(/\./g, "\\.");
    return [
        new RegExp(`(offset:\\s*\\{\\s*x:\\s*)-?[\\d.]+(\\s*,\\s*y:\\s*)-?[\\d.]+(\\s*\\}[^}\\n]*url:\\s*"${file}")`),
        new RegExp(`(url:\\s*"${file}"[^}\\n]*offset:\\s*\\{\\s*x:\\s*)-?[\\d.]+(\\s*,\\s*y:\\s*)-?[\\d.]+()`)
    ];
};
const hasEntry = (ts, f) => OFFSET_ENTRY(f).some(re => re.test(ts));
function setEntryOffset(ts, f, ox, oy) {
    for (const re of OFFSET_ENTRY(f)) if (re.test(ts)) return ts.replace(re, `$1${ox}$2${oy}$3`);
    return ts;
}

function backupRoot() {
    const home = require("os").homedir();
    const desktop = [path.join(home, "Desktop"), path.join(home, "OneDrive", "Desktop")].find(d => fs.existsSync(d)) || home;
    return path.join(desktop, "GikoBackups");
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
function backup(file) {
    if (process.env.FIT_NOBACKUP) return file;
    const backupDir = path.join(backupRoot(), roomId, stamp);
    fs.mkdirSync(backupDir, { recursive: true });
    const dest = path.join(backupDir, path.basename(file));
    if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
    return dest;
}

// ---------- room + menu ----------

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const keepShapes = process.argv.includes("--keep-shapes");
const cornerFlag = (process.argv.find(a => a.startsWith("--corner=")) || "").slice(9);
const infoMode = process.argv.includes("--info");
let write = process.argv.includes("--write");
let interactive = args.length < 2;
let batchMode = false, batchRemove = !keepShapes;

const roomsDir = path.join(REPO, ...LAYOUT.rooms);
const roomNames = {};
try {
    const en = fs.readFileSync(path.join(REPO, ...LAYOUT.lang), "utf8");
    for (const m of en.matchAll(/^\s*(\w+)\s*:\s*"([^"]*)"/gm)) roomNames[m[1]] = m[2];
} catch (e) { /* names are optional */ }
function resolveRoom(input) {
    const want = input.trim().toLowerCase();
    const dir = fs.readdirSync(roomsDir).find(d => d.toLowerCase() === want);
    if (dir) return dir;
    for (const [id, name] of Object.entries(roomNames)) {
        if (name.toLowerCase() === want && fs.existsSync(path.join(roomsDir, id))) return id;
    }
    return null;
}

if (infoMode && !args[0]) {
    const codeIds = new Set(fs.readdirSync(path.join(REPO, ...LAYOUT.code)).filter(f => f.endsWith(".ts")).map(f => f.slice(0, -3)));
    const rooms = fs.readdirSync(roomsDir, { withFileTypes: true }).filter(d => d.isDirectory() && codeIds.has(d.name))
        .map(d => ({ id: d.name, name: roomNames[d.name] || d.name }));
    console.log(JSON.stringify({ repo: REPO, layout: LAYOUT, rooms }));
    process.exit(0);
}

let roomInput = args[0];
if (!roomInput) {
    const custom = fs.readdirSync(path.join(REPO, ...LAYOUT.code)).filter(f => f.endsWith(".ts")).map(f => f.slice(0, -3))
        .filter(id => fs.existsSync(path.join(roomsDir, id)));
    const showList = custom.length > 0;
    if (showList) {
        console.log("Rooms with their own code file:");
        const cells = custom.map((id, i) => `${String(i + 1).padStart(String(custom.length).length)}) ${roomNames[id] ? `${roomNames[id]} (${id})` : id}`);
        const colWidth = Math.max(...cells.map(c => c.length)) + 3;
        const cols = Math.max(1, Math.floor(((process.stdout.columns || 80) - 2) / colWidth));
        const rows = Math.ceil(cells.length / cols);
        for (let r = 0; r < rows; r++) {
            let line = "  ";
            for (let c = 0; c < cols; c++) { const cell = cells[c * rows + r]; if (cell) line += cell.padEnd(colWidth); }
            console.log(line.trimEnd());
        }
    }
    roomInput = ask(showList ? "Pick a number, or type any room id or name (empty to quit): " : "Room id or name (empty to quit): ");
    if (showList && /^\d+$/.test(roomInput) && custom[Number(roomInput) - 1]) roomInput = custom[Number(roomInput) - 1];
}
if (!roomInput) process.exit(99);
const roomId = resolveRoom(roomInput);
if (!roomId) fail(`No room found for "${roomInput}".`);
const roomDir = path.join(roomsDir, roomId);
const allSvgs = fs.readdirSync(roomDir).filter(f => f.toLowerCase().endsWith(".svg"));
const bgFlag = (process.argv.find(a => a.startsWith("--bg=")) || "").slice(5);
const bgFile = allSvgs.includes(bgFlag) ? bgFlag
    : allSvgs.includes("background.svg") ? "background.svg"
    : allSvgs.find(f => f.toLowerCase().startsWith("background")) || null;
const bgPath = path.join(roomDir, bgFile || "background.svg");
const tsPath = path.join(REPO, ...LAYOUT.code, roomId + ".ts");
if (!infoMode) console.log(`Room: ${roomId}`);

const allObjects = allSvgs.filter(f => f !== bgFile && !f.toLowerCase().startsWith("background"));

const CORNERS = ["left", "top", "right", "bottom"];
function askCorner() {
    console.log("Pin the grid corner to the floor's:");
    console.log("  1) leftmost point   2) topmost point   3) rightmost point   4) bottommost point");
    return CORNERS[Number(ask("Pick a number: ")) - 1];
}

let selection = args[1], batchCorner = CORNERS.includes(cornerFlag) ? cornerFlag : null;
if (!selection && !infoMode) {
    console.log("Options:");
    console.log("  1) Do everything   - runs these in order (asks a few questions, then one final confirmation):");
    console.log(`                       a) fit every object: find it in background.svg and update its offset in ${roomId}.ts`);
    console.log("                          (optionally removes the matching shapes from background.svg so they aren't drawn twice)");
    console.log("                       b) crop background.svg's document size to its content, shifting originCoordinates + offsets");
    console.log("                       c) align the walking grid to the floor outline (you choose which corner)");
    console.log("                       Only offsets/origin in the .ts and background.svg change; originals are backed up first.");
    console.log("  2) background.svg  - crops the document size to fit the content, for optimization");
    console.log("                       (also shifts originCoordinates and object offsets in the .ts to match)");
    console.log("  3) Align grid      - moves the walking grid (originCoordinates) to the floor outline of background.svg");
    console.log("  4) All objects     - fit every object listed below");
    allObjects.forEach((f, i) => console.log(`  ${i + 5}) ${f}`));
    const pick = Number(ask("Pick a number: "));
    if (pick === 1) {
        selection = "everything";
        batchCorner = askCorner();
        if (!batchCorner) fail("Invalid choice.");
        batchRemove = ask("Also remove the fitted objects' shapes from background.svg? (y/n): ").toLowerCase() === "y";
    }
    else if (pick === 2) selection = "background.svg";
    else if (pick === 3) {
        const c = askCorner();
        selection = c && "grid:" + c;
    }
    else if (pick === 4) selection = "all";
    else selection = allObjects[pick - 5];
    if (!selection) fail("Invalid choice.");
}
if (!infoMode && selection !== "props" && !fs.existsSync(bgPath)) fail("No background svg found in " + roomDir + " (pick one with --bg=file.svg).");
if (!fs.existsSync(tsPath)) fail("Room code not found: " + tsPath);

// ---------- crop background ----------

function cropBackground() {
    let bgSvg = fs.readFileSync(bgPath, "utf8");
    const doc = docBox(bgSvg);
    if (!doc) fail("Couldn't read the document size of background.svg.");
    let b;
    try { b = contentBounds(bgSvg); } catch (e) { fail("Can't crop automatically: " + e.message + ". Nothing changed."); }

    const minX = Math.max(doc.x, Math.floor(b.minX - b.pad)), minY = Math.max(doc.y, Math.floor(b.minY - b.pad));
    const maxX = Math.min(doc.x + doc.w, Math.ceil(b.maxX + b.pad)), maxY = Math.min(doc.y + doc.h, Math.ceil(b.maxY + b.pad));
    const nw = maxX - minX, nh = maxY - minY;
    const shiftX = minX - doc.x, shiftY = minY - doc.y;
    const saved = Math.round((1 - (nw * nh) / (doc.w * doc.h)) * 100);

    console.log(`Current document: ${doc.w}x${doc.h}`);
    console.log(`Content bounds:   x ${round2(b.minX)}..${round2(b.maxX)}, y ${round2(b.minY)}..${round2(b.maxY)}`);
    console.log(`New document:     ${nw}x${nh}  (${saved}% fewer pixels)`);
    console.log(`Shift:            originCoordinates and all object offsets will change by x ${-shiftX}, y ${-shiftY}`);
    if (nw >= doc.w && nh >= doc.h) { console.log("Nothing to crop."); stopQuietly(); }
    console.log("Tip: check the result visually in the game afterwards.");

    let ts = fs.readFileSync(tsPath, "utf8");
    const originRe = /(originCoordinates:\s*\{\s*x:\s*)(-?[\d.]+)(\s*,\s*y:\s*)(-?[\d.]+)/;
    if (!originRe.test(ts)) fail("Couldn't find originCoordinates in " + tsPath + ". Nothing changed.");

    if (interactive) write = ask("Crop background.svg and shift the coordinates? (y/n): ").toLowerCase() === "y";
    if (!write) { console.log("Nothing changed. Use --write (or answer y) to apply."); stopQuietly(); }

    const bgBackup = backup(bgPath);
    const tsBackup = backup(tsPath);

    let tag = rootTag(bgSvg), newTag = tag;
    newTag = setAttr(newTag, "viewBox", `${minX} ${minY} ${nw} ${nh}`);
    newTag = setAttr(newTag, "width", nw);
    newTag = setAttr(newTag, "height", nh);
    bgSvg = bgSvg.replace(tag, () => newTag);

    ts = ts.replace(originRe, (m, a, x, c, y) => `${a}${round2(Number(x) - shiftX)}${c}${round2(Number(y) - shiftY)}`);
    ts = ts.replace(/(offset:\s*\{\s*x:\s*)(-?[\d.]+)(\s*,\s*y:\s*)(-?[\d.]+)/g,
        (m, a, x, c, y) => `${a}${round2(Number(x) - shiftX)}${c}${round2(Number(y) - shiftY)}`);

    fs.writeFileSync(bgPath, bgSvg);
    fs.writeFileSync(tsPath, ts);
    console.log(`Cropped to ${nw}x${nh}. Backups: ${bgBackup}\n           ${tsBackup}`);
}

// ---------- align grid ----------

function findFloor(svg, doc) {
    const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:.-]*)\b([^>]*)>/g;
    const stack = [{ mat: [1, 0, 0, 1, 0, 0], skip: false }];
    let best = null, m;
    while ((m = re.exec(svg))) {
        if (m[0].startsWith("<!--")) continue;
        if (m[0].startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
        const attrs = {};
        for (const q of m[2].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[q[1]] = q[2];
        const p = stack[stack.length - 1];
        const mat = attrs.transform ? mulM(p.mat, parseTransform(attrs.transform)) : p.mat;
        const skip = p.skip || ["defs", "clipPath", "mask"].includes(m[1]);
        if (m[1] === "path" && attrs.d && !skip && !/[csqatCSQAT]/.test(attrs.d)) {
            const raw = parsePathPoints(attrs.d);
            if (raw && raw.length >= 3) {
                const pts = raw.map(([x, y]) => [mat[0] * x + mat[2] * y + mat[4] - doc.x, mat[1] * x + mat[3] * y + mat[5] - doc.y]);
                let iso = true;
                for (let i = 0; i < pts.length && iso; i++) {
                    const a = pts[i], b = pts[(i + 1) % pts.length];
                    const dx = b[0] - a[0], dy = b[1] - a[1];
                    if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) continue;
                    if (Math.abs(dx) < 0.05 || Math.abs(Math.abs(dy / dx) - 0.5) > 0.02) iso = false;
                }
                if (iso) {
                    const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
                    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
                    if (!best || area > best.area) best = { pts, area, id: attrs.id || "(unnamed)" };
                }
            }
        }
        if (!m[0].endsWith("/>")) stack.push({ mat, skip });
    }
    return best;
}

const originRe = /(originCoordinates:\s*\{\s*x:\s*)(-?[\d.]+)(\s*,\s*y:\s*)(-?[\d.]+)/;

function gridInfo() {
    const bgSvg = fs.readFileSync(bgPath, "utf8");
    const doc = docBox(bgSvg) || { x: 0, y: 0, w: 0, h: 0 };
    const ts = fs.readFileSync(tsPath, "utf8");
    const sizeM = ts.match(/size:\s*\{\s*x:\s*(\d+)\s*,\s*y:\s*(\d+)/);
    if (!sizeM) fail("Couldn't find the room size in " + tsPath);
    const sx = Number(sizeM[1]), sy = Number(sizeM[2]);
    const bwM = ts.match(/blockWidth:\s*([\d.]+)/), bhM = ts.match(/blockHeight:\s*([\d.]+)/);
    const bw = bwM ? Number(bwM[1]) : 80, bh = bhM ? Number(bhM[1]) : 40;
    const om = ts.match(originRe);
    if (!om) fail("Couldn't find originCoordinates in " + tsPath);

    const floor = findFloor(bgSvg, doc);
    const origin = { x: Number(om[2]), y: Number(om[4]) };
    if (!floor) return { floorId: null, sx, sy, bw, bh, origin, corners: null };
    const xs = floor.pts.map(p => p[0]), ys = floor.pts.map(p => p[1]);
    const ext = {
        left: [Math.min(...xs), ys[xs.indexOf(Math.min(...xs))]],
        right: [Math.max(...xs), ys[xs.indexOf(Math.max(...xs))]],
        top: [xs[ys.indexOf(Math.min(...ys))], Math.min(...ys)],
        bottom: [xs[ys.indexOf(Math.max(...ys))], Math.max(...ys)]
    };
    const gridIJ = { left: [0, 0], top: [0, sy], right: [sx, sy], bottom: [sx, 0] };
    const vert = (ox, oy, [i, j]) => [ox + bw / 2 * (i + j), oy - bh / 2 + bh / 2 * (i - j)];
    const corners = {};
    for (const k of Object.keys(gridIJ)) {
        const [ci, cj] = gridIJ[k];
        const ox = round2(ext[k][0] - bw / 2 * (ci + cj));
        const oy = round2(ext[k][1] + bh / 2 - bh / 2 * (ci - cj));
        const dev = {};
        for (const o of Object.keys(gridIJ)) if (o !== k) {
            const v = vert(ox, oy, gridIJ[o]);
            dev[o] = round2(Math.hypot(v[0] - ext[o][0], v[1] - ext[o][1]));
        }
        corners[k] = { ox, oy, dev };
    }
    return { floorId: floor.id, sx, sy, bw, bh, origin: { x: Number(om[2]), y: Number(om[4]) }, corners };
}

const MASK = "\u0000OFFSET\u0000";
function parseObjectText(text) {
    const url = text.match(/url:\s*"([^"]+)"/);
    if (!url) return null;
    const masked = text.replace(/offset:\s*\{[^}]*\}/, MASK);
    const tx = masked.match(/\bx:\s*(-?[\d.]+)/), ty = masked.match(/\by:\s*(-?[\d.]+)/);
    const off = text.match(/offset:\s*\{\s*x:\s*(-?[\d.]+)\s*,\s*y:\s*(-?[\d.]+)/);
    const fr = text.match(/"prefix":\s*"([^"]*)",\s*amount:\s*(\d+),\s*suffix:\s*"([^"]*)"/), dl = text.match(/frameDelay:\s*(\d+)/);
    const anim = fr ? { prefix: fr[1], amount: Number(fr[2]), suffix: fr[3], delay: dl ? Number(dl[1]) : 80 } : null;
    return { anim, url: url[1], tx: tx ? Number(tx[1]) : null, ty: ty ? Number(ty[1]) : null, ox: off ? Number(off[1]) : null, oy: off ? Number(off[2]) : null };
}

function readObjects(ts) {
    const m = ts.match(/\bobjects:\s*\[/);
    if (!m) return [];
    const out = [];
    for (let i = m.index + m[0].length; i < ts.length; i++) {
        if (ts[i] === "]") break;
        if (ts[i] !== "{") continue;
        let d = 0, j = i;
        for (; j < ts.length; j++) { if (ts[j] === "{") d++; else if (ts[j] === "}" && --d === 0) break; }
        const text = ts.slice(i, j + 1), o = parseObjectText(text);
        if (o) out.push({ ...o, start: i, end: j + 1, text });
        i = j;
    }
    return out;
}

function applyObject(text, o) {
    const offM = text.match(/offset:\s*\{[^}]*\}/);
    let t = text.replace(/offset:\s*\{[^}]*\}/, MASK);
    if (o.tx != null) t = t.replace(/(\bx:\s*)-?[\d.]+/, (m, a) => a + o.tx);
    if (o.ty != null) t = t.replace(/(\by:\s*)-?[\d.]+/, (m, a) => a + o.ty);
    if (offM && o.ox != null && o.oy != null) {
        const off = offM[0].replace(/(\bx:\s*)-?[\d.]+/, (m, a) => a + o.ox).replace(/(\by:\s*)-?[\d.]+/, (m, a) => a + o.oy);
        t = t.replace(MASK, () => off);
    } else if (offM) t = t.replace(MASK, () => offM[0]);
    return t;
}

function listSpan(ts, key) {
    const m = ts.match(new RegExp("\\b" + key + ":\\s*\\["));
    if (!m) return null;
    const open = m.index + m[0].length - 1;
    let depth = 0, i = open;
    for (; i < ts.length; i++) {
        if (ts[i] === "[") depth++;
        else if (ts[i] === "]" && --depth === 0) break;
    }
    return { open, close: i };
}
const ITEM = /\{[^{}]*\}[ \t]*,?[ \t]*(\/\/[^\n]*)?/g;
function readTiles(ts, key) {
    const sp = listSpan(ts, key);
    if (!sp) return [];
    return [...ts.slice(sp.open + 1, sp.close).matchAll(ITEM)].map(m => ({ x: Number((m[0].match(/\bx:\s*(-?\d+)/) || [])[1]), y: Number((m[0].match(/\by:\s*(-?\d+)/) || [])[1]), comment: m[1] || "" })).filter(t => Number.isFinite(t.x) && Number.isFinite(t.y));
}
function readForbidden(ts) {
    const sp = listSpan(ts, "forbiddenMovements");
    if (!sp) return [];
    return [...ts.slice(sp.open + 1, sp.close).matchAll(/\{[^{}]*\}/g)].map(m => { const g = k => Number((m[0].match(new RegExp(k + ":\\s*(-?\\d+)")) || [])[1]); return { xFrom: g("xFrom"), yFrom: g("yFrom"), xTo: g("xTo"), yTo: g("yTo") }; });
}
function readDoorTiles(ts) {
    const d = ts.search(/doors:\s*\{/);
    if (d < 0) return [];
    return [...ts.slice(d).matchAll(/(\w+):\s*\{\s*x:\s*(-?\d+),\s*y:\s*(-?\d+)/g)].map(m => ({ name: m[1], x: Number(m[2]), y: Number(m[3]) }));
}
function setTiles(ts, key, list, changes) {
    const cur = readTiles(ts, key);
    const sp = listSpan(ts, key);
    const want = new Set(list.map(t => t[0] + "," + t[1])), have = new Set(cur.map(t => t.x + "," + t.y));
    if (want.size === have.size && [...want].every(k => have.has(k))) return ts;
    if (!sp) fail("Couldn't find " + key + " in " + tsPath);
    const body = ts.slice(sp.open + 1, sp.close);
    const indent = (body.match(/\n([ \t]*)\S/) || [])[1] || "        ";
    const closeIndent = (ts.slice(0, sp.close).match(/\n([ \t]*)$/) || [])[1] || "    ";
    const lines = cur.filter(t => want.has(t.x + "," + t.y));
    for (const k of want) if (!have.has(k)) { const [x, y] = k.split(",").map(Number); lines.push({ x, y, comment: "" }); }
    const text = lines.length ? "\n" + lines.map(t => indent + "{ x: " + t.x + ", y: " + t.y + " }," + (t.comment ? " " + t.comment : "")).join("\n") + "\n" + closeIndent : "";
    changes.push(key + ": " + [...have].filter(k => !want.has(k)).map(k => "-(" + k + ")").concat([...want].filter(k => !have.has(k)).map(k => "+(" + k + ")")).join(" "));
    return ts.slice(0, sp.open + 1) + text + ts.slice(sp.close);
}

function setForbidden(ts, list, changes) {
    const sp = listSpan(ts, "forbiddenMovements");
    const cur = readForbidden(ts);
    const k4 = t => [t.xFrom, t.yFrom, t.xTo, t.yTo].join(",");
    const want = new Set(list.map(t => t.join(","))), have = new Set(cur.map(k4));
    const gone = [...have].filter(k => !want.has(k)), added = [...want].filter(k => !have.has(k));
    if (!gone.length && !added.length) return ts;
    if (!sp) fail("Couldn't find forbiddenMovements in " + tsPath);
    let body = ts.slice(sp.open + 1, sp.close);
    const items = [...body.matchAll(/\{[^{}]*\}[ \t]*,?/g)].map(m => ({ m, t: (() => { const g = k => Number((m[0].match(new RegExp(k + ":\\s*(-?\\d+)")) || [])[1]); return [g("xFrom"), g("yFrom"), g("xTo"), g("yTo")].join(","); })() }));
    for (const it of items.reverse()) {
        if (!gone.includes(it.t)) continue;
        let a = it.m.index, b = a + it.m[0].length;
        const ls = body.lastIndexOf("\n", a - 1) + 1, le = body.indexOf("\n", b);
        if (!body.slice(ls, a).trim() && (le < 0 || !body.slice(b, le).trim())) { a = ls; b = le < 0 ? body.length : le + 1; }
        body = body.slice(0, a) + body.slice(b);
    }
    if (added.length) {
        const indent = (ts.slice(sp.open + 1, sp.close).match(/\n([ \t]*)\{/) || [])[1] || "        ";
        const closeIndent = (ts.slice(0, sp.close).match(/\n([ \t]*)$/) || [])[1] || "    ";
        let head = body.replace(/\s+$/, "");
        if (head.trim() && !head.trimEnd().endsWith(",")) head += ",";
        body = head + "\n" + added.map(k => { const [a, b, c, d] = k.split(","); return indent + "{ xFrom: " + a + ", yFrom: " + b + ", xTo: " + c + ", yTo: " + d + " },"; }).join("\n") + "\n" + closeIndent;
    }
    changes.push("forbiddenMovements: " + gone.map(k => "-(" + k + ")").concat(added.map(k => "+(" + k + ")")).join(" "));
    return ts.slice(0, sp.open + 1) + body + ts.slice(sp.close);
}

function readProps(ts) {
    const str = k => (ts.match(new RegExp(k + ":\\s*\"([^\"]*)\"")) || [])[1];
    const num = ts.match(/streamSlotCount:\s*(\d+)/), anon = ts.match(/forcedAnonymous:\s*(true|false)/);
    const doors = [];
    const dStart = ts.search(/doors:\s*\{/);
    if (dStart >= 0) {
        let depth = 0, i = ts.indexOf("{", dStart);
        const from = i;
        for (; i < ts.length; i++) {
            if (ts[i] === "{") depth++;
            else if (ts[i] === "}" && --depth === 0) break;
        }
        let d2 = 0, key = "";
        for (const m of ts.slice(from, i).matchAll(/[{}]|(?:^|[,{\s])(\w+)\s*:\s*\{/g)) {
            if (m[0] === "{") d2++; else if (m[0] === "}") d2--;
            else if (m[1] && d2 === 1) doors.push(m[1]);
            if (m[1]) d2++;
        }
    }
    return { id: str("id"), group: str("group"), spawnPoint: str("spawnPoint"), streamSlotCount: num ? Number(num[1]) : null, forcedAnonymous: anon ? anon[1] === "true" : false, diagonal: /objectRenderSortMethod:s*"diagonal_scan"/.test(ts), doors, doorTiles: readDoorTiles(ts), sit: readTiles(ts, "sit"), blocked: readTiles(ts, "blocked"), forbidden: readForbidden(ts) };
}

function setProps() {
    const svgWrites = [];
    const flag = k => { const a = process.argv.find(x => x.startsWith("--" + k + "=")); return a === undefined ? undefined : a.slice(k.length + 3); };
    const SAFE = /^[\w.\- ]+$/;
    let ts = fs.readFileSync(tsPath, "utf8");
    const before = readProps(ts), changes = [];
    const setStr = (key, flagName, val) => {
        if (val === undefined || val === before[key]) return;
        if (!SAFE.test(val)) fail(key + " may only contain letters, digits, spaces, dots, dashes and underscores.");
        const re = new RegExp("(\\b" + key + ":\\s*\")[^\"]*(\")");
        if (!re.test(ts)) fail("Couldn't find " + key + " in " + tsPath);
        ts = ts.replace(re, (m, a, c) => a + val + c);
        changes.push(key + ": " + before[key] + "  ->  " + val);
    };
    setStr("id", "id", flag("id"));
    setStr("group", "group", flag("group"));
    setStr("spawnPoint", "spawn", flag("spawn"));
    const slots = flag("slots");
    if (slots !== undefined && Number(slots) !== before.streamSlotCount) {
        if (!/^\d{1,3}$/.test(slots)) fail("Stream slots must be a whole number.");
        if (!/streamSlotCount:/.test(ts)) fail("Couldn't find streamSlotCount in " + tsPath);
        ts = ts.replace(/(streamSlotCount:\s*)\d+/, (m, a) => a + slots);
        changes.push("streamSlotCount: " + before.streamSlotCount + "  ->  " + slots);
    }
    const anon = flag("anon");
    if (anon !== undefined && (anon === "true") !== before.forcedAnonymous) {
        if (anon !== "true" && anon !== "false") fail("Forced anonymous must be true or false.");
        if (/forcedAnonymous:/.test(ts)) ts = ts.replace(/(forcedAnonymous:\s*)(true|false)/, (m, a) => a + anon);
        else if (/streamSlotCount:\s*\d+/.test(ts)) ts = ts.replace(/(streamSlotCount:\s*\d+)(,?)/, (m, a, c) => a + ",\n    forcedAnonymous: " + anon + c);
        else fail("Couldn't find where to add forcedAnonymous in " + tsPath);
        changes.push("forcedAnonymous: " + before.forcedAnonymous + "  ->  " + anon);
    }
    const originFlag = flag("origin");
    if (originFlag !== undefined) {
        const [nx, ny] = originFlag.split(",").map(Number);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) fail("Use --origin=x,y with numbers.");
        const om = ts.match(originRe);
        if (!om) fail("Couldn't find originCoordinates in " + tsPath);
        if (Number(om[2]) !== nx || Number(om[4]) !== ny) {
            ts = ts.replace(originRe, (m, a, x, c, y) => a + nx + c + ny);
            changes.push("originCoordinates: " + om[2] + ", " + om[4] + "  ->  " + nx + ", " + ny);
        }
    }
    for (const key of ["sit", "blocked"]) {
        const v = flag(key);
        if (v === undefined) continue;
        let list; try { list = JSON.parse(v); } catch (e) { fail("Bad --" + key + " value."); }
        if (!Array.isArray(list) || !list.every(t => Array.isArray(t) && t.length === 2 && t.every(Number.isInteger))) fail("--" + key + " must be a list of [x,y] pairs.");
        ts = setTiles(ts, key, list, changes);
    }
    const forbFlag = flag("forbidden");
    if (forbFlag !== undefined) {
        let list; try { list = JSON.parse(forbFlag); } catch (e) { fail("Bad --forbidden value."); }
        if (!Array.isArray(list) || !list.every(t => Array.isArray(t) && t.length === 4 && t.every(Number.isInteger))) fail("--forbidden must be a list of [xFrom,yFrom,xTo,yTo].");
        ts = setForbidden(ts, list, changes);
    }
    const objsFlag = flag("objs");
    if (objsFlag !== undefined) {
        let list; try { list = JSON.parse(objsFlag); } catch (e) { fail("Bad --objs value."); }
        const cur = readObjects(ts);
        const edits = [];
        for (const [i, tx, ty, ox, oy] of list) {
            const c = cur[i];
            if (!c) fail("Object " + i + " not found.");
            const nn = { tx, ty, ox, oy };
            if (![tx, ty, ox, oy].every(v => v === null || Number.isFinite(v))) fail("Object values must be numbers.");
            const diffs = ["tx", "ty", "ox", "oy"].filter(k => nn[k] !== null && c[k] !== null && nn[k] !== c[k]);
            if (!diffs.length) continue;
            edits.push({ c, text: applyObject(c.text, nn) });
            changes.push(c.url + " (#" + i + "): tile " + c.tx + "," + c.ty + " offset " + c.ox + "," + c.oy + "  ->  tile " + tx + "," + ty + " offset " + ox + "," + oy);
        }
        for (const e of edits.sort((a, b) => b.c.start - a.c.start)) ts = ts.slice(0, e.c.start) + e.text + ts.slice(e.c.end);
    }
    const rmFlag = flag("rmobj");
    if (rmFlag !== undefined) {
        let idx; try { idx = JSON.parse(rmFlag); } catch (e) { fail("Bad --rmobj value."); }
        const cur = readObjects(ts);
        if (!Array.isArray(idx) || !idx.length || !idx.every(i => Number.isInteger(i) && cur[i])) fail("--rmobj must be a list of existing object numbers.");
        for (const i of [...new Set(idx)].sort((a, b) => b - a)) {
            const c = cur[i];
            let a = c.start, b = c.end;
            while (/[ \t]/.test(ts[b])) b++;
            if (ts[b] === ",") b++;
            const ls = ts.lastIndexOf("\n", a - 1) + 1, le = ts.indexOf("\n", b);
            if (le >= 0 && !ts.slice(ls, a).trim() && !ts.slice(b, le).trim()) { a = ls; b = le + 1; }
            ts = ts.slice(0, a) + ts.slice(b);
            changes.push("objects: removed " + c.url + " (#" + i + ")");
        }
    }
    const dupFlag = flag("dupobj");
    if (dupFlag !== undefined) {
        const i = Number(dupFlag), cur = readObjects(ts);
        if (!Number.isInteger(i) || !cur[i]) fail("--dupobj must be an existing object number.");
        const c = cur[i], ls = ts.lastIndexOf("\n", c.start - 1) + 1, ind = (ts.slice(ls, c.start).match(/^[ \t]*/) || [""])[0];
        ts = ts.slice(0, c.end) + ",\n" + ind + c.text + ts.slice(c.end);
        changes.push("objects: duplicated " + c.url + " (#" + i + ") as #" + (i + 1) + " at the same tile and offset");
    }
    const addFlag = flag("addobj");
    if (addFlag !== undefined) {
        let names; try { names = JSON.parse(addFlag); } catch (e) { fail("Bad --addobj value."); }
        if (!Array.isArray(names) || !names.every(n => typeof n === "string" && /^[\w.\- ]+\.svg$/i.test(n) && fs.existsSync(path.join(roomDir, n)))) fail("--addobj must be a list of svg files in the room folder.");
        const have = new Set(readObjects(ts).map(o => o.url));
        names = [...new Set(names)].filter(n => !have.has(n));
        const resize = names.map(n => [n, sizeFixOf(fs.readFileSync(path.join(roomDir, n), "utf8"))]).filter(x => x[1]);
        for (const [n, fixed] of resize) { svgWrites.push([path.join(roomDir, n), fixed]); changes.push(n + ": width/height set to the viewBox size so it isn't drawn huge"); }
        if (names.length) {
            const sp = listSpan(ts, "objects");
            if (!sp) fail("Couldn't find objects in " + tsPath);
            let body = ts.slice(sp.open + 1, sp.close);
            const indent = (body.match(/\n([ \t]*)\{/) || [])[1] || "        ", closeIndent = (ts.slice(0, sp.close).match(/\n([ \t]*)$/) || [])[1] || "    ";
            let head = body.replace(/\s+$/, "");
            if (head.trim() && !head.endsWith(",")) head += ",";
            body = head + "\n" + names.map(n => indent + '{x: 0, y: 0, offset: {x: 0, y: 0}, url: "' + n + '", scale: 1}').join(",\n") + "\n" + closeIndent;
            ts = ts.slice(0, sp.open + 1) + body + ts.slice(sp.close);
            changes.push("objects: added " + names.join(", ") + " (tile 0,0 offset 0,0; use Fit all objects / Fit this object to position them)");
        }
    }
    if (!changes.length) { console.log("Nothing to change."); stopQuietly(); }
    changes.forEach(c => console.log(c));
    if (changes.some(c => c.startsWith("id:"))) console.log("Note: only the id inside the .ts changes. The file name, rooms.ts and the room folder are not renamed.");
    if (!write) { console.log("Nothing changed. Use --write to apply."); stopQuietly(); }
    const tsBackup = backup(tsPath);
    for (const [f, text] of svgWrites) { backup(f); fs.writeFileSync(f, text); }
    fs.writeFileSync(tsPath, ts);
    if (changes.some(c => c.startsWith("originCoordinates:"))) ensureBgSize();
    console.log("Done. Backup: " + tsBackup);
}

function ensureBgSize() {
    const svg = fs.readFileSync(bgPath, "utf8"), fixed = sizeFixOf(svg);
    if (!fixed) return;
    backup(bgPath);
    fs.writeFileSync(bgPath, fixed);
    console.log("background.svg: width/height were not real pixel sizes (e.g. 100%), set to the viewBox size so the game draws it at the size the grid was aligned to.");
}

function setOrigin(ox, oy) {
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) fail("Use --origin=x,y with numbers.");
    const g = gridInfo();
    console.log(`originCoordinates: ${g.origin.x}, ${g.origin.y}  ->  ${ox}, ${oy}`);
    if (!write) { console.log("Nothing changed. Use --write to apply."); stopQuietly(); }
    const tsBackup = backup(tsPath);
    const ts = fs.readFileSync(tsPath, "utf8").replace(originRe, (m, a, x, c, y) => `${a}${ox}${c}${oy}`);
    fs.writeFileSync(tsPath, ts);
    ensureBgSize();
    console.log("Done. Backup: " + tsBackup);
}

function alignGrid(corner) {
    const g = gridInfo();
    if (!g.corners) fail("Couldn't find a floor outline (an isometric shape) in background.svg. Nothing changed.");
    const { ox, oy } = g.corners[corner];
    console.log(`Floor outline: "${g.floorId}", grid ${g.sx}x${g.sy}, pinning the grid's ${corner} corner to the floor's ${corner} point.`);
    console.log(`originCoordinates: ${g.origin.x}, ${g.origin.y}  ->  ${ox}, ${oy}`);
    console.log("Remaining distance of the other grid corners to the floor's extreme points: "
        + Object.entries(g.corners[corner].dev).map(([k, v]) => `${k} ${v}px`).join(", "));
    console.log("(Large values on a side mean the floor isn't a full rectangle there or its tile size differs from the grid.)");

    if (interactive) write = ask("Apply? (y/n): ").toLowerCase() === "y";
    if (!write) { console.log("Nothing changed. Use --write (or answer y) to apply."); stopQuietly(); }
    const tsBackup = backup(tsPath);
    const ts = fs.readFileSync(tsPath, "utf8").replace(originRe, (m, a, x, c, y) => `${a}${ox}${c}${oy}`);
    fs.writeFileSync(tsPath, ts);
    ensureBgSize();
    console.log("Done. Backup: " + tsBackup);
}

// ---------- fit objects ----------

function sizeFixOf(svg) {
    const d = docBox(svg);
    if (!d || !d.w || !d.h || !/\sviewBox=/.test(svg)) return null;
    const fixed = svg.replace(/(<svg[^>]*?)\swidth="[^"]*"([^>]*?)\sheight="[^"]*"/, `$1 width="${d.w}"$2 height="${d.h}"`);
    return fixed !== svg ? fixed : null;
}

function planExact(objFile, bgSvg, bgShapes, bgDoc) {
    const objPath = path.join(roomDir, objFile);
    const objSvg = fs.readFileSync(objPath, "utf8");
    const objDoc = docBox(objSvg) || { x: 0, y: 0, w: 0, h: 0 };

    let sizeFix = sizeFixOf(objSvg);

    let objShapes = parseShapes(objSvg);
    if (!objShapes.length) return { objFile, objPath, sizeFix, error: "no usable paths in the object svg" };

    let candidates = [];
    const collect = () => {
        candidates = [];
        for (const o of objShapes) for (const b of bgShapes) {
            if (o.pts.length !== b.pts.length) continue;
            const dx = b.pts[0][0] - o.pts[0][0], dy = b.pts[0][1] - o.pts[0][1];
            if (matchesAt(o, b, dx, dy)) candidates.push([dx, dy]);
        }
    };
    collect();
    let scaleNote = "", scaled = 1;
    if (!candidates.length) {
        const votes = new Map();
        for (const o of objShapes) for (const b of bgShapes) {
            if (o.pts.length !== b.pts.length || o.pts.length < 3) continue;
            const seg = (s, i) => Math.hypot(s.pts[i][0] - s.pts[0][0], s.pts[i][1] - s.pts[0][1]);
            const i = o.pts.findIndex((_, n) => n && seg(o, n) > 1);
            if (i < 0) continue;
            const k = Math.round(seg(b, i) / seg(o, i) * 1000) / 1000;
            if (!(k > 0.2 && k < 5) || Math.abs(k - 1) < 0.01) continue;
            if (o.pts.every((p, n) => Math.abs(b.pts[n][0] - b.pts[0][0] - k * (p[0] - o.pts[0][0])) < 0.05 * k + 0.03 && Math.abs(b.pts[n][1] - b.pts[0][1] - k * (p[1] - o.pts[0][1])) < 0.05 * k + 0.03)) votes.set(k, (votes.get(k) || 0) + 1);
        }
        const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
        if (best) {
            const k = best[0];
            const sc = objShapes.map(o => ({ ...o, pts: o.pts.map(p => [p[0] * k, p[1] * k]), style: o.style.replace(/stroke-(?:width|linecap):[^;"]+;?/g, "") }));
            const keep = objShapes;
            objShapes = sc;
            collect();
            if (candidates.length && Math.max(...candidates.map(c => candidates.filter(k => Math.abs(k[0] - c[0]) < TOL && Math.abs(k[1] - c[1]) < TOL).length)) >= Math.max(2, Math.ceil(objShapes.length / 2))) {
                scaled = k;
                const tagM = objSvg.match(/<svg\b[^>]*>/);
                const nd = { x: round2(objDoc.x * k), y: round2(objDoc.y * k), w: round2(objDoc.w * k), h: round2(objDoc.h * k) };
                let tag = setAttr(setAttr(tagM[0], "viewBox", `${nd.x} ${nd.y} ${nd.w} ${nd.h}`), "width", String(nd.w));
                tag = setAttr(tag, "height", String(nd.h));
                let inner = objSvg.slice(tagM.index + tagM[0].length).replace(/<\/svg>\s*$/, "");
                const wrap = /^\s*<g transform="scale\([\d.]+\)">/;
                while (wrap.test(inner) && /<\/g>\s*$/.test(inner)) inner = inner.replace(wrap, "").replace(/<\/g>\s*$/, "");
                sizeFix = objSvg.slice(0, tagM.index) + tag + `<g transform="scale(${k})">` + inner + "</g></svg>\n";
                scaleNote = `; object was ${Math.round(100 / k)}% of the background's size, it will be rescaled to match`;
                objDoc.x = nd.x; objDoc.y = nd.y; objDoc.w = nd.w; objDoc.h = nd.h;
            } else { objShapes = keep; candidates = []; }
        }
    }
    if (!candidates.length && (objDoc.x || objDoc.y) && objDoc.w && objDoc.h) {
        return { objFile, objPath, ox: round2(objDoc.x - bgDoc.x), oy: round2(objDoc.y - bgDoc.y), toRemove: [], sizeFix, total: objShapes.length, styleMismatch: 0, scaleNote: "; not in the background, placed by its viewBox origin (it was exported in background coordinates)" };
    }
    if (!candidates.length) return { objFile, objPath, sizeFix, error: "no matching shapes found in the background (already fitted, or edited since; offset left alone)" };

    let bestC = candidates[0], bestScore = -1;
    for (const c of candidates) {
        const score = candidates.filter(k => Math.abs(k[0] - c[0]) < TOL && Math.abs(k[1] - c[1]) < TOL).length;
        if (score > bestScore) { bestScore = score; bestC = c; }
    }
    // position in the background image's pixel space (accounts for viewBox origins)
    const ox = round2(bestC[0] - bgDoc.x + objDoc.x), oy = round2(bestC[1] - bgDoc.y + objDoc.y);

    const used = new Set(), toRemove = [];
    let styleMismatch = 0;
    for (const o of objShapes) {
        const idx = bgShapes.findIndex((b, k) => !used.has(k) && matchesAt(o, b, bestC[0], bestC[1]));
        if (idx >= 0) {
            used.add(idx); toRemove.push(bgShapes[idx]);
            const norm = s => s.replace(/stroke-(?:width|linecap):[^;"]+;?/g, "");
            if (norm(bgShapes[idx].style) !== norm(o.style)) styleMismatch++;
        }
    }
    if (toRemove.length < Math.max(2, Math.ceil(objShapes.length / 2))) return { objFile, objPath, sizeFix: null, error: `only ${toRemove.length} of its ${objShapes.length} shapes are in the background, so it looks already fitted or edited; its offset was left alone` };
    if (bgShapes.length >= 20 && toRemove.length > bgShapes.length / 2) return { objFile, objPath, sizeFix: null, error: `it contains ${toRemove.length} of the background's ${bgShapes.length} shapes (looks like a copy of the whole background, not a single object), so fitting it would wipe the background` };
    return { objFile, objPath, ox, oy, toRemove, sizeFix, total: objShapes.length, styleMismatch, scaleNote };
}

// Fallback when shapes were edited after export: match by fill colour, size and position instead of exact points.
function planFuzzy(objFile, bgShapes, bgDoc) {
    const objPath = path.join(roomDir, objFile), objSvg = fs.readFileSync(objPath, "utf8");
    const objDoc = docBox(objSvg) || { x: 0, y: 0, w: 0, h: 0 };
    const fillOf = st => (st.match(/(?:^|;)\s*fill:\s*([^;]+)/) || [, ""])[1].trim();
    const box = sh => {
        const xs = sh.pts.map(p => p[0]), ys = sh.pts.map(p => p[1]);
        const x = Math.min(...xs), y = Math.min(...ys);
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, fill: fillOf(sh.style) };
    };
    const big = b => Math.max(b.w, b.h) >= 3 && b.fill && b.fill !== "none";
    const O = parseShapes(objSvg).map(sh => ({ sh, b: box(sh) })).filter(o => big(o.b));
    const B = bgShapes.map(sh => ({ sh, b: box(sh) })).filter(o => big(o.b));
    if (O.length < 3 || !B.length) return null;
    const need = Math.max(3, Math.ceil(O.length * 0.5));
    const tolS = (a, b) => Math.abs(a - b) <= Math.max(1.5, 0.1 * Math.max(a, b));
    const sv = new Map();
    for (const o of O) for (const b of B) if (o.b.fill === b.b.fill) {
        for (const [p, q] of [[o.b.w, b.b.w], [o.b.h, b.b.h]]) if (p > 8) { const k = Math.round(q / p * 50) / 50; if (k > 0.2 && k < 5) sv.set(k, (sv.get(k) || 0) + 1); }
    }
    const top = [...sv.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
    let best = null;
    for (const k of new Set([1, ...top])) {
        const votes = new Map(), key = (dx, dy) => Math.round(dx / 2) + "," + Math.round(dy / 2);
        for (const o of O) for (const b of B) {
            if (o.b.fill !== b.b.fill || !tolS(o.b.w * k, b.b.w) || !tolS(o.b.h * k, b.b.h)) continue;
            const dx = b.b.x - k * o.b.x, dy = b.b.y - k * o.b.y, kk = key(dx, dy);
            const v = votes.get(kk) || { n: 0, sx: 0, sy: 0 }; v.n++; v.sx += dx; v.sy += dy; votes.set(kk, v);
        }
        for (const v of votes.values()) if (!best || v.n > best.n) best = { n: v.n, k, dx: v.sx / v.n, dy: v.sy / v.n };
    }
    if (!best || best.n < need) return null;
    const { k } = best;
    const used = new Set(), toRemove = [];
    let dx = best.dx, dy = best.dy;
    for (let pass = 0; pass < 2; pass++) {
        used.clear(); toRemove.length = 0;
        let sx = 0, sy = 0;
        for (const o of O) {
            const j = B.findIndex((b, i) => !used.has(i) && o.b.fill === b.b.fill && Math.abs(b.b.x - k * o.b.x - dx) <= 1.5 && Math.abs(b.b.y - k * o.b.y - dy) <= 1.5 && tolS(o.b.w * k, b.b.w) && tolS(o.b.h * k, b.b.h));
            if (j >= 0) { used.add(j); toRemove.push(B[j].sh); sx += B[j].b.x - k * o.b.x; sy += B[j].b.y - k * o.b.y; }
        }
        if (toRemove.length && pass === 0) { dx = sx / toRemove.length; dy = sy / toRemove.length; }
    }
    if (toRemove.length < need) return null;
    if (bgShapes.length >= 20 && toRemove.length > bgShapes.length / 2) return null;
    let sizeFix = sizeFixOf(objSvg), scaleNote = "", od = { ...objDoc };
    if (Math.abs(k - 1) >= 0.03) {
        const r = rescaleSvg(objSvg, objDoc, k);
        sizeFix = r.svg; od = r.doc;
        scaleNote = `; object was ${Math.round(100 / k)}% of the background's size, it will be rescaled`;
    }
    return { objFile, objPath, ox: round2(dx - bgDoc.x + od.x), oy: round2(dy - bgDoc.y + od.y), toRemove, sizeFix, total: O.length, styleMismatch: 0,
        scaleNote: scaleNote + `; approximate fit (it was edited after export): ${toRemove.length}/${O.length} shapes matched by colour, size and position` };
}

function rescaleSvg(objSvg, objDoc, k) {
    const tagM = objSvg.match(/<svg\b[^>]*>/);
    const doc = { x: round2(objDoc.x * k), y: round2(objDoc.y * k), w: round2(objDoc.w * k), h: round2(objDoc.h * k) };
    const tag = setAttr(setAttr(setAttr(tagM[0], "viewBox", `${doc.x} ${doc.y} ${doc.w} ${doc.h}`), "width", String(doc.w)), "height", String(doc.h));
    let inner = objSvg.slice(tagM.index + tagM[0].length).replace(/<\/svg>\s*$/, "");
    const wrap = /^\s*<g transform="scale\([\d.]+\)">/;
    while (wrap.test(inner) && /<\/g>\s*$/.test(inner)) inner = inner.replace(wrap, "").replace(/<\/g>\s*$/, "");
    return { svg: objSvg.slice(0, tagM.index) + tag + `<g transform="scale(${k})">` + inner + "</g></svg>\n", doc };
}

function planObject(objFile, bgSvg, bgShapes, bgDoc) {
    const p = planExact(objFile, bgSvg, bgShapes, bgDoc);
    if (p.error && /no matching shapes|only \d+ of/.test(p.error)) {
        const q = planFuzzy(objFile, bgShapes, bgDoc);
        if (q) return q;
    }
    return p;
}

function fitObjects(files) {
    let bgSvg = fs.readFileSync(bgPath, "utf8");
    const bgDoc = docBox(bgSvg) || { x: 0, y: 0, w: 0, h: 0 };
    const bgShapes = parseShapes(bgSvg);
    let ts = fs.readFileSync(tsPath, "utf8");

    const plans = [];
    for (const f of files) {
        const p = planObject(f, bgSvg, bgShapes, bgDoc);
        if (!p.error && !hasEntry(ts, f)) p.error = `no entry with an offset for "${f}" in ${path.basename(tsPath)} (add it first)`;
        else if (!p.error && ts.split(`url: "${f}"`).length > 2) p.error = `"${f}" is used more than once in ${path.basename(tsPath)}, so it can't be fitted automatically`;
        plans.push(p);
    }
    // layers exported with the same crop (chest1/chest2/chest3...) share one offset
    const stemOf = f => f.replace(/\d*\.svg$/i, "");
    const rootOf = f => { const t = rootTag(fs.readFileSync(path.join(roomDir, f), "utf8")) || ""; return ["width", "height", "viewBox"].map(a => (t.match(new RegExp("\\s" + a + '="([^"]*)"')) || [])[1]).join("|"); };
    for (const p of plans) {
        if (!p.error || !/no matching shapes|only \d+ of/.test(p.error) || !hasEntry(ts, p.objFile)) continue;
        const sibs = plans.filter(q => q !== p && (stemOf(q.objFile).startsWith(stemOf(p.objFile)) || stemOf(p.objFile).startsWith(stemOf(q.objFile))) && rootOf(q.objFile) === rootOf(p.objFile));
        const src = sibs.find(q => !q.error && q.toRemove.length);
        let ox, oy, from;
        if (src) { ox = src.ox; oy = src.oy; from = src.objFile; }
        else for (const q of sibs) {
            const m = ts.match(new RegExp("offset:\\s*\\{\\s*x:\\s*(-?[\\d.]+)\\s*,\\s*y:\\s*(-?[\\d.]+)\\s*\\}[^}\\n]*url:\\s*\"" + q.objFile.replace(/\./g, "\\.") + '\\"'));
            if (m && (Number(m[1]) || Number(m[2]))) { ox = Number(m[1]); oy = Number(m[2]); from = q.objFile; break; }
        }
        if (from) Object.assign(p, { error: undefined, ox, oy, toRemove: [], total: 0, styleMismatch: 0, scaleNote: "; same export size as " + from + ", so it uses that offset" });
    }
    for (const p of plans) {
        const f = p.objFile;
        if (p.error) { console.log(`- ${f}: SKIPPED, ${p.error}` + (p.sizeFix ? " (its width/height will still be set to the real size so it isn't drawn huge; set the offset by hand)" : "")); continue; }
        const missing = p.total - p.toRemove.length;
        console.log(`- ${f}: offset x=${p.ox}, y=${p.oy}; ${p.toRemove.length}/${p.total} shapes found in background` + (p.scaleNote || "")
            + (p.styleMismatch ? `; ${p.styleMismatch} had different colours (replaced anyway)` : "")
            + (missing > 0 ? `; ${missing} not in background` : ""));
    }
    const good = plans.filter(p => !p.error);
    const sizeOnly = plans.filter(p => p.error && p.sizeFix);
    if (!good.length && !sizeOnly.length) fail("Nothing to apply.");

    const anyInBg = good.some(p => p.toRemove.length);
    let removeFromBg = true;
    if (interactive) {
        write = ask(`Update the offsets in ${path.basename(tsPath)} for ${good.length} object(s)? (y/n): `).toLowerCase() === "y";
        if (write && anyInBg) removeFromBg = ask("Also remove the matching shapes from background.svg so they aren't drawn twice? (y/n): ").toLowerCase() === "y";
    } else removeFromBg = batchRemove;
    if (!write) { console.log("Nothing changed. Use --write (or answer y) to apply."); stopQuietly(); }

    const bgBackup = backup(bgPath);
    backup(tsPath);

    const ranges = new Map();
    if (removeFromBg) good.forEach(p => p.toRemove.forEach(s => ranges.set(s.start, s)));
    const emptyBefore = new Set([...bgSvg.matchAll(/<g id="([^"]*)"><\/g>/g)].map(m => m[1]));
    for (const s of [...ranges.values()].sort((a, b) => b.start - a.start)) bgSvg = bgSvg.slice(0, s.start) + bgSvg.slice(s.end);
    let prev;
    do {
        prev = bgSvg;
        bgSvg = bgSvg.replace(/<g id="([^"]*)"><\/g>/g, (m, id) => emptyBefore.has(id) ? m : "");
    } while (bgSvg !== prev);

    for (const p of good) {
        ts = setEntryOffset(ts, p.objFile, p.ox, p.oy);
        if (p.sizeFix) { backup(p.objPath); fs.writeFileSync(p.objPath, p.sizeFix); }
    }
    for (const p of sizeOnly) { backup(p.objPath); fs.writeFileSync(p.objPath, p.sizeFix); }
    fs.writeFileSync(bgPath, bgSvg);
    fs.writeFileSync(tsPath, ts);
    ensureBgSize();
    console.log(removeFromBg ? `Removed ${ranges.size} shapes from background.svg (backup: ${bgBackup})` : "Left background.svg as it was.");
    console.log("Updated " + path.relative(REPO, tsPath));
}

// ---------- run ----------

if (infoMode) {
    let doc = null, grid = null, gridError = null;
    if (!bgFile) gridError = "No background svg in this room's folder.";
    else try { doc = docBox(fs.readFileSync(bgPath, "utf8")); grid = gridInfo(); } catch (e) { gridError = e.message; }
    const tsText = fs.readFileSync(tsPath, "utf8");
    const entries = readObjects(tsText).map((o, i) => ({ i, anim: o.anim, url: o.url, tx: o.tx, ty: o.ty, ox: o.ox, oy: o.oy }));
    console.log(JSON.stringify({ roomId, name: roomNames[roomId] || roomId, folder: path.normalize(roomDir), props: readProps(tsText), objects: allObjects, svgs: allSvgs, bg: bgFile, entries, viewBox: doc, grid, gridError }));
    process.exit(0);
}

const sel = selection.toLowerCase();
if (sel === "everything") {
    if (!batchCorner) fail("Pass --corner=left|top|right|bottom for \"everything\".");
    const steps = [];
    if (allObjects.length) steps.push(["Fit objects", () => fitObjects(allObjects)]);
    steps.push(["Crop background", cropBackground], ["Align grid", () => alignGrid(batchCorner)]);
    console.log("This will: " + steps.map(s => s[0].toLowerCase()).join(", then ") + (batchRemove ? "" : " (shapes stay in background.svg)") + ".");
    if (interactive) {
        if (ask("Go ahead? (y/n): ").toLowerCase() !== "y") { console.log("Nothing changed."); process.exit(0); }
        write = true;
    } else if (!write) console.log("(Preview: each step is shown against the files as they are now.)");
    batchMode = true; interactive = false;
    for (const [name, run] of steps) {
        console.log(`\n== ${name} ==`);
        try { run(); }
        catch (e) { if (!(e instanceof Stop)) throw e; if (e.message) console.log("Skipped: " + e.message); }
    }
} else if (sel === "background.svg") cropBackground();
else if (sel === "grid:manual") {
    const m = (process.argv.find(a => a.startsWith("--origin=")) || "").slice(9).split(",");
    setOrigin(Number(m[0]), Number(m[1]));
}
else if (sel === "props") setProps();
else if (sel.startsWith("grid:")) {
    const c = sel.slice(5);
    if (!["left", "top", "right", "bottom"].includes(c)) fail("Use grid:left, grid:top, grid:right or grid:bottom");
    alignGrid(c);
}
else if (sel === "all") {
    if (!allObjects.length) fail("No object svgs in this room's folder.");
    fitObjects(allObjects);
} else {
    const f = allObjects.find(o => o.toLowerCase() === sel);
    if (!f) fail(`${selection} not found in ${roomDir}`);
    fitObjects([f]);
}
