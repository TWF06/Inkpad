// Notes are plain files on the device. No database.
//
//   <notes folder>/
//     Biology lecture.inkpad      ← one file per note (JSON: strokes, text, pictures, PDF pages)
//     Shopping list.inkpad
//     inkpad-folders.json         ← the folder tree shown in the library
//
// The notes folder is either
//   • in the Android app: a folder picked once with Android's own folder chooser; Android keeps that permission
//     for good, so the app never has to ask again (NotesFolderPlugin.java),
//   • in a browser: a folder the user picks on the device (File System Access API) — visible in the Files app, or
//   • the app's own private folder on the device (Origin Private File System) where picking a folder isn't supported.
// The browser can only remember *which* folder was picked by keeping its handle in IndexedDB, so that one
// handle is the only thing stored there; the notes themselves are always files.

const EXT = '.inkpad';
const FOLDERS_FILE = 'inkpad-folders.json';
const MODE_KEY = 'inkpad.storage';          // 'folder' | 'app'
const MIGRATED_KEY = 'inkpad.migratedFromDb';

import { isNative, isIOS, NotesFolder, nativeFile, blobToBase64 } from './native.js';

export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
export const canPickFolder = isNative || (typeof window !== 'undefined' && 'showDirectoryPicker' in window);

// ---------- the remembered folder handle (tiny key/value, not note data) ----------
let handleDbP = null;
function handleDb() {
  handleDbP ??= new Promise((res, rej) => {
    const r = indexedDB.open('inkpad-handles', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('h');
    r.onsuccess = () => { r.result.onclose = () => { handleDbP = null; }; res(r.result); };
    r.onerror = () => { handleDbP = null; rej(r.error); };
  });
  return handleDbP;
}
async function handleGet() {
  try {
    const d = await handleDb();
    return await new Promise((res) => { const q = d.transaction('h').objectStore('h').get('root'); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
  } catch { return null; }
}
async function handleSet(v) {
  const d = await handleDb();
  await new Promise((res, rej) => { const t = d.transaction('h', 'readwrite'); t.objectStore('h').put(v, 'root'); t.oncomplete = res; t.onerror = () => rej(t.error); });
}

// ---------- state ----------
let root = null;              // the notes folder: { list, read, write, remove } (see webDir / nativeDir)
let place = null;             // { kind: 'folder'|'app', name }
let pending = null;           // saved handle waiting for permission
const entries = new Map();    // note file path → { lm, size, meta: note summary, alias?: id given to a copied file }
const fileOf = new Map();     // note id → file path
let listing = { files: [], dirs: [] };  // last listing of the notes folder (subfolders included)
let dirFolders = [];          // real subfolders, as library folders
let appFolders = [];          // folders made in the app (inkpad-folders.json)
let scannedAt = 0;
let indexKey = '';
let queue = Promise.resolve(); // writes run one at a time

// one failed write must not poison the queue: later reads/writes still run, the caller still sees the error
const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
const clone = (x) => structuredClone(x);

// ---------- validation ----------
// Note files can come from anywhere (a shared .inkpad, a backup, a file edited by hand), so everything read
// from disk or imported is rebuilt from known fields with known types before the UI sees it. This keeps
// crafted files from injecting HTML (ids, colors and image sources end up in markup) and keeps
// malformed files from crashing the library or editor.
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi, d) => Math.max(lo, Math.min(hi, num(v, d)));
const str = (v, d = '', max = 100000) => (typeof v === 'string' ? v.slice(0, max) : d);
const okId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const idOr = (v) => (okId(v) ? v : uid());
const color = (v, d = '#1f2937') => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : d);
const imgSrc = (v) => (typeof v === 'string' && /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]*$/i.test(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const point = (p) => (Array.isArray(p) ? [num(p[0]), num(p[1]), clamp(p[2], 0, 1, 0.5)] : null);
const NOTE_KINDS = ['a4', 'infinite'], TEMPLATE_IDS = ['blank', 'lined', 'grid', 'dot', 'cornell'], PAPER_IDS = ['white', 'cream', 'dark'];

function cleanElement(e, layerIds, fallbackLayer) {
  if (!e || typeof e !== 'object') return null;
  const base = { id: idOr(e.id), layerId: layerIds.has(e.layerId) ? e.layerId : fallbackLayer };
  switch (e.type) {
    case 'stroke': {
      const points = arr(e.points).map(point).filter(Boolean);
      if (!points.length) return null;
      return { ...base, type: 'stroke', tool: e.tool === 'highlighter' ? 'highlighter' : 'pen', color: color(e.color), width: clamp(e.width, 0.1, 500, 2.5), points };
    }
    case 'shape': {
      const s = { ...base, type: 'shape', color: color(e.color), width: clamp(e.width, 0.1, 500, 2.5) };
      if (e.kind === 'ellipse') return { ...s, kind: 'ellipse', cx: num(e.cx), cy: num(e.cy), rx: Math.abs(num(e.rx, 1)), ry: Math.abs(num(e.ry, 1)) };
      const pts = arr(e.pts).map(point).filter(Boolean).map((p) => [p[0], p[1]]);
      return pts.length ? { ...s, kind: ['line', 'polyline', 'polygon'].includes(e.kind) ? e.kind : 'polyline', pts } : null;
    }
    case 'text':
      return { ...base, type: 'text', x: num(e.x), y: num(e.y), w: clamp(e.w, 10, 20000, 360), size: clamp(e.size, 4, 400, 18), color: color(e.color), text: str(e.text) };
    case 'table': {
      const colW = arr(e.colW).slice(0, 50).map((v) => clamp(v, 10, 5000, 120));
      const rowH = arr(e.rowH).slice(0, 200).map((v) => clamp(v, 10, 5000, 36));
      if (!colW.length || !rowH.length) return null;
      const cells = rowH.map((_, r) => colW.map((_, c) => str(arr(arr(e.cells)[r])[c], '', 10000)));
      return { ...base, type: 'table', x: num(e.x), y: num(e.y), colW, rowH, cells, color: color(e.color), size: clamp(e.size, 4, 400, 15) };
    }
    case 'image': {
      const src = imgSrc(e.src);
      return src ? { ...base, type: 'image', x: num(e.x), y: num(e.y), w: clamp(e.w, 1, 50000, 100), h: clamp(e.h, 1, 50000, 100), src } : null;
    }
    default: return null;
  }
}

// a page has its own size only when it isn't A4 portrait (e.g. a landscape PDF page)
const pageDims = (p) => (Number.isFinite(p.w) && Number.isFinite(p.h) && p.w >= 50 && p.h >= 50 && p.w <= 20000 && p.h <= 20000 ? { w: p.w, h: p.h } : {});

/** A safe, well-formed copy of a note from an untrusted source, or null if it isn't a note at all. */
export function sanitizeNote(n) {
  if (!n || typeof n !== 'object' || !Array.isArray(n.pages)) return null;
  const seen = new Set();
  let layers = arr(n.layers).filter((l) => l && typeof l === 'object').map((l) => {
    let id = idOr(l.id); if (seen.has(id)) id = uid(); seen.add(id);
    return { id, name: str(l.name, 'Layer', 200) || 'Layer', visible: l.visible !== false, locked: !!l.locked, ...(l.bg ? { bg: true } : {}) };
  });
  if (!layers.length) layers = [{ id: uid(), name: 'Layer 1', visible: true, locked: false }];
  const layerIds = new Set(layers.map((l) => l.id));
  const fallbackLayer = (layers.find((l) => !l.bg) || layers[layers.length - 1]).id;
  let pages = n.pages.filter((p) => p && typeof p === 'object')
    .map((p) => ({ id: idOr(p.id), ...pageDims(p), elements: arr(p.elements).map((e) => cleanElement(e, layerIds, fallbackLayer)).filter(Boolean) }));
  if (!pages.length) pages = [{ id: uid(), elements: [] }];
  const v = n.view;
  const now = Date.now();
  return {
    id: idOr(n.id),
    title: str(n.title, 'Untitled', 200).trim() || 'Untitled',
    folderId: okId(n.folderId) ? n.folderId : null,
    kind: NOTE_KINDS.includes(n.kind) ? n.kind : 'a4',
    template: TEMPLATE_IDS.includes(n.template) ? n.template : 'lined',
    paper: PAPER_IDS.includes(n.paper) ? n.paper : 'white',
    pages, layers,
    outline: arr(n.outline).filter((o) => o && typeof o === 'object').map((o) => ({ id: idOr(o.id), title: str(o.title, 'Entry', 200), page: Math.max(0, Math.min(pages.length - 1, Math.round(num(o.page)))), x: num(o.x), y: num(o.y) })),
    view: v && typeof v === 'object' && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) ? { x: v.x, y: v.y, z: Math.max(0.1, Math.min(8, v.z)) } : null,
    thumb: imgSrc(n.thumb),
    ...(typeof n.source === 'string' && n.source ? { source: n.source.slice(0, 300) } : {}),   // the PDF/picture in the folder this note writes on
    createdAt: num(n.createdAt, now),
    updatedAt: num(n.updatedAt, now),
  };
}

/** A safe copy of a folder record, or null. */
export function sanitizeFolder(f) {
  if (!f || typeof f !== 'object' || !okId(f.id)) return null;
  return { id: f.id, name: str(f.name, 'Folder', 200).trim() || 'Folder', parentId: okId(f.parentId) && f.parentId !== f.id ? f.parentId : null, color: color(f.color, '#3f3cbb'), createdAt: num(f.createdAt, Date.now()) };
}
const cleanFolders = (list) => arr(list).map(sanitizeFolder).filter(Boolean);

/** Where notes are kept right now, for display. */
export const storagePlace = () => place;

/**
 * Connect to the notes folder at startup.
 * → 'ready' | 'insecure' (page not on https/localhost) | 'choose' (no folder yet, user should pick one) | 'reconnect' (folder known, needs the user to allow access again)
 */
export async function initStorage() {
  if (!isSecureContext) return 'insecure';   // browsers only allow file access on https:// or localhost
  const mode = localStorage.getItem(MODE_KEY);
  if (isNative) {
    const c = await NotesFolder.current();
    if (c.connected) { await use(nativeDir, c.app ? 'app' : 'folder', c.name); return 'ready'; }
    if (mode === 'app') { await useAppStorage(); return 'ready'; }
    return 'choose';
  }
  if (mode === 'folder' && canPickFolder) {
    const h = await handleGet();
    if (h) {
      if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') { await use(webDir(h), 'folder', h.name); return 'ready'; }
      pending = h;
      return 'reconnect';
    }
  }
  if (mode === 'app' || !canPickFolder) { await useAppStorage(); return 'ready'; }
  return 'choose';
}

export const pendingFolderName = () => pending?.name;

/** Ask again for access to the remembered folder (must run from a tap/click). */
export async function reconnectFolder() {
  if (!pending) return false;
  if ((await pending.requestPermission({ mode: 'readwrite' })) !== 'granted') return false;
  await use(webDir(pending), 'folder', pending.name);
  pending = null;
  return true;
}

/**
 * Let the user pick a folder on the device for their notes (must run from a tap/click).
 * If notes already exist where they are now, `copyExisting` decides whether they're copied into the new folder.
 * Returns false if the user cancelled.
 */
export async function chooseFolder(copyExisting = async () => false) {
  if (isNative) {
    const r = await NotesFolder.pick();
    if (!r.picked) return false;
    const old = root ? { notes: await allNotes(), folders: await allFolders() } : null;
    localStorage.setItem(MODE_KEY, 'folder');
    await use(nativeDir, 'folder', r.name);
    if (old && old.notes.length && (await copyExisting(old.notes.length))) await copyIn(old);
    return true;
  }
  let h;
  try { h = await showDirectoryPicker({ id: 'inkpad-notes', mode: 'readwrite', startIn: 'documents' }); }
  catch { return false; }
  if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return false;
  const old = root ? { notes: await allNotes(), folders: await allFolders() } : null;
  await handleSet(h);
  localStorage.setItem(MODE_KEY, 'folder');
  await use(webDir(h), 'folder', h.name);
  if (old && old.notes.length && (await copyExisting(old.notes.length))) await copyIn(old);
  return true;
}

/** Keep notes in the app's own private folder on this device. */
export async function useAppStorage() {
  localStorage.setItem(MODE_KEY, 'app');
  // iPad: the app's own Documents folder, through the native side (the Files app shows it: On My iPad › Inkpad)
  if (isIOS) { const r = await NotesFolder.useAppFolder(); await use(nativeDir, 'app', r.name); return; }
  navigator.storage?.persist?.().catch(() => {});   // ask the browser not to clear it when space runs low
  await use(webDir(await navigator.storage.getDirectory()), 'app', 'App storage on this device');
}

async function use(dir, kind, name) {
  root = dir;
  place = { kind, name };
  entries.clear(); fileOf.clear();
  listing = { files: [], dirs: [] }; dirFolders = []; appFolders = []; scannedAt = 0; haveSnapshot = false;
  indexKey = `index:${kind}:${name}`;
  await loadIndex();
  await migrateFromDatabase();
}

async function copyIn({ notes, folders }) {
  notes = notes.map(sanitizeNote).filter(Boolean);
  folders = cleanFolders(folders.filter((f) => !f?.dir));   // real folders belong to the old place
  const have = new Set((await allFolders()).map((f) => f.id));
  for (const f of folders) if (!have.has(f.id)) await putFolder(f);
  const ids = new Set((await listNotes()).map((n) => n.id));
  for (const n of notes) if (!ids.has(n.id)) await putNote(n);
}

/** Earlier versions kept notes in an IndexedDB database; move them into files once (the old copy is left untouched). */
async function migrateFromDatabase() {
  if (localStorage.getItem(MIGRATED_KEY)) return;
  try {
    if (indexedDB.databases && !(await indexedDB.databases()).some((d) => d.name === 'inkpad')) { localStorage.setItem(MIGRATED_KEY, '1'); return; }
    const d = await new Promise((res, rej) => { const r = indexedDB.open('inkpad'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const read = (s) => (d.objectStoreNames.contains(s) ? new Promise((res) => { const q = d.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); }) : []);
    const [folders, notes] = [await read('folders'), await read('notes')];
    d.close();
    if (notes.length || folders.length) await copyIn({ notes, folders });
    localStorage.setItem(MIGRATED_KEY, '1');
  } catch (e) { console.warn('Could not move old notes into files', e); }
}

// ---------- files ----------
function need() { if (!root) throw new Error('Notes folder is not connected'); }

const LIST_DEPTH = 6, LIST_MAX = 5000;
// paths are relative to the notes folder and use "/": "Biology/Lecture 1.inkpad"
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);

/** A folder from the browser's File System Access API (picked folder or app storage). */
function webDir(h) {
  async function dirHandle(dir) {
    let d = h;
    for (const part of dir.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part);
    return d;
  }
  const fileHandle = async (path, create = false) => (await dirHandle(dirOf(path))).getFileHandle(nameOf(path), { create });
  return {
    async list() {
      const files = [], dirs = [];
      let count = 0;
      const walk = async (d, prefix, depth) => {
        const sub = [];
        for await (const [name, fh] of d.entries()) {
          if (name.startsWith('.') || count >= LIST_MAX) continue;
          count++;
          const path = prefix + name;
          if (fh.kind === 'directory') { dirs.push({ path, name }); sub.push([fh, path]); continue; }
          const f = await fh.getFile();
          files.push({ path, name, lastModified: f.lastModified, size: f.size, file: f });
        }
        if (depth < LIST_DEPTH) for (const [fh, path] of sub) await walk(fh, path + '/', depth + 1);
      };
      await walk(h, '', 0);
      return { files, dirs };
    },
    async read(path, entry) {
      try { return await (entry?.file ?? (await (await fileHandle(path)).getFile())).text(); } catch { return null; }
    },
    async write(path, text) {
      const fh = await fileHandle(path, true);
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      const f = await fh.getFile();
      return { path, lastModified: f.lastModified, size: f.size };
    },
    // createWritable writes to a temporary file and swaps it in on close: already a safe replace
    replaceBlob(path, blob) { return this.writeBlob(path, blob); },
    async move(from, to) {
      const fh = await fileHandle(from);
      if (fh.move) { await fh.move(await dirHandle(dirOf(to)), nameOf(to)); }
      else { await this.writeBlob(to, await fh.getFile()); await this.remove(from); }
      const f = await (await fileHandle(to)).getFile();
      return { path: to, lastModified: f.lastModified, size: f.size };
    },
    async writeBlob(path, blob) {
      const fh = await fileHandle(path, true);
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      const f = await fh.getFile();
      return { path, lastModified: f.lastModified, size: f.size };
    },
    remove: async (path) => { try { await (await dirHandle(dirOf(path))).removeEntry(nameOf(path)); } catch {} },
    readFile: async (path) => (await fileHandle(path)).getFile(),
  };
}

/** The notes folder of the Android or iPad app, through the native plugin (NotesFolderPlugin.java / .swift). */
const nativeDir = {
  async list() {
    const r = await NotesFolder.list();
    return { files: arr(r.files).map((f) => ({ ...f, path: f.path || f.name })), dirs: arr(r.dirs) };
  },
  async read(path) { try { return (await NotesFolder.read({ name: path })).data; } catch { return null; } },
  async write(path, text) {
    const f = await NotesFolder.write({ name: path, data: text, mime: path.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    return { ...f, path: f.path || joinPath(dirOf(path), f.name || nameOf(path)) };   // Android may adjust a file name
  },
  async writeBlob(path, blob) {
    const f = await NotesFolder.write({ name: path, data: await blobToBase64(blob), encoding: 'base64', mime: blob.type || 'application/octet-stream' });
    return { ...f, path: f.path || joinPath(dirOf(path), f.name || nameOf(path)) };
  },
  async replaceBlob(path, blob) {
    const f = await NotesFolder.replace({ name: path, data: await blobToBase64(blob), mime: blob.type || 'application/octet-stream' });
    return { ...f, path };
  },
  async move(from, to) {
    const f = await NotesFolder.move({ name: from, to });
    return { ...f, path: f.path || to };
  },
  remove: (path) => NotesFolder.remove({ name: path }).catch(() => {}),
  /** Move files to the device's Trash, after Android's own prompt: true if allowed, false if not; throws if there's no Trash. */
  trash: async (paths) => (await NotesFolder.trash({ names: paths })).trashed === true,
  readFile: async (path) => nativeFile(await NotesFolder.copyToCache({ name: path })),
};

const safeName = (title) => (title || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80) || 'Untitled';
const baseOf = (file) => file.slice(0, -EXT.length).replace(/ \(\d+\)$/, '');

// ---------- subfolders on the device ----------
// Every real folder inside the notes folder shows in the library as a folder. Its id comes from its path, so it
// stays the same between starts. Notes in it are saved there; folders made in the app (inkpad-folders.json) are
// only in the library, and a note in one of those is saved in the nearest real folder above it.
function dirFolderId(path) {
  let x = 0x811c9dc5;
  for (const ch of path.toLowerCase()) { x ^= ch.codePointAt(0); x = Math.imul(x, 0x01000193) >>> 0; }
  return `d${x.toString(36)}${path.length.toString(36)}`;
}
/** A PDF note's id comes from its path, so it is the same every time the app starts. */
export function pdfIdOf(path) {
  let x = 0x811c9dc5;
  for (const ch of path.toLowerCase()) { x ^= ch.codePointAt(0); x = Math.imul(x, 0x01000193) >>> 0; }
  return `p${x.toString(36)}${path.length.toString(36)}`;
}
const isPdfPath = (p) => /\.pdf$/i.test(p);
// files that are notes themselves: PDFs (pdfnote.js)
const FILE_NOTE_RE = /\.pdf$/i;
const isFileNote = (p) => FILE_NOTE_RE.test(p);
const fileTitle = (p) => nameOf(p).replace(FILE_NOTE_RE, '');
const MIME = { pdf: 'application/pdf' };
const mimeOf = (p) => MIME[/\.([a-z0-9]+)$/i.exec(p)?.[1].toLowerCase()] || 'application/octet-stream';
const pdfNote = () => import('./pdfnote.js');

const folderOfPath = (path) => (dirOf(path) ? dirFolderId(dirOf(path)) : null);

/** The real folder (path, '' = the notes folder) a note in library folder `id` is saved in. */
function dirForFolder(id) {
  const all = new Map([...appFolders, ...dirFolders].map((f) => [f.id, f]));
  const seen = new Set();
  while (id && all.has(id) && !seen.has(id)) { seen.add(id); const f = all.get(id); if (f.dir) return f.dir; id = f.parentId; }
  return '';
}

/** The library folder a note file shows in: its own choice if that's an app folder, else the real folder it's in. */
function shownFolder(path, meta) {
  const own = meta.folderId;
  if (own && appFolders.some((f) => f.id === own)) return own;
  return folderOfPath(path);
}

// ---------- the note index ----------
// Reading every note file at each start is slow (notes with PDF pages are big), so a summary of each file
// (title, folder, thumbnail, text for search) is kept in IndexedDB with the file's date and size. At start only
// the files that changed since are read again. The files stay the only real copy: the index is rebuilt from them.
const INDEX_VERSION = 1;
const FRESH_MS = 3000;   // a listing this recent is reused (the library asks for notes, folders and PDFs at once)

function summarize(n) {
  const { pages, layers, outline, view, ...meta } = n;
  return { ...meta, pageCount: pages.length, text: noteText(n) };
}

async function loadIndex() {
  try {
    const d = await handleDb();
    const v = await new Promise((res) => { const q = d.transaction('h').objectStore('h').get(indexKey); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
    if (v?.version !== INDEX_VERSION || !Array.isArray(v.entries)) return;
    for (const [path, e] of v.entries) if (typeof path === 'string' && e?.meta && okId(e.meta.id)) entries.set(path, e);
    if (v.listing && Array.isArray(v.listing.files) && Array.isArray(v.listing.dirs)) {
      listing = { files: v.listing.files, dirs: v.listing.dirs };
      setDirFolders();
      appFolders = cleanFolders(v.appFolders);
      for (const [path, c] of entries) fileOf.set(c.alias || c.meta.id, path);
      haveSnapshot = true;
    }
  } catch {}
}
let haveSnapshot = false;   // the library can be shown from what was seen last time, before the folder is checked
const listingSig = () => listing.files.map((f) => `${f.path}|${f.lastModified}|${f.size}`).join('\n') + '#' + listing.dirs.map((d) => d.path).join('\n') + '#' + JSON.stringify(appFolders);
let indexTimer = 0;
function saveIndexSoon() {
  clearTimeout(indexTimer);
  const key = indexKey, data = {
    version: INDEX_VERSION, entries: [...entries], appFolders,
    listing: { files: listing.files.map(({ path, name, lastModified, size }) => ({ path, name, lastModified, size })), dirs: listing.dirs },
  };
  indexTimer = setTimeout(async () => {
    try { const d = await handleDb(); d.transaction('h', 'readwrite').objectStore('h').put(data, key); } catch {}
  }, 500);
}

async function readAppFolders() {
  try { return cleanFolders(JSON.parse(await root.read(FOLDERS_FILE))?.folders); } catch { return []; }
}

function setDirFolders() {
  dirFolders = listing.dirs.map((d) => ({ id: dirFolderId(d.path), name: d.name, parentId: folderOfPath(d.path), color: '#64748b', createdAt: 0, dir: d.path }));
}

async function scan() {
  need();
  const before = haveSnapshot ? listingSig() : '';
  const l = await root.list();
  listing = { files: arr(l.files), dirs: arr(l.dirs) };
  setDirFolders();
  appFolders = await readAppFolders();
  const seen = new Set(), ids = new Set();
  let changedIndex = listingSig() !== before;
  haveSnapshot = true;
  fileOf.clear();
  for (const f of listing.files) {
    const path = f.path;
    if (isFileNote(path)) {
      seen.add(path);
      let c = entries.get(path);
      if (!c || c.lm !== f.lastModified || c.size !== f.size) {
        const keep = c && c.meta.pdf ? c.meta : {};
        c = { lm: f.lastModified, size: f.size, meta: {
          id: pdfIdOf(path), title: fileTitle(path), kind: 'a4', pdf: path, folderId: null,
          pageCount: keep.pageCount || 0, thumb: keep.thumbFor && keep.thumbFor.split('|')[1] === String(f.size) ? keep.thumb : null,   // see sameFile in pdfnote.js thumbFor: keep.thumbFor || '',
          text: '', updatedAt: f.lastModified, createdAt: keep.createdAt || f.lastModified,
        } };
        entries.set(path, c);
        changedIndex = true;
      }
      fileOf.set(c.meta.id, path);
      continue;
    }
    if (!path.toLowerCase().endsWith(EXT)) continue;
    seen.add(path);
    let c = entries.get(path);
    if (!c || c.lm !== f.lastModified || c.size !== f.size) {
      let note = null;
      try { const data = JSON.parse(await root.read(path, f)); note = sanitizeNote(data?.note ?? data); } catch {}
      if (!note) { if (entries.delete(path)) changedIndex = true; continue; }
      c = { lm: f.lastModified, size: f.size, meta: summarize(note) };
      entries.set(path, c);
      changedIndex = true;
    }
    // a file copied in the Files app keeps its twin's id: give the copy its own
    let id = c.alias || c.meta.id;
    if (ids.has(id)) { c.alias = uid(); id = c.alias; changedIndex = true; }
    ids.add(id);
    fileOf.set(id, path);
  }
  for (const path of [...entries.keys()]) if (!seen.has(path)) { entries.delete(path); changedIndex = true; }
  scannedAt = Date.now();
  if (changedIndex) saveIndexSoon();
}
const fresh = () => scannedAt && Date.now() - scannedAt < FRESH_MS;

function notesNow() {
  const sources = new Set([...entries.values()].filter((c) => !c.meta.pdf && c.meta.source).map((c) => c.meta.source.toLowerCase()));
  return [...fileOf].filter(([, path]) => entries.has(path) && !sources.has(path.toLowerCase()))
    .map(([id, path]) => { const m = entries.get(path).meta; return { ...m, id, folderId: shownFolder(path, m) }; });
}

/** Summaries of all notes (no pages): id, title, folderId, kind, thumb, pageCount, text, updatedAt… Fast. */
async function listNotes() {
  await queue;
  if (!fresh()) await scan();
  return notesNow();
}

/** What the library looked like last time (notes, folders, files), without touching the folder; null if never seen. */
function snapshot() {
  if (!haveSnapshot) return null;
  return { notes: notesNow(), folders: foldersNow(), docs: docsNow() };
}
/** Look at the folder again now (new, changed or removed files). */
async function refresh() { await queue; await scan(); }

async function readNote(id, path) {
  try {
    const data = JSON.parse(await root.read(path));
    const note = sanitizeNote(data?.note ?? data);
    if (!note) return undefined;
    return { ...note, id, folderId: shownFolder(path, note) };
  } catch { return undefined; }
}

/** Every note in full (pages too). Slow: for backups and copying notes to another folder. */
async function allNotes() {
  await listNotes();
  const out = [];
  for (const [id, path] of [...fileOf]) { if (isFileNote(path)) continue; const n = await readNote(id, path); if (n) out.push(n); }
  return out;
}

async function getNote(id) {
  await queue;
  // the note's file is known from the last look at the folder: read it straight away; look again only if it moved
  let path = fileOf.get(id);
  if (!path || !entries.has(path)) { await scan(); path = fileOf.get(id); }
  if (!path) return undefined;
  if (isFileNote(path)) {
    const c = entries.get(path);
    return (await pdfNote()).openPdfNote({ id, path, folderId: folderOfPath(path), lm: c?.lm, size: c?.size });
  }
  const n = await readNote(id, path);
  if (n) return n;
  await scan();
  path = fileOf.get(id);
  return path ? readNote(id, path) : undefined;
}

/** For the library: a PDF's thumbnail and page count, once worked out. */
function setPdfMeta(path, { thumb, pageCount }) {
  const c = entries.get(path);
  if (!c) return;
  c.meta = { ...c.meta, thumb, pageCount, thumbFor: `${c.lm}|${c.size}` };
  saveIndexSoon();
}

/** Write a whole file, safely: the old file is only replaced once the new one is fully written. */
function replaceFile(path, bytes) {
  return serial(async () => {
    need();
    const blob = new Blob([bytes], { type: mimeOf(path) });
    const f = await root.replaceBlob(path, blob);
    noteListed(path, f);
    const c = entries.get(path);
    if (c) { c.lm = f.lastModified; c.size = f.size; c.meta = { ...c.meta, updatedAt: f.lastModified, thumbFor: c.meta.thumb ? `${f.lastModified}|${f.size}` : '' }; }
    saveIndexSoon();
    return f;
  });
}

/** A new file in the real folder of library folder `folderId`, named after `title` (made unique). Returns its path. */
function createFile(folderId, title, ext, bytes) {
  return serial(async () => {
    need();
    if (!scannedAt) await scan();
    const dir = dirForFolder(folderId), base = safeName(title);
    const taken = new Set(listing.files.map((f) => f.path.toLowerCase()));
    let path;
    for (let i = 1; ; i++) { path = joinPath(dir, `${base}${i > 1 ? ` (${i})` : ''}${ext}`); if (!taken.has(path.toLowerCase())) break; }
    const f = await root.writeBlob(path, new Blob([bytes], { type: mimeOf(path) }));
    path = f.path || path;
    noteListed(path, f);
    return path;
  });
}

/** Rename or move a file (a PDF note) inside the notes folder; returns the new path. */
function moveFile(path, { title, folderId } = {}) {
  return serial(async () => {
    need();
    const dir = folderId === undefined ? dirOf(path) : dirForFolder(folderId);
    const ext = /\.[^./]+$/.exec(path)?.[0] || '';
    const base = title ? safeName(title) : nameOf(path).slice(0, nameOf(path).length - ext.length);
    const taken = new Set(listing.files.map((f) => f.path.toLowerCase()).filter((p) => p !== path.toLowerCase()));
    let to;
    for (let i = 1; ; i++) { to = joinPath(dir, `${base}${i > 1 ? ` (${i})` : ''}${ext}`); if (!taken.has(to.toLowerCase())) break; }
    if (to === path) return path;
    const f = await root.move(path, to);
    to = f.path || to;
    const c = entries.get(path);
    entries.delete(path); noteListed(path, null); noteListed(to, f);
    if (c) entries.set(to, { ...c, meta: { ...c.meta, id: pdfIdOf(to), pdf: to, title: fileTitle(to) } });
    scannedAt = 0;
    saveIndexSoon();
    (await pdfNote()).forgetPdf(path);
    return to;
  });
}

/** Write a PDF note's latest edits into its file now. */
async function flush(note) { return note?.pdf ? (await pdfNote()).flushPdfNote(note) : false; }

function noteListed(path, f) {
  listing.files = listing.files.filter((x) => x.path !== path);
  if (f) listing.files.push({ path, name: nameOf(path), lastModified: f.lastModified, size: f.size });
}

function putNote(n) {
  if (n.pdf) {
    // a PDF note: keep the edits on the device now, write them into the PDF after a pause (pdfnote.js)
    const c = entries.get(n.pdf);
    if (c && n.thumb) { c.meta = { ...c.meta, thumb: n.thumb, pageCount: n.pages.length, updatedAt: n.updatedAt, thumbFor: '' }; saveIndexSoon(); }
    return pdfNote().then((m) => m.stagePdfNote(n, () => { const e = entries.get(n.pdf); if (e && n.thumb) e.meta = { ...e.meta, thumb: n.thumb, thumbFor: `${e.lm}|${e.size}` }; }));
  }
  return serial(async () => {
    need();
    if (!scannedAt) await scan();
    const old = fileOf.get(n.id);
    const dir = dirForFolder(n.folderId);
    const want = safeName(n.title);
    // keep the file name if the title still matches it; a change of letter case only also keeps it, because on
    // case-insensitive storage (Windows, Android) writing "Notes" then removing "notes" would delete the note
    let path = old && dirOf(old) === dir && baseOf(nameOf(old)).toLowerCase() === want.toLowerCase() ? old : null;
    if (!path) {
      // tablets and Windows treat "Notes" and "notes" as the same file name
      const taken = new Set(listing.files.map((f) => f.path.toLowerCase()));
      for (let i = 1; ; i++) {
        const c = joinPath(dir, `${want}${i > 1 ? ` (${i})` : ''}${EXT}`);
        if (!taken.has(c.toLowerCase()) || c.toLowerCase() === old?.toLowerCase()) { path = c; break; }
      }
    }
    const f = await root.write(path, JSON.stringify({ app: 'inkpad', version: 2, note: n }));
    path = f.path || path;
    entries.set(path, { lm: f.lastModified, size: f.size, meta: summarize(n) });
    noteListed(path, f);
    fileOf.set(n.id, path);
    if (old && old !== path) { await root.remove(old); entries.delete(old); noteListed(old, null); }
    saveIndexSoon();
  });
}

function delNote(id) {
  return serial(async () => {
    need();
    if (!fileOf.has(id)) await scan();
    const path = fileOf.get(id);
    if (!path) return;
    await root.remove(path);
    entries.delete(path); fileOf.delete(id); noteListed(path, null);
    if (isFileNote(path)) (await pdfNote()).forgetPdf(path);
    saveIndexSoon();
  });
}

/**
 * Move notes to the device's Trash ("Recently deleted"): Android 11+ with a notes folder on the device. Android asks
 * first with its own prompt. Returns 'trashed', 'cancelled' (the user said no), or 'unsupported' (no Trash here,
 * e.g. older Android or notes kept inside the app; nothing was changed).
 */
function trashNotes(ids) {
  return serial(async () => {
    need();
    if (!root.trash) return 'unsupported';
    if (ids.some((id) => !fileOf.has(id))) await scan();
    const paths = ids.map((id) => fileOf.get(id)).filter(Boolean);
    if (!paths.length) return 'trashed';
    try { if (!(await root.trash(paths))) return 'cancelled'; } catch (err) { console.warn(err); return 'unsupported'; }
    for (const id of ids) fileOf.delete(id);
    for (const path of paths) {
      entries.delete(path); noteListed(path, null);
      if (isFileNote(path)) (await pdfNote()).forgetPdf(path);
    }
    saveIndexSoon();
    return 'trashed';
  });
}

/** Library folders: the real subfolders of the notes folder, plus folders made in the app. */
function foldersNow() {
  const real = new Set(dirFolders.map((f) => f.id));
  return [...dirFolders.map((f) => ({ ...f })), ...appFolders.filter((f) => !real.has(f.id))];
}
async function allFolders() {
  need();
  await queue;
  if (!fresh()) await scan();
  return foldersNow();
}
const editFolders = (fn) => serial(async () => {
  need();
  const list = cleanFolders(fn(await readAppFolders()));
  await root.write(FOLDERS_FILE, JSON.stringify({ app: 'inkpad', version: 2, folders: list }, null, 1));
  appFolders = list;
});
// real folders are the device's: renaming or deleting them is done in the Files app
const putFolder = (f) => (f.dir ? Promise.resolve() : editFolders((l) => [...l.filter((x) => x.id !== f.id), f]));
const delFolder = (id) => editFolders((l) => l.filter((x) => x.id !== id));

const DOC_RE = /\.(pdf|png|jpe?g|webp|gif|bmp|heic|heif)$/i;
const PICTURE_RE = /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i;

/** PDFs and pictures in the notes folder and its subfolders that don't have a note yet (once opened, the note stands for them). */
async function documents() {
  await queue;
  if (!fresh()) await scan();
  return docsNow();
}
function docsNow() {
  const used = new Set([...entries.values()].map((c) => c.meta.source?.toLowerCase()).filter(Boolean));
  const pdfs = new Set(listing.files.filter((f) => isPdfPath(f.path)).map((f) => f.path.toLowerCase().replace(/\.pdf$/, '')));
  return listing.files
    .filter((f) => DOC_RE.test(f.path) && !isFileNote(f.path) && !used.has(f.path.toLowerCase()) && !pdfs.has(f.path.toLowerCase().replace(/\.[^./]+$/, '')))
    .map((f) => ({ path: f.path, name: nameOf(f.path), size: f.size, lastModified: f.lastModified, folderId: folderOfPath(f.path), kind: /\.pdf$/i.test(f.path) ? 'pdf' : 'image' }));
}
async function openDocument(path) { need(); return root.readFile(path); }

/**
 * Keep a copy of a PDF or picture opened in the app (Open file, camera, Share → Inkpad) in the notes folder, in the
 * real folder of library folder `folderId`, so it lives with your notes like files put there in the Files app.
 * Returns its path in the notes folder.
 */
function addDocument(folderId, file) {
  return serial(async () => {
    need();
    if (!scannedAt) await scan();
    const dir = dirForFolder(folderId);
    const ext = (/\.[a-z0-9]{1,5}$/i.exec(file.name)?.[0] || (file.type === 'application/pdf' ? '.pdf' : '.jpg')).toLowerCase();
    const base = safeName(file.name.replace(/\.[^.]+$/, ''));
    // the same file already there (e.g. opened from the notes folder itself): use it rather than copy it again
    const same = listing.files.find((f) => f.path.toLowerCase() === joinPath(dir, base + ext).toLowerCase() && f.size === file.size);
    if (same) return same.path;
    const taken = new Set(listing.files.map((f) => f.path.toLowerCase()));
    let path;
    for (let i = 1; ; i++) { path = joinPath(dir, `${base}${i > 1 ? ` (${i})` : ''}${ext}`); if (!taken.has(path.toLowerCase())) break; }
    const f = await root.writeBlob(path, file);
    path = f.path || path;
    noteListed(path, f);
    saveIndexSoon();
    return path;
  });
}

export const store = { allFolders, putFolder, delFolder, listNotes, allNotes, getNote, putNote, delNote, trashNotes, documents, openDocument, addDocument, snapshot, refresh,
  setPdfMeta, replaceFile, createFile, moveFile, flush, idForPath: (p) => (isFileNote(p) ? pdfIdOf(p) : null),
  hasFile: (p) => !!p && listing.files.some((f) => f.path.toLowerCase() === p.toLowerCase()) };

/** A note file's contents, for "Save a copy". */
export const noteFileBlob = (n) => new Blob([JSON.stringify({ app: 'inkpad', version: 2, note: n })], { type: 'application/json' });
export { EXT as NOTE_EXT };

export function newNote({ title = 'Untitled', folderId = null, kind = 'a4', template = 'lined', paper = 'white', landscape = false } = {}) {
  const now = Date.now();
  return {
    id: uid(), title, folderId, kind, template, paper,
    pages: [{ id: uid(), ...(landscape && kind === 'a4' ? { w: 1123, h: 794 } : {}), elements: [] }],   // A4 landscape
    layers: [{ id: uid(), name: 'Layer 1', visible: true, locked: false }],
    outline: [], view: null, thumb: null, createdAt: now, updatedAt: now,
  };
}

const LINK_RE = /\[\[([^\]\n]+)\]\]/g;

/** All typed text in a note (text boxes + table cells). */
export function noteText(note) {
  if (!note.pages) return note.text || '';   // a summary from listNotes
  const parts = [];
  for (const p of note.pages) for (const e of p.elements) {
    if (e.type === 'text') parts.push(e.text);
    else if (e.type === 'table') parts.push(e.cells.flat().join(' '));
  }
  return parts.join('\n');
}

/** Titles this note links to via [[Title]]. */
export function noteLinks(note) {
  const out = new Map();
  for (const m of noteText(note).matchAll(LINK_RE)) out.set(m[1].trim().toLowerCase(), m[1].trim());
  return [...out.values()];
}
