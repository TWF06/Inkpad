// Canvas note editor: tools, camera, layers, undo/redo, selection, text & tables.
import { store, uid } from './store.js';
import * as R from './render.js';
import { recognize } from './shapes.js';
import { h, icon, esc, toast, modal, menu, download, pickFile, onFileDrop } from './ui.js';
import { readImage, readPdf, pdfNotePage, pageSizeFor, ensureBackgroundLayer, isImage, isPdf, isDocument, convertDocument, ACCEPT_DOCS, renderPdfPages, imageSize, PDF_RES } from './importer.js';
import { createPanels } from './panels.js';
import { isNative, NotesFolder } from './native.js';
import { toggleTimer } from './timer.js';
import { saveAs } from './export.js';

const SETTINGS_KEY = 'inkpad.settings';
const DEFAULT_SETTINGS = {
  palette: ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#9333ea', '#ec4899', '#ffffff'],
  tools: {
    pen: { color: '#1f2937', width: 2.5 },
    highlighter: { color: '#facc15', width: 20 },
    eraser: { width: 20 },
    text: { color: '#1f2937', width: 18 },
  },
  widths: { pen: [1.5, 2.5, 5], highlighter: [12, 20, 32], eraser: [10, 20, 44], text: [14, 18, 28] },
  wsel: {},           // which size preset of each tool is in use; dragging the size slider changes that preset
  floatPos: null,     // where the colour / size bar was dragged to
  autoShape: true,
  eraserMode: 'stroke',   // 'stroke': erase whole strokes; 'part': erase only what the eraser covers
  stylusOnly: true,  // write with the stylus; fingers pan & zoom (palm rejection)
  v: 2,
};
const PEN_SEEN_KEY = 'inkpad.penSeen';
// size slider range per tool: [min, max, step]
const SIZE_RANGE = { pen: [0.5, 30, 0.5], highlighter: [4, 80, 1], eraser: [4, 150, 2], text: [8, 96, 1] };
const LONG_PRESS_MS = 450;
// with "stylus only" on, these tools need the stylus; with any other tool a finger works too (fingers still pan & zoom)
const STYLUS_TOOLS = new Set(['pen', 'highlighter', 'eraser', 'lasso']);
const loadSettings = () => {
  try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY)); if (!s) return structuredClone(DEFAULT_SETTINGS);
    if (!(s.v >= 2)) { s.stylusOnly = true; s.v = 2; } // stylus became the default in v2
    return { ...DEFAULT_SETTINGS, ...s, tools: { ...DEFAULT_SETTINGS.tools, ...s.tools }, widths: { ...DEFAULT_SETTINGS.widths, ...s.widths }, wsel: { ...s.wsel } }; }
  catch { return structuredClone(DEFAULT_SETTINGS); }
};

const TOOLS = [
  ['pen', 'pen', 'Pen (P)'], ['highlighter', 'highlighter', 'Highlighter (H)'], ['eraser', 'eraser', 'Eraser (E)'],
  ['lasso', 'lasso', 'Lasso select (L)'], ['text', 'text', 'Text (T)'], ['hand', 'hand', 'Pan (hold Space)'],
];

/**
 * Open a note in `root`. With split screen, opts (from split.js):
 *   shared   { note, undo, redo, panes }: the same note in both panes. The first pane loads the note into it; the
 *            second edits that same object, with one undo history, and each change redraws the other pane.
 *   isActive () => whether this pane gets the keyboard and paste;  onActivate: called when it's touched
 *   split    { close }: this pane is one side of a split screen; close() leaves only the other side
 */
export async function openEditor(root, noteId, app, opts = {}) {
  const shared = opts.shared || null;
  const peer = !!shared?.note;   // the other pane already has this note open
  const note = peer ? shared.note : await store.getNote(noteId);
  if (!note) { toast('Note not found'); app.go('/'); return null; }

  // Page notes are PDFs now. An older page note (an .inkpad file) is moved into its PDF the first time it's opened:
  // into the PDF it was made from if that is still in the folder, else into a new PDF. Its .inkpad file goes.
  if (!peer && note.kind === 'a4' && !note.pdf) {
    toast('Saving this note as a PDF…', 120000);
    try {
      const pn = await import('./pdfnote.js');
      const id = await pn.moveNoteIntoPdf(note, null, store.hasFile(note.source));
      toast('Saved as a PDF. Your writing is in the PDF now and stays editable here.', 3500);
      app.go(`/note/${id}`);
      return null;
    } catch (err) {
      console.error(err);
      toast('Couldn’t save this note as a PDF; it stays as it was.', 5000);
    }
  }
  const pdfMod = note.pdf ? await import('./pdfnote.js') : null;

  const settings = loadSettings();
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  const a4 = note.kind === 'a4';

  // PDF pages imported by older versions sit inside a fixed A4 page with empty margins (landscape ones squeezed
  // onto a portrait page). Fit each such page to its PDF page: the page becomes the PDF's own shape and everything
  // written on it moves and scales with it, so writing stays where it was on the PDF.
  let fixedPages = false;
  if (a4 && !peer) {
    const bg = new Set(note.layers.filter((l) => l.bg).map((l) => l.id));
    note.pages = note.pages.map((p, pi) => {
      const pdf = p.elements.filter((e) => e.type === 'image' && bg.has(e.layerId));
      if (pdf.length !== 1) return p;
      const e = pdf[0], cur = R.pageSize(p), want = pageSizeFor(e);
      if (Math.abs(e.x) < 1 && Math.abs(e.y) < 1 && Math.abs(cur.w - want.w) < 1 && Math.abs(cur.h - want.h) < 1) return p;
      const k = want.w / e.w;
      const move = (x) => R.scaleElement(R.translate(x, -e.x, -e.y), 0, 0, k);
      note.outline = note.outline.map((o) => (o.page === pi ? { ...o, x: (o.x - e.x) * k, y: (o.y - e.y) * k } : o));
      fixedPages = true;
      return { ...p, ...want, elements: p.elements.map((x) => (x === e ? { ...e, x: 0, y: 0, w: want.w, h: want.h } : move(x))) };
    });
  }

  let tool = 'pen';
  let activeLayer = note.layers[note.layers.length - 1].id;
  let cam = { x: 0, y: 0, z: 1 };
  let dpr = devicePixelRatio || 1, cssW = 0, cssH = 0;
  let action = null;          // current pointer interaction
  let selection = null;       // { page, ids:Set }
  let lifted = new Set();     // element ids hidden from the cached scene
  let editing = null;         // text/cell editor state
  let hover = null;           // screen point for eraser cursor
  let linkRects = [];
  let spaceDown = false;
  let returnTool = null;      // tool to go back to after placing a picture
  let fingerHint = false;
  let sceneDirty = true, raf = 0, saveTimer = 0, destroyed = false;
  let dirty = false;           // content changed since the last save
  let saveWarned = false;
  const thumbOf = { page: null, layers: '' };   // what the library picture was last drawn from
  const undoStack = shared ? shared.undo : [], redoStack = shared ? shared.redo : [];   // one history per note
  const touches = new Map();

  // ---------- DOM ----------
  const el = h(`<div class="editor">
    <header class="etop">
      <div class="grp">
        <button class="icon-btn" data-act="back" title="Library">${icon('back')}</button>
        <input class="title-input" value="${esc(note.title)}" spellcheck="false" />
      </div>
      <div class="grp">
        <button class="icon-btn" data-act="undo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
        <button class="icon-btn" data-act="redo" title="Redo (Ctrl+Y)">${icon('redo')}</button>
      </div>
      <div class="grp tools">${TOOLS.map(([t, ic, tip]) => `<button class="icon-btn tool" data-tool="${t}" title="${tip}">${icon(ic)}</button>`).join('')}
        <button class="icon-btn" data-act="autoshape" title="Auto-shape: hold the pen still at the end of a stroke">${icon('shape')}</button>
        <button class="icon-btn" data-act="image" title="Add a picture, photo or PDF">${icon('image')}</button>
        <button class="icon-btn" data-act="table" title="Insert table">${icon('table')}</button>
      </div>
      <div class="spacer"></div>
      <div class="grp">
        <button class="zoom-btn" data-act="zoom" title="Reset zoom">100%</button>
        <button class="icon-btn" data-act="stylus" title="Stylus only: fingers pan & zoom (palm rejection)">${icon('stylus')}</button>
        <button class="icon-btn" data-act="timer" title="Focus timer">${icon('timer')}</button>
        ${opts.split ? `<button class="icon-btn" data-act="unsplit" title="Close this side">${icon('close')}</button>` : `<button class="icon-btn" data-act="split" title="Split screen">${icon('split')}</button>`}
        ${a4 ? `<button class="icon-btn" data-panel="pages" title="Pages">${icon('pages')}</button>` : ''}
        <button class="icon-btn" data-panel="layers" title="Layers">${icon('layers')}</button>
        <button class="icon-btn" data-panel="outline" title="Outline">${icon('outline')}</button>
        <button class="icon-btn" data-panel="links" title="Links & backlinks">${icon('link')}</button>
        <button class="icon-btn" data-act="export" title="Save as another format">${icon('download')}</button>
      </div>
    </header>
    <div class="ebody">
      <div class="stage"><canvas></canvas><div class="selbar" hidden></div>
        <div class="floatbar"><span class="fb-grip" title="Drag to move">${icon('grip', 16)}</span><div class="grp emode" hidden><button class="seg" data-emode="stroke" title="Erase whole strokes">Whole</button><button class="seg" data-emode="part" title="Erase only what the eraser covers">Part</button></div><div class="grp colors"></div><div class="grp widths"></div></div>
      </div>
      <aside class="panel"></aside>
    </div>
  </div>`);
  root.append(el);
  const stage = el.querySelector('.stage');
  const canvas = stage.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const cache = document.createElement('canvas');
  const cctx = cache.getContext('2d');
  const selbar = stage.querySelector('.selbar');
  const zoomBtn = el.querySelector('[data-act=zoom]');

  // ---------- geometry helpers ----------
  // pages sit one under another, centred on the A4-portrait column; a landscape page is wider than the column
  const sizeOf = (i) => R.pageSize(note.pages[i]);
  function pageOrigin(i) {
    if (!a4) return { x: 0, y: 0 };
    let y = 0;
    for (let k = 0; k < i && k < note.pages.length; k++) y += sizeOf(k).h + R.PAGE_GAP;
    return { x: (R.PAGE_W - sizeOf(i).w) / 2, y };
  }
  const toWorld = (sx, sy) => ({ x: sx / cam.z + cam.x, y: sy / cam.z + cam.y });
  const toScreen = (x, y) => ({ x: (x - cam.x) * cam.z, y: (y - cam.y) * cam.z });
  // where the canvas is on screen; measured on resize and at each pen-down, not on every pointer move (that forces layout)
  let canvasRect = { left: 0, top: 0 };
  const measureCanvas = () => { const r = canvas.getBoundingClientRect(); canvasRect = { left: r.left, top: r.top }; };
  const localPt = (e) => ({ x: e.clientX - canvasRect.left, y: e.clientY - canvasRect.top });
  function pageAt(w, clampToPage = false) {
    if (!a4) return { i: 0, x: w.x, y: w.y };
    const n = note.pages.length;
    let i = -1;
    if (w.y >= 0) {
      let top = 0;
      for (i = 0; i < n; i++) { top += sizeOf(i).h + R.PAGE_GAP; if (w.y < top) break; }
    }
    if (clampToPage) i = Math.max(0, Math.min(n - 1, i));
    if (i < 0 || i >= n) return null;
    const o = pageOrigin(i), s = sizeOf(i), x = w.x - o.x, y = w.y - o.y;
    if (!clampToPage && (x < 0 || x > s.w || y < 0 || y > s.h)) return null;
    return { i, x: Math.max(0, Math.min(s.w, x)), y: Math.max(0, Math.min(s.h, y)) };
  }
  const layerOf = (id) => note.layers.find((l) => l.id === id);
  const editable = (e) => { const l = layerOf(e.layerId); return l && l.visible && !l.locked; };
  const activeLayerObj = () => layerOf(activeLayer);
  const viewCenter = () => pageAt(toWorld(cssW / 2, cssH / 2), true);
  const currentPage = () => viewCenter()?.i ?? 0;

  // ---------- history & persistence ----------
  const snapshot = () => ({
    pages: note.pages.map((p) => ({ ...p, elements: p.elements.slice() })),
    layers: structuredClone(note.layers),
    outline: structuredClone(note.outline),
  });
  function pushHistory() { undoStack.push(snapshot()); if (undoStack.length > 150) undoStack.shift(); redoStack.length = 0; updateButtons(); }
  function restore(s) {
    note.pages = s.pages.map((p) => ({ ...p, elements: p.elements.slice() }));
    note.layers = structuredClone(s.layers);
    note.outline = structuredClone(s.outline);
    if (!layerOf(activeLayer)) activeLayer = note.layers[note.layers.length - 1].id;
    clearSelection();
    changed();
  }
  function undo() { if (!undoStack.length) return; commitEdit(); redoStack.push(snapshot()); restore(undoStack.pop()); updateButtons(); }
  function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); updateButtons(); }

  function changed(scene = true) {
    if (scene) sceneDirty = true;
    requestFrame();
    scheduleSave();
    panels.refresh();
    notifyPeers();
  }
  // the same note in the other pane: show this change there too
  let self = null;
  const notifyPeers = () => { if (shared) for (const p of shared.panes) if (p !== self) p.refresh(); };
  // Writing a note file means turning the whole note (PDF pages included, often many MB) into text and handing it
  // to Android, which stalls the app for a moment. So the file is only written for real changes, after a pause,
  // never in the middle of a stroke; where you scrolled to is kept on the device instead.
  const VIEW_KEY = `inkpad.view.${note.id}`;
  const saveView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(cam)); } catch {} };
  function scheduleSave() { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(save, 1500); }
  async function save(force = false) {
    clearTimeout(saveTimer);
    saveView();
    if (!dirty) return;
    if (action && !force && !destroyed) { saveTimer = setTimeout(save, 800); return; }   // still writing: later
    note.view = { ...cam };
    // only real edits move the note to the top of the library; just opening or panning it doesn't
    if (dirty) {
      note.updatedAt = Date.now();
      // the library picture shows page 1: draw it again only if page 1 (or the layers) changed
      const tk = note.pages[0], lk = note.layers.map((l) => (l.visible ? l.id : '-')).join();
      if (tk !== thumbOf.page || lk !== thumbOf.layers || !note.thumb) {
        try { note.thumb = R.renderPageCanvas(note, 0, { maxW: 260, maxH: 360 }).toDataURL('image/png'); thumbOf.page = tk; thumbOf.layers = lk; } catch {}
      }
    }
    const wasDirty = dirty;
    dirty = false;
    try {
      await store.putNote(note);
      saveWarned = false;
    } catch (err) {
      console.error(err);
      dirty = dirty || wasDirty;
      if (!saveWarned) { saveWarned = true; toast('Couldn’t save this note. Check the notes folder is still available and has free space.', 6000); }
      if (!destroyed && dirty) { clearTimeout(saveTimer); saveTimer = setTimeout(save, 5000); } // keep retrying while open
    }
  }
  // the desk around the pages: dark for dark paper, else it follows the app's theme (the pages never do)
  let desk = '';
  const readDesk = () => { desk = getComputedStyle(document.documentElement).getPropertyValue('--desk').trim() || '#e8e6e1'; };
  readDesk();
  const deskColor = () => (note.paper === 'dark' ? '#121316' : desk);
  const onTheme = () => { readDesk(); sceneDirty = true; requestFrame(); };
  window.addEventListener('inkpad-theme', onTheme);
  const page = (i) => note.pages[i];
  const setElements = (i, els) => { note.pages[i] = { ...note.pages[i], elements: els }; };

  // ---------- rendering ----------
  function requestFrame() { if (!raf && !destroyed) raf = requestAnimationFrame(frame); }
  const worldTransform = (c, v = cam) => c.setTransform(dpr * v.z, 0, 0, dpr * v.z, -v.x * dpr * v.z, -v.y * dpr * v.z);
  // a pen stroke being written goes into the cached scene a few pieces at a time (see R.drawPenPieces), so each
  // frame only draws what is new instead of the whole stroke again
  const livePen = (a) => a?.type === 'draw' && !a.shape && a.el.tool === 'pen';
  function inkIntoCache(a, finish = false) {
    if (tileMode) {
      const t = tiles.get(page(a.page).id);
      if (!t) return false;
      const g = t.ctx, s = sizeOf(a.page), from = a.next || 1;
      g.save();
      g.setTransform(t.scale, 0, 0, t.scale, 0, 0);
      g.beginPath(); g.rect(0, 0, s.w, s.h); g.clip();
      a.next = R.drawPenPieces(g, a.el, from);
      if (finish) R.drawPenTail(g, a.el);
      g.restore();
      if (sharp) {
        cctx.save();
        worldTransform(cctx, sharp);
        withPage(cctx, a.page, () => { R.drawPenPieces(cctx, a.el, from); if (finish) R.drawPenTail(cctx, a.el); });
        cctx.restore();
      }
      return true;
    }
    cctx.save();
    worldTransform(cctx, cacheCam);
    withPage(cctx, a.page, () => {
      a.next = R.drawPenPieces(cctx, a.el, a.next || 1);
      if (finish) R.drawPenTail(cctx, a.el);
    });
    cctx.restore();
    return true;
  }

  // ---------- page pictures (page notes) ----------
  // Each page is drawn once into its own picture at the current zoom. Scrolling then only places those pictures
  // (cheap), so pages are always complete and nothing has to be drawn again when the finger slows down or stops.
  // A page's picture is drawn again only when that page changes, layers change, or the zoom settles somewhere new.
  // Zoomed in very far, a page picture would be too big for memory: then the visible area is drawn instead.
  const TILE_MAX = 3600;     // longest side of a page picture, px
  const TILE_KEEP = 4;       // page pictures kept besides the visible ones
  const tiles = new Map();   // page id → { page, key, scale, canvas, ctx, links, missing, assetVer, used }
  let tileMode = false, tileScale = 0, assetVer = 0, frameNo = 0, prefetchTimer = 0;
  const wantScale = () => cam.z * dpr;
  const useTiles = () => a4;
  // Zoomed in past what a page picture holds, the pictures look soft. They're still what moves while you pinch or
  // scroll (smooth); once you stop, the visible area is drawn sharp at full detail and shown until the view moves.
  let sharp = null, sharpTimer = 0;   // sharp: the camera the sharp view (in `cache`) was drawn for
  const needsSharp = () => { const s = sizeOf(currentPage()); return wantScale() > (TILE_MAX / Math.max(s.w, s.h)) * 1.02; };
  function scheduleSharpen() {
    clearTimeout(sharpTimer);
    sharpTimer = setTimeout(() => {
      if (destroyed || !tileMode || action || !needsSharp()) return;
      renderScene(); cacheCam = { ...cam }; sharp = { ...cam }; sceneDirty = false;
      requestFrame();
    }, 160);
  }
  const layersKey = () => note.layers.map((l) => (l.visible ? l.id : '-')).join(',') + '|' + note.paper + '|' + note.newPaper;
  function dropTile(i) { const t = tiles.get(page(i)?.id); if (t) { t.canvas.width = t.canvas.height = 0; tiles.delete(page(i).id); } }
  function dropTiles() { for (const t of tiles.values()) t.canvas.width = t.canvas.height = 0; tiles.clear(); }
  function tileFor(i, lk = layersKey()) {
    const p = page(i), s = sizeOf(i);
    const scale = Math.min(tileScale, TILE_MAX / Math.max(s.w, s.h));
    const lift = lifted.size && p.elements.some((e) => lifted.has(e.id)) ? [...lifted].join(',') : '';
    const key = `${lk}|${lift}|${scale}`;
    let t = tiles.get(p.id);
    t && (t.used = frameNo);
    if (t && t.page === p && t.key === key && !(t.missing && t.assetVer !== assetVer)) return t;
    const canvas = t?.canvas || document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(s.w * scale)); canvas.height = Math.max(1, Math.round(s.h * scale));
    const g = canvas.getContext('2d', { alpha: false });
    g.setTransform(scale, 0, 0, scale, 0, 0);
    const links = [], miss = R.missing.count;
    R.drawPage(g, note, p, { exclude: lifted, linkRects: links });
    t = { page: p, key, scale, canvas, ctx: g, links, missing: R.missing.count > miss, assetVer, used: frameNo };
    tiles.set(p.id, t);
    if (livePen(action) && action.page === i) action.next = 1;   // the ink written so far goes in again
    return t;
  }
  function frameTiles() {
    frameNo++;
    const useSharp = sharp && !sceneDirty && sharp.x === cam.x && sharp.y === cam.y && sharp.z === cam.z;
    if (!useSharp) { sharp = null; if (!action && needsSharp()) scheduleSharpen(); }
    sceneDirty = false;
    if (useSharp) {
      if (livePen(action)) { tileFor(action.page); inkIntoCache(action); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(cache, 0, 0);
      worldTransform(ctx);
      return;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = deskColor();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    worldTransform(ctx);
    const view = { x: cam.x, y: cam.y, w: cssW / cam.z, h: cssH / cam.z }, lk = layersKey();
    if (livePen(action)) { tileFor(action.page, lk); inkIntoCache(action); }
    linkRects = [];
    const shown = new Set();
    note.pages.forEach((p, i) => {
      const o = pageOrigin(i), s = sizeOf(i);
      if (!R.intersects({ x: o.x, y: o.y, w: s.w, h: s.h }, view)) return;
      const t = tileFor(i, lk);
      shown.add(p.id);
      const d = 1 / cam.z;   // a soft edge under the page, without blur (blur is slow on tablets)
      ctx.fillStyle = 'rgba(0,0,0,.05)'; ctx.fillRect(o.x - 2 * d, o.y - d, s.w + 4 * d, s.h + 5 * d);
      ctx.fillStyle = 'rgba(0,0,0,.08)'; ctx.fillRect(o.x - d, o.y, s.w + 2 * d, s.h + 2.5 * d);
      ctx.drawImage(t.canvas, o.x, o.y, s.w, s.h);
      for (const r of t.links) linkRects.push({ ...r, page: i });
    });
    // forget pictures of pages far away (memory), keeping the most recently used
    const rest = [...tiles.entries()].filter(([id]) => !shown.has(id)).sort((a, b) => b[1].used - a[1].used);
    for (const [id, t] of rest.slice(TILE_KEEP)) { t.canvas.width = t.canvas.height = 0; tiles.delete(id); }
    return shown;
  }
  /** When scrolling pauses, draw the pages just above and below ahead of time, so they're ready when they come in. */
  function prefetchTiles() {
    clearTimeout(prefetchTimer);
    if (!tileMode) return;
    prefetchTimer = setTimeout(() => {
      if (destroyed || action || !tileMode) return;
      const c = currentPage();
      for (const i of [c + 1, c - 1, c + 2]) {
        const p = page(i);
        if (!p) continue;
        const t = tiles.get(p.id);
        if (!t || t.page !== p) { tileFor(i); return prefetchTiles(); }   // one page per pause, then look again
      }
    }, 250);
  }
  let zoomLabel = '';

  function renderScene() {
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.fillStyle = a4 ? (deskColor()) : R.paperOf(note).bg;
    cctx.fillRect(0, 0, cache.width, cache.height);
    worldTransform(cctx);
    const view = { x: cam.x, y: cam.y, w: cssW / cam.z, h: cssH / cam.z };
    linkRects = [];
    note.pages.forEach((p, i) => {
      const o = pageOrigin(i);
      const s = sizeOf(i);
      if (a4 && !R.intersects({ x: o.x, y: o.y, w: s.w, h: s.h }, view)) return;
      cctx.save();
      cctx.translate(o.x, o.y);
      if (a4) {
        cctx.save();
        cctx.shadowColor = 'rgba(0,0,0,.18)'; cctx.shadowBlur = 14; cctx.shadowOffsetY = 3;
        cctx.fillStyle = R.paperOf(note).bg; cctx.fillRect(0, 0, s.w, s.h);
        cctx.restore();
      }
      const lr = [];
      R.drawPage(cctx, note, p, { view: { x: view.x - o.x, y: view.y - o.y, w: view.w, h: view.h }, exclude: lifted, linkRects: lr });
      for (const r of lr) linkRects.push({ ...r, page: i });
      cctx.restore();
    });
  }

  function withPage(c, i, fn) {
    const o = pageOrigin(i);
    c.save();
    c.translate(o.x, o.y);
    if (a4) { const s = sizeOf(i); c.beginPath(); c.rect(0, 0, s.w, s.h); c.clip(); }
    fn();
    c.restore();
  }

  function selectedElements() {
    if (!selection) return [];
    return page(selection.page).elements.filter((e) => selection.ids.has(e.id));
  }

  function frame() {
    raf = 0;
    if (destroyed) return;
    const tm = useTiles();
    if (tm !== tileMode) {
      tileMode = tm; cacheCam = null;
      if (tm) tileScale = wantScale(); else dropTiles();
      if (action?.type === 'draw') action.next = 1;
    }
    if (tileMode) frameTiles();
    else {
    if (sceneDirty || !cacheCam) { renderScene(); sceneDirty = false; cacheCam = { ...cam }; if (action?.type === 'draw') action.next = 1; }
    if (livePen(action)) inkIntoCache(action);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (cacheCam.x === cam.x && cacheCam.y === cam.y && cacheCam.z === cam.z) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(cache, 0, 0);
    } else {
      ctx.fillStyle = a4 ? (deskColor()) : R.paperOf(note).bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const k = cam.z / cacheCam.z;
      ctx.setTransform(k, 0, 0, k, (cacheCam.x - cam.x) * cam.z * dpr, (cacheCam.y - cam.y) * cam.z * dpr);
      ctx.drawImage(cache, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    }
    worldTransform(ctx);

    if (livePen(action)) withPage(ctx, action.page, () => R.drawPenTail(ctx, action.el));
    else if (action?.type === 'draw') withPage(ctx, action.page, () => R.drawElement(ctx, action.shape || action.el));
    if (action?.type === 'move') {
      // not clipped to its page while dragged: it can be carried onto another page
      const o = pageOrigin(selection.page);
      ctx.save();
      ctx.translate(o.x + action.dx, o.y + action.dy);
      for (const e of selectedElements()) R.drawElement(ctx, e);
      ctx.restore();
    }
    if (action?.type === 'resize' || action?.type === 'vertex') withPage(ctx, selection.page, () => {
      for (const e of previewElements()) R.drawElement(ctx, e);
    });
    if (action?.type === 'lasso') withPage(ctx, action.page, () => {
      ctx.save();
      ctx.setLineDash([6 / cam.z, 5 / cam.z]);
      ctx.lineWidth = 1.5 / cam.z;
      ctx.strokeStyle = '#4f46e5';
      ctx.fillStyle = 'rgba(79,70,229,.06)';
      ctx.beginPath();
      action.pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    });
    const pels = selection && action?.type !== 'lasso' ? previewElements() : [];
    const sb = pels.length ? R.unionBounds(pels) : null;
    if (sb) {
      const o = pageOrigin(selection.page), dx = action?.type === 'move' ? action.dx : 0, dy = action?.type === 'move' ? action.dy : 0;
      ctx.save();
      ctx.translate(o.x + dx, o.y + dy);
      ctx.setLineDash([6 / cam.z, 4 / cam.z]);
      ctx.lineWidth = 1.5 / cam.z;
      ctx.strokeStyle = '#4f46e5';
      ctx.strokeRect(sb.x - 4 / cam.z, sb.y - 4 / cam.z, sb.w + 8 / cam.z, sb.h + 8 / cam.z);
      ctx.setLineDash([]);
      // a handle on each corner: drag it to make the selection bigger or smaller
      ctx.fillStyle = '#fff';
      ctx.lineWidth = 2 / cam.z;
      for (const [hx, hy] of cornerHandles(sb)) { ctx.beginPath(); ctx.arc(hx, hy, 7 / cam.z, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      // a shape's own corners: drag one to change the outline
      if (pels.length === 1 && isOutlineShape(pels[0])) {
        ctx.fillStyle = '#4f46e5';
        for (const p of pels[0].pts) { ctx.beginPath(); ctx.arc(p[0], p[1], 5.5 / cam.z, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.restore();
    }
    if ((tool === 'eraser' || action?.held) && hover) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, settings.tools.eraser.width / 2, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.beginPath(); ctx.arc(hover.x, hover.y, settings.tools.eraser.width / 2 + 1, 0, Math.PI * 2); ctx.stroke();
    }
    positionSelbar();
    positionEditor();
    const zl = Math.round(cam.z * 100) + '%';
    if (zl !== zoomLabel) { zoomLabel = zl; zoomBtn.textContent = zl; }
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    dpr = devicePixelRatio || 1;
    cssW = r.width; cssH = r.height;
    for (const c of [canvas, cache]) { c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr); }
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    measureCanvas();
    cam = clampCam(cam);
    placeFloat();
    sceneDirty = true;
    if (tileMode) tileScale = wantScale();
    frame();
  }

  // While panning or zooming, the last full drawing is moved and scaled (cheap); the page is drawn again in full
  // once the movement pauses. Redrawing big PDF pages on every finger move is what made scrolling stutter.
  let cacheCam = null, settleTimer = 0;
  function setCam(c) {
    cam = clampCam(c);
    requestFrame();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 120);
    scheduleSaveView();
  }
  function settle() {
    clearTimeout(settleTimer);
    if (action?.type === 'pinch' || action?.type === 'pan') return;   // fingers still down: wait for them to lift
    {
      if (tileMode) {
        // pages are drawn again only when the zoom has changed enough to make them look soft or too heavy
        const w = wantScale();
        if (Math.abs(w / tileScale - 1) > 0.08) { tileScale = w; requestFrame(); }
        prefetchTiles();
        if (needsSharp()) scheduleSharpen();
      } else { sceneDirty = true; requestFrame(); }
    }
  }

  // Page notes aren't an endless board: zooming out stops when a whole page fits, and panning stops at the
  // edges of the pages (a small margin around them stays visible).
  function docBounds() {
    let x0 = Infinity, x1 = -Infinity, y1 = 0, maxH = 0;
    note.pages.forEach((p, i) => {
      const s = sizeOf(i), ox = (R.PAGE_W - s.w) / 2;
      x0 = Math.min(x0, ox); x1 = Math.max(x1, ox + s.w);
      y1 += s.h + (i ? R.PAGE_GAP : 0); maxH = Math.max(maxH, s.h);
    });
    return { x0, x1, y1, maxH };
  }
  /** The zoom allowed: 10–800 %, and for page notes not smaller than a whole page fitting the screen. */
  function clampZ(z) {
    z = Math.max(0.1, Math.min(8, z));
    if (!a4 || !cssW || !cssH) return z;
    const b = docBounds(), m = 24;
    const zMin = Math.min((cssW - 2 * m) / (b.x1 - b.x0), (cssH - 2 * m) / b.maxH);
    return Math.max(Math.min(zMin, 8), z);
  }
  function clampCam(c) {
    if (!a4 || !cssW || !cssH) return c;
    const b = docBounds(), m = 24;
    const z = clampZ(c.z);
    const vw = cssW / z, vh = cssH / z, mw = m / z, dw = b.x1 - b.x0;
    const x = vw >= dw + 2 * mw ? b.x0 - (vw - dw) / 2 : Math.max(b.x0 - mw, Math.min(b.x1 + mw - vw, c.x));
    const y = vh >= b.y1 + 2 * mw ? -mw : Math.max(-mw, Math.min(b.y1 + mw - vh, c.y));
    return { z, x, y };
  }
  let viewTimer = 0;
  const scheduleSaveView = () => { clearTimeout(viewTimer); viewTimer = setTimeout(saveView, 500); };
  function zoomAt(sx, sy, factor) {
    const w = toWorld(sx, sy);
    const z = clampZ(cam.z * factor);   // limit first: placing the view for a zoom that then gets limited slid the page
    setCam({ z, x: w.x - sx / z, y: w.y - sy / z });
  }
  function fitView() {
    if (a4) {
      const widest = Math.max(R.PAGE_W, ...note.pages.map((p) => R.pageSize(p).w));
      const z = Math.min(1.25, (cssW - 48) / widest);
      setCam({ z, x: -(cssW / z - R.PAGE_W) / 2, y: -24 / z });
    } else setCam({ z: 1, x: 0, y: 0 });
  }
  function goTo(pageIndex, x, y) {
    const o = pageOrigin(pageIndex);
    if (x == null) { // page top
      const z = cam.z;
      setCam({ z, x: a4 ? -(cssW / z - R.PAGE_W) / 2 : cam.x, y: o.y - 24 / z });
    } else setCam({ z: cam.z, x: o.x + x - cssW / 2 / cam.z, y: o.y + y - cssH / 2 / cam.z });
  }

  // ---------- selection ----------
  const HANDLE_OUT = 10;   // screen px the corner handles sit outside the selection box
  const isOutlineShape = (e) => e?.type === 'shape' && e.kind !== 'ellipse';
  const resizeOne = (e, a) => (a.free ? R.stretchElement(e, a.ax, a.ay, a.kx, a.ky) : R.scaleElement(e, a.ax, a.ay, a.kx));
  /** The selection as it looks while a corner or a shape point is being dragged. */
  function previewElements() {
    const els = selectedElements();
    if (action?.type === 'resize') return els.map((e) => resizeOne(e, action));
    if (action?.type === 'vertex') return els.map((e) => (e.id === action.el ? { ...e, pts: e.pts.map((p, k) => (k === action.idx ? [action.x, action.y] : p)) } : e));
    return els;
  }
  /** Corner handles of box b (page coords): [handle x, y, box corner x, y, opposite corner x, y]. */
  function cornerHandles(b) {
    const d = HANDLE_OUT / cam.z, x1 = b.x + b.w, y1 = b.y + b.h;
    return [[b.x - d, b.y - d, b.x, b.y, x1, y1], [x1 + d, b.y - d, x1, b.y, b.x, y1], [b.x - d, y1 + d, b.x, y1, x1, b.y], [x1 + d, y1 + d, x1, y1, b.x, b.y]];
  }
  function selectionBounds() { const els = selectedElements(); return els.length ? R.unionBounds(els) : null; }
  function clearSelection() { if (!selection) return; selection = null; lifted = new Set(); sceneDirty = true; requestFrame(); }

  function positionSelbar() {
    const sb = selectionBounds();
    if (!sb || action) { selbar.hidden = true; return; }
    const o = pageOrigin(selection.page);
    const p = toScreen(o.x + sb.x + sb.w / 2, o.y + sb.y);
    selbar.hidden = false;
    const w = selbar.offsetWidth;
    selbar.style.left = Math.max(8, Math.min(cssW - w - 8, p.x - w / 2)) + 'px';
    selbar.style.top = Math.max(8, p.y - 74) + 'px';   // clear of the top corner handles
  }

  function buildSelbar() {
    const els = selectedElements();
    const single = els.length === 1 ? els[0] : null;
    selbar.innerHTML = `
      <button data-s="color" title="Apply current color"><span class="dot" style="background:${current().color || '#000'}"></span>Recolor</button>
      <button data-s="dup">${icon('copy', 16)}Duplicate</button>
      <button data-s="layer">${icon('layers', 16)}To active layer</button>
      ${single?.type === 'table' ? '<button data-s="row+">+Row</button><button data-s="col+">+Col</button><button data-s="row-">−Row</button><button data-s="col-">−Col</button>' : ''}
      ${single?.type === 'image' || single?.type === 'text' ? '<button data-s="bigger">＋</button><button data-s="smaller">－</button>' : ''}
      <button data-s="del" class="danger">${icon('trash', 16)}Delete</button>`;
  }

  function mutateSelection(fn) {
    if (!selection) return;
    pushHistory();
    const out = [];
    for (const e of page(selection.page).elements) {
      if (!selection.ids.has(e.id)) { out.push(e); continue; }
      const r = fn(e);
      if (Array.isArray(r)) out.push(...r); else if (r) out.push(r);
    }
    setElements(selection.page, out);
    changed();
  }

  /** Move the selection by (dx, dy); dropped with its centre on another page, it goes onto that page. */
  function moveSelection(dx, dy) {
    const sb = selectionBounds();
    if (!sb) return;
    const from = selection.page, o = pageOrigin(from);
    const to = a4 ? pageAt({ x: o.x + sb.x + sb.w / 2 + dx, y: o.y + sb.y + sb.h / 2 + dy }, true).i : from;
    if (to === from) { mutateSelection((x) => R.translate(x, dx, dy)); return; }
    // the same place on the desk, measured from the new page's corner
    const t = pageOrigin(to), kx = o.x + dx - t.x, ky = o.y + dy - t.y;
    pushHistory();
    const moving = page(from).elements.filter((e) => selection.ids.has(e.id));
    setElements(from, page(from).elements.filter((e) => !selection.ids.has(e.id)));
    setElements(to, [...page(to).elements, ...moving.map((x) => R.translate(x, kx, ky))]);
    selection = { ...selection, page: to };
    if (tileMode) { dropTile(from); dropTile(to); }
    changed();
    buildSelbar();
  }

  selbar.addEventListener('pointerdown', (e) => e.stopPropagation());
  selbar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !selection) return;
    const s = b.dataset.s;
    if (s === 'del') { mutateSelection(() => null); clearSelection(); return; }
    if (s === 'dup') {
      const ids = new Set();
      mutateSelection((x) => { const c = { ...R.translate(x, 24, 24), id: uid() }; ids.add(c.id); return [x, c]; });
      selection = { page: selection.page, ids };
    }
    if (s === 'color') mutateSelection((x) => ('color' in x ? { ...x, color: current().color || x.color } : x));
    if (s === 'layer') mutateSelection((x) => ({ ...x, layerId: activeLayer }));
    if (s === 'bigger' || s === 'smaller') {
      const k = s === 'bigger' ? 1.2 : 1 / 1.2;
      mutateSelection((x) => (x.type === 'image' ? { ...x, w: x.w * k, h: x.h * k } : { ...x, size: Math.max(8, Math.round(x.size * k)), w: x.w * k }));
    }
    if (s.startsWith('row') || s.startsWith('col')) mutateSelection((t) => {
      const cells = t.cells.map((r) => r.slice());
      let { rowH, colW } = t;
      if (s === 'row+') { rowH = [...rowH, 36]; cells.push(colW.map(() => '')); }
      if (s === 'col+') { colW = [...colW, 120]; cells.forEach((r) => r.push('')); }
      if (s === 'row-' && rowH.length > 1) { rowH = rowH.slice(0, -1); cells.pop(); }
      if (s === 'col-' && colW.length > 1) { colW = colW.slice(0, -1); cells.forEach((r) => r.pop()); }
      return { ...t, rowH, colW, cells };
    });
    buildSelbar();
    requestFrame();
  });

  // ---------- toolbar ----------
  const current = () => settings.tools[tool] || {};
  function updateToolbar() {
    el.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    el.querySelector('[data-act=autoshape]').classList.toggle('on', settings.autoShape);
    el.querySelector('[data-act=stylus]').classList.toggle('on', settings.stylusOnly);
    const colors = el.querySelector('.colors');
    const t = current();
    colors.hidden = !('color' in t);
    if (!colors.hidden) {
      colors.innerHTML = settings.palette.map((c) => `<button class="swatch ${c.toLowerCase() === t.color.toLowerCase() ? 'on' : ''}" data-color="${c}" style="--c:${c}" title="${c}"></button>`).join('')
        + `<label class="swatch custom" title="Custom color">${icon('palette', 16)}<input type="color" value="${t.color}"></label>`;
    }
    const widths = el.querySelector('.widths');
    const ws = settings.widths[tool];
    widths.hidden = !ws;
    if (ws) {
      const [min, max, step] = SIZE_RANGE[tool];
      widths.innerHTML = `<div class="wpresets"></div>
        <input class="wrange" type="range" min="${min}" max="${max}" step="${step}" value="${t.width}" title="Size">
        <b class="wval"></b>`;
      drawPresets();
    }
    const emode = el.querySelector('.emode');
    emode.hidden = tool !== 'eraser';
    emode.querySelectorAll('[data-emode]').forEach((b) => b.classList.toggle('on', b.dataset.emode === settings.eraserMode));
    el.querySelector('.floatbar').hidden = colors.hidden && widths.hidden && emode.hidden;
    placeFloat();
    canvas.dataset.tool = tool;
    updateButtons();
  }
  function drawPresets() {
    const ws = settings.widths[tool], t = current();
    if (!ws) return;
    const [min, max] = SIZE_RANGE[tool];
    const dot = (w) => Math.round(4 + 18 * Math.min(1, Math.max(0, (w - min) / (max - min)) ** 0.6));
    el.querySelector('.wpresets').innerHTML = ws.map((w, k) => `<button class="wbtn ${w === t.width ? 'on' : ''}" data-width="${w}" data-k="${k}" title="${tool === 'text' ? w + 'px text' : 'Size ' + w}"><span style="width:${dot(w)}px;height:${dot(w)}px"></span></button>`).join('');
    el.querySelector('.wval').textContent = tool === 'text' ? `${t.width}px` : t.width;
  }

  // ---------- floating colour / size bar (drag it by its grip; the place is remembered) ----------
  const floatbar = el.querySelector('.floatbar');
  function placeFloat() {
    if (floatbar.hidden || !stage.clientWidth) return;
    const bw = floatbar.offsetWidth, bh = floatbar.offsetHeight;
    const p = settings.floatPos || { x: (stage.clientWidth - bw) / 2, y: 10 };
    floatbar.style.left = Math.max(4, Math.min(stage.clientWidth - bw - 4, p.x)) + 'px';
    floatbar.style.top = Math.max(4, Math.min(stage.clientHeight - bh - 4, p.y)) + 'px';
  }
  floatbar.querySelector('.fb-grip').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const sx = e.clientX - floatbar.offsetLeft, sy = e.clientY - floatbar.offsetTop;
    const mv = (ev) => { settings.floatPos = { x: ev.clientX - sx, y: ev.clientY - sy }; placeFloat(); };
    const up = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); saveSettings(); };
    grip.addEventListener('pointermove', mv);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  // the size slider sets the tool's size and the preset in use, so the custom size is kept for next time
  floatbar.addEventListener('input', (e) => {
    if (!e.target.classList.contains('wrange')) return;
    const v = Number(e.target.value), t = current(), ws = settings.widths[tool];
    let k = settings.wsel[tool];
    if (!(k >= 0 && k < ws.length)) k = ws.indexOf(t.width);
    if (k < 0) k = ws.reduce((best, w, i) => (Math.abs(w - t.width) < Math.abs(ws[best] - t.width) ? i : best), 0);
    settings.wsel[tool] = k;
    ws[k] = v;
    t.width = v;
    drawPresets();
    requestFrame();
  });
  floatbar.addEventListener('change', (e) => { if (e.target.classList.contains('wrange')) saveSettings(); });
  function updateButtons() {
    el.querySelector('[data-act=undo]').disabled = !undoStack.length;
    el.querySelector('[data-act=redo]').disabled = !redoStack.length;
    el.querySelectorAll('[data-panel]').forEach((b) => b.classList.toggle('on', b.dataset.panel === panels?.tab));
  }
  function setTool(t) {
    returnTool = null;
    commitEdit();
    if (t !== 'lasso') clearSelection();
    tool = t;
    hover = null;
    updateToolbar();
    requestFrame();
  }

  const onBarClick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) return setTool(b.dataset.tool);
    if (b.dataset.emode) { settings.eraserMode = b.dataset.emode; saveSettings(); updateToolbar(); return; }
    if (b.dataset.color) {
      current().color = b.dataset.color; saveSettings(); updateToolbar();
      if (selection) { mutateSelection((x) => ('color' in x ? { ...x, color: b.dataset.color } : x)); buildSelbar(); }
      return;
    }
    if (b.dataset.width) {
      current().width = Number(b.dataset.width);
      settings.wsel[tool] = Number(b.dataset.k);
      saveSettings();
      el.querySelector('.wrange').value = current().width;
      drawPresets(); requestFrame();
      return;
    }
    if (b.dataset.panel) { panels.show(b.dataset.panel); updateButtons(); requestAnimationFrame(resize); return; }
    switch (b.dataset.act) {
      case 'back': return app.go(note.folderId ? `/folder/${note.folderId}` : '/');
      case 'split': return opts.onSplit?.(note);
      case 'unsplit': return opts.split?.close();
      case 'undo': return undo();
      case 'redo': return redo();
      case 'autoshape': settings.autoShape = !settings.autoShape; saveSettings(); updateToolbar(); return toast(`Auto-shape ${settings.autoShape ? 'on — hold still at the end of a stroke' : 'off'}`);
      case 'stylus': settings.stylusOnly = !settings.stylusOnly; saveSettings(); updateToolbar(); return toast(settings.stylusOnly ? 'Stylus writes, fingers pan & zoom' : 'Fingers write too');
      case 'timer': return toggleTimer();
      case 'zoom': return fitView();
      case 'image': return attachMenu(b);
      case 'table': return insertTable();
      case 'export': return saveAs(note, { currentPage: currentPage(), save: () => save(true), print: exportPDF });
    }
  };
  el.querySelector('.etop').addEventListener('click', onBarClick);
  floatbar.addEventListener('click', onBarClick);
  el.querySelector('.colors').addEventListener('input', (e) => {
    if (e.target.type !== 'color') return;
    current().color = e.target.value;
    if (!settings.palette.includes(e.target.value)) settings.palette = [...settings.palette.slice(0, 7), e.target.value];
    saveSettings();
  });
  el.querySelector('.colors').addEventListener('change', () => updateToolbar());
  const titleInput = el.querySelector('.title-input');
  if (note.pdf) { titleInput.readOnly = true; titleInput.title = `${note.pdf} — rename it from the library`; }
  titleInput.addEventListener('change', () => { note.title = titleInput.value.trim() || 'Untitled'; titleInput.value = note.title; scheduleSave(); panels.refresh(); });
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleInput.blur(); e.stopPropagation(); });

  // ---------- inserting ----------
  function insertPoint() { const c = viewCenter(); return c || { i: 0, x: 100, y: 100 }; }
  function requireLayer() { const l = activeLayerObj(); if (!l.visible || l.locked) { toast(`“${l.name}” is ${l.locked ? 'locked' : 'hidden'}`); return false; } return true; }
  function addElement(i, elmt, scene = true) { pushHistory(); setElements(i, [...page(i).elements, elmt]); changed(scene); }

  /** Insert pictures, PDFs and/or documents (Word, PowerPoint, Excel…) read from the device. `at` = page point (drop position) or view centre. */
  async function insertFiles(files, at) {
    files = [...files];
    const imgs = files.filter(isImage), pdfs = files.filter(isPdf);
    const docs = files.filter((f) => !isImage(f) && !isPdf(f) && isDocument(f));
    if (!imgs.length && !pdfs.length && !docs.length) return toast('Only pictures, PDFs and documents (Word, PowerPoint, Excel, text) can be added to a note');
    // Word, PowerPoint, Excel…: made into a PDF first, then its pages are added like a PDF's
    for (const f of docs) {
      try { pdfs.push(await convertDocument(f)); }
      catch (e) { console.error(e); toast(`Couldn’t open ${f.name}`, 4000); }
    }
    if (imgs.length) {
      if (!requireLayer()) return;
      const p = at || insertPoint();
      const ids = new Set();
      const added = [];
      for (const [k, f] of imgs.entries()) {
        let im;
        try { im = await readImage(f); } catch { toast(`Couldn’t read ${f.name}`); continue; }
        const ps = sizeOf(p.i);
        const maxW = a4 ? ps.w * 0.7 : 480;
        const w = Math.min(maxW, im.w), hh = (w * im.h) / im.w;
        let x = p.x - w / 2 + k * 28, y = p.y - hh / 2 + k * 28;
        if (a4) { x = Math.max(0, Math.min(ps.w - w, x)); y = Math.max(0, Math.min(ps.h - hh, y)); }
        const elmt = { id: uid(), type: 'image', layerId: activeLayer, x, y, w, h: hh, src: im.src };
        ids.add(elmt.id); added.push(elmt);
      }
      if (added.length) {
        pushHistory();
        setElements(p.i, [...page(p.i).elements, ...added]);
        changed();
        const prev = tool;
        setTool('lasso');
        if (prev !== 'lasso') returnTool = prev;
        selection = { page: p.i, ids }; buildSelbar(); requestFrame();
        toast(`${added.length > 1 ? `Added ${added.length} pictures` : 'Picture added'} — drag to move, corner to resize${returnTool ? ', then keep writing' : ''}`, 3500);
      }
    }
    for (const f of pdfs) {
      let pages;
      try { pages = await readPdf(f, (i, n) => toast(`Reading ${f.name}… page ${i} of ${n}`, 60000)); }
      catch (e) { console.error(e); toast(`Couldn’t open ${f.name}`); continue; }
      if (!pages) continue;
      // a PDF note: the added PDF's own pages are copied into this PDF when it is saved (a merge)
      const ext = pdfMod ? await pdfMod.stashPdf(f) : null;
      pushHistory();
      const bg = ensureBackgroundLayer(note);
      if (a4) {
        const after = currentPage();
        note.pages.splice(after + 1, 0, ...pages.map((pg, k) => ({ ...pdfNotePage(pg, bg), ...(ext ? { ext: { key: ext, page: k } } : {}) })));
        changed(); goTo(after + 1);
      } else {
        const p = at || insertPoint();
        let y = p.y;
        const els = pages.map((pg) => { const w = 700, hh = (w * pg.h) / pg.w; const e = { id: uid(), type: 'image', layerId: bg, x: p.x - w / 2, y, w, h: hh, src: pg.src }; y += hh + 32; return e; });
        setElements(0, [...page(0).elements, ...els]);
        changed();
      }
      toast(`Added ${pages.length} PDF page${pages.length === 1 ? '' : 's'} — write on top; they sit on the locked “PDF” layer`, 4000);
    }
  }

  async function takePhoto() {
    const f = await pickFile('image/*', { capture: 'environment', multiple: true });
    if (f.length) insertFiles(f);
  }

  async function attachMenu(anchor) {
    menu(anchor, [
      { label: 'Pictures from this device', icon: 'image', action: async () => { const f = await pickFile('image/*', { multiple: true }); if (f.length) insertFiles(f); } },
      { label: 'Take a photo', icon: 'camera', action: takePhoto },
      { label: 'PDF or document from this device', icon: 'pages', action: async () => { const f = await pickFile(ACCEPT_DOCS, { multiple: true }); if (f.length) insertFiles(f); } },
    ]);
  }

  async function insertTable() {
    if (!requireLayer()) return;
    const r = await modal({ title: 'Insert table', fields: [{ name: 'rows', label: 'Rows', type: 'number', value: 3, min: 1, max: 30 }, { name: 'cols', label: 'Columns', type: 'number', value: 3, min: 1, max: 12 }], ok: 'Insert' });
    if (!r) return;
    const rows = Math.max(1, Math.min(30, r.rows || 3)), cols = Math.max(1, Math.min(12, r.cols || 3));
    const p = insertPoint();
    const colW = Array(cols).fill(Math.min(140, Math.floor(600 / cols))), rowH = Array(rows).fill(36);
    const t = { id: uid(), type: 'table', layerId: activeLayer, x: p.x - colW.reduce((a, b) => a + b) / 2, y: p.y - rows * 18, colW, rowH, cells: Array.from({ length: rows }, () => Array(cols).fill('')), color: settings.tools.text.color, size: 15 };
    addElement(p.i, t);
    toast('Use the Text tool to type into cells');
  }

  // ---------- text editing ----------
  function startEdit(state) {
    commitEdit();
    editing = state;
    const ta = document.createElement('textarea');
    ta.className = 'text-edit' + (state.kind === 'cell' ? ' cell' : '');
    ta.value = state.kind === 'cell' ? state.table.cells[state.r][state.c] : state.el.text;
    ta.spellcheck = true;
    editing.ta = ta;
    if (state.kind === 'text' && !state.isNew) { lifted = new Set([state.el.id]); sceneDirty = true; }
    stage.append(ta);
    positionEditor();
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); commitEdit(); }
      if (e.key === 'Tab' && editing?.kind === 'cell') { // jump to next cell
        e.preventDefault();
        const { r, c, table, page: pi } = editing;
        commitEdit();
        const t = page(pi).elements.find((x) => x.id === table.id);
        let nc = c + (e.shiftKey ? -1 : 1), nr = r;
        if (nc >= t.colW.length) { nc = 0; nr++; } if (nc < 0) { nc = t.colW.length - 1; nr--; }
        if (nr >= 0 && nr < t.rowH.length) startEdit({ kind: 'cell', page: pi, table: t, r: nr, c: nc });
      }
    });
    ta.addEventListener('input', () => { positionEditor(); });
    ta.addEventListener('blur', () => setTimeout(() => { if (editing?.ta === ta) commitEdit(); }, 0));
    requestFrame();
    setTimeout(() => ta.focus(), 0);
  }

  function positionEditor() {
    if (!editing) return;
    const { ta } = editing;
    const o = pageOrigin(editing.page);
    let x, y, w, size, color;
    if (editing.kind === 'cell') {
      const t = editing.table;
      x = t.x + t.colW.slice(0, editing.c).reduce((a, b) => a + b, 0);
      y = t.y + t.rowH.slice(0, editing.r).reduce((a, b) => a + b, 0);
      w = t.colW[editing.c]; size = t.size; color = t.color;
      ta.style.minHeight = t.rowH[editing.r] * cam.z + 'px';
      ta.style.padding = `${5 * cam.z}px ${6 * cam.z}px`;
      ta.style.background = R.paperOf(note).bg;
    } else ({ x, y, w, size, color } = editing.el);
    const s = toScreen(o.x + x, o.y + y);
    Object.assign(ta.style, { left: s.x + 'px', top: s.y + 'px', width: w * cam.z + 'px', fontSize: size * cam.z + 'px', lineHeight: Math.round(size * 1.35) * cam.z + 'px', color });
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function commitEdit() {
    if (!editing) return;
    const st = editing;
    editing = null;
    const text = st.ta.value;
    st.ta.remove();
    lifted = selection ? lifted : new Set();
    if (st.kind === 'cell') {
      if (text !== st.table.cells[st.r][st.c]) {
        pushHistory();
        setElements(st.page, page(st.page).elements.map((e) => {
          if (e.id !== st.table.id) return e;
          const cells = e.cells.map((r) => r.slice());
          cells[st.r][st.c] = text;
          // the row grows to fit the text typed into it
          const need = R.layoutText({ type: 'text', x: 0, y: 0, w: e.colW[st.c] - 12, size: e.size, text }).height + 10;
          const rowH = need > e.rowH[st.r] ? e.rowH.map((h, k) => (k === st.r ? need : h)) : e.rowH;
          return { ...e, cells, rowH };
        }));
        changed();
      }
    } else if (!text.trim()) {
      if (!st.isNew) { pushHistory(); setElements(st.page, page(st.page).elements.filter((e) => e.id !== st.el.id)); changed(); }
    } else if (st.isNew) addElement(st.page, { ...st.el, text });
    else if (text !== st.el.text) {
      pushHistory();
      setElements(st.page, page(st.page).elements.map((e) => (e.id === st.el.id ? { ...e, text } : e)));
      changed();
    }
    sceneDirty = true;
    requestFrame();
  }

  function topHit(i, x, y, r, pred = () => true) {
    const els = page(i).elements;
    const order = new Map(note.layers.map((l, k) => [l.id, k]));
    let best = null;
    for (let k = els.length - 1; k >= 0; k--) {
      const e = els[k];
      if (!editable(e) || !pred(e) || !R.hit(e, x, y, r)) continue;
      if (!best || order.get(e.layerId) > order.get(best.layerId)) best = e;
    }
    return best;
  }

  // ---------- pointer input ----------
  function linkAt(sp) {
    const w = toWorld(sp.x, sp.y);
    for (const r of linkRects) {
      const o = pageOrigin(r.page);
      if (w.x >= o.x + r.x && w.x <= o.x + r.x + r.w && w.y >= o.y + r.y && w.y <= o.y + r.y + r.h) return r.title;
    }
    return null;
  }

  function cancelAction() {
    if (!action) return;
    clearTimeout(action.hold);
    clearTimeout(action.lp);
    clearTimeout(action.erh);
    if (action.held) updateToolbar();
    if (action.type === 'tableBorder' && action.pushed) changed();   // keep the new size and save it
    if (action.type === 'move' || action.type === 'resize' || action.type === 'vertex') { lifted = new Set(); sceneDirty = true; }
    action = null;
    requestFrame();
  }

  function simPressure(prev, dist, dt) {
    const speed = dt > 0 ? (dist * cam.z) / dt : 0; // screen px per ms
    const target = Math.max(0.2, Math.min(0.75, 0.72 - speed * 0.12));
    return prev == null ? 0.5 : prev * 0.75 + target * 0.25;
  }

  function onDown(e) {
    measureCanvas();
    const sp = localPt(e);
    if (e.pointerType === 'pen' && !localStorage.getItem(PEN_SEEN_KEY)) {
      localStorage.setItem(PEN_SEEN_KEY, '1');
      if (!settings.stylusOnly) { settings.stylusOnly = true; saveSettings(); updateToolbar(); toast('Stylus detected — fingers now pan & zoom', 3000); }
    }
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, sp);
      if (touches.size === 2) {
        cancelAction();
        const [a, b] = [...touches.values()];
        action = { type: 'pinch', mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
        return;
      }
      if (touches.size > 2) return;
    }
    if (editing) { commitEdit(); if (tool === 'text') return; }
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
    // a selected picture (or other selection) moves / resizes with any finger, stylus or mouse, whatever the tool
    if (selection && e.button === 0 && !spaceDown) {
      // the pen writing inside a shape it just drew must not drag the shape: only its handles react then
      const g = grabSelection(toWorld(sp.x, sp.y), e, !(selection.auto && (tool === 'pen' || tool === 'highlighter')));
      if (g) { action = g; lifted = new Set(selection.ids); sceneDirty = true; requestFrame(); return; }
    }
    // a table's lines can be dragged to make a column wider or a row taller — except by the pen while it writes
    if (e.button === 0 && !spaceDown && !(INK_TOOLS.has(tool) && pointerWrites(e))) {
      const b = tableBorderAt(toWorld(sp.x, sp.y), e);
      if (b) { clearSelection(); action = { type: 'tableBorder', id: e.pointerId, ...b, pushed: false }; requestFrame(); return; }
    }
    const nav = tool === 'hand' || spaceDown || e.button === 1 || e.button === 2 || (e.pointerType === 'touch' && settings.stylusOnly && STYLUS_TOOLS.has(tool));
    if (selection && !nav && tool !== 'lasso') clearSelection();
    startDown(e, sp, nav);
    // press and hold on a picture to select it, then drag to move it
    if (action && action.id === e.pointerId && e.button === 0 && ['pan', 'draw', 'lasso'].includes(action.type) && !action.lp && !spaceDown) {
      const hit = holdTarget(toWorld(sp.x, sp.y), e.pointerType === 'touch');
      if (hit) { const a = action; a.cur = a.lpStart = sp; a.lp = setTimeout(() => longPress(a, hit), LONG_PRESS_MS); clearTimeout(a.erh); }   // on a picture, holding selects it
    }
  }

  // ---------- tables: drag lines to resize columns and rows ----------
  const INK_TOOLS = new Set(['pen', 'highlighter', 'eraser']);
  /** Does this pointer write with the ink tools? The stylus and mouse do; a finger only when "stylus only" is off. */
  const pointerWrites = (e) => e.pointerType !== 'touch' || !settings.stylusOnly;
  /** The table line under world point w: { page, tid, kind: 'col'|'row', idx, start, orig }. */
  function tableBorderAt(w, e) {
    const pg = pageAt(w);
    if (!pg) return null;
    const tol = (e.pointerType === 'touch' ? 14 : e.pointerType === 'pen' ? 9 : 6) / cam.z;
    let best = null, bd = tol;
    for (const t of page(pg.i).elements) {
      if (t.type !== 'table' || !editable(t)) continue;
      const { w: tw, h: th } = R.tableSize(t);
      if (pg.x < t.x - tol || pg.x > t.x + tw + tol || pg.y < t.y - tol || pg.y > t.y + th + tol) continue;
      let x = t.x;
      t.colW.forEach((cw, i) => { x += cw; const d = Math.abs(pg.x - x); if (d < bd) { bd = d; best = { page: pg.i, tid: t.id, kind: 'col', idx: i, start: pg.x, orig: t.colW.slice() }; } });
      let y = t.y;
      t.rowH.forEach((rh, i) => { y += rh; const d = Math.abs(pg.y - y); if (d < bd) { bd = d; best = { page: pg.i, tid: t.id, kind: 'row', idx: i, start: pg.y, orig: t.rowH.slice() }; } });
    }
    return best;
  }
  function dragTableBorder(a, w) {
    const o = pageOrigin(a.page);
    const d = (a.kind === 'col' ? w.x - o.x : w.y - o.y) - a.start;
    const sizes = a.orig.slice();
    sizes[a.idx] = Math.max(a.kind === 'col' ? 24 : 18, a.orig[a.idx] + d);
    if (!a.pushed) { if (Math.abs(d) < 0.5) return; pushHistory(); a.pushed = true; }
    setElements(a.page, page(a.page).elements.map((x) => (x.id === a.tid ? { ...x, [a.kind === 'col' ? 'colW' : 'rowH']: sizes } : x)));
    sceneDirty = true;
    requestFrame();
  }

  /** What pressing at w does to the selection: drag a shape point, a corner (resize), or the whole (move). */
  function grabSelection(w, e, allowMove = true) {
    const sb = selectionBounds();
    if (!sb) return null;
    const o = pageOrigin(selection.page), x = w.x - o.x, y = w.y - o.y;
    const els = selectedElements();
    let best = null, bd = (e.pointerType === 'mouse' ? 11 : 24) / cam.z;
    if (els.length === 1 && isOutlineShape(els[0])) els[0].pts.forEach((p, idx) => {
      const d = Math.hypot(x - p[0], y - p[1]);
      if (d <= bd) { bd = d; best = { type: 'vertex', id: e.pointerId, el: els[0].id, idx, x: p[0], y: p[1], sx: x - p[0], sy: y - p[1] }; }
    });
    for (const [hx, hy, cx, cy, ax, ay] of cornerHandles(sb)) {
      const d = Math.hypot(x - hx, y - hy);
      // one shape can be stretched freely (wider, taller); anything else keeps its proportions
      if (d < bd) { bd = d; best = { type: 'resize', id: e.pointerId, cx, cy, ax, ay, px: x, py: y, kx: 1, ky: 1, free: els.length === 1 && els[0].type === 'shape' }; }
    }
    if (best) return best;
    const pad = (e.pointerType === 'touch' ? 14 : 8) / cam.z;
    if (allowMove && x >= sb.x - pad && x <= sb.x + sb.w + pad && y >= sb.y - pad && y <= sb.y + sb.h + pad) return { type: 'move', id: e.pointerId, start: w, dx: 0, dy: 0 };
    return null;
  }
  // Press and hold selects: a finger picks any element except text (text is selected with the stylus and the
  // lasso); a stylus or mouse picks pictures only, since holding the pen still is also how auto-shape works.
  function holdTarget(w, finger) {
    const pg = pageAt(w);
    const el2 = pg && (finger ? topHit(pg.i, pg.x, pg.y, 12 / cam.z, (x) => x.type !== 'text') : topHit(pg.i, pg.x, pg.y, 0, (x) => x.type === 'image'));
    return el2 ? { i: pg.i, el: el2 } : null;
  }
  let eraseHintShown = false;
  /** The stylus was held still where a stroke started: erase with it from here until it's lifted (the tool stays). */
  function holdToErase(a) {
    if (action !== a) return;
    clearTimeout(a.hold); clearTimeout(a.lp);
    if (tileMode && (a.next || 1) > 1) dropTile(a.page);   // the few dots of ink written so far go away
    const w = toWorld(a.sp0.x, a.sp0.y);
    action = { type: 'erase', id: a.id, last: w, pushed: false, held: true };
    hover = a.sp0;
    el.querySelector('[data-tool=eraser]')?.classList.add('on');
    navigator.vibrate?.(25);
    if (!eraseHintShown) { eraseHintShown = true; toast('Eraser — lift the stylus to go back', 1600); }
    eraseAt(w);
    sceneDirty = true;
    requestFrame();
  }

  function longPress(a, hit) {
    if (action !== a) return;
    clearTimeout(a.hold);
    canvas.classList.remove('panning');
    selection = { page: hit.i, ids: new Set([hit.el.id]) };
    action = { type: 'move', id: a.id, start: toWorld(a.cur.x, a.cur.y), dx: 0, dy: 0 };
    lifted = new Set(selection.ids);
    sceneDirty = true;
    buildSelbar();
    requestFrame();
    navigator.vibrate?.(25);
    toast(`${hit.el.type === 'image' ? 'Picture' : hit.el.type === 'table' ? 'Table' : 'Drawing'} selected: drag to move, drag a corner to resize`, 2200);
  }

  function startDown(e, sp, nav) {
    if (nav && e.pointerType === 'touch' && settings.stylusOnly && !fingerHint && !localStorage.getItem(PEN_SEEN_KEY) && (tool === 'pen' || tool === 'highlighter')) {
      fingerHint = true;
      toast('Fingers move the page. No stylus? Tap the stylus button in the toolbar to write with your finger.', 5000);
    }
    if (nav) { action = { type: 'pan', id: e.pointerId, last: sp, start: sp, touch: e.pointerType === 'touch' }; canvas.classList.add('panning'); return; }
    if (e.button !== 0) return;
    const w = toWorld(sp.x, sp.y);

    if (tool === 'pen' || tool === 'highlighter') {
      const pg = pageAt(w);
      if (!pg) return;
      if (!requireLayer()) return;
      const t = settings.tools[tool];
      const pr = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
      action = { type: 'draw', id: e.pointerId, page: pg.i, pen: e.pointerType === 'pen', t: e.timeStamp, sp0: sp, el: { id: uid(), type: 'stroke', tool, layerId: activeLayer, color: t.color, width: t.width, points: [[round(pg.x), round(pg.y), pr]] } };
      // press and hold the stylus still: it becomes the eraser until it's lifted
      if (e.pointerType === 'pen') { const a = action; a.erh = setTimeout(() => holdToErase(a), LONG_PRESS_MS); }
      armHold();
      requestFrame();
    } else if (tool === 'eraser') {
      action = { type: 'erase', id: e.pointerId, last: w, pushed: false };
      eraseAt(w);
    } else if (tool === 'lasso') {
      if (returnTool) { setTool(returnTool); return onDown(e); } // picture placed: writing outside it picks the pen back up
      clearSelection();
      const pg = pageAt(w, true);
      action = { type: 'lasso', id: e.pointerId, page: pg.i, start: sp, pts: [[pg.x, pg.y]] };
    } else if (tool === 'text') {
      // a finger drags the page; a tap (no drag) puts the text box there
      if (e.pointerType === 'touch') { action = { type: 'pan', id: e.pointerId, last: sp, start: sp, tapText: true }; return; }
      textAt(sp);
    }
  }

  /** The table cell at screen point sp, as an editing state for startEdit, or null. */
  function cellAt(sp) {
    const pg = pageAt(toWorld(sp.x, sp.y));
    const t = pg && topHit(pg.i, pg.x, pg.y, 0, (x) => x.type === 'table');
    const c = t && R.tableCellAt(t, pg.x, pg.y);
    return c ? { kind: 'cell', page: pg.i, table: t, r: c.r, c: c.c } : null;
  }

  /** Text tool at screen point sp: edit the text or table cell there, or start a new text box. */
  function textAt(sp) {
    {
      const pg = pageAt(toWorld(sp.x, sp.y));
      if (!pg) return;
      const hitEl = topHit(pg.i, pg.x, pg.y, 2, (x) => x.type === 'text' || x.type === 'table');
      if (hitEl?.type === 'table') {
        const cell = R.tableCellAt(hitEl, pg.x, pg.y);
        if (cell) startEdit({ kind: 'cell', page: pg.i, table: hitEl, r: cell.r, c: cell.c });
      } else if (hitEl) startEdit({ kind: 'text', page: pg.i, el: hitEl, isNew: false });
      else if (requireLayer()) {
        const t = settings.tools.text;
        const width = Math.min(360, (a4 ? sizeOf(pg.i).w - pg.x - 24 : 360));
        startEdit({ kind: 'text', page: pg.i, isNew: true, el: { id: uid(), type: 'text', layerId: activeLayer, x: pg.x, y: pg.y - t.width * 0.6, w: Math.max(80, width), size: t.width, color: t.color, text: '' } });
      }
    }
  }

  const round = (v) => Math.round(v * 100) / 100;

  function armHold() {
    if (!action || action.type !== 'draw') return;
    clearTimeout(action.hold);
    if (!settings.autoShape || tool !== 'pen' || action.shape) return;
    const a = action;
    a.hold = setTimeout(() => {
      if (action !== a) return;
      const s = recognize(a.el.points);
      if (s) { a.shape = { id: a.el.id, type: 'shape', layerId: a.el.layerId, color: a.el.color, width: a.el.width * 1.1, ...s }; sceneDirty = true; if (tileMode) dropTile(a.page); requestFrame(); }   // the scene drops the stroke's ink
    }, 550);
  }

  function onMove(e) {
    const sp = localPt(e);
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, sp);
    if (!action) {
      if (tool === 'eraser' && e.pointerType !== 'touch') { hover = sp; requestFrame(); }
      if (e.pointerType === 'mouse') {
        const b = !INK_TOOLS.has(tool) && tableBorderAt(toWorld(sp.x, sp.y), e);
        canvas.style.cursor = b ? (b.kind === 'col' ? 'col-resize' : 'row-resize') : '';
      }
      return;
    }
    if (action.type === 'pinch') {
      if (touches.size < 2) return;
      const [a, b] = [...touches.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist = Math.hypot(a.x - b.x, a.y - b.y);
      const w = toWorld(action.mid.x, action.mid.y);
      const z = clampZ(cam.z * (dist / (action.dist || dist)));
      setCam({ z, x: w.x - mid.x / z, y: w.y - mid.y / z });
      action.mid = mid; action.dist = dist;
      return;
    }
    if (e.pointerId !== action.id) return;
    if (action.lp) {
      action.cur = sp;
      if (Math.hypot(sp.x - action.lpStart.x, sp.y - action.lpStart.y) > 10) { clearTimeout(action.lp); action.lp = 0; }
    }
    if (action.type === 'pan') {
      setCam({ ...cam, x: cam.x - (sp.x - action.last.x) / cam.z, y: cam.y - (sp.y - action.last.y) / cam.z });
      action.last = sp;
      return;
    }
    if (action.type === 'draw') {
      if (action.shape) return;
      if (action.erh && Math.hypot(sp.x - action.sp0.x, sp.y - action.sp0.y) > 8) { clearTimeout(action.erh); action.erh = 0; }   // moving: it's writing
      const o = pageOrigin(action.page);
      const co = e.getCoalescedEvents?.();
      const evs = co?.length ? co : [e];
      const pts = action.el.points;
      let moved = false;
      for (const ev of evs) {
        const q = localPt(ev), w = toWorld(q.x, q.y);
        let x = w.x - o.x, y = w.y - o.y;
        if (a4) { const s = sizeOf(action.page); x = Math.max(0, Math.min(s.w, x)); y = Math.max(0, Math.min(s.h, y)); }
        const last = pts[pts.length - 1];
        const d = Math.hypot(x - last[0], y - last[1]);
        if (d < 0.7 / cam.z) continue;
        const pr = action.pen && ev.pressure > 0 ? last[2] * 0.4 + ev.pressure * 0.6 : simPressure(last[2], d, ev.timeStamp - action.t);
        action.t = ev.timeStamp;
        pts.push([round(x), round(y), Math.round(pr * 1000) / 1000]);
        if (d * cam.z > 1.5) moved = true;
      }
      if (moved) armHold();
      requestFrame();
      return;
    }
    if (action.type === 'erase') {
      const w = toWorld(sp.x, sp.y);
      const r = settings.tools.eraser.width / 2 / cam.z;
      const d = Math.hypot(w.x - action.last.x, w.y - action.last.y);
      // partial erasing steps closer together, so the cut edge is smooth instead of scalloped
      const steps = Math.max(1, Math.ceil(d / (settings.eraserMode === 'part' ? r / 2 : r)));
      for (let k = 1; k <= steps; k++) eraseAt({ x: action.last.x + ((w.x - action.last.x) * k) / steps, y: action.last.y + ((w.y - action.last.y) * k) / steps });
      action.last = w;
      hover = sp;
      requestFrame();
      return;
    }
    if (action.type === 'lasso') {
      const o = pageOrigin(action.page), w = toWorld(sp.x, sp.y);
      action.pts.push([w.x - o.x, w.y - o.y]);
      requestFrame();
      return;
    }
    if (action.type === 'resize') {
      const o = pageOrigin(selection.page), w = toWorld(sp.x, sp.y), a = action;
      // where the dragged corner is now; the opposite corner stays put
      const nx = a.cx + (w.x - o.x - a.px), ny = a.cy + (w.y - o.y - a.py);
      const vx = a.cx - a.ax, vy = a.cy - a.ay;
      if (a.free) {
        a.kx = Math.abs(vx) > 1 ? Math.max(0.05, (nx - a.ax) / vx) : 1;
        a.ky = Math.abs(vy) > 1 ? Math.max(0.05, (ny - a.ay) / vy) : 1;
      } else a.kx = a.ky = Math.max(0.05, ((nx - a.ax) * vx + (ny - a.ay) * vy) / (vx * vx + vy * vy || 1));
      requestFrame();
      return;
    }
    if (action.type === 'tableBorder') { dragTableBorder(action, toWorld(sp.x, sp.y)); return; }
    if (action.type === 'vertex') {
      const o = pageOrigin(selection.page), w = toWorld(sp.x, sp.y);
      action.x = w.x - o.x - action.sx; action.y = w.y - o.y - action.sy;
      requestFrame();
      return;
    }
    if (action.type === 'move') {
      const w = toWorld(sp.x, sp.y);
      action.dx = w.x - action.start.x; action.dy = w.y - action.start.y;
      requestFrame();
    }
  }

  function eraseAt(w) {
    const pg = pageAt(w);
    if (!pg) return;
    const r = settings.tools.eraser.width / 2 / cam.z;
    const els = page(pg.i).elements;
    // The eraser removes ink (strokes and shapes); text, images and tables are deleted via lasso.
    const inkEl = (e) => (e.type === 'stroke' || e.type === 'shape') && editable(e);
    let keep, touched = false;
    if (settings.eraserMode === 'part') {
      // cut away only what's under the eraser; the pieces left take the stroke's place, so the drawing order stays
      keep = [];
      for (const e of els) {
        const rest = inkEl(e) ? R.eraseFrom(e, pg.x, pg.y, r, uid) : null;
        if (rest) { touched = true; keep.push(...rest); } else keep.push(e);
      }
    } else {
      keep = els.filter((e) => !(inkEl(e) && R.hit(e, pg.x, pg.y, r)));
      touched = keep.length !== els.length;
    }
    if (touched) {
      if (!action.pushed) { pushHistory(); action.pushed = true; }
      setElements(pg.i, keep);
      sceneDirty = true;
      scheduleSave();
      requestFrame();
    }
  }

  function onUp(e) {
    if (e.pointerType === 'touch') touches.delete(e.pointerId);
    if (!action) return;
    if (action.type === 'pinch') { if (touches.size < 2) { action = null; settle(); } return; }
    if (e.pointerId !== action.id) return;
    const a = action;
    action = null;
    clearTimeout(a.hold);
    clearTimeout(a.lp);
    clearTimeout(a.erh);
    canvas.classList.remove('panning');
    const sp = localPt(e);

    if (a.type === 'pan') {
      settle();
      if (a.tapText && Math.hypot(sp.x - a.start.x, sp.y - a.start.y) < 8) {
        textAt(sp);
        editing?.ta.focus();   // focus during the tap itself: Android only shows the keyboard then
      } else if (Math.hypot(sp.x - a.start.x, sp.y - a.start.y) < 5) {
        const t = linkAt(sp);
        const cell = !t && a.touch && settings.stylusOnly && cellAt(sp);
        if (t) app.openByTitle(t, note);
        else if (cell) { clearSelection(); startEdit(cell); editing?.ta.focus(); }   // a finger tap in a table: type there
        else if (selection) { if (returnTool) setTool(returnTool); else clearSelection(); }   // tap elsewhere: done editing the picture
      }
    } else if (a.type === 'draw') {
      // a pen stroke on the top layer is already in the cached scene where a full redraw would put it: just finish
      // its end there instead of drawing the whole page again
      const top = a.el.layerId === note.layers[note.layers.length - 1].id;
      if (livePen(a) && top && (tileMode || (!sceneDirty && cacheCam)) && inkIntoCache(a, true)) {
        addElement(a.page, a.el, false);
        const t = tileMode && tiles.get(page(a.page).id);
        if (t) t.page = page(a.page);   // the picture already shows the new page
      } else { if (tileMode) dropTile(a.page); addElement(a.page, a.shape || a.el); }
      // a recognised shape is selected right away: drag its corners or points to fix it, or just keep writing
      if (a.shape) { selection = { page: a.page, ids: new Set([a.shape.id]), auto: true }; buildSelbar(); }
    } else if (a.type === 'erase') {
      if (a.pushed) changed();
      if (a.held) { hover = null; updateToolbar(); }
    } else if (a.type === 'lasso') {
      if (Math.hypot(sp.x - a.start.x, sp.y - a.start.y) < 6) {
        const t = linkAt(sp);
        if (t) app.openByTitle(t, note);
        else { // tap-select a single element
          const pg = pageAt(toWorld(sp.x, sp.y));
          const hitEl = pg && topHit(pg.i, pg.x, pg.y, 6 / cam.z);
          if (hitEl) { selection = { page: pg.i, ids: new Set([hitEl.id]) }; buildSelbar(); }
        }
      } else {
        const ids = new Set();
        const poly = a.pts;
        for (const el2 of page(a.page).elements) {
          if (!editable(el2)) continue;
          const pts = el2.type === 'stroke' ? el2.points : el2.type === 'shape' && el2.kind !== 'ellipse' ? el2.pts : null;
          if (pts) { let n = 0; for (const p of pts) if (inPoly(p[0], p[1], poly)) n++; if (n / pts.length >= 0.6) ids.add(el2.id); }
          else { const b = R.bounds(el2); if (inPoly(b.x + b.w / 2, b.y + b.h / 2, poly)) ids.add(el2.id); }
        }
        if (ids.size) { selection = { page: a.page, ids }; buildSelbar(); }
      }
    } else if (a.type === 'tableBorder') {
      if (a.pushed) changed();
    } else if (a.type === 'resize') {
      lifted = new Set();
      if (Math.abs(a.kx - 1) > 0.005 || Math.abs(a.ky - 1) > 0.005) mutateSelection((x) => resizeOne(x, a));
      else sceneDirty = true;
    } else if (a.type === 'vertex') {
      lifted = new Set();
      const p = selectedElements().find((x) => x.id === a.el)?.pts[a.idx];
      if (p && Math.hypot(p[0] - a.x, p[1] - a.y) > 0.5) mutateSelection((x) => (x.id === a.el ? { ...x, pts: x.pts.map((q, k) => (k === a.idx ? [a.x, a.y] : q)) } : x));
      else sceneDirty = true;
    } else if (a.type === 'move') {
      lifted = new Set();
      if (Math.abs(a.dx) > 0.5 || Math.abs(a.dy) > 0.5) moveSelection(a.dx, a.dy);
      else { sceneDirty = true; }
    }
    requestFrame();
  }

  function inPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', (e) => { touches.delete(e.pointerId); cancelAction(); });
  canvas.addEventListener('pointerleave', () => { if (!action) { hover = null; requestFrame(); } });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const sp = localPt(e);
    if (e.ctrlKey || e.metaKey) zoomAt(sp.x, sp.y, Math.exp(-e.deltaY * 0.0045));
    else {
      const k = e.deltaMode === 1 ? 16 : 1;
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) * k, dy = (e.shiftKey ? 0 : e.deltaY) * k;
      setCam({ ...cam, x: cam.x + dx / cam.z, y: cam.y + dy / cam.z });
    }
  }, { passive: false });
  // iPad with a trackpad: a pinch arrives as Safari's gesture events (desktop browsers send Ctrl + wheel instead)
  let gestureScale = 1;
  canvas.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureScale = 1; });
  canvas.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (!e.scale || touches.size) return;   // fingers on the screen: the pointer pinch handles it
    const sp = localPt(e);
    zoomAt(sp.x, sp.y, e.scale / gestureScale);
    gestureScale = e.scale;
  });

  // ---------- keyboard & clipboard ----------
  const active = () => !opts.isActive || opts.isActive();
  function onKey(e) {
    if (!active() || e.target.matches?.('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && (k === '=' || k === '+')) { e.preventDefault(); zoomAt(cssW / 2, cssH / 2, 1.2); return; }
    if ((e.ctrlKey || e.metaKey) && k === '-') { e.preventDefault(); zoomAt(cssW / 2, cssH / 2, 1 / 1.2); return; }
    if ((e.ctrlKey || e.metaKey) && k === '0') { e.preventDefault(); fitView(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === ' ') { spaceDown = true; canvas.classList.add('grab'); e.preventDefault(); return; }
    if ((k === 'delete' || k === 'backspace') && selection) { mutateSelection(() => null); clearSelection(); return; }
    if (k === 'escape') { clearSelection(); return; }
    const map = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', t: 'text' };
    if (map[k]) setTool(map[k]);
  }
  function onKeyUp(e) { if (e.key === ' ') { spaceDown = false; canvas.classList.remove('grab'); } }
  function onPaste(e) {
    if (!active() || e.target.matches?.('input, textarea')) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); insertFiles([item.getAsFile()]); return; }
    const text = e.clipboardData?.getData('text/plain');
    if (text && requireLayer()) {
      e.preventDefault();
      const p = insertPoint(), t = settings.tools.text;
      addElement(p.i, { id: uid(), type: 'text', layerId: activeLayer, x: p.x - 180, y: p.y, w: 360, size: t.width, color: t.color, text });
    }
  }
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKeyUp);
  document.addEventListener('paste', onPaste);
  const onHide = () => {
    if (document.visibilityState !== 'hidden') return;
    save(true).then(() => (pdfMod ? store.flush(note) : null)).catch((err) => console.error(err));
  };
  document.addEventListener('visibilitychange', onHide);

  // ---------- export ----------
  function exportPDF() {
    const imgs = note.pages.map((p, i) => ({ src: R.renderPageCanvas(note, i, { scale: 2 }).toDataURL('image/png'), wide: a4 && R.pageSize(p).w > R.pageSize(p).h }));
    // landscape pages print on landscape paper (named pages)
    const html = `<!doctype html><title>${esc(note.title)}</title><style>@page{${a4 ? 'size:A4;' : ''}margin:0}@page wide{size:A4 landscape;margin:0}body{margin:0}img{display:block;width:100%;page-break-after:always}img.wide{page:wide}</style>${imgs.map((m) => `<img${m.wide ? ' class="wide"' : ''} src="${m.src}">`).join('')}`;
    // Android app: hand the pages to Android's print screen, which also offers "Save as PDF"
    if (isNative) return NotesFolder.print({ html, title: note.title }).catch(() => toast('Printing isn’t available'));
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;';
    document.body.append(frame);
    const d = frame.contentDocument;
    d.open();
    d.write(html);
    d.close();
    frame.onload = null;
    setTimeout(() => { frame.contentWindow.focus(); frame.contentWindow.print(); setTimeout(() => frame.remove(), 1000); }, 300);
  }

  // ---------- panels API ----------
  const ed = {
    note, a4,
    get activeLayer() { return activeLayer; },
    set activeLayer(id) { activeLayer = id; },
    pushHistory, changed, currentPage, goTo, viewCenter,
    thumb(i) {
      const t = tileMode && tiles.get(page(i).id);
      if (!t || t.page !== page(i)) return R.renderPageCanvas(note, i, { maxW: 150, maxH: 210 });
      const s = sizeOf(i), k = Math.min(150 / s.w, 210 / s.h), c = document.createElement('canvas');
      c.width = Math.round(s.w * k); c.height = Math.round(s.h * k);
      c.getContext('2d').drawImage(t.canvas, 0, 0, c.width, c.height);   // a page already drawn: just shrink it
      return c;
    },
    pageSize: (i) => sizeOf(i),
    addPage(after) {
      pushHistory();
      // a new page has the same size and orientation as the page it follows
      const s = note.pages[after]?.w ? { w: note.pages[after].w, h: note.pages[after].h } : {};
      // in a PDF note a new page gets the note's paper (written into the PDF as the page itself when saved)
      note.pages.splice(after + 1, 0, { id: uid(), ...s, ...(note.pdf ? { tpl: note.newPaper } : {}), elements: [] });
      changed(); goTo(after + 1);
    },
    deletePage(i) {
      if (note.pages.length < 2) return toast('A note needs at least one page');
      pushHistory();
      note.pages.splice(i, 1);
      note.outline = note.outline.filter((o) => o.page !== i).map((o) => (o.page > i ? { ...o, page: o.page - 1 } : o));
      clearSelection(); changed();
    },
    movePage(i, d) {
      const j = i + d;
      if (j < 0 || j >= note.pages.length) return;
      pushHistory();
      [note.pages[i], note.pages[j]] = [note.pages[j], note.pages[i]];
      note.outline = note.outline.map((o) => (o.page === i ? { ...o, page: j } : o.page === j ? { ...o, page: i } : o));
      clearSelection(); changed(); goTo(j);
    },
    setLayers(fn, history = true) { if (history) pushHistory(); fn(note.layers); clearSelection(); changed(); },
    removeLayer(id) {
      pushHistory();
      note.layers = note.layers.filter((l) => l.id !== id);
      note.pages = note.pages.map((p) => ({ ...p, elements: p.elements.filter((e) => e.layerId !== id) }));
      if (activeLayer === id) activeLayer = note.layers[note.layers.length - 1].id;
      clearSelection(); changed();
    },
    openByTitle: (t) => app.openByTitle(t, note),
    allNotes: () => store.listNotes(),
  };
  const panels = createPanels(el.querySelector('.panel'), ed);

  // ---------- init ----------
  onFileDrop(stage, (files, e) => {
    const r = canvas.getBoundingClientRect();
    const pg = pageAt(toWorld(e.clientX - r.left, e.clientY - r.top), true);
    insertFiles(files, pg || undefined);
  });
  const stopAssets = R.addAssetListener(() => { assetVer++; sceneDirty = true; requestFrame(); panels.refresh(true); });
  el.addEventListener('pointerdown', () => opts.onActivate?.(), true);
  const ro = new ResizeObserver(() => resize());
  ro.observe(stage);
  resize();
  let lastView = null;
  try { lastView = JSON.parse(localStorage.getItem(VIEW_KEY)); } catch {}
  lastView = lastView && Number.isFinite(lastView.x) && Number.isFinite(lastView.y) && Number.isFinite(lastView.z) ? lastView : note.view;
  if (lastView && !fixedPages) setCam(lastView); else fitView();
  updateToolbar();
  if (fixedPages) scheduleSave();
  if (!peer) sharpenPdfPages();

  // PDF notes: draw the PDF's pages (cached on the device after the first time), the ones on screen first
  if (pdfMod && !peer) {   // one pane draws them for both
    const here = currentPage();
    const order = note.pages.map((p) => p.pdfIndex).filter((i) => i != null)
      .sort((a, b) => Math.abs(a - here) - Math.abs(b - here));
    pdfMod.renderPages(note, order, (i, src) => {
      const p = note.pages.find((x) => x.pdfIndex === i);
      const bgEl = p?.elements.find((e) => e.type === 'image' && note.layers.some((l) => l.bg && l.id === e.layerId));
      if (!bgEl) return;
      const swap = (pages) => pages.map((pg) => (pg.elements.some((e) => e.id === bgEl.id) ? { ...pg, elements: pg.elements.map((e) => (e.id === bgEl.id ? { ...e, src } : e)) } : pg));
      note.pages = swap(note.pages);
      for (const s of [...undoStack, ...redoStack]) s.pages = swap(s.pages);
      sceneDirty = true; requestFrame(); notifyPeers();
    }, () => destroyed && !shared?.panes.size).catch((err) => { console.error(err); toast('Couldn’t draw some PDF pages', 4000); });
  }

  // Notes made by older versions hold PDF pages rendered at 1500 px, blurry when zoomed. If the PDF the note was
  // made from is still in the notes folder, render those pages again at full sharpness, one by one, while you work.
  async function sharpenPdfPages() {
    if (!a4 || !note.source || !/\.pdf$/i.test(note.source)) return;
    const bg = new Set(note.layers.filter((l) => l.bg).map((l) => l.id));
    const targets = [];
    for (const p of note.pages) {
      const e = p.elements.find((x) => x.type === 'image' && bg.has(x.layerId));
      if (e) targets.push({ n: targets.length + 1, id: e.id, src: e.src, ratio: e.w / e.h });
    }
    const todo = [];
    for (const t of targets) { const s = await imageSize(t.src); if (Math.max(s.w, s.h) < PDF_RES * 0.9) todo.push(t); }
    if (!todo.length || destroyed) return;
    let file;
    try { file = await store.openDocument(note.source); } catch { return; }
    let done = 0;
    try {
      await renderPdfPages(file, todo.map((t) => t.n), async (n, img) => {
        // give the pen priority: wait while a stroke or gesture is going on, and breathe between pages
        while (action && !destroyed) await new Promise((r) => setTimeout(r, 300));
        await new Promise((r) => setTimeout(r, 150));
        if (destroyed) return false;
        const t = todo.find((x) => x.n === n);
        if (Math.abs(img.w / img.h - t.ratio) > 0.02 * t.ratio) return true;   // pages were rearranged: leave this one
        const swap = (pages) => pages.map((p) => (p.elements.some((e) => e.id === t.id) ? { ...p, elements: p.elements.map((e) => (e.id === t.id ? { ...e, src: img.src } : e)) } : p));
        note.pages = swap(note.pages);
        for (const s of [...undoStack, ...redoStack]) s.pages = swap(s.pages);
        done++;
        sceneDirty = true; requestFrame(); notifyPeers();
        toast(`Sharpening PDF pages… ${done} of ${todo.length}`, 4000);
        if (done % 10 === 0) scheduleSave();
      });
    } catch (err) { console.error(err); }
    if (done && !destroyed) { scheduleSave(); toast('PDF pages are sharp now', 1800); }
  }

  self = {
    /** The other pane changed this same note: draw it again here. */
    refresh() {
      if (destroyed) return;
      if (selection && [...selection.ids].some((id) => !page(selection.page)?.elements.some((e) => e.id === id))) clearSelection();
      if (!layerOf(activeLayer)) activeLayer = note.layers[note.layers.length - 1].id;
      if (document.activeElement !== titleInput) titleInput.value = note.title;
      sceneDirty = true;
      requestFrame();
      updateButtons();
      panels.refresh();
    },
    async destroy() {
      commitEdit();
      destroyed = true;
      stopAssets();
      shared?.panes.delete(self);
      ro.disconnect();
      removeEventListener('keydown', onKey);
      removeEventListener('keyup', onKeyUp);
      removeEventListener('inkpad-theme', onTheme);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('visibilitychange', onHide);
      clearTimeout(viewTimer);
      clearTimeout(saveTimer);
      clearTimeout(settleTimer);
      clearTimeout(prefetchTimer);
      clearTimeout(sharpTimer);
      dropTiles();
      await save(true);
      // the same note still open in the other pane: that pane writes and closes it
      if (pdfMod && !shared?.panes.size) {
        // write the PDF in the background so the library opens at once
        const name = note.title;
        store.flush(note)
          .then((wrote) => { if (wrote) toast(`Saved into ${name}.pdf`, 1600); })
          .catch((err) => { console.error(err); toast(`Couldn’t write into ${name}.pdf. Your writing is kept on this device and saved next time.`, 6000); })
          .finally(() => pdfMod.closePdfNote(note.id));
      }
    },
  };
  if (shared) { shared.note = note; shared.panes.add(self); }
  return self;
}
