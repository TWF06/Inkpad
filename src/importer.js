// Read pictures and PDFs straight from the device (nothing leaves the device) and turn them into note content.
import { uid, newNote, store, NOTE_EXT, sanitizeNote, sanitizeFolder } from './store.js';
import { PAGE_W, PAGE_H } from './render.js';
import { toast, modal } from './ui.js';
import { isDocument, isOldFormat, oldFormatHelp, documentToPdf, DOC_ACCEPT } from './docconvert.js';

export { isDocument };

// every page becomes a picture kept in memory and in the note file; past this a tablet can run out of memory
export const MAX_PDF_PAGES = 150;
export const PDF_RES = 2400;

export const ACCEPT_ALL = `image/*,application/pdf,.pdf,${DOC_ACCEPT},.json,application/json,${NOTE_EXT}`;
/** PDFs and the documents Inkpad turns into PDFs (Word, PowerPoint, Excel, CSV, text, Markdown, web pages). */
export const ACCEPT_DOCS = `application/pdf,.pdf,${DOC_ACCEPT}`;
export const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
export const isImage = (f) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(f.name);
export const isBackup = (f) => /\.(json|inkpad)$/i.test(f.name) || f.type === 'application/json';
const baseName = (f) => f.name.replace(/\.[^.]+$/, '') || 'Imported';

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('bad image')); i.src = src; });
}

/** Image file → {src (data URL), w, h}, downscaled so notes stay light. */
export async function readImage(file, max = 2400) {
  const url = URL.createObjectURL(file);
  try {
    const im = await loadImage(url);
    const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * k);
    c.height = Math.round(im.naturalHeight * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    const png = file.type === 'image/png' || file.type === 'image/gif' || file.type === 'image/webp';
    return { src: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88), w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}

let pdfjs;
export async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

/** PDF file → array of rendered pages {src, w, h}, or null if the user chose not to open a very long PDF. */
export async function readPdf(file, onProgress = () => {}) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, enableXfa: false }).promise;
  let count = doc.numPages;
  if (count > MAX_PDF_PAGES) {
    const ok = await modal({
      title: `${file.name} has ${count} pages`,
      message: `Very long PDFs make a note slow and can run out of memory on a tablet. Open the first ${MAX_PDF_PAGES} pages? To get the rest, split the PDF into parts first.`,
      ok: `Open first ${MAX_PDF_PAGES}`,
    });
    if (!ok) { await doc.destroy(); return null; }
    count = MAX_PDF_PAGES;
  }
  const out = [];
  for (let n = 1; n <= count; n++) {
    onProgress(n, count);
    out.push(await renderPdfPage(doc, n));
  }
  await doc.destroy();
  return out;
}

/** One PDF page → {src, w, h}: a JPEG about PDF_RES px on the long side, and the page's size in CSS px. */
async function renderPdfPage(doc, n) {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  // sharp enough to zoom in on a tablet: about 2400 px on the long side
  const vp = page.getViewport({ scale: Math.min(4, PDF_RES / Math.max(base.width, base.height)) });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  // the page's own size in CSS px (PDF points are 1/72 in, CSS px 1/96 in): an A4 PDF page is exactly an A4 note page
  const r = { src: c.toDataURL('image/jpeg', 0.9), w: base.width * 96 / 72, h: base.height * 96 / 72 };
  c.width = c.height = 0; // free the canvas memory now, not at the next garbage collection
  page.cleanup();
  return r;
}

/** Render the given PDF pages (1-based) one at a time; onPage(n, page) returning false stops early. */
export async function renderPdfPages(file, numbers, onPage) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, enableXfa: false }).promise;
  try {
    for (const n of numbers) {
      if (n < 1 || n > doc.numPages) continue;
      if ((await onPage(n, await renderPdfPage(doc, n))) === false) break;
    }
  } finally { await doc.destroy(); }
}

/** Pixel size of the picture behind a data URL. */
export const imageSize = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res({ w: 0, h: 0 }); i.src = src; });

/** Fit an image inside a page (A4 portrait unless a size is given, with margin) and centre it. */
export function fitToPage(img, layerId, margin = 0, size = { w: PAGE_W, h: PAGE_H }) {
  const k = Math.min((size.w - 2 * margin) / img.w, (size.h - 2 * margin) / img.h);
  const w = img.w * k, h = img.h * k;
  return { id: uid(), type: 'image', layerId, x: (size.w - w) / 2, y: (size.h - h) / 2, w, h, src: img.src };
}

/**
 * The page size for a document page: its own shape, scaled so its long side is as long as A4's.
 * An A4 PDF page stays exactly A4; a slide, receipt or photo gets a page of exactly its shape, with no empty margins.
 */
export function pageSizeFor(img) {
  const k = PAGE_H / Math.max(img.w, img.h);
  return { w: Math.round(img.w * k * 100) / 100, h: Math.round(img.h * k * 100) / 100 };
}

/** A rendered PDF page → a note page of exactly its size, the PDF filling it on the background layer. */
export function pdfNotePage(img, bgLayer) {
  const size = pageSizeFor(img);
  return { id: uid(), ...size, elements: [fitToPage(img, bgLayer, 0, size)] };
}

/** A picture → a note page of exactly its shape. */
export const imageNotePage = (img, layerId) => {
  const size = pageSizeFor(img);
  return { id: uid(), ...size, elements: [fitToPage(img, layerId, 0, size)] };
};

/** Ensure a locked bottom layer for PDF backgrounds; returns its id. */
export function ensureBackgroundLayer(note) {
  let l = note.layers.find((x) => x.bg);
  if (!l) { l = { id: uid(), name: 'PDF', visible: true, locked: true, bg: true }; note.layers.unshift(l); }
  return l.id;
}

/** Save the opened PDF / picture itself into the notes folder too (best effort); returns its path there. */
async function keepCopy(file, folderId) {
  try { return await store.addDocument(folderId, file); }
  catch (e) { console.warn('Could not keep a copy of', file.name, e); return null; }
}

const progress = (name) => (i, n) => toast(`Opening ${name}… page ${i} of ${n}`, 60000);

/** A document that isn't a PDF or picture (Word, PowerPoint, Excel…) → a PDF File made from it on the device. */
export async function convertDocument(file) {
  toast(`Converting ${file.name}…`, 60000);
  return documentToPdf(file, (i, n) => toast(`Converting ${file.name}… page ${i} of ${n}`, 60000));
}

/**
 * Turn files picked/shared/dropped from the device into notes.
 * PDFs → one A4 note each (pages on a locked "PDF" layer, write on top).
 * Pictures → one A4 note with one picture per page.
 * Backups (.json) → restored.
 * @returns id of the note to open (or null)
 */
/**
 * A PDF or picture from the notes folder → a note to write on, linked to it by `source`, saved next to it.
 * @returns the new note's id, or null
 */
export async function noteFromDocument(file, { source = file.name, folderId = null } = {}) {
  // a PDF in the folder is a note already; a picture becomes a PDF next to it
  if (isPdf(file)) return store.idForPath(source);
  // Word, PowerPoint, Excel…: a PDF of it is made next to it, and that PDF is the note
  if (!isImage(file) && isDocument(file)) return store.idForPath(await store.addDocument(folderId, await convertDocument(file)));
  const n = newNote({ title: baseName(file), folderId, kind: 'a4', template: 'blank' });
  if (!isImage(file)) {
    const pages = await readPdf(file, progress(file.name));
    if (!pages) return null;
    const bg = ensureBackgroundLayer(n);
    n.pages = pages.map((p) => pdfNotePage(p, bg));
  } else {
    n.pages = [imageNotePage(await readImage(file), n.layers[0].id)];
  }
  return (await import('./pdfnote.js')).saveAsNewPdf(n);
}

export async function importFiles(files, folderId = null) {
  files = [...files];
  let openId = null;
  const images = files.filter(isImage);
  const pdfs = files.filter(isPdf);
  // Word, PowerPoint, Excel, text…: made into a PDF here, then opened like any PDF
  const docs = files.filter((f) => !isPdf(f) && !isImage(f) && !isBackup(f) && isDocument(f));
  for (const f of docs) {
    try { pdfs.push(await convertDocument(f)); }
    catch (e) { console.error(e); toast(`Couldn’t open ${f.name}${e?.message && !/^Could/.test(e.message) ? ` — ${e.message}` : ''}`, 5000); }
  }
  for (const f of pdfs) {
    // the PDF itself is the note: put it in the folder and open it (no copy of its pages is made)
    const path = await keepCopy(f, folderId);
    if (path) { openId ??= store.idForPath(path); continue; }
    try {
      const pages = await readPdf(f, progress(f.name));
      if (!pages) continue;
      const n = newNote({ title: baseName(f), folderId, kind: 'a4', template: 'blank' });
      const bg = ensureBackgroundLayer(n);
      n.pages = pages.map((p) => pdfNotePage(p, bg));
      const src = await keepCopy(f, folderId);
      if (src) n.source = src;
      await store.putNote(n);
      openId ??= n.id;
    } catch (e) { console.error(e); toast(`Couldn’t open ${f.name} (is it a valid PDF?)`, 4000); }
  }
  if (images.length) {
    const n = newNote({ title: images.length === 1 ? baseName(images[0]) : `Pictures ${new Date().toLocaleDateString()}`, folderId, kind: 'a4', template: 'blank' });
    const layer = n.layers[0].id;
    n.pages = [];
    for (const f of images) {
      try { n.pages.push(imageNotePage(await readImage(f), layer)); }
      catch { toast(`Couldn’t read ${f.name}`); }
    }
    if (n.pages.length) {
      // pictures become a PDF (one picture per page) in the folder
      try { openId ??= await (await import('./pdfnote.js')).saveAsNewPdf(n); }
      catch (e) { console.error(e); await store.putNote(n); openId ??= n.id; }
    }
  }
  let restored = 0, keptNewer = 0;
  for (const f of files.filter(isBackup)) {
    try {
      const data = JSON.parse(await f.text());
      if (data?.app === 'inkpad' && data.note && !Array.isArray(data.notes)) {
        // a single note file (.inkpad) from elsewhere: add it as a new note so it never overwrites one in the library
        const clean = sanitizeNote(data.note);
        if (!clean) throw new Error('not a note');
        const n = { ...clean, id: uid(), folderId, updatedAt: Date.now() };
        await store.putNote(n);
        openId ??= n.id;
        continue;
      }
      if (data?.app !== 'inkpad' || !Array.isArray(data.notes)) throw new Error('not a backup');
      for (const x of Array.isArray(data.folders) ? data.folders : []) { const f = sanitizeFolder(x); if (f) await store.putFolder(f); }
      // a note that is newer in the library than in the backup is kept, so restoring an old backup never loses edits
      const have = new Map((await store.listNotes()).map((n) => [n.id, n.updatedAt]));
      for (const x of data.notes) {
        const n = sanitizeNote(x);
        if (!n) continue;
        if (have.has(n.id) && have.get(n.id) > n.updatedAt) { keptNewer++; continue; }
        await store.putNote(n); restored++;
      }
    } catch { toast(`${f.name} is not an Inkpad backup`); }
  }
  const skipped = files.filter((f) => !isPdf(f) && !isImage(f) && !isBackup(f) && !isDocument(f));
  const old = skipped.filter(isOldFormat);
  if (old.length) toast(oldFormatHelp(old[0]), 7000);
  else if (skipped.length) toast(`Can’t open ${skipped.map((f) => f.name).join(', ')} — use PDFs, pictures, Word, PowerPoint, Excel, text or Inkpad files`, 5000);
  else if (restored || keptNewer) toast(`Restored ${restored} note(s)${keptNewer ? ` · kept ${keptNewer} that are newer here` : ''}`, keptNewer ? 4000 : 2400);
  else if (openId) toast('Opened', 800);
  return openId;
}
