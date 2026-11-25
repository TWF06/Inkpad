// Hash router + cross-note actions.
import { store, newNote, initStorage, chooseFolder, useAppStorage, reconnectFolder, pendingFolderName } from './store.js';
import { renderLibrary } from './library.js';
import { openEditor } from './editor.js';
import { openSplit, pickSplitNote } from './split.js';
import { confirmBox, toast, h, icon, esc, modal } from './ui.js';
import { importFiles, isPdf, isImage } from './importer.js';
import { isNative, isIOS, NotesFolder, nativeFile } from './native.js';

const root = document.getElementById('app');
let current = null;
let routing = Promise.resolve();

const app = {
  go(path) { location.hash = path; },
  /** Follow a [[Title]] link: open the matching note, or offer to create it next to the source note. */
  async openByTitle(title, from, go = (p) => app.go(p)) {
    const all = await store.listNotes();
    const hit = all.find((n) => n.title.trim().toLowerCase() === title.trim().toLowerCase());
    if (hit) return go(`/note/${hit.id}`);
    if (!(await confirmBox(`Create “${title}”?`, '', 'Create'))) return;
    const opts = { title, folderId: from?.folderId ?? null, kind: from?.kind ?? 'a4', template: from?.template && from.template !== 'blank' ? from.template : (from?.newPaper ?? 'lined'), paper: from?.paper ?? 'white' };
    if (opts.kind === 'a4') return go(`/note/${await (await import('./pdfnote.js')).createPdfNote(opts)}`);
    const n = newNote(opts);
    await store.putNote(n);
    go(`/note/${n.id}`);
  },
};

let storageReady = false;
let pendingShared = []; // Android app: shared files waiting to be opened

/** Before anything else: connect to the folder on the device where note files live. */
async function storageGate() {
  const state = await initStorage();
  if (state === 'ready') return true;
  const name = esc(pendingFolderName() || '');
  const body = {
    insecure: `<h2>Open Inkpad from a secure address</h2>
      <p class="muted">Browsers only let a web app read and write files on the device when it is opened from <b>https://</b> or <b>localhost</b>.
      You opened <code>${esc(location.origin)}</code>. Put the app on an HTTPS host (see README) and open it from there.</p>`,
    choose: `<h2>Notes folder</h2>
      <button class="btn primary wide" data-g="pick">${icon('folder', 18)} Choose a folder</button>
      <button class="btn ghost wide" data-g="app">Keep inside the app</button>`,
    reconnect: `<h2>Allow access</h2>
      <button class="btn primary wide" data-g="again">${icon('folder', 18)} Open “${name}”</button>
      <button class="btn ghost wide" data-g="pick">Choose a different folder</button>`,
  }[state];
  root.innerHTML = '';
  const el = h(`<div class="gate"><div class="gate-card"><div class="brand">${icon('pen', 26)}<b>Inkpad</b></div>${body}</div></div>`);
  root.append(el);
  return new Promise((resolve) => {
    el.addEventListener('click', async (e) => {
      const g = e.target.closest('[data-g]')?.dataset.g;
      let ok = false;
      try {
        if (g === 'pick') ok = await chooseFolder();
        if (g === 'app') { await useAppStorage(); ok = true; }
        if (g === 'again') ok = await reconnectFolder();
      } catch (err) {
        console.error(err);
        return toast('Couldn’t open storage', 4000);
      }
      if (ok) { el.remove(); resolve(true); } else if (g) toast(g === 'again' ? 'Access was not allowed' : 'No folder chosen');
    });
  });
}

// ---------- one window per note ----------
// Two tabs editing the same note would overwrite each other's saves. A Web Lock per note lets only one tab
// edit it; another tab can ask the first to save and let go ("Open here instead").
const channel = 'BroadcastChannel' in self ? new BroadcastChannel('inkpad') : null;
let openNoteId = null;
channel?.addEventListener('message', (e) => {
  const mine = openNoteId instanceof Set ? openNoteId.has(e.data?.id) : e.data?.id === openNoteId;
  if (e.data?.type === 'takeover' && mine) {
    toast('This note was opened in another window', 4000);
    app.go('/');   // leaving the editor saves the note and releases its lock
  }
});

/**
 * Hold a lock until the returned release() is called. With ifAvailable, resolves to null if it's taken.
 * release() returns a promise that settles once the lock is really free (opening the same note right after,
 * e.g. in split screen, must wait for that).
 */
function holdLock(name, opts = {}) {
  return new Promise((resolve, reject) => {
    let freed = null;
    const req = navigator.locks.request(name, opts, (lock) => {
      if (!lock) return resolve(null);
      return new Promise((release) => resolve(() => { release(); return freed; }));
    });
    freed = req.catch(() => {});
    req.catch(reject);
  });
}

/** Lock a note for this window. Returns a release function, or null if the user went back instead. */
async function lockNote(id) {
  if (!navigator.locks) return () => {};
  const name = `inkpad-note:${id}`;
  const got = await holdLock(name, { ifAvailable: true });
  if (got) return got;
  const el = h(`<div class="gate"><div class="gate-card"><div class="brand">${icon('pen', 26)}<b>Inkpad</b></div>
    <h2>This note is open in another window</h2>
    <button class="btn primary wide" data-g="here">Open here instead</button>
    <button class="btn ghost wide" data-g="back">Back to the library</button></div></div>`);
  root.append(el);
  const choice = await new Promise((res) => el.addEventListener('click', (e) => { const g = e.target.closest('[data-g]')?.dataset.g; if (g) res(g); }));
  if (choice === 'back') { el.remove(); app.go('/'); return null; }
  el.querySelector('.gate-card').innerHTML = '<p class="muted">Waiting…</p>';
  channel?.postMessage({ type: 'takeover', id });
  try {
    return await holdLock(name, { signal: AbortSignal.timeout(8000) });
  } catch {
    // the other window didn't answer (closed mid-way, or the browser froze it): open anyway rather than get stuck
    toast('The other window did not respond', 3000);
    return () => {};
  } finally { el.remove(); }
}

async function route() {
  if (!storageReady) {
    if (!(await storageGate())) return;
    storageReady = true;
    // Android app started by "Share → Inkpad" / "Open with": open those files first
    if (isNative) {
      pendingShared = (await NotesFolder.takeShared().catch(() => ({ files: [] }))).files;
      if (pendingShared.length) history.replaceState(null, '', '#/shared');
    }
  }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const prev = current;
  current = null;
  openNoteId = null;
  try { if (prev?.destroy) await prev.destroy(); } finally { await prev?.release?.(); }
  root.innerHTML = '';
  document.querySelector('.popmenu')?.remove();
  if (parts[0] === 'shared') return openShared();
  if (parts[0] === 'split' && parts[1] && parts[2]) {
    current = await openSplit(root, [parts[1], parts[2]], app, lockNote);
    if (current) openNoteId = new Set([parts[1], parts[2]]);
    return;
  }
  if (parts[0] === 'note') {
    const release = await lockNote(parts[1]);
    if (!release) return;
    const onSplit = async (note) => { const other = await pickSplitNote(note); if (other) app.go(`/split/${note.id}/${other}`); };
    try { current = await openEditor(root, parts[1], app, { onSplit }); } catch (err) { release(); throw err; }
    if (!current) return release();
    current.release = release;
    openNoteId = parts[1];
    return;
  }
  current = await renderLibrary(root, app, parts[0] === 'folder' ? parts[1] : null);
}

/** Files shared to Inkpad from another app (Files, Gallery, Drive…) are parked by sw.js; open them. */
async function openShared() {
  const files = [];
  if (isNative) {
    const list = [...pendingShared.splice(0), ...(await NotesFolder.takeShared()).files];
    for (const x of list) { try { files.push(await nativeFile(x)); } catch (e) { console.error(e); } }
  } else if ('caches' in self) {
    const cache = await caches.open('inkpad-shared');
    for (const req of await cache.keys()) {
      try {
        const res = await cache.match(req);
        const blob = await res.blob();
        let name = 'shared';
        try { name = decodeURIComponent(res.headers.get('X-Name') || 'shared'); } catch {}
        files.push(new File([blob], name, { type: blob.type }));
      } catch (e) { console.error(e); }
      await cache.delete(req);
    }
  }
  // only what the share target advertises: a page on another site can also POST to /share-target
  const usable = files.filter((f) => isPdf(f) || isImage(f));
  if (!usable.length) { toast('Nothing was shared'); return location.replace('#/'); }
  // in a browser, any website can send files here (a form posting to /share-target), not only the device's Share
  // menu: nothing goes into the notes folder until the user says so
  if (!isNative) {
    const names = usable.map((f) => f.name);
    const ok = await modal({
      title: `Open ${usable.length === 1 ? 'this shared file' : `${usable.length} shared files`}?`,
      message: `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}. They will be saved in your notes folder.`,
      ok: 'Open',
    });
    if (!ok) return location.replace('#/');
  }
  const id = await importFiles(usable);
  location.replace(id ? `#/note/${id}` : '#/');
}

// "Open with Inkpad" on desktop when installed (File Handling API).
if ('launchQueue' in window) {
  launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    await routing; // the notes folder must be connected first
    try {
      const files = await Promise.all(params.files.map((fh) => fh.getFile()));
      const id = await importFiles(files);
      if (id) app.go(`/note/${id}`);
    } catch (err) { console.error(err); toast('Could not open that file'); }
  });
}

// Android app: files shared while Inkpad is already open
NotesFolder?.addListener('shared', () => {
  if (!storageReady) return; // picked up after the folder is connected
  if (location.hash === '#/shared') routing = routing.then(route); else location.hash = '/shared';
});

// the Android app has its files built in; the service worker is only for the browser version
if (!isNative && 'serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});

function showError(err) {
  console.error(err);
  root.innerHTML = '';
  root.append(h(`<div class="gate"><div class="gate-card"><div class="brand">${icon('pen', 26)}<b>Inkpad</b></div>
    <h2>Something went wrong</h2><p class="muted">${esc(err?.message || String(err))}</p>
    <a class="btn primary wide" href="#/">Back to the library</a></div></div>`));
}
// a failure in one route must not stop every later navigation
const safeRoute = () => route().catch(showError);
addEventListener('hashchange', () => { routing = routing.then(safeRoute); });
routing = routing.then(safeRoute);
