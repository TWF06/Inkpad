// A PDF in the notes folder *is* the note: Inkpad writes into the PDF itself and keeps no other file.
//
//  Opening:  the pages are drawn from the PDF (cached on the device, so the next opening is quick) and the
//            editable writing is read back from the PDF (see pdfwork.js), so old writing can still be erased,
//            moved or recoloured.
//  Writing:  every change is first kept in a journal on the device (instant, survives a crash); the PDF itself is
//            rewritten after a pause, when the note is closed and when the app goes to the background.
import * as R from './render.js';
import { uid, sanitizeNote, store, pdfIdOf } from './store.js';
import { loadPdfJs, pageSizeFor, PDF_RES } from './importer.js';

const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const FLUSH_AFTER_MS = 15000;

// ---------- small key/value store on the device (same database as the folder handle) ----------
// one connection, opened once: opening the database for every read and write was slow with many pages
let dbp = null;
function db() {
  dbp ??= new Promise((res, rej) => { const r = indexedDB.open('inkpad-handles', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onsuccess = () => { r.result.onclose = () => { dbp = null; }; res(r.result); }; r.onerror = () => { dbp = null; rej(r.error); }; });
  return dbp;
}
async function kvGet(key) {
  try { const d = await db(); return await new Promise((res) => { const q = d.transaction('h').objectStore('h').get(key); q.onsuccess = () => res(q.result ?? null); q.onerror = () => res(null); }); } catch { return null; }
}
async function kvSet(key, value) {
  try { const d = await db(); await new Promise((res) => { const t = d.transaction('h', 'readwrite'); value === undefined ? t.objectStore('h').delete(key) : t.objectStore('h').put(value, key); t.oncomplete = res; t.onerror = res; }); } catch {}
}

// ---------- the worker ----------
let worker = null, seq = 0;
const waiting = new Map();
function call(msg, transfer = []) {
  if (!worker) {
    worker = new Worker(new URL('./pdfwork.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (!w) return; waiting.delete(e.data.id); e.data.ok ? w.res(e.data) : w.rej(new Error(e.data.error)); };
    worker.onerror = (e) => { for (const w of waiting.values()) w.rej(new Error(e.message || 'PDF worker failed')); waiting.clear(); worker = null; };
  }
  return new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); worker.postMessage({ ...msg, id }, transfer); });
}

// ---------- ids ----------
export const pdfId = pdfIdOf;
const isBgLayer = (note, layerId) => note.layers.some((l) => l.id === layerId && l.bg);

// ---------- opening ----------
const openDocs = new Map();   // note id → { doc (pdf.js), path, ver }

// Is this still the file we know? After Inkpad writes a PDF, the folder listing on Android can report a different
// date than the write did, so the date alone made every opening look like a changed file: all cached page pictures
// and the writing were thrown away and every page was drawn from the PDF again. The size tells an outside change.
const sameFile = (known, size) => !!known && known.size === size;

/** What the device knows about a PDF: { lm, size, ver } — ver changes when someone else changed the file. */
async function fileState(path, lm, size) {
  const st = await kvGet(`pdfstate:${path}`);
  if (sameFile(st, size)) { if (st.lm !== lm) { st.lm = lm; await kvSet(`pdfstate:${path}`, st); } return st; }
  const next = { lm, size, ver: uid() };
  await kvSet(`pdfstate:${path}`, next);
  return next;
}

/**
 * Open a PDF from the notes folder as a note.
 * @returns the note, with the PDF pages as pictures on a locked bottom layer (drawn in the background; see renderPages)
 */
export async function openPdfNote({ id, path, folderId, lm, size }) {
  await (flushing.get(id) || Promise.resolve()).catch(() => {});   // closed a moment ago: let that write finish first
  if (flushing.has(id)) { lm = undefined; size = undefined; }
  const file = await store.openDocument(path);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false }).promise;
  lm = lm ?? file.lastModified; size = size ?? file.size;
  const st = await fileState(path, lm, size);

  // the editable writing: unsaved edits (journal) → cached copy → read from the PDF
  let json = null;
  const journal = await kvGet(`journal:${path}`);
  if (journal && sameFile(journal, size)) json = journal.json;   // edits not written into the PDF yet
  if (!json) { const c = await kvGet(`pdfdata:${path}`); if (c && c.ver === st.ver) json = c.json; }
  if (!json) {
    try {
      const r = await call({ op: 'read', bytes: bytes.slice() });
      json = r.data;
      await kvSet(`pdfdata:${path}`, { ver: st.ver, json });
    } catch (e) { console.warn('Could not read Inkpad data from', path, e); }
  }
  let data = null;
  try { data = json ? JSON.parse(json) : null; } catch {}

  const count = doc.numPages;
  const sizes = [];
  for (let i = 1; i <= count; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    sizes.push(pageSizeFor({ w: vp.width * 96 / 72, h: vp.height * 96 / 72 }));
  }

  // rebuild through the same checks as any note file: the data inside a PDF can come from anywhere
  const clean = data && sanitizeNote({ ...data, pages: Array.isArray(data.pages) ? data.pages : [] });
  let layers = clean?.layers?.length ? clean.layers : [];
  let bg = layers.find((l) => l.bg);
  if (!bg) { bg = { id: uid(), name: 'PDF', visible: true, locked: true, bg: true }; layers = [bg, ...layers]; }
  bg.locked = true;
  if (!layers.some((l) => !l.bg)) layers.push({ id: uid(), name: 'Layer 1', visible: true, locked: false });
  const dataPages = clean && Array.isArray(data.pages) && data.pages.length === count ? clean.pages : null;

  const pages = sizes.map((s, i) => {
    const dp = dataPages?.[i];
    const pid = dp?.id || `pg${i}`;
    return { id: pid, ...s, pdfIndex: i, elements: [
      { id: `bg_${pid}`.slice(0, 64), type: 'image', layerId: bg.id, x: 0, y: 0, w: s.w, h: s.h, src: BLANK },
      ...(dp ? dp.elements.filter((e) => e.layerId !== bg.id) : []),
    ] };
  });
  // pages added in Inkpad that the file doesn't have yet (only in an unsaved journal)
  if (clean && Array.isArray(data.pages) && data.pages.length > count && journal?.json === json) {
    clean.pages.slice(count).forEach((dp, k) => {
      const tpl = data.pages[count + k]?.tpl, ext = data.pages[count + k]?.ext;
      const okExt = ext && typeof ext.key === 'string' && Number.isInteger(ext.page) ? { ext: { key: ext.key, page: ext.page } } : {};
      pages.push({ id: dp.id, w: dp.w || R.PAGE_W, h: dp.h || R.PAGE_H, pdfIndex: null, ...(R.TEMPLATES[tpl] ? { tpl } : {}), ...okExt, elements: [
        ...(okExt.ext ? [{ id: `bg_${dp.id}`.slice(0, 64), type: 'image', layerId: bg.id, x: 0, y: 0, w: dp.w || R.PAGE_W, h: dp.h || R.PAGE_H, src: BLANK }] : []),
        ...dp.elements] });
    });
  }

  const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.pdf$/i, '');
  const note = {
    id, title, folderId, kind: 'a4', template: 'blank', paper: clean?.paper || 'white', pdf: path,
    newPaper: data?.newPaper && R.TEMPLATES[data.newPaper] ? data.newPaper : 'lined',
    pages, layers, outline: clean?.outline || [], view: null, thumb: null,
    createdAt: lm, updatedAt: lm, dataId: typeof data?.id === 'string' ? data.id : uid(),
  };
  openDocs.set(id, { doc, path, ver: st.ver, lm, size });
  return note;
}

/**
 * Draw the PDF pages (cached on the device) and hand each to onPage(pageIndex, src). `order` = page indices,
 * the ones on screen first. Returns false if stopped (stop() → true).
 */
export async function renderPages(note, order, onPage, stop = () => false) {
  const o = openDocs.get(note.id);
  if (!o) return;
  const lib = await loadPdfJs();
  // Inkpad's own writing is in the PDF as the layer "Inkpad ink": hide it, the editor draws the editable copy
  const cfg = await o.doc.getOptionalContentConfig();
  for (const [gid, g] of Object.entries(cfg.getGroups() || {})) if (g?.name === 'Inkpad ink') cfg.setVisibility(gid, false);
  for (const i of order) {
    if (stop()) return false;
    const page = note.pages.find((p) => p.pdfIndex === i);
    if (!page) continue;
    const key = `bg:${o.path}:${page.id}`;
    const c = await kvGet(key);
    if (c && c.ver === o.ver && (c.blob || c.src)) { onPage(i, c.blob ? blobUrl(note.id, c.blob) : c.src); continue; }
    const p = await o.doc.getPage(i + 1);
    const base = p.getViewport({ scale: 1 });
    const vp = p.getViewport({ scale: Math.min(4, PDF_RES / Math.max(base.width, base.height)) });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await p.render({ canvasContext: ctx, viewport: vp, optionalContentConfigPromise: Promise.resolve(cfg), annotationMode: lib.AnnotationMode.ENABLE }).promise;
    // toBlob encodes the JPEG in the background; toDataURL did it on the main thread (~85 ms a page on a tablet)
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.9));
    cv.width = cv.height = 0;
    p.cleanup();
    if (!blob) continue;
    await kvSet(key, { ver: o.ver, blob });
    onPage(i, blobUrl(note.id, blob));
    await new Promise((r) => setTimeout(r, 30));
  }
  return true;
}

// page pictures are shown from blob: URLs, released when the note closes
const urls = new Map();   // note id → [url]
function blobUrl(id, blob) {
  const u = URL.createObjectURL(blob);
  if (!urls.has(id)) urls.set(id, []);
  urls.get(id).push(u);
  return u;
}

export function closePdfNote(id) {
  for (const u of urls.get(id) || []) URL.revokeObjectURL(u);
  urls.delete(id);
  const o = openDocs.get(id);
  openDocs.delete(id);
  o?.doc.destroy().catch(() => {});
}

// ---------- PDFs added into a PDF note ("PDF from this device") ----------
/** Keep an added PDF on the device until its pages are copied into the note's PDF. Returns its key. */
export async function stashPdf(file) {
  const key = uid();
  await kvSet(`pdfins:${key}`, new Uint8Array(await file.arrayBuffer()));
  return key;
}

// ---------- saving ----------
/** The editable copy kept inside the PDF: everything except the PDF pages themselves. */
function editableData(note) {
  return JSON.stringify({
    app: 'inkpad', v: 1, id: note.dataId, paper: note.paper, newPaper: note.newPaper,
    layers: note.layers, outline: note.outline,
    pages: note.pages.map((p) => ({
      id: p.id, w: p.w, h: p.h,
      ...(p.pdfIndex == null && p.tpl ? { tpl: p.tpl } : {}),
      ...(p.pdfIndex == null && p.ext ? { ext: p.ext } : {}),
      elements: p.elements.filter((e) => !isBgLayer(note, e.layerId)),
    })),
  });
}

const timers = new Map();
/** Keep the edits on the device now; write the PDF after a pause. */
export async function stagePdfNote(note, onSaved) {
  const o = openDocs.get(note.id);
  if (!o) return;
  await kvSet(`journal:${o.path}`, { lm: o.lm, size: o.size, json: editableData(note), at: Date.now() });
  clearTimeout(timers.get(note.id));
  timers.set(note.id, setTimeout(() => flushPdfNote(note).then(onSaved).catch((e) => console.warn(e)), FLUSH_AFTER_MS));
}

const flushing = new Map();
/** Resolves once any write of this note into its PDF has finished (e.g. right after closing it). */
export const settled = (id) => (flushing.get(id) || Promise.resolve()).catch(() => {});
/** Write the PDF now (if there are edits not in it yet). */
export function flushPdfNote(note) {
  clearTimeout(timers.get(note.id));
  const prev = flushing.get(note.id) || Promise.resolve();
  const p = prev.catch(() => {}).then(() => writePdf(note));
  flushing.set(note.id, p);
  return p;
}

async function writePdf(note) {
  const o = openDocs.get(note.id);
  if (!o) return false;
  const j = await kvGet(`journal:${o.path}`);
  if (!j) return false;   // nothing new
  const file = await store.openDocument(o.path);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pages = await pagesForSave(note);
  const added = await addedPdfs(note);
  const r = await call({ op: 'save', bytes, pages: pages.specs, data: editableData(note), added: added.docs }, [bytes.buffer, ...pages.transfer, ...added.transfer]);
  const f = await store.replaceFile(o.path, r.bytes);
  // the pages are now all in the file, in this order (a new page's paper or added PDF page is part of it now)
  note.pages.forEach((p, i) => { p.pdfIndex = i; delete p.ext; });
  for (const key of added.keys) await kvSet(`pdfins:${key}`, undefined);
  o.lm = f.lastModified; o.size = f.size;
  await kvSet(`pdfstate:${o.path}`, { lm: o.lm, size: o.size, ver: o.ver });
  await kvSet(`pdfdata:${o.path}`, { ver: o.ver, json: editableData(note) });
  const j2 = await kvGet(`journal:${o.path}`);
  if (j2 && j2.at === j.at) await kvSet(`journal:${o.path}`, undefined);
  else if (j2) await kvSet(`journal:${o.path}`, { ...j2, lm: o.lm, size: o.size });   // newer edits arrived meanwhile
  return true;
}

// ---------- turning the writing into PDF drawing operations (in note px, y down) ----------
function hexRgb(c) {
  let h = String(c || '#000').replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbaOver(rgba, bg) {
  const m = /rgba?\(([^)]+)\)/.exec(rgba);
  if (!m) return hexRgb(rgba);
  const [r, g, b, a = 1] = m[1].split(',').map(Number);
  return [r, g, b].map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
}
const paperSpec = (note) => {
  const pal = R.PAPERS[note.paper] || R.PAPERS.white, bg = hexRgb(pal.bg);
  return { template: note.newPaper || 'lined', bg: note.paper === 'white' ? null : bg, line: rgbaOver(pal.line, bg), dot: rgbaOver(pal.dot, bg) };
};

function quadPieces(p, width) {
  const n = p.length, out = [];
  const w = (i) => (width == null ? 0 : width * R.pressureWidth(p[i][2]));
  let prev = p[0];
  for (let i = 1; i < n - 1; i++) {
    const m = [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2];
    out.push([prev[0], prev[1], p[i][0], p[i][1], m[0], m[1], w(i)]);
    prev = m;
  }
  out.push([prev[0], prev[1], null, null, p[n - 1][0], p[n - 1][1], w(n - 1)]);
  return out;
}

async function dataUrlBytes(src) {
  const m = /^data:image\/(png|jpe?g);base64,/i.exec(src);
  if (m) {
    const bin = atob(src.slice(src.indexOf(',') + 1)), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);   // much faster than Uint8Array.from(…, fn) on big pictures
    return { bytes, fmt: /png/i.test(m[1]) ? 'png' : 'jpg' };
  }
  // other formats (webp, gif, bmp) → PNG
  const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
  c.getContext('2d').drawImage(im, 0, 0);
  return dataUrlBytes(c.toDataURL('image/png'));
}

/** Typed text and tables are drawn as pictures, so every language and font looks the same as in Inkpad. */
function rasterize(el) {
  const b = R.bounds(el);
  const k = Math.min(3, 4000 / Math.max(b.w, b.h, 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(b.w * k)); c.height = Math.max(1, Math.ceil(b.h * k));
  const ctx = c.getContext('2d');
  ctx.scale(k, k); ctx.translate(-b.x, -b.y);
  R.drawElement(ctx, el);
  const src = c.toDataURL('image/png');
  return { b, src };
}

async function pagesForSave(note) {
  const specs = [], transfer = [];
  const paper = paperSpec(note);
  for (const p of note.pages) {
    const ink = [];
    for (const layer of note.layers) {
      if (layer.bg || !layer.visible) continue;
      const els = p.elements.filter((e) => e.layerId === layer.id);
      for (const e of [...els.filter((x) => x.tool === 'highlighter'), ...els.filter((x) => x.tool !== 'highlighter')]) {
        if (e.type === 'stroke') {
          const c = hexRgb(e.color);
          if (e.tool === 'highlighter') ink.push(['hl', c, e.width, e.points.length > 1 ? quadPieces(e.points, null) : [[e.points[0][0], e.points[0][1], null, null, e.points[0][0] + 0.01, e.points[0][1], 0]]]);
          else if (e.points.length === 1) ink.push(['dot', c, e.points[0][0], e.points[0][1], (e.width * R.pressureWidth(e.points[0][2])) / 2]);
          else ink.push(['pen', c, quadPieces(e.points, e.width)]);
        } else if (e.type === 'shape') {
          if (e.kind === 'ellipse') ink.push(['ell', hexRgb(e.color), e.width, e.cx, e.cy, Math.max(e.rx, 0.5), Math.max(e.ry, 0.5)]);
          else ink.push(['poly', hexRgb(e.color), e.width, e.pts, e.kind === 'polygon']);
        } else if (e.type === 'image') {
          const { bytes, fmt } = await dataUrlBytes(e.src);
          ink.push(['img', e.x, e.y, e.w, e.h, bytes, fmt]); transfer.push(bytes.buffer);
        } else if (e.type === 'text' || e.type === 'table') {
          const { b, src } = rasterize(e);
          const { bytes } = await dataUrlBytes(src);
          ink.push(['img', b.x, b.y, b.w, b.h, bytes, 'png']); transfer.push(bytes.buffer);
        }
      }
    }
    const s = R.pageSize(p);
    const ext = p.pdfIndex == null && p.ext ? p.ext : null;
    specs.push({ from: p.pdfIndex ?? null, ext, pxW: s.w, pxH: s.h, paper: p.pdfIndex == null && !ext ? paper : null, ink });
  }
  return { specs, transfer };
}

// ---------- making new PDFs ----------
/**
 * Write a note that has no PDF yet (a new note, pictures, an old .inkpad note) as a new PDF, or into `bytes`
 * (an existing PDF whose pages the note's pages with a pdfIndex refer to). Returns the bytes.
 */
export async function buildPdf(note, bytes = null) {
  const pages = await pagesForSave(note);
  const added = await addedPdfs(note);
  const r = await call({ op: 'save', bytes, pages: pages.specs, data: editableData(note), added: added.docs }, [...(bytes ? [bytes.buffer] : []), ...pages.transfer, ...added.transfer]);
  for (const key of added.keys) await kvSet(`pdfins:${key}`, undefined);
  return r.bytes;
}

/** The added PDFs the note's new pages come from: { docs: { key: bytes }, keys, transfer }. */
async function addedPdfs(note) {
  const keys = [...new Set(note.pages.filter((p) => p.pdfIndex == null && p.ext).map((p) => p.ext.key))];
  const docs = {}, transfer = [];
  for (const key of keys) {
    const b = await kvGet(`pdfins:${key}`);
    if (b) { const copy = new Uint8Array(b); docs[key] = copy; transfer.push(copy.buffer); }
  }
  return { docs, keys, transfer };
}

/** A thumbnail of page 1 (with the writing) and the page count, for the library. */
export async function pdfThumb(path) {
  const file = await store.openDocument(path);
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, enableXfa: false }).promise;
  try {
    const p = await doc.getPage(1);
    const base = p.getViewport({ scale: 1 });
    const vp = p.getViewport({ scale: Math.min(400 / base.width, 400 / base.height) });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    return { thumb: c.toDataURL('image/jpeg', 0.8), pageCount: doc.numPages };
  } finally { doc.destroy().catch(() => {}); }
}

/** Forget what the device cached about a PDF (after it was deleted, renamed or moved). */
export async function forgetPdf(path) {
  for (const k of ['pdfstate', 'pdfdata', 'journal']) await kvSet(`${k}:${path}`, undefined);
}

// ---------- notes that aren't PDFs yet ----------
/**
 * Old notes kept PDF pages as pictures inside a fixed A4 page. Fit each such page to its picture, moving and
 * scaling the writing with it (so it stays where it was on the page). Returns true if anything changed.
 */
export function fitPagesToBackgrounds(note) {
  let changed = false;
  const bg = new Set(note.layers.filter((l) => l.bg).map((l) => l.id));
  note.pages = note.pages.map((p, pi) => {
    const pdf = p.elements.filter((e) => e.type === 'image' && bg.has(e.layerId));
    if (pdf.length !== 1) return p;
    const e = pdf[0], cur = R.pageSize(p), want = pageSizeFor(e);
    if (Math.abs(e.x) < 1 && Math.abs(e.y) < 1 && Math.abs(cur.w - want.w) < 1 && Math.abs(cur.h - want.h) < 1) return p;
    const k = want.w / e.w;
    const move = (x) => R.scaleElement(R.translate(x, -e.x, -e.y), 0, 0, k);
    note.outline = note.outline.map((o) => (o.page === pi ? { ...o, x: (o.x - e.x) * k, y: (o.y - e.y) * k } : o));
    changed = true;
    return { ...p, ...want, elements: p.elements.map((x) => (x === e ? { ...e, x: 0, y: 0, w: want.w, h: want.h } : move(x))) };
  });
  return changed;
}

/** A note made in Inkpad (not from a PDF file) → a new PDF in the folder. Returns the new note's id. */
export async function saveAsNewPdf(note) {
  note.dataId ??= uid();
  note.newPaper ??= note.template && note.template !== 'blank' ? note.template : 'blank';
  note.pages.forEach((p) => { p.pdfIndex = null; });
  const bytes = await buildPdf(note, null);
  const path = await store.createFile(note.folderId, note.title || 'Untitled', '.pdf', bytes);
  return store.idForPath(path);
}

/** A new, empty page note: a PDF with the chosen paper. */
export async function createPdfNote({ title = 'Untitled', folderId = null, template = 'lined', paper = 'white', landscape = false } = {}) {
  const s = landscape ? { w: R.PAGE_H, h: R.PAGE_W } : { w: R.PAGE_W, h: R.PAGE_H };
  const note = {
    id: uid(), title, folderId, kind: 'a4', template: 'blank', newPaper: template, paper,
    layers: [{ id: uid(), name: 'PDF', visible: true, locked: true, bg: true }, { id: uid(), name: 'Layer 1', visible: true, locked: false }],
    pages: [{ id: uid(), ...s, elements: [] }], outline: [],
  };
  return saveAsNewPdf(note);
}

/**
 * An older .inkpad page note → its PDF. If it was made from a PDF that is still in the folder, the writing goes into
 * that PDF; otherwise a new PDF is made. The .inkpad file is removed afterwards. Returns the PDF note's id.
 */
export async function moveNoteIntoPdf(note, inkpadPath, sourceExists) {
  fitPagesToBackgrounds(note);
  note.dataId = uid();
  note.newPaper = note.template && note.template !== 'blank' ? note.template : 'blank';
  const bg = new Set(note.layers.filter((l) => l.bg).map((l) => l.id));
  if (!note.layers.some((l) => l.bg)) note.layers.unshift({ id: uid(), name: 'PDF', visible: true, locked: true, bg: true });
  let id;
  if (note.source && /\.pdf$/i.test(note.source) && sourceExists) {
    const file = await store.openDocument(note.source);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const count = (await call({ op: 'read', bytes: bytes.slice() })).pages;
    let k = 0;
    for (const p of note.pages) {
      const hasPdf = p.elements.some((e) => e.type === 'image' && bg.has(e.layerId));
      p.pdfIndex = hasPdf && k < count ? k++ : null;
      p.elements = p.elements.filter((e) => !(e.type === 'image' && bg.has(e.layerId)));
    }
    const out = await buildPdf(note, bytes);
    await store.replaceFile(note.source, out);
    id = store.idForPath(note.source);
  } else {
    // no PDF to write into: the page pictures it holds are kept, on a locked layer of their own
    if (note.pages.some((p) => p.elements.some((e) => bg.has(e.layerId)))) {
      const keep = { id: uid(), name: 'Pages', visible: true, locked: true };
      const at = note.layers.findIndex((l) => l.bg);
      note.layers.splice(at + 1, 0, keep);
      for (const p of note.pages) p.elements = p.elements.map((e) => (bg.has(e.layerId) ? { ...e, layerId: keep.id } : e));
    }
    id = await saveAsNewPdf(note);
  }
  await store.delNote(note.id);   // the PDF holds everything now
  void inkpadPath;
  return id;
}
