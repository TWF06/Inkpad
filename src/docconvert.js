// Word, PowerPoint, Excel, CSV, text, Markdown and web-page files → a PDF made on the device (nothing is uploaded).
// Each page is laid out in a hidden frame, drawn to a picture and put into a new PDF, which then opens and saves
// like any other PDF in Inkpad: write on top, the document stays on the locked "PDF" layer.
//
// Word: docx-preview (vendored) lays the document out; it is cut into pages between lines.
// PowerPoint, Excel, CSV, Markdown, text, HTML: read here (OOXML is a zip of XML files, read with JSZip).
import { toast } from './ui.js';

// Word, PowerPoint and Excel files can also *be* notes (officenote.js): Inkpad then writes your writing into them as
// pictures with this name, and adds pages of its own (marked as below). Drawing the document for Inkpad leaves all
// of those out: the editor shows the editable writing on top instead.
export const INK_NAME = 'Inkpad ink';
export const INK_MARK = '00494E4B';            // w:rsidRDefault of Word paragraphs Inkpad added (a page of its own)
export const ADDED_PART = /\/(slide|sheet)Inkpad\d+\.xml$/i;   // PowerPoint slides / Excel sheets Inkpad added

const MAX_PAGES = 150; // like PDFs: more than this makes a note slow and can run out of memory on a tablet
const RES = 2200; // pixels on a page's long side: sharp when zoomed in on a tablet, light enough to keep
const A4 = { w: 794, h: 1123 }; // CSS px
const MARGIN = 72; // 3/4 inch

// ---------- which files ----------
const EXT_KIND = {
  docx: 'word', docm: 'word', dotx: 'word',
  pptx: 'slides', pptm: 'slides', ppsx: 'slides', potx: 'slides',
  xlsx: 'sheet', xlsm: 'sheet', xltx: 'sheet',
  csv: 'csv', tsv: 'tsv', tab: 'tsv',
  txt: 'text', text: 'text', log: 'text',
  md: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html', xhtml: 'html',
};
const MIME_KIND = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'slides',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow': 'slides',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'sheet',
  'text/csv': 'csv', 'text/comma-separated-values': 'csv', 'text/tab-separated-values': 'tsv',
  'text/plain': 'text', 'text/markdown': 'markdown', 'text/x-markdown': 'markdown', 'text/html': 'html',
};
/** Formats people often have that can't be read in a browser: they get a clear message instead. */
const OLD_FORMATS = /\.(doc|dot|ppt|pps|pot|xls|xlt|rtf|odt|odp|ods|pages|key|numbers|wps|hwp)$/i;

const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();
/** 'word' | 'slides' | 'sheet' | 'csv' | 'tsv' | 'text' | 'markdown' | 'html' | null */
export const docKind = (f) => EXT_KIND[extOf(f.name)] || (extOf(f.name) ? null : MIME_KIND[f.type] || null);
export const isDocument = (f) => !!docKind(f);
export const isOldFormat = (f) => OLD_FORMATS.test(f.name || '');
export const DOC_EXTS = Object.keys(EXT_KIND);
export const DOC_ACCEPT = [...DOC_EXTS.map((e) => `.${e}`), ...Object.keys(MIME_KIND).filter((m) => !m.startsWith('text/plain'))].join(',');
/** Short label for a library card. */
export function docLabel(name) {
  const k = EXT_KIND[extOf(name)];
  return { word: 'Word', slides: 'PowerPoint', sheet: 'Excel', csv: 'CSV', tsv: 'Table', markdown: 'Markdown', html: 'Web page', text: 'Text' }[k] || 'Document';
}
export const oldFormatHelp = (f) => `${f.name} is an older file type Inkpad can’t read. Save it as .docx, .pptx, .xlsx or PDF (File → Save as / Export), then open that.`;

// ---------- the whole conversion ----------
/**
 * A document → a PDF File with one page per page / slide / sheet page.
 * onProgress(i, n) is called before each page is drawn.
 */
export async function documentToPdf(file, onProgress = () => {}) {
  const base = file.name.replace(/\.[^.]+$/, '') || 'Document';
  const { pages } = await documentPages(file, onProgress);
  const { PDFDocument } = await import('../vendor/pdf-lib/pdf-lib.esm.min.js');
  const pdf = await PDFDocument.create();
  pdf.setTitle(base);
  pdf.setProducer('Inkpad');
  for (const { bytes, w, h } of pages) {
    const im = await pdf.embedJpg(bytes);
    // CSS px are 1/96 in, PDF points 1/72 in: an A4 page here is an A4 page in the PDF
    const page = pdf.addPage([w * 0.75, h * 0.75]);
    page.drawImage(im, { x: 0, y: 0, width: w * 0.75, height: h * 0.75 });
  }
  const bytes = await pdf.save();
  return new File([bytes], `${base}.pdf`, { type: 'application/pdf', lastModified: Date.now() });
}

/**
 * A document → its pages as JPEG pictures, plus where each page comes from in the file, so writing done on a page
 * can be put back into the file in the right place (officenote.js):
 *   pages: [{ bytes, w, h, at }]   at = { part } (a slide) or { flow, s, e, top } (a stretch of a Word section /
 *                                  an Excel sheet: flow px s…e, shown from `top` px down the page)
 *   geo:   { kind, paras: [{ flow, top }] (Word: every paragraph, in order), flows: [{ part, table }] (Excel) }
 */
export async function documentPages(file, onProgress = () => {}) {
  const kind = docKind(file);
  if (!kind) throw new Error(`Can’t read ${file.name}`);
  let total = 0;
  const out = [], geo = { kind, paras: [], flows: [] };
  const frame = makeFrame();
  try {
    let pages;
    if (kind === 'slides') {
      const slides = await slidePages(file);
      pages = slides.map((s) => ({ draw: () => rasterize(fixedMarkup(s), s.w, s.h), at: { part: s.part } }));
    } else {
      const flows = await buildFlows(kind, file, frame.doc);
      await settle(frame.doc);
      pages = [];
      flows.forEach((fl, fi) => {
        prepareFlow(fl);
        measureFlow(fl, fi, geo);
        for (const [s, e] of paginate(fl)) pages.push({ draw: () => rasterize(sliceMarkup(fl, s, e), fl.w, fl.h), at: { flow: fi, s, e, top: fl.top } });
      });
    }
    total = pages.length;
    if (!total) throw new Error(`${file.name} is empty`);
    const n = Math.min(total, MAX_PAGES);
    for (let i = 0; i < n; i++) {
      onProgress(i + 1, n);
      out.push({ ...(await pages[i].draw()), at: pages[i].at });
    }
  } finally { frame.remove(); }
  if (total > MAX_PAGES) toast(`${file.name} has ${total} pages; opened the first ${MAX_PAGES}. Split it into parts to get the rest.`, 6000);
  return { pages: out, geo };
}

/** Where a flow's paragraphs (Word) or table rows and columns (Excel) are, in flow px. */
function measureFlow(fl, fi, geo) {
  const el = fl.el, box = el.getBoundingClientRect();
  if (geo.kind === 'word') {
    for (const p of el.querySelectorAll('p')) geo.paras.push({ flow: fi, top: p.getBoundingClientRect().top - box.top });
    return;
  }
  if (geo.kind !== 'sheet') return;
  const table = el.querySelector('table.sheet');
  let t = null;
  if (table) {
    const tb = table.getBoundingClientRect();
    const rows = [...table.rows].map((tr) => { const r = tr.getBoundingClientRect(); return [r.top - box.top, r.bottom - box.top]; });
    // column edges from cells one column wide (merged cells span several)
    const widths = [...table.querySelectorAll('col')].map((c) => parseFloat(c.style.width) || 64);
    const cols = widths.map(() => null), occ = [];
    [...table.rows].slice(0, 300).forEach((tr, r) => {
      let c = 0;
      for (const td of tr.cells) {
        while (occ[r]?.[c]) c++;
        for (let dr = 0; dr < (td.rowSpan || 1); dr++) for (let dc = 0; dc < (td.colSpan || 1); dc++) (occ[r + dr] ??= [])[c + dc] = 1;
        if ((td.colSpan || 1) === 1 && c < cols.length && !cols[c]) { const b = td.getBoundingClientRect(); cols[c] = [b.left - box.left, b.right - box.left]; }
        c += td.colSpan || 1;
      }
    });
    let x = tb.left - box.left;
    for (let c = 0; c < cols.length; c++) { cols[c] ??= [x, x + widths[c]]; x = cols[c][1]; }
    t = { left: tb.left - box.left, top: tb.top - box.top, rows, cols };
  }
  geo.flows[fi] = { part: fl.part || null, table: t };
}

// ---------- drawing pages ----------
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not draw the page')); i.src = src; });
}

/** XHTML markup of exactly one page (w × h CSS px) → JPEG bytes. */
async function rasterize(markup, w, h) {
  const k = Math.min(3, RES / Math.max(w, h));
  const cw = Math.round(w * k), ch = Math.round(h * k);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="0 0 ${w} ${h}"><foreignObject x="0" y="0" width="${w}" height="${h}">${markup}</foreignObject></svg>`;
  // a data: URL, not a blob: one: Chrome taints the canvas for an SVG with HTML inside unless it comes from data:
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  {
    const img = await loadImage(url);
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the page'))), 'image/jpeg', 0.9));
    c.width = c.height = 0;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
  }
}

const XHTML = 'http://www.w3.org/1999/xhtml';
const xmlText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pageBox = (w, h) => `width:${w}px;height:${h}px;background:#fff;position:relative;overflow:hidden;margin:0`;

/** A fixed page (a slide): HTML string → XHTML for the SVG. */
function fixedMarkup({ html, w, h }) {
  const t = document.createElement('template');
  t.innerHTML = html; // a template is inert: nothing loads or runs
  const inner = [...t.content.childNodes].map((n) => new XMLSerializer().serializeToString(n)).join('');
  return `<div xmlns="${XHTML}" style="${pageBox(w, h)}">${inner}</div>`;
}

/** One page cut from a flow: the flow drawn shifted up by `s` and clipped to [s, e), inside the page margins. */
function sliceMarkup(fl, s, e) {
  const clone = fl.el.cloneNode(true);
  // pictures far from this page are swapped for empty boxes of the same size, so each page's SVG stays small
  const imgs = clone.querySelectorAll('img');
  fl.imgs.forEach((r, i) => {
    const im = imgs[i];
    if (!im || (r.b > s - 40 && r.t < e + 40)) return;
    im.removeAttribute('srcset');
    im.setAttribute('src', BLANK);
    im.style.setProperty('width', `${r.w}px`, 'important');
    im.style.setProperty('height', `${r.h}px`, 'important');
  });
  const inner = new XMLSerializer().serializeToString(clone);
  return `<div xmlns="${XHTML}" style="${pageBox(fl.w, fl.h)}"><style>${xmlText(fl.css)}</style>`
    + `<div style="position:absolute;left:0;top:${fl.top}px;width:${fl.w}px;height:${Math.ceil(e - s)}px;overflow:hidden">`
    + `<div style="position:absolute;left:0;top:${-s}px;width:${fl.w}px">${inner}</div></div></div>`;
}
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// ---------- flows: content laid out at a page's width, cut into pages between lines ----------
// A flow is { el, w, h, top, avail, css }: el is page-wide (side margins as its own padding) with no top/bottom
// padding; each page shows `avail` px of it starting `top` px down the page.

/** A hidden same-origin frame to lay documents out in, away from the app's own styles. */
function makeFrame() {
  const f = document.createElement('iframe');
  f.setAttribute('aria-hidden', 'true');
  f.tabIndex = -1;
  f.style.cssText = 'position:fixed;left:-30000px;top:0;width:4000px;height:2000px;border:0;visibility:hidden;pointer-events:none';
  document.body.append(f);
  const doc = f.contentDocument;
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#fff"></body></html>');
  doc.close();
  return { doc, remove: () => f.remove() };
}

/** Wait for every picture in the frame to load, so layout is final before measuring. */
function settle(doc) {
  return Promise.all([...doc.images].map((im) => (im.complete ? null : im.decode().catch(() => {}))));
}

const DOC_CSS = `
.dc{box-sizing:border-box;margin:0;background:#fff;color:#1d1d1f;font:15px/1.5 "Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:break-word}
.dc *{box-sizing:border-box}
.dc h1{font-size:1.9em;line-height:1.25;margin:.7em 0 .4em}.dc h2{font-size:1.5em;line-height:1.3;margin:.8em 0 .4em}
.dc h3{font-size:1.25em;margin:.8em 0 .3em}.dc h4,.dc h5,.dc h6{font-size:1.05em;margin:.8em 0 .3em}
.dc>:first-child{margin-top:0}
.dc p{margin:0 0 .75em}.dc ul,.dc ol{margin:0 0 .75em;padding-left:1.6em}.dc li{margin:.15em 0}
.dc pre,.dc code{font-family:Consolas,"Roboto Mono","Courier New",monospace;font-size:.9em}
.dc code{background:#f1f0ec;padding:.05em .3em;border-radius:3px}
.dc pre{white-space:pre-wrap;background:#f5f4f0;padding:10px 12px;border-radius:6px;margin:0 0 .9em}
.dc pre code{background:none;padding:0}
.dc.plain pre{background:none;padding:0;border-radius:0;font-size:13.5px;line-height:1.45}
.dc blockquote{margin:0 0 .9em;padding:.1em 0 .1em 1em;border-left:3px solid #d0cec8;color:#55534e}
.dc hr{border:0;border-top:1px solid #d9d7d2;margin:1.2em 0}
.dc img{max-width:100%;height:auto}
.dc table{border-collapse:collapse;margin:0 0 1em}
.dc td,.dc th{border:1px solid #c9c7c2;padding:3px 7px;vertical-align:top;text-align:left}
.dc th{background:#f1f0ec;font-weight:600}
.dc .sheet-name{font-size:1.15em;font-weight:600;margin:0 0 .6em}
.dc table.sheet{font-size:12.5px;line-height:1.35}
.dc table.sheet td{white-space:pre;border-color:#d4d2cd}
.dc table.sheet td.n{text-align:right}
.dc table.csv td,.dc table.csv th{font-size:13px;max-width:420px}
.dc .task{list-style:none;margin-left:-1.3em}
`;

async function buildFlows(kind, file, doc) {
  if (kind === 'word') return wordFlows(file, doc);
  if (kind === 'sheet') return (await sheetHtml(file)).map(({ html, part }) => Object.assign(htmlFlow(doc, html, { cls: 'dc' }), { part }));
  const text = await readText(file);
  if (kind === 'csv' || kind === 'tsv') return [htmlFlow(doc, tableHtml(parseCsv(text, kind === 'tsv' ? '\t' : guessSep(text)), 'csv'), {})];
  if (kind === 'markdown') return [htmlFlow(doc, markdown(text), {})];
  if (kind === 'html') { const { body, css } = cleanHtml(text); return [htmlFlow(doc, body, { css })]; }
  return [htmlFlow(doc, `<pre>${esc(text)}</pre>`, { cls: 'dc plain' })];
}

/** Text in UTF-8 (or UTF-16 with a byte-order mark); old Windows text that isn't valid UTF-8 is read as Windows-1252. */
async function readText(file) {
  const b = new Uint8Array(await file.arrayBuffer());
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return new TextDecoder('windows-1252').decode(b); }
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HTML → a page-wide flow in the frame. Content wider than A4 (big tables) gets a wider, landscape page. */
function htmlFlow(doc, html, { css = '', cls = 'dc' }) {
  const el = doc.createElement('div');
  el.className = cls;
  el.style.cssText = `width:${A4.w}px;padding:0 ${MARGIN}px;display:flow-root`;
  el.innerHTML = html;
  const style = doc.createElement('style');
  style.textContent = DOC_CSS + css;
  doc.head.append(style);
  doc.body.append(el);
  return { el, w: A4.w, h: A4.h, top: MARGIN, avail: A4.h - 2 * MARGIN, css: DOC_CSS + css, widen: true };
}

/** Word: docx-preview lays it out; each of its sections (split at page breaks) becomes a flow of the Word page size. */
async function wordFlows(file, doc) {
  const lib = await loadDocx();
  const styles = doc.createElement('div'), holder = doc.createElement('div');
  doc.body.append(styles, holder);
  await lib.renderAsync(await withoutInkpad(await file.arrayBuffer()), holder, styles, {
    className: 'docx', inWrapper: false, ignoreWidth: false, ignoreHeight: false, ignoreFonts: true,
    breakPages: true, ignoreLastRenderedPageBreak: true, renderHeaders: false, renderFooters: false,
    renderFootnotes: true, renderEndnotes: true, renderComments: false, renderChanges: false,
    useBase64URL: true, experimental: false, trimXmlDeclaration: true, debug: false,
  });
  const extra = 'section.docx{box-shadow:none!important;margin:0!important}';
  const st = doc.createElement('style');
  st.textContent = extra;
  doc.head.append(st);
  const css = [...styles.querySelectorAll('style')].map((s) => s.textContent).join('\n') + extra;
  const win = doc.defaultView;
  const flows = [];
  for (const sec of holder.querySelectorAll('section.docx')) {
    const cs = win.getComputedStyle(sec);
    const w = sec.offsetWidth || A4.w;
    const h = parseFloat(cs.minHeight) || Math.round(w * 1.4142);
    const mt = parseFloat(cs.paddingTop) || 0, mb = parseFloat(cs.paddingBottom) || 0;
    for (const [p, v] of [['padding-top', '0'], ['padding-bottom', '0'], ['min-height', '0'], ['height', 'auto'], ['margin', '0']]) sec.style.setProperty(p, v, 'important');
    flows.push({ el: sec, w, h, top: mt, avail: Math.max(80, h - mt - mb), css });
  }
  if (!flows.length) throw new Error('No pages in this Word file');
  return flows;
}

/** A Word file without what Inkpad put into it (its writing pictures and its own pages): the document alone. */
async function withoutInkpad(buf) {
  const JSZip = await loadZip();
  let z;
  try { z = await JSZip.loadAsync(buf); } catch { return buf; }
  const f = z.file('word/document.xml');
  const xml = f && (await f.async('string'));
  if (!xml || (!xml.includes(INK_NAME) && !xml.includes(INK_MARK))) return buf;
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  if (d.getElementsByTagName('parsererror').length) return buf;
  for (const p of all(d, 'p')) if (attr(p, 'rsidRDefault') === INK_MARK) p.remove();
  for (const pr of all(d, 'docPr')) if (attr(pr, 'name') === INK_NAME) climb(pr, 'r')?.remove();
  z.file('word/document.xml', new XMLSerializer().serializeToString(d));
  return z.generateAsync({ type: 'arraybuffer' });
}
const climb = (el, name) => { for (let e = el; e; e = e.parentElement) if (e.localName === name) return e; return null; };

/** Measure a flow: widen it for wide content, then find where pages may break and where pictures are. */
function prepareFlow(fl) {
  const el = fl.el;
  if (fl.widen && el.scrollWidth > el.clientWidth + 2) {
    // wider than A4 (a big table): a landscape page as wide as the content, up to 3 × A4
    const w = Math.min(A4.w * 3, el.scrollWidth + MARGIN);
    const h = Math.round(w / 1.4142);
    el.style.width = `${w}px`;
    Object.assign(fl, { w, h, avail: h - 2 * MARGIN });
  }
  const base = el.getBoundingClientRect().top;
  const starts = [], solid = [];
  const range = el.ownerDocument.createRange();
  const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) {
    if (!n.data.trim()) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.height <= 0) continue;
      starts.push(r.top - base);
      solid.push([r.top - base, r.bottom - base]);
    }
  }
  fl.imgs = [];
  let bottom = el.getBoundingClientRect().height;
  for (const x of el.querySelectorAll('img,svg,canvas,hr,tr,li,p,h1,h2,h3,h4,h5,h6,pre,blockquote,table,figure')) {
    const r = x.getBoundingClientRect();
    if (x.tagName === 'IMG') fl.imgs.push({ t: r.top - base, b: r.bottom - base, w: r.width, h: r.height });
    if (!r.height) continue;
    starts.push(r.top - base);
    bottom = Math.max(bottom, r.bottom - base);
    if (/^(img|svg|canvas)$/i.test(x.tagName)) solid.push([r.top - base, r.bottom - base]);
  }
  fl.total = Math.ceil(bottom);
  // a page may start at the top of a line or block, unless that would cut through another line or a picture
  starts.sort((a, b) => a - b);
  solid.sort((a, b) => a[0] - b[0]);
  const ok = [];
  let j = 0, reach = -Infinity;
  for (const c of starts) {
    while (j < solid.length && solid[j][0] < c - 0.5) reach = Math.max(reach, solid[j++][1]);
    if (reach <= c + 0.5 && c > 0) ok.push(Math.floor(c));
  }
  fl.breaks = ok;
}

/** [start, end) of each page of a flow. */
function paginate(fl) {
  const out = [], pts = fl.breaks, total = Math.max(1, fl.total);
  let s = 0, k = 0;
  while (s < total - 1) {
    const lim = s + fl.avail;
    if (lim >= total) { out.push([s, total]); break; }
    while (k < pts.length && pts[k] <= lim) k++;
    let c = k > 0 ? pts[k - 1] : -1;
    // nowhere sensible to break (a picture taller than a page): cut through it
    if (c <= s + fl.avail * 0.15) c = lim;
    out.push([s, c]);
    s = c;
  }
  return out.length ? out : [[0, total]];
}

// ---------- libraries ----------
function script(rel) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL(rel, import.meta.url).href;
    s.onload = res;
    s.onerror = () => rej(new Error('Could not load the document reader'));
    document.head.append(s);
  });
}
let zipLib, docxLib;
export const loadZip = () => (zipLib ??= script('../vendor/jszip/jszip.min.js').then(() => window.JSZip));
const loadDocx = () => (docxLib ??= loadZip().then(() => script('../vendor/docx-preview/docx-preview.min.js')).then(() => window.docx));

// ---------- reading OOXML (zip of XML parts) ----------
const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => (el ? [...el.children].find((c) => c.localName === name) || null : null);
const path = (el, ...names) => names.reduce((e, n) => kid(e, n), el);
const all = (el, name) => (el ? [...el.getElementsByTagNameNS('*', name)] : []);
function attr(el, name) {
  if (!el) return null;
  for (const a of el.attributes) if (a.localName === name && !a.prefix) return a.value;
  for (const a of el.attributes) if (a.localName === name) return a.value;
  return null;
}
/** A relationship-id attribute (r:id, r:embed). */
function rid(el, name) {
  if (!el) return null;
  for (const a of el.attributes) if (a.localName === name && a.namespaceURI && /relationships/.test(a.namespaceURI)) return a.value;
  return null;
}
function resolve(dir, target) {
  if (!target) return null;
  const parts = (target.startsWith('/') ? target.slice(1) : dir + target).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };

async function openZip(file) {
  const JSZip = await loadZip();
  let z;
  try { z = await JSZip.loadAsync(await file.arrayBuffer()); }
  catch { throw new Error(`${file.name} is damaged or not an Office file`); }
  const cache = new Map();
  const xml = (p) => {
    if (!cache.has(p)) cache.set(p, (async () => {
      const t = p && (await z.file(p)?.async('string'));
      if (!t) return null;
      const d = new DOMParser().parseFromString(t, 'application/xml');
      return d.getElementsByTagName('parsererror').length ? null : d;
    })());
    return cache.get(p);
  };
  const rels = async (p) => {
    const i = p.lastIndexOf('/'), dir = p.slice(0, i + 1);
    const d = await xml(`${dir}_rels/${p.slice(i + 1)}.rels`);
    const m = new Map();
    for (const r of all(d, 'Relationship')) m.set(attr(r, 'Id'), { type: attr(r, 'Type') || '', target: attr(r, 'TargetMode') === 'External' ? null : resolve(dir, attr(r, 'Target')) });
    return m;
  };
  const media = new Map();
  const dataUrl = (p) => {
    if (!p) return null;
    if (!media.has(p)) {
      const mime = IMG_MIME[extOf(p)], f = z.file(p);
      media.set(p, mime && f ? f.async('base64').then((b) => `data:${mime};base64,${b}`) : Promise.resolve(null));
    }
    return media.get(p);
  };
  const part = async (p) => {
    if (!p) return null;
    const [d, r] = await Promise.all([xml(p), rels(p)]);
    if (!d) return null;
    return { path: p, doc: d.documentElement, rels: r, rel: (id) => r.get(id)?.target || null, relType: (t) => [...r.values()].find((x) => x.type.endsWith(`/${t}`))?.target || null };
  };
  return { xml, rels, part, dataUrl };
}

// ---------- Excel ----------
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const MAX_ROWS = 3000, MAX_COLS = 80;

function colIndex(ref) {
  let n = 0;
  for (const ch of /^[A-Z]+/i.exec(ref)?.[0] || 'A') n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
}
const rowIndex = (ref) => (+(/\d+/.exec(ref)?.[0] || 1)) - 1;

function numFormatter(code) {
  if (!code || /^general$/i.test(code)) return (v) => String(+v.toPrecision(12));
  const c = code.split(';')[0].replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  const pct = c.includes('%');
  const dec = (/0\.(0+)/.exec(c)?.[1] || '').length;
  const group = c.includes(',');
  return (v) => {
    const x = pct ? v * 100 : v;
    const s = x.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: group });
    return pct ? `${s}%` : s;
  };
}
const isDateCode = (code) => !!code && /[dmyhs]/i.test(code.split(';')[0].replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) && !/^general$/i.test(code);
function excelDate(v, code) {
  const d = new Date(Math.round((v - 25569) * 86400000));
  if (Number.isNaN(d.getTime())) return String(v);
  const day = /[dy]/i.test(code.replace(/\[[^\]]*\]/g, '')) || v >= 1;
  const time = /h|s/i.test(code);
  const o = { timeZone: 'UTC' };
  return [day ? d.toLocaleDateString(undefined, o) : '', time ? d.toLocaleTimeString(undefined, { ...o, hour: '2-digit', minute: '2-digit' }) : ''].filter(Boolean).join(' ');
}

async function sheetHtml(file) {
  const z = await openZip(file);
  const wb = await z.part('xl/workbook.xml');
  if (!wb) throw new Error(`${file.name} is not an Excel workbook`);
  const shared = [];
  const ss = await z.xml(wb.relType('sharedStrings') || 'xl/sharedStrings.xml');
  for (const si of all(ss, 'si')) shared.push(all(si, 't').filter((t) => t.parentElement.localName !== 'rPh').map((t) => t.textContent).join(''));
  // number formats per style index
  const styles = await z.xml(wb.relType('styles') || 'xl/styles.xml');
  const codes = new Map(all(styles, 'numFmt').map((n) => [+attr(n, 'numFmtId'), attr(n, 'formatCode')]));
  const xfs = kids(all(styles, 'cellXfs')[0], 'xf').map((x) => {
    const id = +(attr(x, 'numFmtId') || 0), code = codes.get(id) || (id === 9 ? '0%' : id === 10 ? '0.00%' : id === 2 ? '0.00' : id === 4 ? '#,##0.00' : id === 3 ? '#,##0' : null);
    return { date: BUILTIN_DATE.has(id) || isDateCode(codes.get(id)), code: code || (BUILTIN_DATE.has(id) ? (id >= 18 && id <= 21 ? 'h:mm' : id === 22 ? 'd h:mm' : 'd') : null), fmt: numFormatter(code) };
  });
  const sheets = kids(kid(wb.doc, 'sheets'), 'sheet').filter((s) => !/hidden/i.test(attr(s, 'state') || ''));
  const out = [];
  for (const s of sheets) {
    const p = await z.part(wb.rel(rid(s, 'id')));
    if (!p || ADDED_PART.test(p.path)) continue;   // a page Inkpad added: not part of the document itself
    const cells = new Map();
    let maxR = -1, maxC = -1, cut = false;
    for (const c of all(p.doc, 'c')) {
      const ref = attr(c, 'r');
      if (!ref) continue;
      const r = rowIndex(ref), col = colIndex(ref);
      if (r >= MAX_ROWS || col >= MAX_COLS) { cut = true; continue; }
      const t = attr(c, 't'), v = kid(c, 'v')?.textContent;
      let text = '', num = false;
      if (t === 's') text = shared[+v] ?? '';
      else if (t === 'inlineStr') text = all(c, 't').map((x) => x.textContent).join('');
      else if (t === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'str' || t === 'e') text = v ?? '';
      else if (v != null && v !== '') {
        const x = +v, st = xfs[+(attr(c, 's') || 0)];
        num = true;
        text = st?.date ? excelDate(x, st.code || 'd') : Number.isFinite(x) ? (st ? st.fmt(x) : String(+x.toPrecision(12))) : v;
      }
      if (text === '') continue;
      cells.set(`${r},${col}`, { text, num });
      maxR = Math.max(maxR, r); maxC = Math.max(maxC, col);
    }
    // merged cells
    const span = new Map(), hidden = new Set();
    for (const m of all(p.doc, 'mergeCell')) {
      const [a, b] = (attr(m, 'ref') || '').split(':');
      if (!a || !b) continue;
      const r0 = rowIndex(a), c0 = colIndex(a), r1 = Math.min(rowIndex(b), MAX_ROWS - 1), c1 = Math.min(colIndex(b), MAX_COLS - 1);
      span.set(`${r0},${c0}`, { rs: r1 - r0 + 1, cs: c1 - c0 + 1 });
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (r !== r0 || c !== c0) hidden.add(`${r},${c}`);
    }
    const widths = [];
    for (const col of all(p.doc, 'col')) {
      const w = +attr(col, 'width');
      for (let i = +attr(col, 'min') - 1; i < Math.min(+attr(col, 'max'), MAX_COLS); i++) widths[i] = attr(col, 'hidden') === '1' ? 0 : w;
    }
    let html = sheets.length > 1 ? `<div class="sheet-name">${esc(attr(s, 'name'))}</div>` : '';
    if (maxR < 0) html += '<p class="muted">(empty sheet)</p>';
    else {
      html += '<table class="sheet"><colgroup>';
      for (let c = 0; c <= maxC; c++) html += `<col style="width:${Math.round((widths[c] ?? 8.43) * 7 + 5)}px">`;
      html += '</colgroup>';
      for (let r = 0; r <= maxR; r++) {
        html += '<tr>';
        for (let c = 0; c <= maxC; c++) {
          const key = `${r},${c}`;
          if (hidden.has(key)) continue;
          const v = cells.get(key), sp = span.get(key);
          html += `<td${v?.num ? ' class="n"' : ''}${sp?.rs > 1 ? ` rowspan="${sp.rs}"` : ''}${sp?.cs > 1 ? ` colspan="${sp.cs}"` : ''}>${v ? esc(v.text) : ''}</td>`;
        }
        html += '</tr>';
      }
      html += '</table>';
      if (cut) html += `<p><i>Only the first ${MAX_ROWS} rows and ${MAX_COLS} columns are shown.</i></p>`;
    }
    out.push({ name: attr(s, 'name'), html, part: p.path });
  }
  if (!out.length) throw new Error(`${file.name} has no sheets`);
  return out;
}

// ---------- CSV ----------
function guessSep(text) {
  const line = text.slice(0, 4000).split(/\r?\n/).find((l) => l.trim()) || '';
  const n = (ch) => line.split(ch).length;
  return [',', ';', '\t', '|'].reduce((a, b) => (n(b) > n(a) ? b : a), ',');
}
function parseCsv(text, sep) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
    } else if (ch === '"' && field === '') q = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
      if (rows.length >= MAX_ROWS) break;
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop();
  return rows;
}
function tableHtml(rows, cls) {
  if (!rows.length) return '<p>(empty)</p>';
  const cols = Math.min(MAX_COLS, Math.max(...rows.map((r) => r.length)));
  const cell = (tag, v) => `<${tag}${/^-?[\d.,]+%?$/.test(v.trim()) && tag === 'td' ? ' style="text-align:right"' : ''}>${esc(v)}</${tag}>`;
  return `<table class="${cls}">${rows.map((r, i) => `<tr>${Array.from({ length: cols }, (_, c) => cell(i ? 'td' : 'th', r[c] ?? '')).join('')}</tr>`).join('')}</table>`;
}

// ---------- Markdown (the common parts) ----------
function inline(s) {
  const codes = [];
  let t = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  t = t
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, src) => (/^data:image\//i.test(src) ? `<img src="${src}" alt="${alt}">` : `<i>[${alt || 'picture'}]</i>`))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<u style="color:#1a5fb4">$1</u>')
    .replace(/(\*\*|__)(?=\S)(.+?)\1/g, '<b>$2</b>')
    .replace(/(^|[^*\w])[*_](?=\S)(.+?)[*_](?!\w)/g, '$1<i>$2</i>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}
function markdown(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l || '');
  const cellsOf = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const startsBlock = (l) => /^(#{1,6})\s|^```|^~~~|^>\s?|^\s*([-*_])(\s*\2){2,}\s*$/.test(l) || listRe.test(l);
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (!l.trim()) { i++; continue; }
    if ((m = /^(```|~~~)/.exec(l))) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith(m[1]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      out.push('<hr>'); i++;
    } else if (l.includes('|') && isTableSep(lines[i + 1])) {
      const head = cellsOf(l);
      i += 2;
      const body = [];
      for (; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) body.push(cellsOf(lines[i]));
      out.push(`<table><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${body.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</table>`);
    } else if (/^>\s?/.test(l)) {
      const body = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) body.push(lines[i].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdown(body.join('\n'))}</blockquote>`);
    } else if (listRe.test(l)) {
      // nested lists by indentation
      const stack = [];
      let html = '';
      for (; i < lines.length; i++) {
        const x = lines[i];
        const lm = listRe.exec(x);
        if (!lm) {
          if (x.trim() && /^\s{2,}/.test(x) && stack.length) { html += ` ${inline(x.trim())}`; continue; }
          break;
        }
        const ind = lm[1].replace(/\t/g, '    ').length, tag = /\d/.test(lm[2]) ? 'ol' : 'ul';
        while (stack.length && ind < stack[stack.length - 1].ind) html += `</li></${stack.pop().tag}>`;
        if (!stack.length || ind > stack[stack.length - 1].ind) { html += `<${tag}>`; stack.push({ ind, tag }); } else html += '</li>';
        const task = /^\[([ xX])\]\s+(.*)$/.exec(lm[3]);
        html += task ? `<li class="task">${task[1] === ' ' ? '☐' : '☑'} ${inline(task[2])}` : `<li>${inline(lm[3])}`;
      }
      while (stack.length) html += `</li></${stack.pop().tag}>`;
      out.push(html);
    } else {
      const body = [];
      for (; i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !(lines[i].includes('|') && isTableSep(lines[i + 1])); i++) body.push(lines[i]);
      if (!body.length) { body.push(lines[i]); i++; }
      out.push(`<p>${body.map((x) => inline(x.trim())).join(/ {2}$/.test(body[0]) ? '<br>' : ' ')}</p>`);
    }
  }
  return out.join('\n');
}

// ---------- HTML files: only their content and look; nothing that runs or loads from elsewhere ----------
const noRemote = (css) => css.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*(['"]?)(?!data:image\/)[^)]*\)/gi, 'none');
function cleanHtml(text) {
  const d = new DOMParser().parseFromString(text, 'text/html');
  d.querySelectorAll('script,iframe,frame,frameset,object,embed,link,meta,base,form,input,button,select,textarea,noscript,template,audio,video,source,track,canvas,dialog').forEach((e) => e.remove());
  for (const e of d.querySelectorAll('*')) {
    for (const a of [...e.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || n === 'srcset' || n === 'action' || n === 'formaction' || n === 'ping') e.removeAttribute(a.name);
      else if (/^(src|href|xlink:href|poster|background|data)$/.test(n) && !/^data:image\//i.test(a.value.trim())) e.removeAttribute(a.name);
      else if (n === 'style') e.setAttribute('style', noRemote(a.value));
    }
    if (e.tagName === 'IMG' && !e.getAttribute('src')) e.replaceWith(Object.assign(d.createElement('i'), { textContent: e.alt ? `[${e.alt}]` : '' }));
  }
  // the page's own styles, scoped to the flow: its html / body rules apply to the document's box
  const css = [...d.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  d.querySelectorAll('style').forEach((s) => s.remove());
  return { body: d.body.innerHTML, css: noRemote(css).replace(/(^|[},;\s])(html|body)(?=[\s,{.:#[>])/gi, '$1.dc') };
}

// ---------- PowerPoint ----------
const EMU = 9525; // EMUs per CSS px
const CLR_DEFAULT = { dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6', accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5', accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47', hlink: '0563C1', folHlink: '954F72' };
const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500', navy: '000080', purple: '800080' };

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]) {
  if (!s) return [l, l, l].map((v) => v * 255);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => v * 255);
}
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

function makeCtx(z, theme, master, slide, defText) {
  const scheme = { ...CLR_DEFAULT };
  const cs = all(theme?.doc, 'clrScheme')[0];
  for (const c of cs ? [...cs.children] : []) {
    const v = kid(c, 'srgbClr') ? attr(kid(c, 'srgbClr'), 'val') : kid(c, 'sysClr') ? attr(kid(c, 'sysClr'), 'lastClr') : null;
    if (v) scheme[c.localName] = v;
  }
  const map = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
  const cm = path(slide?.doc, 'clrMapOvr', 'overrideClrMapping') || kid(master?.doc, 'clrMap');
  for (const a of cm ? [...cm.attributes] : []) map[a.localName] = a.value;
  const font = (kind) => attr(path(all(theme?.doc, 'fontScheme')[0], kind, 'latin'), 'typeface');
  const ctx = {
    z, defText,
    major: font('majorFont') || 'Calibri Light', minor: font('minorFont') || 'Calibri',
    txStyles: kid(master?.doc, 'txStyles'),
    color(el) {
      const c = el && [...el.children].find((x) => /^(srgbClr|schemeClr|sysClr|prstClr|scrgbClr)$/.test(x.localName));
      if (!c) return null;
      let hex;
      if (c.localName === 'srgbClr') hex = attr(c, 'val');
      else if (c.localName === 'sysClr') hex = attr(c, 'lastClr') || (attr(c, 'val') === 'window' ? 'FFFFFF' : '000000');
      else if (c.localName === 'prstClr') hex = PRESET[attr(c, 'val')] || '000000';
      else if (c.localName === 'scrgbClr') hex = ['r', 'g', 'b'].map((k) => Math.round(clamp(+attr(c, k) / 100000) * 255).toString(16).padStart(2, '0')).join('');
      else { let v = attr(c, 'val'); if (v === 'phClr') v = 'accent1'; hex = scheme[map[v] || v] || scheme[v] || '000000'; }
      let rgb = [0, 2, 4].map((i) => parseInt((hex || '000000').slice(i, i + 2), 16) || 0), a = 1;
      for (const m of c.children) {
        const v = +attr(m, 'val') / 100000;
        let hsl;
        switch (m.localName) {
          case 'lumMod': hsl = rgbToHsl(rgb); hsl[2] = clamp(hsl[2] * v); rgb = hslToRgb(hsl); break;
          case 'lumOff': hsl = rgbToHsl(rgb); hsl[2] = clamp(hsl[2] + v); rgb = hslToRgb(hsl); break;
          case 'satMod': hsl = rgbToHsl(rgb); hsl[1] = clamp(hsl[1] * v); rgb = hslToRgb(hsl); break;
          case 'tint': rgb = rgb.map((x) => x + (255 - x) * (1 - v)); break;
          case 'shade': rgb = rgb.map((x) => x * v); break;
          case 'alpha': a = clamp(v); break;
          default:
        }
      }
      const [r, g, b] = rgb.map((x) => Math.round(clamp(x, 0, 255)));
      return a < 1 ? `rgba(${r},${g},${b},${a.toFixed(3)})` : `rgb(${r},${g},${b})`;
    },
  };
  return ctx;
}

/** Every slide → { html, w, h }. */
async function slidePages(file) {
  const z = await openZip(file);
  const pres = await z.part('ppt/presentation.xml');
  if (!pres) throw new Error(`${file.name} is not a PowerPoint file`);
  const sz = all(pres.doc, 'sldSz')[0];
  const W = (+attr(sz, 'cx') || 12192000) / EMU, H = (+attr(sz, 'cy') || 6858000) / EMU;
  const defText = kid(pres.doc, 'defaultTextStyle');
  const out = [];
  for (const s of all(pres.doc, 'sldId')) {
    const slide = await z.part(pres.rel(rid(s, 'id')));
    if (!slide || attr(slide.doc, 'show') === '0' || ADDED_PART.test(slide.path)) continue;
    const layout = await z.part(slide.relType('slideLayout'));
    const master = await z.part(layout?.relType('slideMaster'));
    const theme = await z.part(master?.relType('theme'));
    const ctx = makeCtx(z, theme, master, slide, defText);
    out.push({ html: await slideHtml(ctx, slide, layout, master, W, H), w: W, h: H, part: slide.path });
  }
  return out;
}

async function slideHtml(ctx, slide, layout, master, W, H) {
  const bg = (await background(ctx, slide)) || (await background(ctx, layout)) || (await background(ctx, master)) || '#fff';
  const shows = (p) => !p || attr(p.doc, 'showMasterSp') !== '0';
  let html = `<div style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:hidden;background:${bg};font-family:${fontCss(ctx.minor)};color:#000;line-height:1.2">`;
  const S = { ctx, layout, master };
  if (master && shows(slide) && shows(layout)) html += await walk(S, path(master.doc, 'cSld', 'spTree'), master, true, ID);
  if (layout && shows(slide)) html += await walk(S, path(layout.doc, 'cSld', 'spTree'), layout, true, ID);
  html += await walk(S, path(slide.doc, 'cSld', 'spTree'), slide, false, ID);
  return `${html}</div>`;
}

const fontCss = (face) => `${face ? `'${face.replace(/['\\]/g, '')}', ` : ''}'Segoe UI', Roboto, Arial, sans-serif`;

async function background(ctx, p) {
  const bg = path(p?.doc, 'cSld', 'bg');
  if (!bg) return null;
  const pr = kid(bg, 'bgPr');
  if (pr) {
    const f = await fill(ctx, pr, p);
    if (f?.image) return `center / cover no-repeat url(${f.image})`;
    if (f?.css) return f.css;
  }
  const ref = kid(bg, 'bgRef');
  return ref ? ctx.color(ref) : null;
}

/** A fill (solidFill / gradFill / blipFill / noFill) under `el` → { none } | { color, css } | { image } | null if not set. */
async function fill(ctx, el, p) {
  if (!el) return null;
  if (kid(el, 'noFill')) return { none: true };
  const sf = kid(el, 'solidFill');
  if (sf) { const c = ctx.color(sf); return { color: c, css: c }; }
  const gf = kid(el, 'gradFill');
  if (gf) {
    const stops = kids(kid(gf, 'gsLst'), 'gs').map((g) => ({ pos: +attr(g, 'pos') / 1000, c: ctx.color(g) })).sort((a, b) => a.pos - b.pos);
    if (!stops.length) return null;
    const ang = (+attr(kid(gf, 'lin'), 'ang') || 0) / 60000;
    return { color: stops[0].c, css: `linear-gradient(${ang + 90}deg, ${stops.map((s) => `${s.c} ${s.pos}%`).join(', ')})` };
  }
  const bf = kid(el, 'blipFill');
  if (bf) { const img = await ctx.z.dataUrl(p.rel(rid(kid(bf, 'blip'), 'embed'))); return img ? { image: img } : null; }
  return null;
}

const ID = (r) => r;
function rectOf(xf) {
  const off = kid(xf, 'off'), ext = kid(xf, 'ext');
  if (!off || !ext) return null;
  return { x: +attr(off, 'x') / EMU, y: +attr(off, 'y') / EMU, w: +attr(ext, 'cx') / EMU, h: +attr(ext, 'cy') / EMU, rot: (+attr(xf, 'rot') || 0) / 60000, flipH: attr(xf, 'flipH') === '1', flipV: attr(xf, 'flipV') === '1' };
}
/** A group's transform: its children's coordinates → slide coordinates. */
function groupX(X, xf) {
  const r = rectOf(xf);
  if (!r) return X;
  const co = kid(xf, 'chOff'), ce = kid(xf, 'chExt');
  const cx = +attr(co, 'x') / EMU || 0, cy = +attr(co, 'y') / EMU || 0;
  const sx = ce && +attr(ce, 'cx') ? r.w / (+attr(ce, 'cx') / EMU) : 1, sy = ce && +attr(ce, 'cy') ? r.h / (+attr(ce, 'cy') / EMU) : 1;
  return (c) => X({ ...c, x: r.x + (c.x - cx) * sx, y: r.y + (c.y - cy) * sy, w: c.w * sx, h: c.h * sy, rot: c.rot + r.rot });
}

async function walk(S, tree, p, isTemplate, X) {
  let html = '';
  for (const c of tree ? tree.children : []) {
    try { html += await node(S, c, p, isTemplate, X); } catch (e) { console.warn('Skipped a slide item', e); }
  }
  return html;
}
async function node(S, c, p, isTemplate, X) {
  switch (c.localName) {
    case 'sp': case 'cxnSp': return shape(S, c, p, isTemplate, X);
    case 'pic': return picture(S, c, p, isTemplate, X);
    case 'grpSp': return walk(S, c, p, isTemplate, groupX(X, path(c, 'grpSpPr', 'xfrm')));
    case 'graphicFrame': return frameItem(S, c, p, isTemplate, X);
    case 'AlternateContent': { const alt = kid(c, 'Fallback') || kid(c, 'Choice'); return alt ? walk(S, alt, p, isTemplate, X) : ''; }
    default: return '';
  }
}

const normType = (t) => ({ ctrTitle: 'title', subTitle: 'body', obj: 'body' }[t] || t || 'body');
/** The placeholder a slide's placeholder takes its position and text style from, in the layout and in the master. */
function inherited(S, p, ph) {
  if (!ph) return { type: null };
  const type = normType(attr(ph, 'type')), idx = attr(ph, 'idx');
  const find = (part, byIdx) => {
    if (!part || part === p) return null;
    const list = all(path(part.doc, 'cSld', 'spTree'), 'ph');
    const m = (byIdx && idx != null && list.find((x) => attr(x, 'idx') === idx)) || list.find((x) => normType(attr(x, 'type')) === type);
    return m?.parentElement?.parentElement?.parentElement || null;
  };
  const layoutSp = p === S.master ? null : find(S.layout, true);
  const masterSp = find(S.master, false);
  return { type, layoutSp, masterSp };
}
const xfrmOf = (sp) => (sp ? path(sp, 'spPr', 'xfrm') || kid(sp, 'xfrm') : null);

function box(r, inner, extra = '') {
  const t = [];
  if (r.rot) t.push(`rotate(${r.rot}deg)`);
  return `<div style="position:absolute;left:${r.x}px;top:${r.y}px;width:${Math.max(0, r.w)}px;height:${Math.max(0, r.h)}px;${t.length ? `transform:${t.join(' ')};` : ''}${extra}">${inner}</div>`;
}

async function shape(S, c, p, isTemplate, X) {
  const nv = c.children[0];
  if (attr(kid(nv, 'cNvPr'), 'hidden') === '1') return '';
  const ph = path(nv, 'nvPr', 'ph');
  if (ph && isTemplate) return ''; // a layout's empty placeholders ("Click to add title") aren't shown
  const inh = inherited(S, p, ph);
  const spPr = kid(c, 'spPr');
  const r0 = rectOf(kid(spPr, 'xfrm') || xfrmOf(inh.layoutSp) || xfrmOf(inh.masterSp));
  if (!r0) return '';
  const r = X(r0);
  const geo = await geometry(S.ctx, c, spPr, r, p);
  const text = textBox(S.ctx, kid(c, 'txBody'), inh, r, c.localName === 'cxnSp');
  return geo || text ? box(r, geo + text) : '';
}

/** The shape's outline and fill as SVG. */
async function geometry(ctx, c, spPr, r, p) {
  const prst = attr(kid(spPr, 'prstGeom'), 'prst') || (c.localName === 'cxnSp' ? 'line' : kid(spPr, 'custGeom') ? 'cust' : 'rect');
  const style = kid(c, 'style');
  let f = await fill(ctx, spPr, p);
  if (!f) { const ref = kid(style, 'fillRef'); f = ref && +attr(ref, 'idx') > 0 ? { color: ctx.color(ref) } : { none: true }; }
  const ln = kid(spPr, 'ln');
  let stroke = null, sw = 0;
  if (ln && kid(ln, 'noFill')) stroke = null;
  else {
    const lf = ln && (await fill(ctx, ln, p));
    const ref = kid(style, 'lnRef');
    stroke = lf?.color || (ref && +attr(ref, 'idx') > 0 ? ctx.color(ref) : null);
    sw = stroke ? Math.max(0.75, (+attr(ln, 'w') || 9525) / EMU) : 0;
  }
  const isLine = /^(line|straightConnector|bentConnector|curvedConnector)/.test(prst);
  const w = Math.max(r.w, 0.01), h = Math.max(r.h, 0.01);
  if (isLine) {
    if (!stroke) return '';
    return svgWrap(w, h, r, `<line x1="0" y1="0" x2="${r.w}" y2="${r.h}" stroke="${stroke}" stroke-width="${sw}"${dash(ln, sw)}/>`);
  }
  if (f.image) return svgWrap(w, h, r, `<image href="${f.image}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none"/>`);
  const fillC = f.none ? 'none' : f.color || 'none';
  if (fillC === 'none' && !stroke) return '';
  const paint = `fill="${fillC}" stroke="${stroke || 'none'}" stroke-width="${sw}"${dash(ln, sw)}`;
  const adj = (name, d) => { const g = kids(path(spPr, 'prstGeom', 'avLst'), 'gd').find((x) => attr(x, 'name') === name); const m = /val\s+(-?\d+)/.exec(attr(g, 'fmla') || ''); return m ? +m[1] / 100000 : d; };
  let shapeSvg;
  switch (prst) {
    case 'ellipse': case 'flowChartConnector': shapeSvg = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" ${paint}/>`; break;
    case 'roundRect': case 'flowChartAlternateProcess': { const k = Math.min(w, h) * adj('adj', 0.16667); shapeSvg = `<rect x="0" y="0" width="${w}" height="${h}" rx="${k}" ry="${k}" ${paint}/>`; break; }
    case 'triangle': case 'flowChartExtract': shapeSvg = poly([[w * adj('adj', 0.5), 0], [w, h], [0, h]], paint); break;
    case 'rtTriangle': shapeSvg = poly([[0, 0], [w, h], [0, h]], paint); break;
    case 'diamond': case 'flowChartDecision': shapeSvg = poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]], paint); break;
    case 'parallelogram': { const k = Math.min(w, h) * adj('adj', 0.25); shapeSvg = poly([[k, 0], [w, 0], [w - k, h], [0, h]], paint); break; }
    case 'trapezoid': { const k = Math.min(w, h) * adj('adj', 0.25); shapeSvg = poly([[k, 0], [w - k, 0], [w, h], [0, h]], paint); break; }
    case 'hexagon': { const k = Math.min(w, h) * adj('adj', 0.25); shapeSvg = poly([[k, 0], [w - k, 0], [w, h / 2], [w - k, h], [k, h], [0, h / 2]], paint); break; }
    case 'chevron': { const k = Math.min(w, h) * adj('adj', 0.5); shapeSvg = poly([[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h], [k, h / 2]], paint); break; }
    case 'homePlate': { const k = Math.min(w, h) * adj('adj', 0.5); shapeSvg = poly([[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h]], paint); break; }
    case 'rightArrow': { const a = adj('adj1', 0.5), k = Math.min(w, h) * adj('adj2', 0.5), y0 = h * (1 - a) / 2; shapeSvg = poly([[0, y0], [w - k, y0], [w - k, 0], [w, h / 2], [w - k, h], [w - k, h - y0], [0, h - y0]], paint); break; }
    case 'leftArrow': { const a = adj('adj1', 0.5), k = Math.min(w, h) * adj('adj2', 0.5), y0 = h * (1 - a) / 2; shapeSvg = poly([[w, y0], [k, y0], [k, 0], [0, h / 2], [k, h], [k, h - y0], [w, h - y0]], paint); break; }
    case 'cust': shapeSvg = customPath(kid(spPr, 'custGeom'), w, h, fillC, stroke, sw, ln); break;
    default: shapeSvg = `<rect x="0" y="0" width="${w}" height="${h}" ${paint}/>`;
  }
  return svgWrap(w, h, r, shapeSvg);
}
const poly = (pts, paint) => `<polygon points="${pts.map((q) => q.map((v) => +v.toFixed(2)).join(',')).join(' ')}" ${paint}/>`;
function dash(ln, sw) {
  const d = attr(kid(ln, 'prstDash'), 'val');
  if (!d || d === 'solid') return '';
  const k = Math.max(1, sw);
  return ` stroke-dasharray="${/dot/i.test(d) && !/dash/i.test(d) ? `${k} ${2 * k}` : `${4 * k} ${3 * k}`}"`;
}
function svgWrap(w, h, r, inner) {
  const flip = r.flipH || r.flipV ? `transform:scale(${r.flipH ? -1 : 1},${r.flipV ? -1 : 1});` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="position:absolute;left:0;top:0;overflow:visible;${flip}">${inner}</svg>`;
}
/** custGeom paths → SVG path data, scaled to the shape. */
function customPath(geom, w, h, fillC, stroke, sw, ln) {
  let out = '';
  for (const pa of kids(kid(geom, 'pathLst'), 'path')) {
    const pw = +attr(pa, 'w') || w * EMU, phh = +attr(pa, 'h') || h * EMU;
    const sx = w / pw, sy = h / phh;
    let d = '', cx = 0, cy = 0;
    const pt = (e) => [(+attr(e, 'x') || 0) * sx, (+attr(e, 'y') || 0) * sy];
    for (const cmd of pa.children) {
      const pts = kids(cmd, 'pt').map(pt);
      switch (cmd.localName) {
        case 'moveTo': [[cx, cy]] = pts; d += `M${cx} ${cy}`; break;
        case 'lnTo': [[cx, cy]] = pts; d += `L${cx} ${cy}`; break;
        case 'cubicBezTo': d += `C${pts.map((q) => q.join(' ')).join(' ')}`; [cx, cy] = pts[2]; break;
        case 'quadBezTo': d += `Q${pts.map((q) => q.join(' ')).join(' ')}`; [cx, cy] = pts[1]; break;
        case 'arcTo': {
          const wr = (+attr(cmd, 'wR') || 0) * sx, hr = (+attr(cmd, 'hR') || 0) * sy;
          const st = (+attr(cmd, 'stAng') || 0) / 60000 * Math.PI / 180, swa = (+attr(cmd, 'swAng') || 0) / 60000 * Math.PI / 180;
          const ox = cx - wr * Math.cos(st), oy = cy - hr * Math.sin(st);
          const ex = ox + wr * Math.cos(st + swa), ey = oy + hr * Math.sin(st + swa);
          d += `A${wr} ${hr} 0 ${Math.abs(swa) > Math.PI ? 1 : 0} ${swa > 0 ? 1 : 0} ${ex} ${ey}`;
          cx = ex; cy = ey;
          break;
        }
        case 'close': d += 'Z'; break;
        default:
      }
    }
    if (!d) continue;
    const f = attr(pa, 'fill') === 'none' ? 'none' : fillC;
    const s = attr(pa, 'stroke') === '0' ? 'none' : stroke || 'none';
    out += `<path d="${d}" fill="${f}" stroke="${s}" stroke-width="${sw}"${dash(ln, sw)}/>`;
  }
  return out;
}

async function picture(S, c, p, isTemplate, X) {
  const nv = c.children[0];
  if (attr(kid(nv, 'cNvPr'), 'hidden') === '1' || attr(kid(nv, 'cNvPr'), 'name') === INK_NAME) return '';
  const ph = path(nv, 'nvPr', 'ph');
  if (ph && isTemplate) return '';
  const inh = inherited(S, p, ph);
  const r0 = rectOf(path(c, 'spPr', 'xfrm') || xfrmOf(inh.layoutSp) || xfrmOf(inh.masterSp));
  if (!r0) return '';
  const r = X(r0);
  const bf = kid(c, 'blipFill');
  const src = await S.ctx.z.dataUrl(p.rel(rid(kid(bf, 'blip'), 'embed')));
  if (!src) return ''; // EMF / WMF / TIFF pictures can't be drawn in a browser
  const cr = kid(bf, 'srcRect');
  const [l, t, rr, b] = ['l', 't', 'r', 'b'].map((k) => (+attr(cr, k) || 0) / 100000);
  const fx = Math.max(0.01, 1 - l - rr), fy = Math.max(0.01, 1 - t - b);
  const flip = r.flipH || r.flipV ? `transform:scale(${r.flipH ? -1 : 1},${r.flipV ? -1 : 1});` : '';
  const geom = attr(path(c, 'spPr', 'prstGeom'), 'prst');
  const round = geom === 'ellipse' ? 'border-radius:50%;' : geom === 'roundRect' ? `border-radius:${Math.min(r.w, r.h) * 0.16667}px;` : '';
  return box(r, `<div style="position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;${round}${flip}"><img src="${src}" alt="" style="position:absolute;max-width:none;left:${(-l / fx) * 100}%;top:${(-t / fy) * 100}%;width:${100 / fx}%;height:${100 / fy}%"/></div>`);
}

async function frameItem(S, c, p, isTemplate, X) {
  const nv = c.children[0];
  if (isTemplate && path(nv, 'nvPr', 'ph')) return '';
  const tbl = path(c, 'graphic', 'graphicData', 'tbl');
  const r0 = rectOf(kid(c, 'xfrm'));
  if (!tbl || !r0) return ''; // charts and SmartArt aren't drawn
  const r = X(r0);
  const ctx = S.ctx;
  const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => +attr(g, 'w') / EMU);
  const tp = kid(tbl, 'tblPr');
  const firstRow = attr(tp, 'firstRow') === '1', bandRow = attr(tp, 'bandRow') === '1';
  const acc = ctx.color(parseXmlEl('<x><schemeClr val="accent1"/></x>'));
  const accLight = ctx.color(parseXmlEl('<x><schemeClr val="accent1"><tint val="20000"/></schemeClr></x>'));
  const accLighter = ctx.color(parseXmlEl('<x><schemeClr val="accent1"><tint val="40000"/></schemeClr></x>'));
  const lst = [null, null, null, kid(ctx.txStyles, 'otherStyle'), ctx.defText];
  let html = `<table style="position:absolute;left:0;top:0;width:${r.w}px;border-collapse:collapse;table-layout:fixed"><colgroup>${cols.map((w) => `<col style="width:${w}px"/>`).join('')}</colgroup>`;
  kids(tbl, 'tr').forEach((tr, ri) => {
    html += `<tr style="height:${+attr(tr, 'h') / EMU}px">`;
    for (const tc of kids(tr, 'tc')) {
      if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') continue;
      const pr = kid(tc, 'tcPr');
      const header = firstRow && ri === 0;
      const sf = kid(pr, 'solidFill');
      const bg = kid(pr, 'noFill') ? 'transparent' : sf ? ctx.color(sf) : header ? acc : bandRow ? (ri % 2 ? accLight : accLighter) : 'transparent';
      const border = (k) => {
        const l = kid(pr, k);
        if (l && kid(l, 'noFill')) return 'none';
        const col = l && kid(l, 'solidFill') ? ctx.color(kid(l, 'solidFill')) : '#fff';
        return `${Math.max(1, (+attr(l, 'w') || 12700) / EMU)}px solid ${col}`;
      };
      const pad = (k, d) => (+(attr(pr, k) ?? d)) / EMU;
      const va = { ctr: 'middle', b: 'bottom' }[attr(pr, 'anchor')] || 'top';
      const span = `${+attr(tc, 'gridSpan') > 1 ? ` colspan="${attr(tc, 'gridSpan')}"` : ''}${+attr(tc, 'rowSpan') > 1 ? ` rowspan="${attr(tc, 'rowSpan')}"` : ''}`;
      const inner = paragraphs(ctx, kid(tc, 'txBody'), lst, null, 1, 0, header ? { color: 'rgb(255,255,255)', bold: true } : null);
      html += `<td${span} style="background:${bg};border-left:${border('lnL')};border-right:${border('lnR')};border-top:${border('lnT')};border-bottom:${border('lnB')};padding:${pad('marT', 45720)}px ${pad('marR', 91440)}px ${pad('marB', 45720)}px ${pad('marL', 91440)}px;vertical-align:${va};overflow:hidden">${inner}</td>`;
    }
    html += '</tr>';
  });
  return box(r, `${html}</table>`);
}
const parseXmlEl = (s) => new DOMParser().parseFromString(s, 'application/xml').documentElement;

/** A shape's text, laid out like PowerPoint: insets, anchor, autofit scale, inherited sizes, bullets. */
function textBox(ctx, tx, inh, r, isLine) {
  if (!tx || isLine) return '';
  const own = kid(tx, 'bodyPr'), lay = path(inh.layoutSp, 'txBody', 'bodyPr'), mas = path(inh.masterSp, 'txBody', 'bodyPr');
  const bp = (n) => { for (const b of [own, lay, mas]) { const v = attr(b, n); if (v != null) return v; } return null; };
  const auto = [own, lay, mas].map((b) => kid(b, 'normAutofit')).find(Boolean);
  const scale = auto ? (+attr(auto, 'fontScale') || 100000) / 100000 : 1;
  const lnRed = auto ? (+attr(auto, 'lnSpcReduction') || 0) / 100000 : 0;
  const style = inh.type == null ? kid(ctx.txStyles, 'otherStyle') : inh.type === 'title' ? kid(ctx.txStyles, 'titleStyle') : inh.type === 'body' ? kid(ctx.txStyles, 'bodyStyle') : kid(ctx.txStyles, 'otherStyle');
  const lst = [kid(tx, 'lstStyle'), path(inh.layoutSp, 'txBody', 'lstStyle'), path(inh.masterSp, 'txBody', 'lstStyle'), style, ctx.defText];
  const inner = paragraphs(ctx, tx, lst, inh.type === 'title' ? ctx.major : ctx.minor, scale, lnRed);
  if (!inner) return '';
  const ins = (n, d) => (+(bp(n) ?? d)) / EMU;
  const justify = { ctr: 'center', b: 'flex-end' }[bp('anchor')] || 'flex-start';
  const nowrap = bp('wrap') === 'none' ? 'white-space:nowrap;' : '';
  const vert = /^vert/.test(bp('vert') || '') ? 'writing-mode:vertical-rl;' : '';
  return `<div style="position:absolute;left:0;top:0;width:100%;height:100%;box-sizing:border-box;padding:${ins('tIns', 45720)}px ${ins('rIns', 91440)}px ${ins('bIns', 45720)}px ${ins('lIns', 91440)}px;display:flex;flex-direction:column;justify-content:${justify};${nowrap}${vert}overflow:visible">${inner}</div>`;
}

const ALIGN = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' };
function roman(n) { let s = ''; for (const [v, k] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]) while (n >= v) { s += k; n -= v; } return s; }
function autoNum(type, n) {
  const t = type || 'arabicPeriod';
  const core = /^alphaLc/.test(t) ? String.fromCharCode(96 + ((n - 1) % 26) + 1) : /^alphaUc/.test(t) ? String.fromCharCode(64 + ((n - 1) % 26) + 1) : /^romanLc/.test(t) ? roman(n) : /^romanUc/.test(t) ? roman(n).toUpperCase() : String(n);
  return /ParenBoth$/.test(t) ? `(${core})` : /ParenR$/.test(t) ? `${core})` : /Plain$/.test(t) ? core : `${core}.`;
}

/** The paragraphs of a txBody → HTML, '' when there's no text. */
function paragraphs(ctx, tx, lst, defaultFont, scale = 1, lnRed = 0, force = null) {
  if (!tx) return '';
  const counters = [];
  let html = '', any = false;
  for (const p of kids(tx, 'p')) {
    const pPr = kid(p, 'pPr');
    const L = Math.min(8, +(attr(pPr, 'lvl') || 0));
    const lv = (fn) => {
      const v0 = pPr ? fn(pPr) : null;
      if (v0 != null) return v0;
      for (const s of lst) { const q = kid(s, `lvl${L + 1}pPr`); if (q) { const v = fn(q); if (v != null) return v; } }
      return null;
    };
    const defR = (fn) => lv((q) => { const d = kid(q, 'defRPr'); return d ? fn(d) : null; });
    const size = (+(defR((d) => attr(d, 'sz'))) || 1800) / 100;
    const color = force?.color || defR((d) => (kid(d, 'solidFill') ? ctx.color(kid(d, 'solidFill')) : null)) || (ctx.tx1 ??= ctx.color(parseXmlEl('<x><schemeClr val="tx1"/></x>')));
    const bold = force?.bold || defR((d) => attr(d, 'b')) === '1';
    const italic = defR((d) => attr(d, 'i')) === '1';
    const face = defR((d) => attr(kid(d, 'latin'), 'typeface'));
    const runs = [];
    for (const r of p.children) {
      if (r.localName === 'br') { runs.push({ br: true, rPr: kid(r, 'rPr') }); continue; }
      if (r.localName !== 'r' && r.localName !== 'fld') continue;
      const t = kid(r, 't')?.textContent ?? '';
      runs.push({ text: t, rPr: kid(r, 'rPr') });
    }
    const hasText = runs.some((x) => x.text && x.text.trim());
    any ||= hasText;
    const algn = ALIGN[lv((q) => attr(q, 'algn'))] || 'left';
    const marL = (+lv((q) => attr(q, 'marL')) || 0) / EMU, indent = (+lv((q) => attr(q, 'indent')) || 0) / EMU;
    const spacing = (name) => lv((q) => { const s = kid(q, name); if (!s) return null; const pct = kid(s, 'spcPct'), pts = kid(s, 'spcPts'); return pct ? { pct: +attr(pct, 'val') / 100000 } : pts ? { pts: +attr(pts, 'val') / 100 } : null; });
    const px = (pt) => (pt * 4) / 3 * scale;
    const firstSz = (+attr(runs.find((x) => x.text)?.rPr, 'sz') || size * 100) / 100;
    const ls = spacing('lnSpc');
    const lh = ls?.pts ? `${px(ls.pts)}px` : String(Math.max(0.6, 1.2 * (ls?.pct ?? 1) - lnRed));
    const sb = spacing('spcBef'), sa = spacing('spcAft');
    const space = (s) => (s ? (s.pts != null ? px(s.pts) : s.pct * px(firstSz) * 1.2) : 0);
    // bullets
    const bu = lv((q) => (kid(q, 'buNone') ? { none: true } : kid(q, 'buChar') ? { ch: attr(kid(q, 'buChar'), 'char') } : kid(q, 'buAutoNum') ? { auto: attr(kid(q, 'buAutoNum'), 'type'), start: +attr(kid(q, 'buAutoNum'), 'startAt') || 1 } : kid(q, 'buBlip') ? { ch: '•' } : null));
    counters.length = L + 1;
    let bullet = '';
    if (hasText && bu && !bu.none) {
      if (bu.auto) { counters[L] = (counters[L] ?? bu.start - 1) + 1; bullet = autoNum(bu.auto, counters[L]); } else bullet = bu.ch || '•';
      counters.length = bu.auto ? L + 1 : L;
    } else counters.length = L;
    const runCss = (rPr) => {
      const sz = (+attr(rPr, 'sz') || size * 100) / 100;
      const sf = kid(rPr, 'solidFill');
      const c = force?.color && !sf ? force.color : (sf && ctx.color(sf)) || color;
      const tf = attr(kid(rPr, 'latin'), 'typeface') || face;
      const f = tf === '+mj-lt' ? ctx.major : tf === '+mn-lt' ? ctx.minor : tf && !tf.startsWith('+') ? tf : defaultFont;
      const b = attr(rPr, 'b') != null ? attr(rPr, 'b') === '1' || attr(rPr, 'b') === 'true' : bold;
      const i = attr(rPr, 'i') != null ? attr(rPr, 'i') === '1' || attr(rPr, 'i') === 'true' : italic;
      const u = attr(rPr, 'u'), st = attr(rPr, 'strike'), base = +attr(rPr, 'baseline') || 0;
      const deco = [u && u !== 'none' ? 'underline' : '', st && st !== 'noStrike' ? 'line-through' : ''].filter(Boolean).join(' ');
      const cap = attr(rPr, 'cap');
      return `font-size:${px(base ? sz * 0.66 : sz).toFixed(2)}px;color:${c};${f ? `font-family:${fontCss(f)};` : ''}${b ? 'font-weight:700;' : ''}${i ? 'font-style:italic;' : ''}${deco ? `text-decoration:${deco};` : ''}${base ? `vertical-align:${base > 0 ? 'super' : 'sub'};` : ''}${cap === 'all' ? 'text-transform:uppercase;' : cap === 'small' ? 'font-variant:small-caps;' : ''}`;
    };
    let body = runs.map((x) => (x.br ? '<br/>' : x.text ? `<span style="${runCss(x.rPr)}">${esc(x.text)}</span>` : '')).join('');
    if (!hasText) body = `<span style="${runCss(kid(p, 'endParaRPr'))}">&#160;</span>`;
    const first = runs.find((x) => x.text)?.rPr;
    const bulletHtml = bullet ? `<span style="${runCss(first)}display:inline-block;${indent < 0 ? `min-width:${-indent}px;` : 'margin-right:0.4em;'}text-indent:0;text-decoration:none">${esc(bullet)}</span>` : '';
    html += `<div style="margin:${space(sb).toFixed(2)}px 0 ${space(sa).toFixed(2)}px ${marL}px;text-indent:${indent}px;text-align:${algn};line-height:${lh}">${bulletHtml}${body}</div>`;
  }
  return any ? html : '';
}
