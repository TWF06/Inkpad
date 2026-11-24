// PDF worker: reads and writes Inkpad's layer inside PDF files, off the main thread so the pen never stalls.
//
// What Inkpad puts in a PDF:
//   • one "Stamp" annotation per page (named "inkpad-ink") whose appearance is the writing on that page: pen and
//     highlighter strokes and shapes as vector paths, pictures and typed text as images. Every PDF app shows and
//     prints it. It sits inside an optional-content layer "Inkpad ink", so Inkpad can render the page without it.
//   • /InkpadData in the document catalog: the editable copy (strokes, text, pictures, layers, outline) as
//     compressed JSON, so the writing stays editable when the PDF is opened in Inkpad again.
// The pages' own content is never changed. Pages added in Inkpad get the paper (lines, grid…) as page content.
import { PDFDocument, PDFName, PDFString, PDFArray, PDFDict, PDFRef, PDFRawStream, rgb, decodePDFRawStream } from '../vendor/pdf-lib/pdf-lib.esm.min.js';

const INK_NAME = 'inkpad-ink';
const OCG_NAME = 'Inkpad ink';
const DATA_KEY = PDFName.of('InkpadData');

self.onmessage = async (e) => {
  const { id, op } = e.data;
  try {
    const out = op === 'read' ? await read(e.data) : await save(e.data);
    self.postMessage({ id, ok: true, ...out }, out.bytes ? [out.bytes.buffer] : []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};

const load = (bytes) => PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });

/** → { data: JSON string | null, pages, encrypted } */
async function read({ bytes }) {
  const doc = await load(bytes);
  return { data: readData(doc), pages: doc.getPageCount(), encrypted: doc.isEncrypted };
}

function readData(doc) {
  const ref = doc.catalog.get(DATA_KEY);
  const s = ref && doc.context.lookup(ref);
  if (!(s instanceof PDFRawStream)) return null;
  try { return new TextDecoder().decode(decodePDFRawStream(s).decode()); } catch { return null; }
}

/**
 * save({ bytes|null, pages: [{ from: index in the file | null, pxW, pxH, paper?, ink: ops[] }], data }) → { bytes }
 * `from` = which page of the current file this page is (pages can be reordered / deleted / added in Inkpad).
 */
async function save({ bytes, pages, data, added = {} }) {
  const doc = bytes ? await load(bytes) : await PDFDocument.create();
  if (doc.isEncrypted) throw new Error('This PDF is password-protected, so Inkpad can’t write into it');
  const ctx = doc.context;

  // remove what Inkpad wrote last time
  const orig = doc.getPages();
  for (const p of orig) removeInk(doc, p);
  const oldData = doc.catalog.get(DATA_KEY);
  if (oldData instanceof PDFRef) ctx.delete(oldData);

  // page order: only rebuild the page tree if pages were added, removed or moved
  const same = pages.length === orig.length && pages.every((p, i) => p.from === i);
  let final;
  if (same) final = orig;
  else {
    // pages added from another PDF ("PDF from this device") are copied in: a merge
    const copied = new Map();
    for (const p of pages) {
      if (p.from != null || !p.ext || !added[p.ext.key]) continue;
      if (!copied.has(p.ext.key)) copied.set(p.ext.key, { src: await load(added[p.ext.key]), pages: new Map() });
    }
    for (const [key, c] of copied) {
      const want = [...new Set(pages.filter((p) => p.from == null && p.ext?.key === key).map((p) => p.ext.page))].filter((i) => i < c.src.getPageCount());
      const got = await doc.copyPages(c.src, want);
      want.forEach((i, k) => c.pages.set(i, got[k]));
    }
    for (let i = orig.length - 1; i >= 0; i--) doc.removePage(i);
    final = pages.map((p) => {
      if (p.from != null && orig[p.from]) { doc.addPage(orig[p.from]); return orig[p.from]; }
      const cp = p.ext && copied.get(p.ext.key)?.pages.get(p.ext.page);
      if (cp) { doc.addPage(cp); return cp; }
      const np = doc.addPage([p.pxW * 0.75, p.pxH * 0.75]);   // 96 px per inch → 72 pt per inch
      if (p.paper) drawPaper(np, p.paper);
      return np;
    });
  }

  const ocg = inkLayer(doc);
  for (let i = 0; i < final.length; i++) if (pages[i].ink.length) await addInk(doc, final[i], pages[i], ocg);

  doc.catalog.set(DATA_KEY, ctx.register(ctx.flateStream(new TextEncoder().encode(data))));
  await flushImages(doc);
  dropUnused(ctx);
  const out = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return { bytes: out };
}

// ---------- keeping the file from growing ----------
/** pdf-lib writes embedded pictures only at save(); do it now so they are seen as in use. */
async function flushImages(doc) { for (const im of doc.images || []) await im.embed(); doc.images = []; }

/** Delete every object nothing in the document points to (left over from earlier saves or removed pages). */
function dropUnused(ctx) {
  const seen = new Set();
  const walk = (o) => {
    if (o instanceof PDFRef) {
      const key = o.toString();
      if (seen.has(key)) return;
      seen.add(key);
      walk(ctx.lookup(o));
    } else if (o instanceof PDFRawStream || (o && o.dict instanceof PDFDict)) walk(o.dict);
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) walk(v);
    else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) walk(o.get(i));
  };
  const t = ctx.trailerInfo;
  for (const k of ['Root', 'Info', 'Encrypt']) if (t[k]) walk(t[k]);
  if (!seen.size) return;   // couldn't find the document root: change nothing
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.toString())) ctx.delete(ref);
}

// ---------- the ink annotation ----------
function annotsOf(page) {
  const a = page.node.lookup(PDFName.of('Annots'));
  return a instanceof PDFArray ? a : null;
}

function removeInk(doc, page) {
  const annots = annotsOf(page);
  if (!annots) return;
  const ctx = doc.context;
  for (let i = annots.size() - 1; i >= 0; i--) {
    const ref = annots.get(i);
    const d = ctx.lookup(ref);
    if (!(d instanceof PDFDict)) continue;
    const nm = d.lookup(PDFName.of('NM'));
    if (!nm || nm.decodeText?.() !== INK_NAME) continue;
    // the objects Inkpad made for it (appearance, pictures) go too, so the file doesn't grow with every save
    const owned = d.lookup(PDFName.of('InkpadRefs'));
    if (owned instanceof PDFArray) for (let k = 0; k < owned.size(); k++) {
      const r = owned.get(k);
      if (!(r instanceof PDFRef)) continue;
      // a picture with transparency keeps its mask in a second object
      const o = ctx.lookup(r);
      const mask = (o instanceof PDFRawStream ? o.dict : o instanceof PDFDict ? o : null)?.get(PDFName.of('SMask'));
      if (mask instanceof PDFRef) ctx.delete(mask);
      ctx.delete(r);
    }
    annots.remove(i);
    if (ref instanceof PDFRef) ctx.delete(ref);
  }
}

/** The optional-content layer "Inkpad ink" (created once per file). */
function inkLayer(doc) {
  const ctx = doc.context, cat = doc.catalog;
  let props = cat.lookup(PDFName.of('OCProperties'));
  if (props instanceof PDFDict) {
    const ocgs = props.lookup(PDFName.of('OCGs'));
    if (ocgs instanceof PDFArray) for (let i = 0; i < ocgs.size(); i++) {
      const g = ctx.lookup(ocgs.get(i));
      if (g instanceof PDFDict && g.lookup(PDFName.of('Name'))?.decodeText?.() === OCG_NAME) return ocgs.get(i);
    }
  }
  const ref = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(OCG_NAME) }));
  if (!(props instanceof PDFDict)) {
    cat.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [ref], D: { Order: [ref], ON: [ref] } }));
  } else {
    let ocgs = props.lookup(PDFName.of('OCGs'));
    if (!(ocgs instanceof PDFArray)) { ocgs = ctx.obj([]); props.set(PDFName.of('OCGs'), ocgs); }
    ocgs.push(ref);
    let d = props.lookup(PDFName.of('D'));
    if (!(d instanceof PDFDict)) { d = ctx.obj({}); props.set(PDFName.of('D'), d); }
    for (const key of ['Order', 'ON']) {
      let arr = d.lookup(PDFName.of(key));
      if (!(arr instanceof PDFArray)) { arr = ctx.obj([]); d.set(PDFName.of(key), arr); }
      arr.push(ref);
    }
  }
  return ref;
}

const f = (n) => (Math.round(n * 100) / 100).toString();
const col = (c) => c.map((v) => f(v / 255)).join(' ');

/**
 * Page geometry: Inkpad draws in px with y going down, on the page as shown (rotation applied). This builds the
 * matrix from that space to the page's own PDF space, for each /Rotate.
 */
function pageMatrix(page, pxW) {
  const box = page.getCropBox();
  const x0 = box.x, y0 = box.y, x1 = box.x + box.width, y1 = box.y + box.height;
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const shownW = rot === 90 || rot === 270 ? box.height : box.width;
  const s = shownW / pxW;
  const R = { 0: [1, 0, 0, -1, x0, y1], 90: [0, 1, 1, 0, x0, y0], 180: [-1, 0, 0, 1, x1, y0], 270: [0, -1, -1, 0, x1, y1] }[rot] || [1, 0, 0, -1, x0, y1];
  return { R, s, rect: [x0, y0, x1, y1] };
}

async function addInk(doc, page, spec, ocg) {
  const ctx = doc.context;
  const { R, s, rect } = pageMatrix(page, spec.pxW);
  const xobjects = {}, owned = [];
  let gs = null, imgN = 0;
  const out = [`/OC /InkOC BDC q ${R.map(f).join(' ')} cm ${f(s)} 0 0 ${f(s)} 0 0 cm 1 J 1 j`];
  for (const op of spec.ink) {
    const k = op[0];
    if (k === 'pen') {
      out.push(`${col(op[1])} RG`);
      for (const g of op[2]) {
        // [x0, y0, cx, cy, x1, y1, width] — a quadratic piece (cx null = straight)
        out.push(`${f(g[6])} w ${f(g[0])} ${f(g[1])} m`);
        if (g[2] == null) out.push(`${f(g[4])} ${f(g[5])} l S`);
        else {
          const c1x = g[0] + (2 / 3) * (g[2] - g[0]), c1y = g[1] + (2 / 3) * (g[3] - g[1]);
          const c2x = g[4] + (2 / 3) * (g[2] - g[4]), c2y = g[5] + (2 / 3) * (g[3] - g[5]);
          out.push(`${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(g[4])} ${f(g[5])} c S`);
        }
      }
    } else if (k === 'dot') {
      const [, c, x, y, r] = op, m = 0.5523 * r;
      out.push(`${col(c)} rg ${f(x + r)} ${f(y)} m ${f(x + r)} ${f(y + m)} ${f(x + m)} ${f(y + r)} ${f(x)} ${f(y + r)} c ${f(x - m)} ${f(y + r)} ${f(x - r)} ${f(y + m)} ${f(x - r)} ${f(y)} c ${f(x - r)} ${f(y - m)} ${f(x - m)} ${f(y - r)} ${f(x)} ${f(y - r)} c ${f(x + m)} ${f(y - r)} ${f(x + r)} ${f(y - m)} ${f(x + r)} ${f(y)} c f`);
    } else if (k === 'hl') {
      if (!gs) { gs = ctx.register(ctx.obj({ Type: 'ExtGState', CA: 0.4, ca: 0.4, BM: 'Multiply' })); owned.push(gs); }
      const [, c, w, segs] = op;
      out.push(`q /GSh gs ${col(c)} RG ${f(w)} w ${f(segs[0][0])} ${f(segs[0][1])} m`);
      for (const g of segs) {
        if (g[2] == null) out.push(`${f(g[4])} ${f(g[5])} l`);
        else {
          const c1x = g[0] + (2 / 3) * (g[2] - g[0]), c1y = g[1] + (2 / 3) * (g[3] - g[1]);
          const c2x = g[4] + (2 / 3) * (g[2] - g[4]), c2y = g[5] + (2 / 3) * (g[3] - g[5]);
          out.push(`${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(g[4])} ${f(g[5])} c`);
        }
      }
      out.push('S Q');
    } else if (k === 'poly') {
      const [, c, w, pts, closed] = op;
      out.push(`${col(c)} RG ${f(w)} w ${f(pts[0][0])} ${f(pts[0][1])} m ${pts.slice(1).map((p) => `${f(p[0])} ${f(p[1])} l`).join(' ')} ${closed ? 'h ' : ''}S`);
    } else if (k === 'ell') {
      const [, c, w, cx, cy, rx, ry] = op, mx = 0.5523 * rx, my = 0.5523 * ry;
      out.push(`${col(c)} RG ${f(w)} w ${f(cx + rx)} ${f(cy)} m ${f(cx + rx)} ${f(cy + my)} ${f(cx + mx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c ${f(cx - mx)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + my)} ${f(cx - rx)} ${f(cy)} c ${f(cx - rx)} ${f(cy - my)} ${f(cx - mx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c ${f(cx + mx)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - my)} ${f(cx + rx)} ${f(cy)} c S`);
    } else if (k === 'img') {
      const [, x, y, w, h, bytes, fmt] = op;
      const name = `Im${imgN++}`;
      const ref = await embedImage(doc, bytes, fmt);
      if (!ref) continue;
      xobjects[name] = ref; owned.push(ref);
      // the space is y-down: draw the unit square flipped so the picture is upright
      out.push(`q ${f(w)} 0 0 ${f(-h)} ${f(x)} ${f(y + h)} cm /${name} Do Q`);
    }
  }
  out.push('Q EMC');
  const resources = { Properties: { InkOC: ocg } };
  if (Object.keys(xobjects).length) resources.XObject = xobjects;
  if (gs) resources.ExtGState = { GSh: gs };
  const form = ctx.register(ctx.flateStream(out.join('\n'), { Type: 'XObject', Subtype: 'Form', BBox: rect, Resources: resources }));
  owned.push(form);
  const annot = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Stamp', Rect: rect, F: 4 | 128,   // print, locked
    NM: PDFString.of(INK_NAME), Contents: PDFString.of('Writing from Inkpad'),
    OC: ocg, AP: { N: form }, P: page.ref, InkpadRefs: owned,
  }));
  let annots = annotsOf(page);
  if (!annots) { annots = ctx.obj([]); page.node.set(PDFName.of('Annots'), annots); }
  annots.push(annot);
}

/** A JPEG or PNG → an image XObject; returns its reference (the image itself is written when the file is saved). */
async function embedImage(doc, bytes, fmt) {
  try { return (fmt === 'jpg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes)).ref; } catch { return null; }
}

// ---------- paper for pages added in Inkpad ----------
function drawPaper(page, paper) {
  const { width: W, height: H } = page.getSize();
  const k = 0.75;   // px → pt
  const c = (a) => rgb(a[0] / 255, a[1] / 255, a[2] / 255);
  if (paper.bg) page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: c(paper.bg) });
  const line = (x0, y0, x1, y1, color) => page.drawLine({ start: { x: x0 * k, y: H - y0 * k }, end: { x: x1 * k, y: H - y1 * k }, thickness: 0.75, color: c(color) });
  const pw = W / k, ph = H / k, t = paper.template;
  if (t === 'lined' || t === 'cornell') {
    const bottom = t === 'cornell' ? ph - 220 : ph;
    for (let y = 96; y <= bottom; y += 32) line(0, y, pw, y, paper.line);
    if (t === 'cornell') { line(200, 64, 200, ph - 220, paper.line); line(0, ph - 220, pw, ph - 220, paper.line); line(0, 64, pw, 64, paper.line); }
  } else if (t === 'grid') {
    for (let y = 24; y <= ph; y += 24) line(0, y, pw, y, paper.line);
    for (let x = 24; x <= pw; x += 24) line(x, 0, x, ph, paper.line);
  } else if (t === 'dot') {
    for (let y = 24; y <= ph; y += 24) for (let x = 24; x <= pw; x += 24) page.drawRectangle({ x: (x - 1) * k, y: H - (y + 1) * k, width: 2 * k, height: 2 * k, color: c(paper.dot) });
  }
}
