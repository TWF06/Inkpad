// Writing Word (.docx), PowerPoint (.pptx) and Excel (.xlsx) files for notes that *are* such a file (officenote.js).
//
// What goes into the file:
//   • your writing on each page, as a picture named "Inkpad ink" (transparent, over the document's own content),
//     so it shows in Word / PowerPoint / Excel and anywhere else the file is opened;
//   • pages you added in Inkpad, as pages of Inkpad's own: Word paragraphs marked INK_MARK, PowerPoint slides and
//     Excel sheets named slideInkpadN / sheetInkpadN, each holding a picture of the page (paper and writing);
//   • the editable copy of the writing (strokes, text, pictures, layers…) as the part inkpad/note.json, which Office
//     ignores, so the writing can still be erased, moved and recoloured when the file is opened in Inkpad again.
// Every save first takes out what Inkpad put in last time, so nothing piles up. The document's own content is never
// changed. A file made in Inkpad (a new Word / PowerPoint / Excel note) is simply written anew from its pages.
import { INK_NAME, INK_MARK, ADDED_PART, loadZip } from './docconvert.js';

export const DATA_PART = 'inkpad/note.json';
const EMU = 9525;            // EMUs per CSS px
const TWIP = 15;             // twips per CSS px
const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  xdr: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  pr: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
};
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RT = { image: `${REL}/image`, slide: `${REL}/slide`, layout: `${REL}/slideLayout`, master: `${REL}/slideMaster`, theme: `${REL}/theme`,
  sheet: `${REL}/worksheet`, drawing: `${REL}/drawing`, styles: `${REL}/styles`, doc: `${REL}/officeDocument` };
const CT = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  pres: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  layout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  master: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  book: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  sheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  drawing: 'application/vnd.openxmlformats-officedocument.drawing+xml',
  styles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
};
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const emu = (px) => Math.round(px * EMU);

// ---------- small XML helpers (DOM, namespace-aware) ----------
const parse = (t) => { const d = new DOMParser().parseFromString(t, 'application/xml'); if (d.getElementsByTagName('parsererror').length) throw new Error('A part of the file can’t be read'); return d; };
const ser = (d) => new XMLSerializer().serializeToString(d);
const els = (n, ns, name) => [...n.getElementsByTagNameNS(ns, name)];
const kids = (n, ns, name) => [...n.children].filter((c) => c.namespaceURI === ns && c.localName === name);
const ancestor = (el, ns, name) => { for (let e = el; e; e = e.parentElement) if (e.namespaceURI === ns && e.localName === name) return e; return null; };
const fragment = (d, xml) => { const t = parse(`<x xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}" xmlns:p="${NS.p}" xmlns:xdr="${NS.xdr}" xmlns:s="${NS.s}">${xml}</x>`); return [...t.documentElement.children].map((c) => d.importNode(c, true)); };
const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
const relsOf = (p) => `${dirOf(p)}_rels/${p.slice(p.lastIndexOf('/') + 1)}.rels`;
function resolve(base, target) {
  const parts = (target.startsWith('/') ? target.slice(1) : dirOf(base) + target).split('/'), out = [];
  for (const x of parts) { if (x === '..') out.pop(); else if (x && x !== '.') out.push(x); }
  return out.join('/');
}
function relative(from, to) {
  const a = dirOf(from).split('/').filter(Boolean), b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/** A zip, with helpers for relationships and content types. */
async function pkg(bytes) {
  const JSZip = await loadZip();
  const z = bytes ? await JSZip.loadAsync(bytes) : new JSZip();
  const text = async (p) => (await z.file(p)?.async('string')) ?? null;
  const ctDoc = parse((await text('[Content_Types].xml')) || `${XML}<Types xmlns="${NS.ct}"/>`);
  const relDocs = new Map();
  const P = {
    z, text,
    async xml(p) { const t = await text(p); return t ? parse(t) : null; },
    put(p, data) { z.file(p, typeof data === 'string' ? data : data instanceof Document ? XML + ser(data).replace(/^<\?xml[^>]*\?>\s*/, '') : data); },
    /** Take a part out, with its relationships (also any already read: they must not be written back). */
    remove(p) { z.remove(p); z.remove(relsOf(p)); relDocs.delete(relsOf(p)); P.override(p, null); },
    files(re) { return Object.keys(z.files).filter((p) => re.test(p)); },
    /** Relationships of part p: { doc, list(), add(type, target, id?) → id, drop(pred) } */
    async rels(p) {
      const rp = relsOf(p);
      if (!relDocs.has(rp)) relDocs.set(rp, parse((await text(rp)) || `${XML}<Relationships xmlns="${NS.pr}"/>`));
      const d = relDocs.get(rp);
      const list = () => els(d, NS.pr, 'Relationship').map((r) => ({ el: r, id: r.getAttribute('Id'), type: r.getAttribute('Type'), target: r.getAttribute('Target'), ext: r.getAttribute('TargetMode') === 'External', path: r.getAttribute('TargetMode') === 'External' ? null : resolve(p, r.getAttribute('Target')) }));
      return {
        doc: d, list,
        byId: (id) => list().find((r) => r.id === id) || null,
        add(type, targetPath, id) {
          const ids = new Set(list().map((r) => r.id));
          let n = ids.size + 1;
          while (!id || ids.has(id)) id = `rIdInk${n++}`;
          const r = d.createElementNS(NS.pr, 'Relationship');
          r.setAttribute('Id', id); r.setAttribute('Type', type); r.setAttribute('Target', relative(p, targetPath));
          d.documentElement.append(r);
          return id;
        },
        drop(pred) { for (const r of list()) if (pred(r)) r.el.remove(); },
      };
    },
    /** Content type of a part (null removes its override). */
    override(p, type) {
      const name = `/${p}`;
      for (const o of els(ctDoc, NS.ct, 'Override')) if (o.getAttribute('PartName') === name) o.remove();
      if (!type) return;
      const o = ctDoc.createElementNS(NS.ct, 'Override');
      o.setAttribute('PartName', name); o.setAttribute('ContentType', type);
      ctDoc.documentElement.append(o);
    },
    deflt(ext, type) {
      if (els(ctDoc, NS.ct, 'Default').some((d) => d.getAttribute('Extension').toLowerCase() === ext)) return;
      const d = ctDoc.createElementNS(NS.ct, 'Default');
      d.setAttribute('Extension', ext); d.setAttribute('ContentType', type);
      ctDoc.documentElement.prepend(d);
    },
    async done() {
      P.deflt('rels', 'application/vnd.openxmlformats-package.relationships+xml');
      P.deflt('xml', 'application/xml');
      P.deflt('png', 'image/png');
      P.deflt('json', 'application/json');
      for (const [rp, d] of relDocs) { if (els(d, NS.pr, 'Relationship').length) P.put(rp, d); else z.remove(rp); }
      P.put('[Content_Types].xml', ctDoc);
      return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    },
  };
  return P;
}

const picXml = (prefix, id, rid, w, h) => `<${prefix}:pic><${prefix}:nvPicPr><${prefix}:cNvPr id="${id}" name="${INK_NAME}" descr="Writing from Inkpad"/><${prefix}:cNvPicPr><a:picLocks noChangeAspect="1"/></${prefix}:cNvPicPr>${prefix === 'p' ? '<p:nvPr/>' : ''}</${prefix}:nvPicPr><${prefix}:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></${prefix}:blipFill><${prefix}:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></${prefix}:spPr></${prefix}:pic>`;

/**
 * Write a note into its Office file.
 *   type      'docx' | 'pptx' | 'xlsx'
 *   bytes     the file as it is now (null: write a new file, as for notes made in Inkpad)
 *   data      the editable copy (JSON string)
 *   pages     [{ w, h, doc (index of the document page it is on, or null for a page added in Inkpad), png (bytes) }]
 *             png: the writing alone (transparent) for document pages; paper and writing for added pages
 *   geo       where each document page is in the file (docconvert.js documentPages: at + geo)
 * Returns the new file's bytes.
 */
export async function writeOffice({ type, bytes, data, pages, geo }) {
  const P = await pkg(bytes);
  if (type === 'docx') await (bytes ? patchDocx : newDocx)(P, pages, geo);
  else if (type === 'pptx') await (bytes ? patchPptx : newPptx)(P, pages, geo);
  else if (type === 'xlsx') await (bytes ? patchXlsx : newXlsx)(P, pages, geo);
  else throw new Error(`Can’t write ${type} files`);
  P.put(DATA_PART, data);
  return P.done();
}

/** Media files Inkpad wrote last time (all named inkpad-…): taken out before writing the new ones. */
function dropOldMedia(P) { for (const p of P.files(/(^|\/)media\/inkpad-[^/]*$/i)) P.z.remove(p); }
let mediaN = 0;
function addMedia(P, dir, png) { const p = `${dir}media/inkpad-${Date.now().toString(36)}-${++mediaN}.png`; P.put(p, png); return p; }

// ---------- Word ----------
const W_ROOT = `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}"`;
function anchorXml({ id, rid, w, h, x = 0, y = 0, vRel = 'page' }) {
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251659264 + id}" behindDoc="0" locked="1" layoutInCell="1" allowOverlap="1">`
    + `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(x)}</wp:posOffset></wp:positionH>`
    + `<wp:positionV relativeFrom="${vRel}"><wp:posOffset>${emu(y)}</wp:posOffset></wp:positionV>`
    + `<wp:extent cx="${emu(w)}" cy="${emu(h)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>`
    + `<wp:docPr id="${id}" name="${INK_NAME}" descr="Writing from Inkpad"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic><a:graphicData uri="${NS.pic}">${picXml('pic', id, rid, w, h)}</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
}
// half-inch margins: the page picture is placed from the page edge anyway, and zero margins make Word warn when printing
const sectXml = (w, h) => `<w:sectPr><w:pgSz w:w="${Math.round(w * TWIP)}" w:h="${Math.round(h * TWIP)}"${w > h ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;

/** A page of Inkpad's own in Word: an empty paragraph on a page of its own, holding the page's picture. */
const addedParaXml = (pg, id, rid, last, ownDoc) => `<w:p w:rsidR="${INK_MARK}" w:rsidRDefault="${INK_MARK}"><w:pPr>${ownDoc ? '' : '<w:pageBreakBefore/>'}<w:spacing w:before="0" w:after="0"/>${ownDoc && !last ? sectXml(pg.w, pg.h) : ''}</w:pPr>${anchorXml({ id, rid, w: pg.w, h: pg.h })}</w:p>`;

async function newDocx(P, pages) {
  P.put('_rels/.rels', `${XML}<Relationships xmlns="${NS.pr}"><Relationship Id="rId1" Type="${RT.doc}" Target="word/document.xml"/></Relationships>`);
  P.override('word/document.xml', CT.docx);
  const rels = await P.rels('word/document.xml');
  let body = '';
  pages.forEach((pg, i) => { const rid = rels.add(RT.image, addMedia(P, 'word/', pg.png)); body += addedParaXml(pg, i + 1, rid, i === pages.length - 1, true); });
  const last = pages[pages.length - 1];
  P.put('word/document.xml', `${XML}<w:document ${W_ROOT}><w:body>${body}${sectXml(last.w, last.h)}</w:body></w:document>`);
}

async function patchDocx(P, pages, geo) {
  const main = 'word/document.xml';
  const d = await P.xml(main);
  if (!d) throw new Error('This Word file has no document');
  const rels = await P.rels(main);
  // out with what Inkpad put in last time
  for (const p of els(d, NS.w, 'p')) if (p.getAttributeNS(NS.w, 'rsidRDefault') === INK_MARK) p.remove();
  for (const pr of els(d, NS.wp, 'docPr')) if (pr.getAttribute('name') === INK_NAME) ancestor(pr, NS.w, 'r')?.remove();
  rels.drop((r) => /(^|\/)media\/inkpad-/i.test(r.target || ''));
  dropOldMedia(P);
  let id = Math.max(1000, ...els(d, NS.wp, 'docPr').map((x) => +x.getAttribute('id') || 0)) + 1;
  const body = els(d, NS.w, 'body')[0];
  // the paragraphs as Inkpad laid them out ↔ the paragraphs in the file (same order; text boxes are drawn elsewhere)
  const paras = els(body, NS.w, 'p').filter((p) => !ancestor(p, NS.w, 'txbxContent'));
  const laid = geo?.paras || [];
  const xmlFor = (k) => paras[laid.length === paras.length ? k : Math.round((k * (paras.length - 1)) / Math.max(1, laid.length - 1))] || paras[0];
  for (const pg of pages) {
    if (pg.doc == null || !pg.png) continue;
    const at = geo?.pages?.[pg.doc];
    if (!at || !paras.length) continue;
    // anchor the page's writing to the first paragraph that starts on that page, placed relative to it, so it
    // stays with that text even if Word lays the document out a little differently
    let k = laid.findIndex((q) => q.flow === at.flow && q.top >= at.s - 0.5 && q.top < at.e);
    if (k < 0) k = laid.reduce((best, q, i) => (q.flow === at.flow && q.top < at.s ? i : best), -1);
    if (k < 0) k = laid.findIndex((q) => q.flow === at.flow);
    if (k < 0) k = 0;
    const p = xmlFor(k);
    const onPage = laid[k] ? at.top + (laid[k].top - at.s) : at.top;
    const rid = rels.add(RT.image, addMedia(P, 'word/', pg.png));
    const run = fragment(d, anchorXml({ id: id++, rid, w: pg.w, h: pg.h, y: -onPage, vRel: 'paragraph' }))[0];
    const ppr = kids(p, NS.w, 'pPr')[0];
    if (ppr) ppr.after(run); else p.prepend(run);
  }
  // pages added in Inkpad: at the end of the document, each on a page of its own
  const sect = kids(body, NS.w, 'sectPr')[0] || null;
  for (const pg of pages) {
    if (pg.doc != null) continue;
    const rid = rels.add(RT.image, addMedia(P, 'word/', pg.png));
    for (const n of fragment(d, addedParaXml(pg, id++, rid, false, false))) body.insertBefore(n, sect);
  }
  P.put(main, d);
}

// ---------- PowerPoint ----------
const P_ROOT = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"`;
const TREE = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const slideXml = (pic) => `${XML}<p:sld ${P_ROOT}><p:cSld><p:spTree>${TREE}${pic}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

async function newPptx(P, pages) {
  const w = pages[0].w, h = pages[0].h;
  P.put('_rels/.rels', `${XML}<Relationships xmlns="${NS.pr}"><Relationship Id="rId1" Type="${RT.doc}" Target="ppt/presentation.xml"/></Relationships>`);
  P.put('ppt/theme/theme1.xml', THEME);
  P.override('ppt/theme/theme1.xml', CT.theme);
  P.put('ppt/slideMasters/slideMaster1.xml', `${XML}<p:sldMaster ${P_ROOT}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${TREE}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`);
  P.override('ppt/slideMasters/slideMaster1.xml', CT.master);
  const mr = await P.rels('ppt/slideMasters/slideMaster1.xml');
  mr.add(RT.layout, 'ppt/slideLayouts/slideLayout1.xml', 'rId1');
  mr.add(RT.theme, 'ppt/theme/theme1.xml', 'rId2');
  P.put('ppt/slideLayouts/slideLayout1.xml', `${XML}<p:sldLayout ${P_ROOT} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${TREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  P.override('ppt/slideLayouts/slideLayout1.xml', CT.layout);
  (await P.rels('ppt/slideLayouts/slideLayout1.xml')).add(RT.master, 'ppt/slideMasters/slideMaster1.xml', 'rId1');
  const pr = await P.rels('ppt/presentation.xml');
  pr.add(RT.master, 'ppt/slideMasters/slideMaster1.xml', 'rId1');
  pr.add(RT.theme, 'ppt/theme/theme1.xml', 'rId2');
  let ids = '';
  for (let i = 0; i < pages.length; i++) {
    const sp = `ppt/slides/slideInkpad${i + 1}.xml`;   // Inkpad's own slides: rewritten on every save
    const sr = await P.rels(sp);
    sr.add(RT.layout, 'ppt/slideLayouts/slideLayout1.xml', 'rId1');
    const rid = sr.add(RT.image, addMedia(P, 'ppt/', pages[i].png), 'rId2');
    P.put(sp, slideXml(picXml('p', 2, rid, w, h)));
    P.override(sp, CT.slide);
    ids += `<p:sldId id="${256 + i}" r:id="${pr.add(RT.slide, sp, `rId${3 + i}`)}"/>`;
  }
  P.put('ppt/presentation.xml', `${XML}<p:presentation ${P_ROOT} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="${emu(w)}" cy="${emu(h)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  P.override('ppt/presentation.xml', CT.pres);
}

async function patchPptx(P, pages, geo) {
  const main = 'ppt/presentation.xml';
  const pres = await P.xml(main);
  if (!pres) throw new Error('This PowerPoint file has no slides');
  const pr = await P.rels(main);
  const list = els(pres, NS.p, 'sldIdLst')[0];
  // slides Inkpad added last time: out (they are written again below, from the pages as they are now)
  for (const r of pr.list().filter((x) => x.type === RT.slide && ADDED_PART.test(`/${x.path}`))) {
    for (const s of els(pres, NS.p, 'sldId')) if (s.getAttributeNS(NS.r, 'id') === r.id) s.remove();
    r.el.remove();
    P.remove(r.path);
  }
  dropOldMedia(P);
  const sz = els(pres, NS.p, 'sldSz')[0];
  const W = (+sz?.getAttribute('cx') || 12192000) / EMU, H = (+sz?.getAttribute('cy') || 6858000) / EMU;
  const slidePath = (doc) => geo?.pages?.[doc]?.part || null;
  // writing on the document's own slides: a picture over the whole slide, on top of everything
  for (const pg of pages) {
    const sp = pg.doc != null ? slidePath(pg.doc) : null;
    if (!sp) continue;
    const d = await P.xml(sp);
    if (!d) continue;
    const sr = await P.rels(sp);
    for (const c of els(d, NS.p, 'cNvPr')) if (c.getAttribute('name') === INK_NAME) ancestor(c, NS.p, 'pic')?.remove();
    sr.drop((r) => /(^|\/)media\/inkpad-/i.test(r.target || ''));
    if (pg.png) {
      const tree = els(d, NS.p, 'spTree')[0];
      const id = Math.max(1, ...els(d, NS.p, 'cNvPr').map((x) => +x.getAttribute('id') || 0)) + 1;
      const rid = sr.add(RT.image, addMedia(P, 'ppt/', pg.png));
      tree.append(...fragment(d, picXml('p', id, rid, W, H)));
    }
    P.put(sp, d);
  }
  // pages added in Inkpad: new slides, after the slide they follow in Inkpad
  const firstSlide = pr.list().find((r) => r.type === RT.slide);
  let layout = firstSlide && (await P.rels(firstSlide.path)).list().find((r) => r.type === RT.layout)?.path;
  if (!layout) {   // only Inkpad's own slides (a PowerPoint note made in Inkpad): the master's first layout
    const m = pr.list().find((r) => r.type === RT.master);
    layout = m && (await P.rels(m.path)).list().find((r) => r.type === RT.layout)?.path;
  }
  let nextId = Math.max(255, ...els(pres, NS.p, 'sldId').map((s) => +s.getAttribute('id') || 0)) + 1;
  let after = null, n = 0;
  for (const pg of pages) {
    if (pg.doc != null) { const sp = slidePath(pg.doc); const r = sp && pr.list().find((x) => x.path === sp); after = r ? els(pres, NS.p, 'sldId').find((s) => s.getAttributeNS(NS.r, 'id') === r.id) || after : after; continue; }
    if (!layout) break;
    const sp = `ppt/slides/slideInkpad${++n}.xml`;
    const sr = await P.rels(sp);
    sr.add(RT.layout, layout, 'rId1');
    const rid = sr.add(RT.image, addMedia(P, 'ppt/', pg.png), 'rId2');
    P.put(sp, slideXml(picXml('p', 2, rid, W, H)));
    P.override(sp, CT.slide);
    const el = fragment(pres, `<p:sldId id="${nextId++}" r:id="${pr.add(RT.slide, sp)}"/>`)[0];
    if (after) after.after(el); else list.prepend(el);
    after = el;
  }
  P.put(main, pres);
}

// ---------- Excel ----------
const X_ROOT = `xmlns:xdr="${NS.xdr}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"`;
const STYLES = `${XML}<styleSheet xmlns="${NS.s}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
const oneCell = (id, rid, w, h) => `<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${emu(w)}" cy="${emu(h)}"/>${picXml('xdr', id, rid, w, h)}<xdr:clientData/></xdr:oneCellAnchor>`;
const twoCell = (id, rid, from, to, w, h) => `<xdr:twoCellAnchor editAs="twoCell"><xdr:from><xdr:col>${from.c}</xdr:col><xdr:colOff>${from.co}</xdr:colOff><xdr:row>${from.r}</xdr:row><xdr:rowOff>${from.ro}</xdr:rowOff></xdr:from><xdr:to><xdr:col>${to.c}</xdr:col><xdr:colOff>${to.co}</xdr:colOff><xdr:row>${to.r}</xdr:row><xdr:rowOff>${to.ro}</xdr:rowOff></xdr:to>${picXml('xdr', id, rid, w, h)}<xdr:clientData/></xdr:twoCellAnchor>`;

/** A sheet holding one page's picture (Excel pages of Inkpad's own). */
async function pageSheet(P, sp, pg, n) {
  const dp = `xl/drawings/drawingInkpad${n}.xml`;
  const dr = await P.rels(dp);
  const rid = dr.add(RT.image, addMedia(P, 'xl/', pg.png), 'rId1');
  P.put(dp, `${XML}<xdr:wsDr ${X_ROOT}>${oneCell(2, rid, pg.w, pg.h)}</xdr:wsDr>`);
  P.override(dp, CT.drawing);
  const sr = await P.rels(sp);
  const did = sr.add(RT.drawing, dp, 'rId1');
  P.put(sp, `${XML}<worksheet xmlns="${NS.s}" xmlns:r="${NS.r}"><sheetData/><drawing r:id="${did}"/></worksheet>`);
  P.override(sp, CT.sheet);
}

async function newXlsx(P, pages) {
  P.put('_rels/.rels', `${XML}<Relationships xmlns="${NS.pr}"><Relationship Id="rId1" Type="${RT.doc}" Target="xl/workbook.xml"/></Relationships>`);
  const br = await P.rels('xl/workbook.xml');
  let sheets = '';
  for (let i = 0; i < pages.length; i++) {
    const sp = `xl/worksheets/sheetInkpad${i + 1}.xml`;   // Inkpad's own sheets: rewritten on every save
    await pageSheet(P, sp, pages[i], i + 1);
    sheets += `<sheet name="Page ${i + 1}" sheetId="${i + 1}" r:id="${br.add(RT.sheet, sp, `rId${i + 1}`)}"/>`;
  }
  br.add(RT.styles, 'xl/styles.xml');
  P.put('xl/styles.xml', STYLES);
  P.override('xl/styles.xml', CT.styles);
  P.put('xl/workbook.xml', `${XML}<workbook xmlns="${NS.s}" xmlns:r="${NS.r}"><sheets>${sheets}</sheets></workbook>`);
  P.override('xl/workbook.xml', CT.book);
}

// where <drawing> goes in a worksheet: before these elements (the schema fixes the order)
const AFTER_DRAWING = ['legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];

/** Excel's own size of each column and row, in px (from the sheet's settings). */
function sheetSizes(d) {
  const fmt = els(d, NS.s, 'sheetFormatPr')[0];
  const defW = +(fmt?.getAttribute('defaultColWidth') || 8.43);   // Excel's standard column: 8.43 characters, 64 px
  const defH = (+(fmt?.getAttribute('defaultRowHeight') || 15)) * 96 / 72;
  const colW = new Map(), rowH = new Map();
  for (const c of els(d, NS.s, 'col')) {
    const w = c.getAttribute('hidden') === '1' ? 0 : +(c.getAttribute('width') || defW);
    for (let i = +c.getAttribute('min') - 1; i < Math.min(+c.getAttribute('max'), 400); i++) colW.set(i, Math.round(w * 7 + 5));
  }
  for (const r of els(d, NS.s, 'row')) if (r.getAttribute('ht')) rowH.set(+r.getAttribute('r') - 1, r.getAttribute('hidden') === '1' ? 0 : +r.getAttribute('ht') * 96 / 72);
  return { col: (i) => colW.get(i) ?? Math.round(defW * 7 + 5), row: (i) => rowH.get(i) ?? defH };
}

/** A point on Inkpad's page of a sheet → the cell it is in, and the offset in it in Excel's own size (EMU). */
function cellAt(t, x, y, size) {
  const find = (edges, v, ourDefault) => {
    const last = edges[edges.length - 1];
    if (!edges.length || v < edges[0][0]) return { i: 0, frac: 0 };
    for (let i = 0; i < edges.length; i++) if (v < edges[i][1]) return { i, frac: (v - edges[i][0]) / Math.max(1, edges[i][1] - edges[i][0]) };
    const k = Math.floor((v - last[1]) / ourDefault);   // past the table: Excel's default-size cells
    return { i: edges.length + k, frac: ((v - last[1]) - k * ourDefault) / ourDefault };
  };
  const c = find(t.cols, x, 64), r = find(t.rows, y, 21);
  return { c: c.i, co: Math.round(c.frac * size.col(c.i) * EMU), r: r.i, ro: Math.round(r.frac * size.row(r.i) * EMU) };
}

async function patchXlsx(P, pages, geo) {
  const main = 'xl/workbook.xml';
  const book = await P.xml(main);
  if (!book) throw new Error('This Excel file has no workbook');
  const br = await P.rels(main);
  // sheets Inkpad added last time: out
  for (const r of br.list().filter((x) => x.type === RT.sheet && ADDED_PART.test(`/${x.path}`))) {
    for (const s of els(book, NS.s, 'sheet')) if (s.getAttributeNS(NS.r, 'id') === r.id) s.remove();
    r.el.remove();
    const rels = await P.rels(r.path);
    for (const x of rels.list()) if (x.type === RT.drawing) P.remove(x.path);
    P.remove(r.path);
  }
  dropOldMedia(P);
  // writing on the document's own sheets, grouped by sheet
  const bySheet = new Map();
  for (const pg of pages) {
    const at = pg.doc != null ? geo?.pages?.[pg.doc] : null;
    const fl = at && geo.flows?.[at.flow];
    if (!fl?.part) continue;
    if (!bySheet.has(fl.part)) bySheet.set(fl.part, []);
    if (pg.png && fl.table) bySheet.get(fl.part).push({ pg, at, t: fl.table });
  }
  for (const [sp, items] of bySheet) {
    const d = await P.xml(sp);
    if (!d) continue;
    const sr = await P.rels(sp);
    // the sheet's drawing: its own, or one for Inkpad's writing
    let draw = sr.list().find((r) => r.type === RT.drawing && kids(d.documentElement, NS.s, 'drawing').some((x) => x.getAttributeNS(NS.r, 'id') === r.id));
    let dd = draw && (await P.xml(draw.path));
    if (!dd) {
      if (!items.length) continue;
      let n = 1;
      while (P.z.file(`xl/drawings/drawingInkpad${n}.xml`)) n++;
      const dp = `xl/drawings/drawingInkpad${n}.xml`;
      dd = parse(`${XML}<xdr:wsDr ${X_ROOT}/>`);
      P.override(dp, CT.drawing);
      const id = sr.add(RT.drawing, dp);
      draw = { path: dp };
      const el = d.createElementNS(NS.s, 'drawing');
      el.setAttributeNS(NS.r, 'r:id', id);
      const before = [...d.documentElement.children].find((c) => AFTER_DRAWING.includes(c.localName));
      d.documentElement.insertBefore(el, before || null);
      P.put(sp, d);
    }
    for (const c of els(dd, NS.xdr, 'cNvPr')) {
      if (c.getAttribute('name') !== INK_NAME) continue;
      ['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'].map((n) => ancestor(c, NS.xdr, n)).find(Boolean)?.remove();
    }
    const dr = await P.rels(draw.path);
    dr.drop((r) => /(^|\/)media\/inkpad-/i.test(r.target || ''));
    const size = sheetSizes(d);
    let id = Math.max(1, ...els(dd, NS.xdr, 'cNvPr').map((x) => +x.getAttribute('id') || 0)) + 1;
    for (const { pg, at, t } of items) {
      // the page shows the sheet from `s` px down, starting `top` px down the page: its corners on the sheet
      const y0 = at.s - at.top, x0 = 0;
      const from = cellAt(t, x0, y0, size), to = cellAt(t, x0 + pg.w, y0 + pg.h, size);
      const rid = dr.add(RT.image, addMedia(P, 'xl/', pg.png));
      dd.documentElement.append(...fragment(dd, twoCell(id++, rid, from, to, pg.w, pg.h)));
    }
    P.put(draw.path, dd);
  }
  // pages added in Inkpad: sheets of their own at the end
  const sheetsEl = els(book, NS.s, 'sheets')[0];
  let sheetId = Math.max(0, ...els(book, NS.s, 'sheet').map((s) => +s.getAttribute('sheetId') || 0)) + 1;
  const names = new Set(els(book, NS.s, 'sheet').map((s) => s.getAttribute('name').toLowerCase()));
  let n = 0;
  for (const pg of pages) {
    if (pg.doc != null) continue;
    n++;
    const sp = `xl/worksheets/sheetInkpad${n}.xml`;
    await pageSheet(P, sp, pg, `Page${n}`);
    let name = `Page ${n}`;
    for (let k = 2; names.has(name.toLowerCase()); k++) name = `Page ${n} (${k})`;
    names.add(name.toLowerCase());
    sheetsEl.append(...fragment(book, `<s:sheet name="${esc(name)}" sheetId="${sheetId++}" r:id="${br.add(RT.sheet, sp)}"/>`));
  }
  P.put(main, book);
}

// a minimal theme (PowerPoint needs one); colours and fonts are Office's defaults
const THEME = `${XML}<a:theme xmlns:a="${NS.a}" name="Inkpad"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
