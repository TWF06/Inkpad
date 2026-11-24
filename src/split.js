// Split screen: two notes side by side (top and bottom on a tablet held upright), or the same note twice, for
// example to look at page 1 while writing on page 9. Route: #/split/<left id>/<right id>.
//
// The same note in both panes is one note in memory: both panes edit it, share one undo history, and each change
// shows in the other pane straight away (see `shared` in editor.js). The keyboard and paste go to the pane last touched.
import { openEditor } from './editor.js';
import { store } from './store.js';
import { h, icon, esc } from './ui.js';

const RATIO_KEY = 'inkpad.splitRatio';

/**
 * Open two panes in root. lockNote(id) → release() | null keeps another window from editing the same note.
 * Returns { destroy, release } like a single editor, or null when it couldn't open.
 */
export async function openSplit(root, ids, app, lockNote) {
  const releases = [];
  for (const id of new Set(ids)) {
    const r = await lockNote(id);
    if (!r) { releases.forEach((f) => f()); return null; }
    releases.push(r);
  }
  const release = () => Promise.all(releases.map((f) => f()));

  const el = h(`<div class="split">
    <div class="pane"></div>
    <div class="split-bar" title="Drag to resize"><span></span></div>
    <div class="pane"></div>
  </div>`);
  root.append(el);
  const panes = [...el.querySelectorAll('.pane')];
  let ratio = Number(localStorage.getItem(RATIO_KEY)) || 0.5;
  const setRatio = (r) => { ratio = Math.min(0.8, Math.max(0.2, r)); panes[0].style.flexBasis = `${ratio * 100}%`; };
  setRatio(ratio);

  // the pane last touched gets the keyboard
  let activeSide = 0;
  const activate = (side) => { activeSide = side; panes.forEach((p, i) => p.classList.toggle('active', i === side)); };
  activate(0);

  // drag the bar between the panes
  const bar = el.querySelector('.split-bar');
  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const vertical = getComputedStyle(el).flexDirection === 'column';
    const r = el.getBoundingClientRect();
    const move = (ev) => setRatio(vertical ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width);
    const up = () => {
      bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up);
      localStorage.setItem(RATIO_KEY, String(ratio));
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });

  // the same note twice: one note in memory for both panes
  const shared = ids[0] === ids[1] ? { note: null, undo: [], redo: [], panes: new Set() } : null;

  // inside a pane, opening another note (a [[link]]) replaces that pane only
  const paneApp = (side) => {
    const go = (path) => {
      const m = /^\/note\/([^/]+)$/.exec(path);
      if (!m) return app.go(path);
      const next = [...ids]; next[side] = m[1];
      app.go(`/split/${next[0]}/${next[1]}`);
    };
    return { ...app, go, openByTitle: (title, from) => app.openByTitle(title, from, go) };
  };

  const editors = [];
  try {
    for (const side of [0, 1]) {
      const ed = await openEditor(panes[side], ids[side], paneApp(side), {
        shared,
        isActive: () => activeSide === side,
        onActivate: () => activate(side),
        split: { close: () => app.go(`/note/${ids[1 - side]}`) },
      });
      if (!ed) { for (const x of editors) await x.destroy(); release(); return null; }
      editors.push(ed);
    }
  } catch (err) {
    for (const x of editors) await x.destroy().catch(() => {});
    release();
    throw err;
  }
  return {
    async destroy() { for (const x of editors) await x.destroy(); },
    release,
  };
}

/** Ask which note goes next to `note`: the same note, or another one. Resolves to a note id, or null. */
export async function pickSplitNote(note) {
  const all = (await store.listNotes()).filter((n) => n.id !== note.id).sort((a, b) => b.updatedAt - a.updatedAt);
  return new Promise((resolve) => {
    const dlg = h(`<dialog class="modal split-pick"><form method="dialog">
      <h3>Split screen</h3>
      <p class="muted">Choose what goes next to “${esc(note.title)}”.</p>
      <button type="button" class="pick-row same" data-id="${esc(note.id)}">${icon('copy', 18)}<span><b>This note again</b><small class="muted">Look at one page while you write on another</small></span></button>
      <label class="search">${icon('search', 16)}<input placeholder="Search notes…" /></label>
      <div class="pick-list"></div>
      <div class="actions"><button type="button" class="btn ghost" data-cancel>Cancel</button></div>
    </form></dialog>`);
    const list = dlg.querySelector('.pick-list');
    const draw = (q = '') => {
      const hits = all.filter((n) => n.title.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 60);
      list.innerHTML = hits.length
        ? hits.map((n) => `<button type="button" class="pick-row" data-id="${esc(n.id)}">${icon('note', 18)}<span><b>${esc(n.title)}</b><small class="muted">${new Date(n.updatedAt).toLocaleDateString()}</small></span></button>`).join('')
        : `<div class="muted small pick-empty">${all.length ? 'No notes match.' : 'There are no other notes yet.'}</div>`;
    };
    draw();
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('input').addEventListener('input', (e) => draw(e.target.value));
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-cancel]')) return close(null);
      const row = e.target.closest('[data-id]');
      if (row) close(row.dataset.id);
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dlg);
    dlg.showModal();
  });
}
