// Library: nested folders, notes grid, search, opening files (old backups too).
import { store, uid, newNote, noteText, storagePlace, canPickFolder, chooseFolder, noteFileBlob, NOTE_EXT } from './store.js';
import { TEMPLATES } from './render.js';
import { h, icon, esc, modal, confirmBox, promptBox, menu, toast, download, shareFile, pickFile, onFileDrop } from './ui.js';
import { isNative, isIOS } from './native.js';

// notes that are files: what to call them and how to hand them over
const fileKind = () => 'PDF';
const unit = () => 'page';
const FILE_MIME = { '.pdf': 'application/pdf' };
import { importFiles, ACCEPT_ALL, noteFromDocument } from './importer.js';

// page sizes for a new page note, portrait, in mm (Custom… takes any width × height in SIZE_MM)
const PAGE_SIZES = {
  a4: { label: 'A4 (210 × 297 mm)', w: 210, h: 297 },
  a5: { label: 'A5 (148 × 210 mm)', w: 148, h: 210 },
  a3: { label: 'A3 (297 × 420 mm)', w: 297, h: 420 },
  b5: { label: 'B5 (176 × 250 mm)', w: 176, h: 250 },
  letter: { label: 'US Letter (8.5 × 11 in)', w: 215.9, h: 279.4 },
  legal: { label: 'US Legal (8.5 × 14 in)', w: 215.9, h: 355.6 },
  square: { label: 'Square (210 × 210 mm)', w: 210, h: 210 },
};
const SIZE_MM = { min: 20, max: 1000 };
const MM = 96 / 25.4;   // CSS px per mm
/** The New note form's size → the page's size in CSS px. */
function pageSizePx({ size, cw, ch, orient }) {
  const clampMm = (v, d) => (Number.isFinite(v) && v > 0 ? Math.min(SIZE_MM.max, Math.max(SIZE_MM.min, v)) : d);
  let { w, h } = size === 'custom' ? { w: clampMm(cw, 210), h: clampMm(ch, 297) } : PAGE_SIZES[size] || PAGE_SIZES.a4;
  if (size !== 'custom' && orient === 'landscape') [w, h] = [h, w];
  return { w: Math.round(w * MM), h: Math.round(h * MM) };
}

const COLORS = ['#3f3cbb', '#0f766e', '#b45309', '#be123c', '#4d7c0f', '#6d28d9', '#334155'];
const PIN_KEY = 'inkpad.sidebarPinned';   // '0' = sidebar hidden until the menu button opens it
const OPEN_KEY = 'inkpad.treeOpen';       // ids of folders expanded in the sidebar
const readOpen = () => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY)) || []); } catch { return new Set(); } };

export async function renderLibrary(root, app, folderId = null) {
  // show what was there last time straight away; the folder is checked in the background and the view updates
  // if files were added, changed or removed outside the app. The first time, everything is read before showing.
  const snap = store.snapshot();
  if (!snap) toast('Loading the notes folder…', 60000);
  let folders = snap ? snap.folders : await store.allFolders();
  let notes = snap ? snap.notes : await store.listNotes();   // summaries: quick, no pages
  let docs = snap ? snap.docs : await store.documents();
  if (!snap) toast('Ready', 600);
  let gone = false;
  let query = '';
  const byId = new Map(folders.map((f) => [f.id, f]));
  // a note or picture whose folder is gone shows at the top level
  const tidy = () => { for (const x of [...notes, ...docs]) if (x.folderId && !byId.has(x.folderId)) x.folderId = null; };
  tidy();
  if (folderId && !byId.has(folderId)) folderId = null;

  let pinned = localStorage.getItem(PIN_KEY) !== '0';
  const open = readOpen();
  const el = h(`<div class="library">
    <aside class="tree"><div class="brand">${icon('pen', 22)}<b>Inkpad</b><button class="icon-btn sm pin" data-a="pin"></button></div><nav></nav>
      <div class="tree-foot">
        <div class="where" title="Notes are saved as .inkpad files here">${icon('folder', 16)}<span><small class="muted">Saved in</small><b></b></span></div>
        ${canPickFolder ? `<button class="btn ghost wide" data-a="where">${icon('folder', 16)} Change notes folder</button>` : ''}
        <div class="theme-seg" title="Theme of the app (paper keeps its own colour)">${[['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([t, l]) => `<button data-theme-set="${t}">${l}</button>`).join('')}</div>
      </div></aside>
    <main>
      <header class="lhead">
        <button class="icon-btn menu-btn" data-a="sidebar" title="Folders">${icon('sidebar', 20)}</button>
        <div class="crumbs"></div>
        <label class="search">${icon('search', 16)}<input placeholder="Search titles and text…" /></label>
        <button class="btn ghost" data-a="open" title="Open a PDF, picture or backup from this device">${icon('upload', 16)}<span class="lbl">Open file</span></button>
        <button class="btn ghost" data-a="folder" title="New folder">${icon('folder', 16)}<span class="lbl">New folder</span></button>
        <button class="btn primary" data-a="note" title="New note">${icon('plus', 16)}<span class="lbl">New note</span></button>
      </header>
      <section class="grid"></section>
      <div class="drop-hint">Drop PDFs, documents or pictures to open them</div>
    </main></div>`);
  root.append(el);
  // on a narrow screen the sidebar slides over the page; tapping outside closes it
  const narrow = () => matchMedia('(max-width: 720px)').matches;
  const drawTheme = () => el.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === window.inkpadTheme?.get()));
  el.querySelector('.theme-seg').addEventListener('click', (e) => {
    const t = e.target.closest('[data-theme-set]')?.dataset.themeSet;
    if (t) { window.inkpadTheme?.set(t); drawTheme(); }
  });
  drawTheme();
  el.addEventListener('click', (e) => { if (narrow() && !e.target.closest('.tree, [data-a=sidebar]')) el.classList.remove('show-tree'); });

  function drawPin() {
    el.classList.toggle('unpinned', !pinned);
    const b = el.querySelector('.pin');
    b.innerHTML = icon('sidebar', 18);
    b.title = 'Hide the sidebar';
  }

  const pathOf = (id) => { const out = [], seen = new Set(); while (id && byId.has(id) && !seen.has(id)) { seen.add(id); out.unshift(byId.get(id)); id = byId.get(id).parentId; } return out; };
  const children = (pid) => folders.filter((f) => (f.parentId ?? null) === pid).sort((a, b) => a.name.localeCompare(b.name));
  const descendants = (id) => { const s = new Set([id]); let grew = true; while (grew) { grew = false; for (const f of folders) if (s.has(f.parentId) && !s.has(f.id)) { s.add(f.id); grew = true; } } return s; };

  async function reload() {
    folders = await store.allFolders();
    notes = await store.listNotes();
    docs = await store.documents();
    byId.clear(); folders.forEach((f) => byId.set(f.id, f));
    tidy();
    draw();
  }

  function drawTree() {
    const nav = el.querySelector('nav');
    for (const f of pathOf(folderId).slice(0, -1)) open.add(f.id);   // the open folder is always visible
    const item = (f, depth) => {
      const kids = f ? children(f.id) : [];
      const isOpen = f && open.has(f.id);
      const tw = !f ? '' : kids.length ? `<button class="tw" data-tw="${esc(f.id)}" title="${isOpen ? 'Collapse' : 'Expand'}">${icon(isOpen ? 'down' : 'right', 14)}</button>` : '<i class="tw"></i>';
      return `<a href="#/${f ? 'folder/' + esc(f.id) : ''}" class="${(f?.id ?? null) === folderId ? 'on' : ''}" style="padding-left:${(f ? 4 : 12) + depth * 16}px">${tw}${icon(f ? 'folder' : 'note', 16)}<span>${esc(f ? f.name : 'All notes')}</span></a>`
        + (isOpen ? kids.map((c) => item(c, depth + 1)).join('') : '');
    };
    nav.innerHTML = item(null, 0) + children(null).map((f) => item(f, 0)).join('');
  }
  el.querySelector('nav').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tw]');
    if (!t) { if (narrow() && e.target.closest('a')) el.classList.remove('show-tree'); return; }
    e.preventDefault();
    const id = t.dataset.tw;
    if (open.has(id)) open.delete(id); else open.add(id);
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
    drawTree();
  });

  function drawCrumbs() {
    const c = el.querySelector('.crumbs');
    c.innerHTML = `<a href="#/">Library</a>` + pathOf(folderId).map((f) => `<span>›</span><a href="#/folder/${esc(f.id)}">${esc(f.name)}</a>`).join('');
  }

  function folderPicker(title, exclude = new Set()) {
    const opts = [{ value: '', label: 'Library (top level)' }];
    const walk = (pid, depth) => children(pid).forEach((f) => { if (!exclude.has(f.id)) { opts.push({ value: f.id, label: `${'— '.repeat(depth + 1)}${f.name}` }); walk(f.id, depth + 1); } });
    walk(null, 0);
    return modal({ title, fields: [{ name: 'to', label: 'Destination', type: 'select', options: opts, value: folderId ?? '' }], ok: 'Move' }).then((r) => (r ? r.to || null : undefined));
  }

  /**
   * Delete notes. On the tablet they go to the device's Trash, where they can be restored for 30 days: Android shows
   * its own prompt first (so there's no second question here); on the iPad they go to Recently Deleted in the Files
   * app. Only where there's no Trash (older Android, notes kept inside the Android app) are they deleted for good,
   * after asking.
   */
  async function deleteNotes(list, what) {
    const r = isNative ? await store.trashNotes(list.map((x) => x.id)) : 'unsupported';
    if (r === 'trashed') {
      toast(isIOS ? 'Moved to Recently Deleted. Restore it from the Files app within 30 days.' : 'Moved to the device’s Trash. Restore it from the Trash in the Files app within 30 days.', 4000);
      return true;
    }
    if (r === 'cancelled') return false;
    const one = list.length === 1;
    const why = isNative ? `This device has no Trash for ${one ? 'this note' : 'these notes'}, so ${one ? 'it' : 'they'}` : (one ? 'It' : 'They');
    if (!(await confirmBox(`Delete ${what}?`, `${why} will be deleted for good. This can’t be undone.`))) return false;
    for (const x of list) await store.delNote(x.id);
    return true;
  }

  function drawGrid() {
    const grid = el.querySelector('.grid');
    grid.innerHTML = '';
    const q = query.trim().toLowerCase();
    const subfolders = q ? folders.filter((f) => f.name.toLowerCase().includes(q)) : children(folderId);
    const list = (q ? notes.filter((n) => n.title.toLowerCase().includes(q) || noteText(n).toLowerCase().includes(q)) : notes.filter((n) => (n.folderId ?? null) === folderId))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    for (const f of subfolders) {
      const count = notes.filter((n) => n.folderId === f.id).length + folders.filter((x) => x.parentId === f.id).length + docs.filter((d) => d.folderId === f.id).length;
      // real folders on the device are renamed / deleted in the Files app, not here
      const card = h(`<div class="card folder" style="--fc:${esc(f.color || COLORS[0])}"><div class="ficon">${icon('folder', 40)}</div>
        <div class="meta"><b>${esc(f.name)}</b><span class="muted">${count} item${count === 1 ? '' : 's'}${f.dir ? ' · on device' : ''}</span></div>
        ${f.dir ? '' : `<button class="icon-btn sm more" title="More">${icon('more', 18)}</button>`}</div>`);
      card.onclick = (e) => { if (!e.target.closest('.more')) app.go(`/folder/${f.id}`); };
      if (!f.dir) card.querySelector('.more').onclick = (e) => menu(e.currentTarget, [
        { label: 'Rename', icon: 'text', action: async () => { const n = await promptBox('Rename folder', f.name); if (n) { await store.putFolder({ ...f, name: n }); reload(); } } },
        { label: 'Move to…', icon: 'folder', action: async () => { const to = await folderPicker('Move folder', descendants(f.id)); if (to !== undefined) { await store.putFolder({ ...f, parentId: to }); reload(); } } },
        { label: 'Delete', icon: 'trash', danger: true, action: async () => {
          const ids = descendants(f.id);
          const n = notes.filter((x) => ids.has(x.folderId));
          if (n.length) { if (!(await deleteNotes(n, `“${f.name}”, ${ids.size - 1} subfolder(s) and ${n.length} note(s)`))) return; }
          else if (!(await confirmBox(`Delete “${f.name}”?`, `It has ${ids.size - 1} empty subfolder(s) and no notes.`))) return;
          for (const id of ids) await store.delFolder(id);
          reload();
        } },
      ]);
      grid.append(card);
    }

    for (const n of list) {
      const card = h(`<div class="card note">
        <div class="thumb">${n.thumb ? `<img src="${esc(n.thumb)}" alt="">` : `<div class="blank">${icon('note', 32)}</div>`}</div>
        <div class="meta"><b>${esc(n.title)}</b><span class="muted">${n.pdf ? (n.pageCount ? `${fileKind(n)} · ${n.pageCount} ${unit(n)}${n.pageCount === 1 ? '' : 's'}` : fileKind(n)) : n.kind === 'a4' ? `${n.pageCount} page${n.pageCount === 1 ? '' : 's'}` : 'Infinite canvas'} · ${new Date(n.updatedAt).toLocaleDateString()}</span>
        ${q && n.folderId ? `<span class="muted small">in ${esc(pathOf(n.folderId).map((f) => f.name).join(' / '))}</span>` : ''}</div>
        <button class="icon-btn sm more" title="More">${icon('more', 18)}</button></div>`);
      card.onclick = (e) => { if (!e.target.closest('.more')) app.go(`/note/${n.id}`); };
      // the list only has summaries: changes load the whole note first
      const full = async () => { const x = await store.getNote(n.id); if (!x) { toast('This note is gone'); reload(); } return x; };
      if (n.pdf) card.dataset.pdf = n.pdf;
      const ext = n.pdf ? (/\.[a-z0-9]+$/i.exec(n.pdf)?.[0] || '.pdf').toLowerCase() : '';
      card.querySelector('.more').onclick = (e) => menu(e.currentTarget, n.pdf ? [
        // a PDF / Word / PowerPoint / Excel note is that file: these act on the file in the folder
        { label: 'Rename', icon: 'text', action: async () => { const t = await promptBox(`Rename ${fileKind(n)} file`, n.title, 'Name'); if (t) { try { await store.moveFile(n.pdf, { title: t }); } catch (err) { console.error(err); toast('Couldn’t rename it', 3000); } reload(); } } },
        { label: 'Move to…', icon: 'folder', action: async () => { const to = await folderPicker(`Move ${fileKind(n)} file`); if (to !== undefined) { try { await store.moveFile(n.pdf, { folderId: to }); } catch (err) { console.error(err); toast('Couldn’t move it', 3000); } reload(); } } },
        { label: 'Duplicate', icon: 'copy', action: async () => { const f = await store.openDocument(n.pdf); await store.createFile(byId.get(n.folderId)?.id ?? null, `${n.title} copy`, ext, new Uint8Array(await f.arrayBuffer())); reload(); } },
        // the tablet: Android's Share menu (Drive, email, chats, Files…); a browser: download the file
        { label: isNative ? 'Share…' : `Save a copy (${ext})`, icon: isNative ? 'share' : 'download', action: async () => {
          await (await import('./pdfnote.js')).settled(n.id);   // just closed: the writing may still be going into the file
          if (isNative) shareFile(`${n.title}${ext}`, { path: n.pdf }, FILE_MIME[ext] || 'application/octet-stream');
          else download(`${n.title}${ext}`, await store.openDocument(n.pdf));
        } },
        { label: 'Delete', icon: 'trash', danger: true, action: async () => { if (await deleteNotes([n], `“${n.title}${ext}”`)) reload(); } },
      ] : [
        { label: 'Rename', icon: 'text', action: async () => { const t = await promptBox('Rename note', n.title, 'Title'); const x = t && (await full()); if (x) { await store.putNote({ ...x, title: t, updatedAt: Date.now() }); reload(); } } },
        { label: 'Move to…', icon: 'folder', action: async () => { const to = await folderPicker('Move note'); const x = to !== undefined && (await full()); if (x) { await store.putNote({ ...x, folderId: to }); reload(); } } },
        { label: 'Duplicate', icon: 'copy', action: async () => { const x = await full(); if (x) { await store.putNote({ ...x, id: uid(), title: n.title + ' copy', createdAt: Date.now(), updatedAt: Date.now() }); reload(); } } },
        { label: isNative ? 'Share…' : `Save a copy (${NOTE_EXT})`, icon: isNative ? 'share' : 'download', action: async () => { const x = await full(); if (x) download(`${n.title}${NOTE_EXT}`, noteFileBlob(x)); } },
        { label: 'Delete', icon: 'trash', danger: true, action: async () => { if (await deleteNotes([n], `“${n.title}”`)) reload(); } },
      ]);
      grid.append(card);
    }

    // PDFs, pictures and documents in the notes folder (and its subfolders) that haven't been opened yet
    const shownDocs = docs.filter((d) => (q ? d.name.toLowerCase().includes(q) : (d.folderId ?? null) === folderId));
    for (const d of shownDocs) {
      const mb = d.size / 1048576;
      const card = h(`<div class="card note doc">
        <div class="thumb"><div class="blank">${icon(d.kind === 'image' ? 'image' : 'pages', 32)}<span class="badge">${d.kind === 'pdf' ? 'PDF' : 'Picture'}</span></div></div>
        <div class="meta"><b>${esc(d.name.replace(/\.[^.]+$/, ''))}</b><span class="muted">${mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(d.size / 1024)) + ' KB'} · tap to write on it</span></div></div>`);
      card.onclick = async () => {
        if (card.classList.contains('busy')) return;
        card.classList.add('busy');
        toast(`Opening ${d.name}…`, 60000);
        try {
          const id = await noteFromDocument(await store.openDocument(d.path), { source: d.path, folderId: d.folderId });
          if (id) app.go(`/note/${id}`); else card.classList.remove('busy');
        } catch (e) { console.error(e); toast(`Couldn’t open ${d.name}`, 4000); card.classList.remove('busy'); }
      };
      grid.append(card);
    }

    if (!subfolders.length && !list.length && !shownDocs.length) {
      grid.append(h(`<div class="empty">${q ? `No results for “${esc(query)}”.` : `<b>Nothing here yet</b><span class="muted">Create a note to start writing.</span>`}</div>`));
    }
  }

  function draw() { drawPin(); drawTree(); drawCrumbs(); drawGrid(); el.querySelector('.where b').textContent = storagePlace()?.name ?? ''; }

  async function createNote() {
    const r = await modal({
      title: 'New note', ok: 'Create',
      fields: [
        { name: 'title', label: 'Title', value: 'Untitled' },
        { name: 'kind', label: 'Type', type: 'choice', value: 'a4', options: [
          { value: 'a4', html: `<b>PDF pages</b><small>Page-by-page notebook, saved as a PDF</small>` },
          { value: 'infinite', html: `<b>Infinite canvas</b><small>Unbounded board for mind maps & sketches</small>` },
        ] },
        { name: 'size', label: 'Page size', type: 'select', value: 'a4', when: { field: 'kind', is: 'a4' },
          options: [...Object.entries(PAGE_SIZES).map(([value, s]) => ({ value, label: s.label })), { value: 'custom', label: 'Custom…' }] },
        { name: 'cw', label: 'Width (mm)', type: 'number', value: 210, min: SIZE_MM.min, max: SIZE_MM.max, step: 'any', when: { field: 'size', is: 'custom' } },
        { name: 'ch', label: 'Height (mm)', type: 'number', value: 297, min: SIZE_MM.min, max: SIZE_MM.max, step: 'any', when: { field: 'size', is: 'custom' } },
        { name: 'orient', label: 'Orientation', type: 'choice', value: 'portrait', when: { field: 'size', is: Object.keys(PAGE_SIZES).filter((k) => k !== 'square') }, options: [
          { value: 'portrait', html: `<b>Vertical</b><small>Portrait</small>` },
          { value: 'landscape', html: `<b>Horizontal</b><small>Landscape</small>` },
        ] },
        { name: 'template', label: 'Template', type: 'select', value: 'lined', options: Object.entries(TEMPLATES).map(([value, label]) => ({ value, label })) },
        { name: 'paper', label: 'Paper color', type: 'select', value: 'white', options: [{ value: 'white', label: 'White' }, { value: 'cream', label: 'Cream' }, { value: 'dark', label: 'Dark' }] },
      ],
    });
    if (!r) return;
    const opts = { title: r.title.trim() || 'Untitled', folderId, kind: r.kind, template: r.template, paper: r.paper, size: pageSizePx(r) };
    // page notes are PDFs in the folder; an infinite canvas is an .inkpad file
    if (r.kind === 'a4') {
      try { return app.go(`/note/${await (await import('./pdfnote.js')).createPdfNote(opts)}`); }
      catch (err) { console.error(err); toast('Couldn’t create the PDF', 4000); return; }
    }
    const n = newNote(opts);
    await store.putNote(n);
    app.go(`/note/${n.id}`);
  }

  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'note') createNote();

    // hiding / showing the sidebar gives its space to the cards (the cards move over, nothing is covered)
    const setPinned = (v) => { pinned = v; localStorage.setItem(PIN_KEY, v ? '1' : '0'); drawPin(); };
    if (a === 'pin') { if (narrow()) el.classList.remove('show-tree'); else setPinned(false); }
    if (a === 'sidebar') { if (narrow()) el.classList.toggle('show-tree'); else setPinned(true); }
    if (a === 'folder') {
      const name = await promptBox('New folder', 'New folder');
      if (name) { await store.putFolder({ id: uid(), name, parentId: folderId, color: COLORS[folders.length % COLORS.length], createdAt: Date.now() }); reload(); }
    }
    if (a === 'where') {
      const ok = await chooseFolder((count) => modal({ title: `Copy your ${count} note(s) into this folder?`, message: 'They also stay where they are now. Choose Skip to see only what is already in the new folder.', ok: 'Copy', cancel: 'Skip' }).then(Boolean));
      if (ok) { toast(`Notes are now saved in “${storagePlace().name}”`); reload(); }
    }
    if (a === 'open') {
      menu(e.target.closest('[data-a]'), [
        { label: 'PDF, document, picture or backup from this device', icon: 'note', action: async () => openFiles(await pickFile(ACCEPT_ALL, { multiple: true })) },
        { label: 'Take a photo', icon: 'image', action: async () => openFiles(await pickFile('image/*', { capture: 'environment', multiple: true })) },
      ]);
    }
  });
  el.querySelector('.search input').addEventListener('input', (e) => { query = e.target.value; drawGrid(); });

  async function openFiles(files) {
    if (!files?.length) return;
    const id = await importFiles(files, folderId);
    if (id) app.go(`/note/${id}`); else reload();
  }
  onFileDrop(el.querySelector('main'), openFiles);

  // PDFs that have no thumbnail yet: draw page 1 in the background, one at a time
  async function thumbs() {
    const todo = notes.filter((n) => n.pdf && !n.thumb);
    if (!todo.length) return;
    const pn = await import('./pdfnote.js');
    for (const n of todo) {
      if (gone) return;
      try {
        const t = await pn.pdfThumb(n.pdf);
        store.setPdfMeta(n.pdf, t);
        Object.assign(n, t);
        const card = [...el.querySelectorAll('.card[data-pdf]')].find((c) => c.dataset.pdf === n.pdf);
        if (card) {
          card.querySelector('.thumb').innerHTML = `<img src="${esc(t.thumb)}" alt="">`;
          card.querySelector('.meta .muted').textContent = `${t.pageCount ? `${fileKind(n)} · ${t.pageCount} ${unit(n)}${t.pageCount === 1 ? '' : 's'}` : fileKind(n)} · ${new Date(n.updatedAt).toLocaleDateString()}`;
        }
      } catch (err) { console.warn('No thumbnail for', n.pdf, err); }
    }
  }

  draw();
  thumbs();
  if (snap) {
    const sig = () => JSON.stringify([folders.map((f) => [f.id, f.name, f.parentId]), notes.map((n) => [n.id, n.title, n.folderId, n.updatedAt]), docs.map((d) => d.path)]);
    const was = sig();
    store.refresh().then(async () => {
      if (gone) return;
      const s = store.snapshot();
      const prev = [folders, notes, docs];
      [folders, notes, docs] = [s.folders, s.notes, s.docs];
      if (sig() === was) { [folders, notes, docs] = prev; return; }
      byId.clear(); folders.forEach((f) => byId.set(f.id, f));
      tidy();
      if (folderId && !byId.has(folderId)) folderId = null;
      draw();
      thumbs();
    }).catch((e) => console.warn('Could not check the notes folder', e));
  }
  return { destroy() { gone = true; } };
}
