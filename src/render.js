// Geometry + drawing for all note elements. Elements are treated as immutable.
export const PAGE_W = 794;   // A4 at 96 dpi
export const PAGE_H = 1123;
export const PAGE_GAP = 48;
/** A page's size: A4 portrait unless the page says otherwise (landscape PDF pages). */
export const pageSize = (page) => (page && page.w && page.h ? { w: page.w, h: page.h } : { w: PAGE_W, h: PAGE_H });
export const FONT = 'Inter, "Segoe UI", system-ui, sans-serif';
export const LINK_COLOR = '#2563eb';

export const PAPERS = {
  white: { bg: '#ffffff', line: 'rgba(60,80,120,0.16)', dot: 'rgba(60,80,120,0.35)' },
  cream: { bg: '#fbf6e9', line: 'rgba(120,90,40,0.18)', dot: 'rgba(120,90,40,0.38)' },
  dark:  { bg: '#1f2126', line: 'rgba(255,255,255,0.10)', dot: 'rgba(255,255,255,0.28)' },
};
export const paperOf = (note) => PAPERS[note.paper] || PAPERS.white;

const measure = document.createElement('canvas').getContext('2d');
// Pictures (PDF pages above all: 2400 px JPEGs) are decoded in the background with createImageBitmap and kept
// decoded. Drawing a plain <img> makes the browser decode the JPEG right then, on the main thread: 50-70 ms per
// page on a tablet, which is what made scrolling into a new page stutter. Until its decoded copy is ready a picture
// is drawn as a grey box and the page is drawn again when it arrives. Decoded pictures are big (13 MB for a page),
// so only the most recently drawn ones are kept.
const images = new Map();    // src → { im, bmp, pending, failed, used }
const MAX_DECODED = 10;
let useClock = 0, exact = 0;
// every open editor (two with split screen) redraws when a picture it waits for has loaded
const assetListeners = new Set();
const onAssetLoad = () => { for (const fn of assetListeners) fn(); };
/** Call fn whenever a picture finishes loading; returns a function that stops it. */
export function addAssetListener(fn) { assetListeners.add(fn); return () => assetListeners.delete(fn); }
const canDecode = typeof createImageBitmap === 'function';
function decode(r) {
  if (r.bmp || r.pending || r.failed) return;
  r.pending = true;
  createImageBitmap(r.im).then((b) => { r.bmp = b; trimDecoded(); }, () => { r.failed = true; })
    .finally(() => { r.pending = false; onAssetLoad(); });
}
function trimDecoded() {
  const held = [...images.values()].filter((r) => r.bmp);
  if (held.length <= MAX_DECODED) return;
  held.sort((a, b) => a.used - b.used);
  for (const r of held.slice(0, held.length - MAX_DECODED)) { r.bmp.close?.(); r.bmp = null; }
}
function getImage(src) {
  let r = images.get(src);
  if (!r) { r = { im: new Image(), bmp: null, pending: false, failed: false, used: 0 }; r.im.onload = () => onAssetLoad(); r.im.src = src; images.set(src, r); }
  r.used = ++useClock;
  if (r.bmp) return r.bmp;
  if (!r.im.complete || !r.im.naturalWidth) return null;
  if (!canDecode || r.failed) return r.im;
  decode(r);
  return exact ? r.im : null;   // exports and thumbnails can't wait: they decode on the spot
}

export const pressureWidth = (p) => 0.3 + p * 1.4;
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// ---------- strokes ----------
function drawStroke(ctx, el) {
  const p = el.points, n = p.length;
  if (!n) return;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = el.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (el.tool === 'highlighter') {
    ctx.globalAlpha = 0.4;
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineWidth = el.width;
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < n - 1; i++) { const m = mid(p[i], p[i + 1]); ctx.quadraticCurveTo(p[i][0], p[i][1], m[0], m[1]); }
    ctx.lineTo(p[n - 1][0] + (n === 1 ? 0.01 : 0), p[n - 1][1]);
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0][0], p[0][1], (el.width * pressureWidth(p[0][2])) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  penSegments(ctx, el, 1, n - 1);
  penTail(ctx, el);
  ctx.restore();
}

// A pen stroke is drawn as separate pieces (each with its own width from the pressure). Pieces 1 … n-2 are final
// once the next point exists; only the tail to the last point changes while writing. So a stroke being written can
// be drawn a few pieces at a time instead of all of it on every frame.
function penSegments(ctx, el, from, to) {
  const p = el.points;
  for (let i = Math.max(1, from); i < to && i < p.length - 1; i++) {
    const s = i === 1 ? p[0] : mid(p[i - 1], p[i]), m = mid(p[i], p[i + 1]);
    ctx.lineWidth = el.width * pressureWidth(p[i][2]);
    ctx.beginPath();
    ctx.moveTo(s[0], s[1]);
    ctx.quadraticCurveTo(p[i][0], p[i][1], m[0], m[1]);
    ctx.stroke();
  }
}
function penTail(ctx, el) {
  const p = el.points, n = p.length;
  const s = n === 2 ? p[0] : mid(p[n - 2], p[n - 1]);
  ctx.lineWidth = el.width * pressureWidth(p[n - 1][2]);
  ctx.beginPath();
  ctx.moveTo(s[0], s[1]);
  ctx.lineTo(p[n - 1][0], p[n - 1][1]);
  ctx.stroke();
}
const penStyle = (ctx, el) => { ctx.strokeStyle = ctx.fillStyle = el.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; };

/** Draw the pieces of a pen stroke from piece `from` up to (not incl.) `to`; returns the next piece to draw. */
export function drawPenPieces(ctx, el, from) {
  const to = el.points.length - 1;
  if (to <= from) return from;
  ctx.save(); penStyle(ctx, el); penSegments(ctx, el, from, to); ctx.restore();
  return to;
}
/** The end of a pen stroke being written (a dot while it has one point). */
export function drawPenTail(ctx, el) {
  const p = el.points;
  ctx.save(); penStyle(ctx, el);
  if (p.length === 1) { ctx.beginPath(); ctx.arc(p[0][0], p[0][1], (el.width * pressureWidth(p[0][2])) / 2, 0, Math.PI * 2); ctx.fill(); }
  else penTail(ctx, el);
  ctx.restore();
}

function drawShape(ctx, el) {
  ctx.save();
  ctx.strokeStyle = el.color;
  ctx.lineWidth = el.width;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.beginPath();
  if (el.kind === 'ellipse') ctx.ellipse(el.cx, el.cy, Math.max(el.rx, 0.5), Math.max(el.ry, 0.5), 0, 0, Math.PI * 2);
  else {
    ctx.moveTo(el.pts[0][0], el.pts[0][1]);
    for (let i = 1; i < el.pts.length; i++) ctx.lineTo(el.pts[i][0], el.pts[i][1]);
    if (el.kind === 'polygon') ctx.closePath();
  }
  ctx.stroke();
  ctx.restore();
}

// ---------- text ----------
const LINK_RE = /\[\[([^\]\n]+)\]\]/g;
const layoutCache = new WeakMap();
const font = (size) => `${size}px ${FONT}`;

/** Word-wrap text into lines of runs; [[Title]] becomes an unbreakable link run. */
export function layoutText(el) {
  let L = layoutCache.get(el);
  if (L) return L;
  const size = el.size, lh = Math.round(size * 1.35);
  measure.font = font(size);
  const lines = [];
  for (const para of el.text.split('\n')) {
    const toks = [];
    let last = 0;
    const pushPlain = (s) => { for (const w of s.split(/(\s+)/)) if (w) toks.push({ text: w }); };
    for (const m of para.matchAll(LINK_RE)) {
      if (m.index > last) pushPlain(para.slice(last, m.index));
      toks.push({ text: m[1], link: m[1].trim() });
      last = m.index + m[0].length;
    }
    if (last < para.length) pushPlain(para.slice(last));
    let line = [], x = 0;
    for (const t of toks) {
      const w = measure.measureText(t.text).width;
      const space = !t.link && /^\s+$/.test(t.text);
      if (x + w > el.w && x > 0 && !space) { lines.push(line); line = []; x = 0; }
      if (space && x === 0 && lines.length && line.length === 0) continue;
      line.push({ ...t, x, w });
      x += w;
    }
    lines.push(line);
  }
  L = { lines, lh, height: Math.max(1, lines.length) * lh };
  layoutCache.set(el, L);
  return L;
}

function drawText(ctx, el, linkRects) {
  const L = layoutText(el);
  ctx.save();
  ctx.font = font(el.size);
  ctx.textBaseline = 'middle';
  L.lines.forEach((line, i) => {
    const y = el.y + i * L.lh + L.lh / 2;
    for (const r of line) {
      ctx.fillStyle = r.link ? LINK_COLOR : el.color;
      ctx.fillText(r.text, el.x + r.x, y);
      if (r.link) {
        ctx.fillRect(el.x + r.x, y + el.size * 0.55, r.w, Math.max(1, el.size / 14));
        linkRects?.push({ x: el.x + r.x, y: el.y + i * L.lh, w: r.w, h: L.lh, title: r.link });
      }
    }
  });
  ctx.restore();
}

// ---------- tables ----------
export const tableSize = (el) => ({ w: el.colW.reduce((a, b) => a + b, 0), h: el.rowH.reduce((a, b) => a + b, 0) });

export function tableCellAt(el, x, y) {
  let cy = el.y;
  for (let r = 0; r < el.rowH.length; r++) {
    let cx = el.x;
    for (let c = 0; c < el.colW.length; c++) {
      if (x >= cx && x < cx + el.colW[c] && y >= cy && y < cy + el.rowH[r]) return { r, c, x: cx, y: cy, w: el.colW[c], h: el.rowH[r] };
      cx += el.colW[c];
    }
    cy += el.rowH[r];
  }
  return null;
}

function drawTable(ctx, el, linkRects) {
  const { w, h } = tableSize(el);
  ctx.save();
  ctx.strokeStyle = el.color;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(el.x, el.y, w, h);
  let cy = el.y;
  el.rowH.forEach((rh, r) => {
    let cx = el.x;
    el.colW.forEach((cw, c) => {
      const t = el.cells[r]?.[c];
      if (t) {
        ctx.save();
        ctx.beginPath(); ctx.rect(cx, cy, cw, rh); ctx.clip();
        drawText(ctx, { type: 'text', x: cx + 6, y: cy + 5, w: cw - 12, size: el.size, color: el.color, text: t }, linkRects);
        ctx.restore();
      }
      cx += cw;
      if (c < el.colW.length - 1) { ctx.beginPath(); ctx.moveTo(cx, el.y); ctx.lineTo(cx, el.y + h); ctx.stroke(); }
    });
    cy += rh;
    if (r < el.rowH.length - 1) { ctx.beginPath(); ctx.moveTo(el.x, cy); ctx.lineTo(el.x + w, cy); ctx.stroke(); }
  });
  ctx.restore();
}

/** How many times a picture was drawn as a grey box because it hadn't loaded yet (so a cached page knows to redraw). */
export const missing = { count: 0 };

// ---------- dispatch ----------
export function drawElement(ctx, el, linkRects) {
  switch (el.type) {
    case 'stroke': return drawStroke(ctx, el);
    case 'shape': return drawShape(ctx, el);
    case 'text': return drawText(ctx, el, linkRects);
    case 'table': return drawTable(ctx, el, linkRects);
    case 'image': {
      const im = getImage(el.src);
      if (im) ctx.drawImage(im, el.x, el.y, el.w, el.h);
      else { missing.count++; ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.06)'; ctx.fillRect(el.x, el.y, el.w, el.h); ctx.restore(); }
    }
  }
}

const boundsCache = new WeakMap();
export function bounds(el) {
  let b = boundsCache.get(el);
  if (b) return b;
  const ptsBounds = (pts, pad) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; }
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  };
  switch (el.type) {
    case 'stroke': b = ptsBounds(el.points, el.width); break;
    case 'shape': b = el.kind === 'ellipse'
      ? { x: el.cx - el.rx - el.width, y: el.cy - el.ry - el.width, w: 2 * (el.rx + el.width), h: 2 * (el.ry + el.width) }
      : ptsBounds(el.pts, el.width); break;
    case 'text': b = { x: el.x, y: el.y, w: el.w, h: layoutText(el).height }; break;
    case 'table': b = { x: el.x, y: el.y, ...tableSize(el) }; break;
    default: b = { x: el.x, y: el.y, w: el.w, h: el.h };
  }
  boundsCache.set(el, b);
  return b;
}

export const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export function unionBounds(list) {
  if (!list.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of list) { const b = bounds(e); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function distToSeg(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/** Is point (x,y) within r of the element's ink? */
export function hit(el, x, y, r) {
  const b = bounds(el);
  if (x < b.x - r || x > b.x + b.w + r || y < b.y - r || y > b.y + b.h + r) return false;
  if (el.type === 'stroke' || (el.type === 'shape' && el.kind !== 'ellipse')) {
    const pts = el.type === 'stroke' ? el.points : el.pts;
    const tol = r + el.width / 2;
    if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= tol;
    for (let i = 1; i < pts.length; i++) if (distToSeg(x, y, pts[i - 1], pts[i]) <= tol) return true;
    if (el.kind === 'polygon' && distToSeg(x, y, pts[pts.length - 1], pts[0]) <= tol) return true;
    return false;
  }
  if (el.type === 'shape') {
    const k = Math.hypot((x - el.cx) / Math.max(el.rx, 1), (y - el.cy) / Math.max(el.ry, 1));
    return Math.abs(k - 1) * Math.min(el.rx, el.ry) <= r + el.width / 2;
  }
  return true; // text / image / table: inside padded bounds
}

/** The points of a shape as a pen stroke drawn at the shape's width (pressure 0.5 gives exactly el.width). */
function shapeAsPoints(el) {
  if (el.kind === 'ellipse') {
    const n = Math.max(24, Math.min(180, Math.round((el.rx + el.ry) / 3)));
    return Array.from({ length: n + 1 }, (_, i) => { const a = (i / n) * Math.PI * 2; return [el.cx + el.rx * Math.cos(a), el.cy + el.ry * Math.sin(a), 0.5]; });
  }
  const pts = el.pts.map((p) => [p[0], p[1], 0.5]);
  if (el.kind === 'polygon' && pts.length > 1) pts.push([...pts[0]]);
  return pts;
}

/**
 * Partial erase: cut away the part of a stroke or shape inside the eraser circle (x, y, r).
 * Returns null when nothing is touched, else the pieces that are left (possibly none), as new pen/highlighter strokes.
 * Each piece gets a new id from makeId(). Only the stretch near the eraser is resampled, so the rest stays as it was.
 */
export function eraseFrom(el, x, y, r, makeId) {
  if (!hit(el, x, y, r)) return null;
  const src = el.type === 'stroke' ? el.points : shapeAsPoints(el);
  const base = el.type === 'stroke'
    ? el
    : { id: el.id, type: 'stroke', layerId: el.layerId, color: el.color, width: el.width, tool: 'pen' };
  const half = (p) => (base.tool === 'highlighter' ? base.width : base.width * pressureWidth(p[2] ?? 0.5)) / 2;
  const gone = (p) => Math.hypot(p[0] - x, p[1] - y) <= r + half(p);
  // resample segments that pass near the eraser, so the cut lands close to the circle's edge
  const step = Math.max(0.5, Math.min(r, base.width) / 3);
  const pts = [src[0]];
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > step && distToSeg(x, y, a, b) <= r + base.width) {
      const n = Math.min(400, Math.ceil(len / step));
      for (let k = 1; k < n; k++) { const t = k / n; pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] ?? 0.5) + ((b[2] ?? 0.5) - (a[2] ?? 0.5)) * t]); }
    }
    pts.push(b);
  }
  const runs = [];
  let run = [];
  for (const p of pts) {
    if (gone(p)) { if (run.length) runs.push(run); run = []; } else run.push(p);
  }
  if (run.length) runs.push(run);
  if (runs.length === 1 && runs[0].length === pts.length && el.type === 'stroke') return null;   // only grazed the padding
  // a leftover crumb of one point would show as a stray dot: drop it (a stroke that was a single dot is gone anyway)
  return runs.filter((p) => p.length > 1).map((p) => ({ ...base, id: makeId(), points: p }));
}

export function translate(el, dx, dy) {
  switch (el.type) {
    case 'stroke': return { ...el, points: el.points.map((p) => [p[0] + dx, p[1] + dy, p[2]]) };
    case 'shape': return el.kind === 'ellipse' ? { ...el, cx: el.cx + dx, cy: el.cy + dy } : { ...el, pts: el.pts.map((p) => [p[0] + dx, p[1] + dy]) };
    default: return { ...el, x: el.x + dx, y: el.y + dy };
  }
}

// ---------- paper templates ----------
export const TEMPLATES = { blank: 'Blank', lined: 'Lined', grid: 'Grid', dot: 'Dot grid', cornell: 'Cornell' };

export function drawTemplate(ctx, note, rect, a4) {
  const pal = paperOf(note);
  const t = note.template === 'cornell' && !a4 ? 'lined' : note.template;
  if (t === 'blank') return;
  ctx.save();
  ctx.strokeStyle = pal.line;
  ctx.fillStyle = pal.dot;
  ctx.lineWidth = 1;
  const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.w, y1 = rect.y + rect.h;
  const from = (v, s, min = -Infinity) => Math.max(min, Math.ceil(v / s) * s);
  ctx.beginPath();
  if (t === 'lined' || t === 'cornell') {
    const top = a4 ? 96 : -Infinity, bottom = a4 && t === 'cornell' ? y1 - 220 : y1;
    for (let y = from(y0, 32, top); y <= Math.min(y1, bottom); y += 32) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    if (t === 'cornell') {
      ctx.moveTo(200, 64); ctx.lineTo(200, y1 - 220);
      ctx.moveTo(0, y1 - 220); ctx.lineTo(x1, y1 - 220);
      ctx.moveTo(0, 64); ctx.lineTo(x1, 64);
    }
    ctx.stroke();
  } else if (t === 'grid') {
    for (let y = from(y0, 24); y <= y1; y += 24) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    for (let x = from(x0, 24); x <= x1; x += 24) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    ctx.stroke();
  } else if (t === 'dot') {
    for (let y = from(y0, 24); y <= y1; y += 24) for (let x = from(x0, 24); x <= x1; x += 24) ctx.rect(x - 1, y - 1, 2, 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Draw one page (template + layered elements) in page-local coordinates.
 * opts.view: visible rect (page-local) for culling / infinite template; opts.exclude: Set of ids; opts.linkRects: out array.
 */
export function drawPage(ctx, note, page, { view, exclude, linkRects } = {}) {
  if (page.tpl && TEMPLATES[page.tpl]) note = { ...note, template: page.tpl };
  const a4 = note.kind === 'a4';
  const rect = a4 ? { x: 0, y: 0, ...pageSize(page) } : view;
  ctx.save();
  ctx.fillStyle = paperOf(note).bg;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  if (a4) { ctx.beginPath(); ctx.rect(0, 0, rect.w, rect.h); ctx.clip(); }
  drawTemplate(ctx, note, rect, a4);
  for (const layer of note.layers) {
    if (!layer.visible) continue;
    const els = page.elements.filter((e) => e.layerId === layer.id && !exclude?.has(e.id) && (!view || intersects(bounds(e), view)));
    for (const e of els) if (e.tool === 'highlighter') drawElement(ctx, e, linkRects);
    for (const e of els) if (e.tool !== 'highlighter') drawElement(ctx, e, linkRects);
  }
  ctx.restore();
}

/** Render a page to a standalone canvas at a given scale (thumbnails, export). */
export function renderPageCanvas(note, i, { scale = 1, maxW, maxH, pad = 40 } = {}) {
  const page = note.pages[i];
  let r = { x: 0, y: 0, ...pageSize(page) };
  if (note.kind !== 'a4') {
    const b = unionBounds(page.elements);
    r = b ? { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad } : { x: 0, y: 0, w: 800, h: 600 };
  }
  if (maxW) scale = Math.min(maxW / r.w, (maxH || Infinity) / r.h);
  scale = Math.min(scale, 8000 / Math.max(r.w, r.h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(r.w * scale));
  c.height = Math.max(1, Math.round(r.h * scale));
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(-r.x, -r.y);
  exact++;
  try { drawPage(ctx, note, page, { view: r }); } finally { exact--; }
  return c;
}

/** Stretch a shape by kx, ky around (ox, oy), so a rectangle or ellipse can change its proportions; its line width stays.
 *  Other elements keep their proportions (scaled by the larger change). */
export function stretchElement(el, ox, oy, kx, ky) {
  if (el.type !== 'shape') return scaleElement(el, ox, oy, Math.abs(kx - 1) > Math.abs(ky - 1) ? kx : ky);
  const sx = (x) => ox + (x - ox) * kx, sy = (y) => oy + (y - oy) * ky;
  return el.kind === 'ellipse'
    ? { ...el, cx: sx(el.cx), cy: sy(el.cy), rx: el.rx * kx, ry: el.ry * ky }
    : { ...el, pts: el.pts.map((p) => [sx(p[0]), sy(p[1])]) };
}

/** Scale an element by k around (ox, oy). Ink widths and text sizes scale too. */
export function scaleElement(el, ox, oy, k) {
  const sx = (x) => ox + (x - ox) * k, sy = (y) => oy + (y - oy) * k;
  switch (el.type) {
    case 'stroke': return { ...el, width: el.width * k, points: el.points.map((p) => [sx(p[0]), sy(p[1]), p[2]]) };
    case 'shape': return el.kind === 'ellipse'
      ? { ...el, width: el.width * k, cx: sx(el.cx), cy: sy(el.cy), rx: el.rx * k, ry: el.ry * k }
      : { ...el, width: el.width * k, pts: el.pts.map((p) => [sx(p[0]), sy(p[1])]) };
    case 'text': return { ...el, x: sx(el.x), y: sy(el.y), w: el.w * k, size: Math.max(6, el.size * k) };
    case 'table': return { ...el, x: sx(el.x), y: sy(el.y), colW: el.colW.map((v) => v * k), rowH: el.rowH.map((v) => v * k), size: Math.max(6, el.size * k) };
    default: return { ...el, x: sx(el.x), y: sy(el.y), w: el.w * k, h: el.h * k };
  }
}
