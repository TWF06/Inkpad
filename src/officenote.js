// Word, PowerPoint and Excel files as notes, the way PDFs are (pdfnote.js): the file in the notes folder *is* the
// note, and Inkpad writes into it. Nothing else is kept next to it.
//
//  Opening:  the document's pages are drawn as pictures (the first time only; they are kept on the device), and the
//            editable writing is read back from the file (officefile.js: inkpad/note.json), so writing from before
//            can still be erased, moved or recoloured.
//  Writing:  every change goes into a journal on the device at once (survives a crash); the file itself is written
//            after a pause, when the note is closed and when the app goes to the background.
//  In Word / PowerPoint / Excel your writing shows as a picture over each page, slide or sheet; pages added in
//  Inkpad are pages, slides or sheets of their own. The document's own content is never changed.
import * as R from './render.js';
import { uid, sanitizeNote, store } from './store.js';
import { kvGet, kvSet } from './pdfnote.js';
import { documentPages, loadZip, INK_MARK, ADDED_PART } from './docconvert.js';
import { writeOffice, DATA_PART } from './officefile.js';
import { toast } from './ui.js';

export const OFFICE_RE = /\.(docx|pptx|xlsx)$/i;
export const officeType = (path) => OFFICE_RE.exec(path || '')?.[1].toLowerCase() || null;
export const TYPE_LABEL = { docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel' };
export const TYPE_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const FLUSH_AFTER_MS = 15000;
const SLIDE = { w: 1280, h: 720 };   // PowerPoint's widescreen slide (13.33 × 7.5 in)
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);

const open = new Map();   // note id → { path, type, base, lm, size }
const urls = new Map();   // note id → [blob: URLs of page pictures]
function blobUrl(id, blob) {
  const u = URL.createObjectURL(blob);
  if (!urls.has(id)) urls.set(id, []);
  urls.get(id).push(u);
  return u;
}

// ---------- the document's own pages ----------
/** Does the file have content of its own (not just pages Inkpad made)? A new Word / PowerPoint / Excel note doesn't. */
async function hasOwnContent(zip, type) {
  const xml = async (p) => (await zip.file(p)?.async('string')) || '';
  if (type === 'pptx') return zip.file(/^ppt\/slides\/slide[^/]*\.xml$/i).some((f) => !ADDED_PART.test(`/${f.name}`));
  if (type === 'xlsx') return zip.file(/^xl\/worksheets\/sheet[^/]*\.xml$/i).some((f) => !ADDED_PART.test(`/${f.name}`));
  const d = new DOMParser().parseFromString(await xml('word/document.xml'), 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const body = d.getElementsByTagNameNS(W, 'body')[0];
  if (!body) return false;
  for (const c of body.children) {
    if (c.localName === 'tbl' || c.localName === 'sdt') return true;
    if (c.localName === 'p' && c.getAttributeNS(W, 'rsidRDefault') !== INK_MARK && (c.textContent.trim() || c.getElementsByTagNameNS('*', 'drawing').length || c.getElementsByTagNameNS('*', 'pict').length)) return true;
  }
  return false;
}

/** The document's pages as pictures, and where each is in the file; drawn once, then kept on the device. */
async function baseOf(path, file, size, zip, type) {
  const c = await kvGet(`officebase:${path}`);
  if (c && c.size === size) return c;
  let base = { size, pages: [], geo: null };
  if (await hasOwnContent(zip, type)) {
    toast(`Opening ${nameOf(path)}…`, 60000);
    const { pages, geo } = await documentPages(file, (i, n) => toast(`Opening ${nameOf(path)}… page ${i} of ${n}`, 60000));
    base = { size, pages: pages.map((p) => ({ w: p.w, h: p.h, blob: new Blob([p.bytes], { type: 'image/jpeg' }) })), geo: { ...geo, pages: pages.map((p) => p.at) } };
    toast('Ready', 700);
  }
  await kvSet(`officebase:${path}`, base);
  return base;
}

// ---------- opening ----------
/** Open a Word / PowerPoint / Excel file from the notes folder as a note (same shape as a PDF note). */
export async function openOfficeNote({ id, path, folderId, lm, size }) {
  await settled(id);   // closed a moment ago: let that write finish first
  const type = officeType(path);
  const file = await store.openDocument(path);
  if (lm == null || size == null || flushing.has(id)) { lm = file.lastModified; size = file.size; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const JSZip = await loadZip();
  let zip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new Error(`${nameOf(path)} is damaged or not a ${TYPE_LABEL[type]} file`); }

  // the editable writing: unsaved edits (journal) → inside the file
  let json = null;
  const journal = await kvGet(`journal:${path}`);
  if (journal && journal.size === size) json = journal.json;
  json ??= (await zip.file(DATA_PART)?.async('string')) ?? null;
  let data = null;
  try { data = json ? JSON.parse(json) : null; } catch {}
  const base = await baseOf(path, file, size, zip, type);

  // rebuild through the same checks as any note file: the data inside a file can come from anywhere
  const clean = data && sanitizeNote({ ...data, pages: Array.isArray(data.pages) ? data.pages : [] });
  let layers = clean?.layers?.length ? clean.layers : [];
  let bg = layers.find((l) => l.bg);
  if (!bg) { bg = { id: uid(), name: TYPE_LABEL[type], visible: true, locked: true, bg: true }; layers = [bg, ...layers]; }
  bg.locked = true;
  if (!layers.some((l) => !l.bg)) layers.push({ id: uid(), name: 'Layer 1', visible: true, locked: false });

  const saved = clean ? clean.pages.map((cp, i) => ({ cp, raw: data.pages[i] || {} })) : [];
  const count = base.pages.length;
  const docPage = (k, x) => {
    const pid = x?.cp.id || `dp${k}`, s = base.pages[k];
    return { id: pid, w: s.w, h: s.h, docIndex: k, elements: [
      { id: `bg_${pid}`.slice(0, 64), type: 'image', layerId: bg.id, x: 0, y: 0, w: s.w, h: s.h, src: blobUrl(id, s.blob) },
      ...(x ? x.cp.elements.filter((e) => e.layerId !== bg.id) : []),
    ] };
  };
  const ownPage = (x) => ({ id: x.cp.id || uid(), w: x.cp.w || x.raw.w || R.PAGE_W, h: x.cp.h || x.raw.h || R.PAGE_H, docIndex: null,
    ...(R.TEMPLATES[x.raw.tpl] ? { tpl: x.raw.tpl } : {}), elements: x.cp.elements.filter((e) => e.layerId !== bg.id) });
  // the pages in the order they had in Inkpad; document pages nobody has written on yet in their own order
  const pages = [], used = new Set();
  for (const x of saved) {
    const k = x.raw.doc;
    if (Number.isInteger(k) && k >= 0 && k < count && !used.has(k)) { used.add(k); pages.push(docPage(k, x)); }
    else if (k == null) pages.push(ownPage(x));
  }
  for (let k = 0; k < count; k++) {
    if (used.has(k)) continue;
    const at = pages.findIndex((p) => p.docIndex != null && p.docIndex > k);
    pages.splice(at < 0 ? pages.length : at, 0, docPage(k));
  }
  if (!pages.length) pages.push({ id: uid(), ...(type === 'pptx' ? SLIDE : { w: R.PAGE_W, h: R.PAGE_H }), docIndex: null, tpl: data?.newPaper || 'blank', elements: [] });

  const note = {
    id, title: nameOf(path).replace(OFFICE_RE, ''), folderId, kind: 'a4', template: 'blank', paper: clean?.paper || 'white',
    pdf: path,   // the file this note is (named `pdf` for every file-backed note: PDF, Word, PowerPoint, Excel)
    docType: type, newPaper: R.TEMPLATES[data?.newPaper] ? data.newPaper : 'lined',
    pages, layers, outline: clean?.outline || [], view: null, thumb: null,
    createdAt: lm, updatedAt: lm, dataId: typeof data?.id === 'string' ? data.id : uid(),
  };
  open.set(id, { path, type, base, lm, size });
  return note;
}

export function closeOfficeNote(id) {
  for (const u of urls.get(id) || []) URL.revokeObjectURL(u);
  urls.delete(id);
  open.delete(id);
}

// ---------- saving ----------
/** The editable copy kept inside the file: everything except the document's own pages. */
function editableData(note) {
  const bg = new Set(note.layers.filter((l) => l.bg).map((l) => l.id));
  return JSON.stringify({
    app: 'inkpad', v: 1, id: note.dataId, paper: note.paper, newPaper: note.newPaper,
    layers: note.layers, outline: note.outline,
    pages: note.pages.map((p) => ({ id: p.id, w: p.w, h: p.h, doc: p.docIndex ?? null, ...(p.tpl ? { tpl: p.tpl } : {}),
      elements: p.elements.filter((e) => !bg.has(e.layerId)) })),
  });
}

/** A page as a PNG: the writing alone (transparent) over a document page, or paper and writing for a page of Inkpad's own. */
async function pagePng(note, i) {
  const p = note.pages[i], own = p.docIndex == null;
  const bg = new Set(note.layers.filter((l) => l.bg).map((l) => l.id));
  const ink = p.elements.filter((e) => !bg.has(e.layerId) && note.layers.find((l) => l.id === e.layerId)?.visible !== false);
  if (!own && !ink.length) return null;
  await R.preloadImages(ink.filter((e) => e.type === 'image').map((e) => e.src));
  const s = R.pageSize(p);
  const canvas = R.renderPageCanvas(note, i, { scale: Math.min(2, 4000 / Math.max(s.w, s.h)), inkOnly: !own });
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  canvas.width = canvas.height = 0;
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

const timers = new Map();
/** Keep the edits on the device now; write the file after a pause. */
export async function stageOfficeNote(note, onSaved) {
  const o = open.get(note.id);
  if (!o) return;
  await kvSet(`journal:${o.path}`, { size: o.size, json: editableData(note), at: Date.now() });
  clearTimeout(timers.get(note.id));
  timers.set(note.id, setTimeout(() => flushOfficeNote(note).then(onSaved).catch((e) => console.warn(e)), FLUSH_AFTER_MS));
}

const flushing = new Map();
/** Resolves once any write of this note into its file has finished. */
export const settled = (id) => (flushing.get(id) || Promise.resolve()).catch(() => {});
/** Write the file now (if there are edits not in it yet). */
export function flushOfficeNote(note) {
  clearTimeout(timers.get(note.id));
  const prev = flushing.get(note.id) || Promise.resolve();
  const p = prev.catch(() => {}).then(() => writeNote(note));
  flushing.set(note.id, p);
  return p;
}

async function writeNote(note) {
  const o = open.get(note.id);
  if (!o) return false;
  const j = await kvGet(`journal:${o.path}`);
  if (!j) return false;   // nothing new
  const pages = [];
  for (let i = 0; i < note.pages.length; i++) {
    const p = note.pages[i];
    pages.push({ w: p.w, h: p.h, doc: p.docIndex ?? null, png: await pagePng(note, i) });
  }
  const bytes = new Uint8Array(await (await store.openDocument(o.path)).arrayBuffer());
  const out = await writeOffice({ type: o.type, bytes, data: editableData(note), pages, geo: o.base.geo });
  const f = await store.replaceFile(o.path, out);
  o.lm = f.lastModified; o.size = f.size;
  // the document's own pages are as they were: keep their pictures for the new file
  o.base.size = f.size;
  await kvSet(`officebase:${o.path}`, o.base);
  const j2 = await kvGet(`journal:${o.path}`);
  if (j2 && j2.at === j.at) await kvSet(`journal:${o.path}`, undefined);
  else if (j2) await kvSet(`journal:${o.path}`, { ...j2, size: o.size });   // newer edits arrived meanwhile
  return true;
}

/** Forget what the device kept about a file (after it was deleted, renamed or moved). */
export async function forgetOffice(path) {
  for (const k of ['journal', 'officebase']) await kvSet(`${k}:${path}`, undefined);
}

// ---------- library ----------
/** A thumbnail for the library: the first page if it was opened before, else a card showing the file type. */
export async function officeThumb(path) {
  const type = officeType(path);
  const c = await kvGet(`officebase:${path}`);
  const first = c?.pages?.[0];
  const W = 300, H = first?.blob ? (type === 'pptx' ? 169 : 400) : 200;   // a placeholder fits the library card (3:2)
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  if (first?.blob) {
    const bmp = await createImageBitmap(first.blob).catch(() => null);
    if (bmp) { const k = Math.min(W / bmp.width, H / bmp.height); ctx.drawImage(bmp, (W - bmp.width * k) / 2, (H - bmp.height * k) / 2, bmp.width * k, bmp.height * k); bmp.close?.(); }
  } else {
    const col = { docx: '#2b579a', pptx: '#c43e1c', xlsx: '#217346' }[type] || '#555';
    ctx.fillStyle = col; ctx.fillRect(0, 0, W, 8);
    ctx.font = `600 34px ${R.FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(TYPE_LABEL[type] || 'Document', W / 2, H / 2);
  }
  return { thumb: cv.toDataURL('image/jpeg', 0.8), pageCount: c?.pages?.length || 0 };
}

// ---------- new notes ----------
/** A new, empty Word / PowerPoint / Excel note: a file in the folder with one page of the chosen paper. */
export async function createOfficeNote({ type, title = 'Untitled', folderId = null, template = 'lined', paper = 'white', landscape = false }) {
  const s = type === 'pptx' ? SLIDE : landscape ? { w: R.PAGE_H, h: R.PAGE_W } : { w: R.PAGE_W, h: R.PAGE_H };
  const note = {
    id: uid(), title, folderId, kind: 'a4', template: 'blank', newPaper: template, paper, dataId: uid(),
    layers: [{ id: uid(), name: TYPE_LABEL[type], visible: true, locked: true, bg: true }, { id: uid(), name: 'Layer 1', visible: true, locked: false }],
    pages: [{ id: uid(), ...s, docIndex: null, tpl: template, elements: [] }], outline: [],
  };
  const bytes = await writeOffice({ type, bytes: null, data: editableData(note), pages: [{ ...s, doc: null, png: await pagePng(note, 0) }], geo: null });
  const path = await store.createFile(folderId, title, `.${type}`, bytes);
  return store.idForPath(path);
}
