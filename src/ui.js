// Small UI helpers: icons, toasts, modals, popup menus.
import { isNative, NotesFolder, blobToBase64 } from './native.js';

/**
 * Android app: there are no browser downloads, so a file the app hands you (a copy of a note, a PNG) opens
 * Android's Share menu: Drive, email, chat apps, "Save to Files"… `src` is a Blob / URL, or { path } for a file
 * already in the notes folder (sent straight from there, without passing through the page).
 */
export async function shareFile(filename, src, mime) {
  try {
    if (src?.path) return await NotesFolder.share({ name: src.path, filename, mime: mime || 'application/octet-stream' });
    const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
    await NotesFolder.share({ data: await blobToBase64(blob), filename, mime: mime || blob.type || 'application/octet-stream' });
  } catch (e) {
    console.error(e);
    toast(`Couldn’t share ${filename}`, 4000);
  }
}
const PATHS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 000 10h3"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  highlighter: '<path d="M9 11l-6 6v3h9l3-3"/><path d="M22 12l-4.6 4.6a2 2 0 01-2.8 0l-5.2-5.2a2 2 0 010-2.8L14 4"/>',
  eraser: '<path d="M7 21l-4.3-4.3a1 1 0 010-1.4l10-10a1 1 0 011.4 0l5.6 5.6a1 1 0 010 1.4L11 21z"/><path d="M22 21H7"/><path d="M5 11l9 9"/>',
  lasso: '<path d="M7 22a5 5 0 01-2-4"/><path d="M3.3 14A6.8 6.8 0 012 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 01-5-1"/><circle cx="5" cy="16" r="2"/>',
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  hand: '<path d="M18 11V6a2 2 0 00-4 0v5"/><path d="M14 10V4a2 2 0 00-4 0v6"/><path d="M10 10.5V6a2 2 0 00-4 0v8"/><path d="M18 8a2 2 0 114 0v6a8 8 0 01-8 8h-2c-2.8 0-4.5-.9-5.9-2.3l-3.6-3.6a2 2 0 012.8-2.8L7 15"/>',
  camera: '<path d="M4 7h3l2-3h6l2 3h3a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z"/><circle cx="12" cy="13" r="4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  shape: '<circle cx="8" cy="8" r="5"/><rect x="11" y="11" width="10" height="10" rx="1"/>',
  layers: '<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
  pages: '<rect x="4" y="2" width="12" height="16" rx="1"/><path d="M8 22h12V6"/>',
  outline: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  link: '<path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M10 2h4"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  stylus: '<path d="M3 21l3-1 12-12-2-2L4 18z"/><path d="M14 4l2-2 4 4-2 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  note: '<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 012-2h11"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4M6.6 6.6A17 17 0 002 12s3.5 7 10 7a10 10 0 005.4-1.6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.7-1.5"/>',
  up: '<path d="M18 15l-6-6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16" cy="10" r="1.2"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
};

export const icon = (name, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

let toastEl;
export function toast(msg, ms = 2400) {
  toastEl?.remove();
  if (!msg) { toastEl = null; return; }
  toastEl = h(`<div class="toast">${esc(msg)}</div>`);
  document.body.append(toastEl);
  const el = toastEl;
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 300);
}

/**
 * Modal form. fields: [{name,label,type:'text'|'number'|'select'|'choice', value, options:[{value,label}], min,max}]
 * Resolves to {values} or null on cancel.
 */
export function modal({ title, message = '', fields = [], ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const dlg = h(`<dialog class="modal"><form method="dialog">
      <h3>${esc(title)}</h3>${message ? `<p class="muted">${esc(message)}</p>` : ''}
      <div class="fields"></div>
      <div class="actions">${cancel ? `<button type="button" class="btn ghost" data-cancel>${esc(cancel)}</button>` : ''}
      <button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(ok)}</button></div></form></dialog>`);
    const box = dlg.querySelector('.fields');
    for (const f of fields) {
      const id = 'f_' + f.name;
      let input;
      if (f.type === 'select') {
        input = `<select id="${id}" name="${f.name}">${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      } else if (f.type === 'choice') {
        input = `<div class="choice">${f.options.map((o) => `<label><input type="radio" name="${f.name}" value="${esc(o.value)}" ${o.value === f.value ? 'checked' : ''}/><span>${o.html ?? esc(o.label)}</span></label>`).join('')}</div>`;
      } else {
        input = `<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${f.step != null ? `step="${f.step}"` : ''} autocomplete="off"/>`;
      }
      const row = h(`<div class="field"><label for="${id}">${esc(f.label)}</label>${input}</div>`);
      if (f.when) row.dataset.when = f.name;
      box.append(row);
    }
    // fields with `when: { field, is }` only show while that other field has that value (or one of them, if a list)
    // and is showing itself
    const form = dlg.querySelector('form');
    const rowOf = (name) => box.querySelector(`[data-when="${name}"]`);
    // a `required` field (e.g. a choice with nothing picked yet) keeps the OK button off until it has a value
    const okBtn = form.querySelector('button[value=ok]');
    const showFields = () => {
      const data = new FormData(form);
      for (const f of fields) if (f.when) rowOf(f.name).hidden = !!rowOf(f.when.field)?.hidden || ![].concat(f.when.is).includes(data.get(f.when.field));
      okBtn.disabled = fields.some((f) => f.required && !data.get(f.name));
    };
    form.addEventListener('change', showFields);
    showFields();
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('[data-cancel]')?.addEventListener('click', () => close(null));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    dlg.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const values = {};
      for (const f of fields) {
        const v = new FormData(e.target).get(f.name);
        values[f.name] = f.type === 'number' ? Number(v) : v;
      }
      close(values);
    });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('input[type=text],input[type=number]');
    if (first) { first.focus(); first.select(); }
  });
}

export const confirmBox = (title, message = '', ok = 'Delete') => modal({ title, message, ok, danger: true }).then((v) => !!v);
export const promptBox = (title, value = '', label = 'Name') =>
  modal({ title, fields: [{ name: 'v', label, value }] }).then((r) => (r ? r.v.trim() : null));

/** Popup menu anchored to an element. items: [{label, icon, action, danger}] */
export function menu(anchor, items) {
  document.querySelector('.popmenu')?.remove();
  const m = h(`<div class="popmenu"></div>`);
  for (const it of items) {
    const b = h(`<button class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon, 16) : ''}<span>${esc(it.label)}</span></button>`);
    b.onclick = (e) => { e.stopPropagation(); m.remove(); it.action(); };
    m.append(b);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw)) + 'px';
  m.style.top = (r.bottom + mh + 8 > innerHeight ? r.top - mh - 4 : r.bottom + 4) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off, true); }
  }, true));
}

export function download(filename, blobOrUrl) {
  if (isNative) return shareFile(filename, blobOrUrl);
  const a = document.createElement('a');
  a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  a.download = filename;
  a.click();
  if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * Open the device's own file chooser (gallery / Files app / camera). Files are read locally, never uploaded.
 * opts.multiple → resolves to an array; opts.capture → open the camera directly on tablets/phones.
 */
export function pickFile(accept, { multiple = false, capture } = {}) {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.multiple = multiple;
    if (capture) i.setAttribute('capture', capture);
    i.style.display = 'none';
    document.body.append(i);
    i.onchange = () => { const f = [...i.files]; i.remove(); resolve(multiple ? f : f[0] || null); };
    i.addEventListener('cancel', () => { i.remove(); resolve(multiple ? [] : null); });
    i.click();
  });
}

/** Call onFiles(files, event) when files are dragged onto el. Shows a drop highlight. */
export function onFileDrop(el, onFiles) {
  let depth = 0;
  const has = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const enter = (e) => { if (!has(e)) return; e.preventDefault(); depth++; el.classList.add('dropping'); };
  const over = (e) => { if (has(e)) e.preventDefault(); };
  const leave = () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('dropping'); };
  const drop = (e) => { if (!has(e)) return; e.preventDefault(); depth = 0; el.classList.remove('dropping'); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files], e); };
  el.addEventListener('dragenter', enter); el.addEventListener('dragover', over);
  el.addEventListener('dragleave', leave); el.addEventListener('drop', drop);
}
