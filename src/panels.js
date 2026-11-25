// Editor side panels: Pages, Layers, Outline, Links/backlinks.
import { uid, noteLinks, noteText } from './store.js';
import { h, icon, esc, promptBox, confirmBox } from './ui.js';

const TITLES = { pages: 'Pages', layers: 'Layers', outline: 'Outline', links: 'Links' };

export function createPanels(aside, ed) {
  let tab = null, timer = 0;
  // page thumbnails are drawn again only for pages that changed (an edit makes a new page object)
  let thumbs = new WeakMap();
  const thumbOf = (i) => {
    const p = ed.note.pages[i];
    let c = thumbs.get(p);
    if (!c) { c = ed.thumb(i); thumbs.set(p, c); }
    return c;
  };

  function show(name) { tab = tab === name ? null : name; thumbs = new WeakMap(); render(); }
  /** Draw the open panel again soon; `redraw` = also every page thumbnail (pictures finished loading). */
  function refresh(redraw = false) { if (redraw) thumbs = new WeakMap(); if (!tab) return; clearTimeout(timer); timer = setTimeout(render, 350); }

  // thumbnails are drawn when their card scrolls into view, one per moment, so the panel opens straight away
  const queue = new Set();
  let busy = false;
  const lazy = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { queue.add(e.target); lazy.unobserve(e.target); }
    pump();
  }, { root: aside, rootMargin: '300px' });
  function pump() {
    if (busy || !queue.size) return;
    busy = true;
    setTimeout(() => {
      busy = false;
      const box = queue.values().next().value;
      queue.delete(box);
      const i = Number(box.dataset.i);
      if (box.isConnected && ed.note.pages[i]) { box.style.background = ''; box.append(thumbOf(i)); }
      pump();
    }, 16);
  }

  function render() {
    lazy.disconnect(); queue.clear();
    aside.classList.toggle('open', !!tab);
    aside.innerHTML = '';
    if (!tab) return;
    const head = h(`<div class="ph"><b>${TITLES[tab]}</b><button class="icon-btn sm" title="Close">${icon('close', 16)}</button></div>`);
    head.querySelector('button').onclick = () => { show(tab); dispatchEvent(new Event('resize')); };
    const body = h('<div class="pbody"></div>');
    aside.append(head, body);
    ({ pages, layers, outline, links })[tab](body);
  }

  // ----- pages (A4 notes) -----
  function pages(body) {
    const cur = ed.currentPage();
    ed.note.pages.forEach((p, i) => {
      const card = h(`<div class="pcard ${i === cur ? 'on' : ''}">
        <div class="pthumb"></div>
        <div class="prow"><span>${i + 1}</span>
          <button class="icon-btn sm" data-a="up" title="Move up">${icon('up', 14)}</button>
          <button class="icon-btn sm" data-a="down" title="Move down">${icon('down', 14)}</button>
          <button class="icon-btn sm" data-a="add" title="Add page after">${icon('plus', 14)}</button>
          <button class="icon-btn sm danger" data-a="del" title="Delete page">${icon('trash', 14)}</button>
        </div></div>`);
      const box = card.querySelector('.pthumb');
      const cached = thumbs.get(ed.note.pages[i]);
      if (cached) box.append(cached);
      else {
        const s = ed.pageSize(i), k = Math.min(150 / s.w, 210 / s.h);
        box.style.cssText = `width:${Math.round(s.w * k)}px;height:${Math.round(s.h * k)}px;margin:auto;background:#f1efea;border-radius:3px`;
        box.dataset.i = i;
        lazy.observe(box);
      }
      card.onclick = async (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (!a) return ed.goTo(i);
        if (a === 'up') ed.movePage(i, -1);
        if (a === 'down') ed.movePage(i, 1);
        if (a === 'add') ed.addPage(i);
        if (a === 'del' && await confirmBox(`Delete page ${i + 1}?`)) ed.deletePage(i);
      };
      body.append(card);
    });
    const add = h(`<button class="btn ghost wide">${icon('plus', 16)} Add page</button>`);
    add.onclick = () => ed.addPage(ed.note.pages.length - 1);
    body.append(add);
  }

  // ----- layers -----
  function layers(body) {
    const list = [...ed.note.layers].reverse(); // top first
    for (const l of list) {
      const idx = ed.note.layers.indexOf(l);
      const row = h(`<div class="lrow ${l.id === ed.activeLayer ? 'on' : ''}">
        <button class="icon-btn sm" data-a="vis" title="${l.visible ? 'Hide' : 'Show'}">${icon(l.visible ? 'eye' : 'eyeOff', 16)}</button>
        <button class="icon-btn sm" data-a="lock" title="${l.locked ? 'Unlock' : 'Lock'}">${icon(l.locked ? 'lock' : 'unlock', 16)}</button>
        <span class="lname" title="Double-click to rename">${esc(l.name)}</span>
        <button class="icon-btn sm" data-a="up" title="Move up" ${idx === ed.note.layers.length - 1 ? 'disabled' : ''}>${icon('up', 14)}</button>
        <button class="icon-btn sm" data-a="down" title="Move down" ${idx === 0 ? 'disabled' : ''}>${icon('down', 14)}</button>
        <button class="icon-btn sm danger" data-a="del" title="Delete layer" ${ed.note.layers.length < 2 ? 'disabled' : ''}>${icon('trash', 14)}</button>
      </div>`);
      row.onclick = async (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (!a) { ed.activeLayer = l.id; return render(); }
        if (a === 'vis') ed.setLayers(() => { l.visible = !l.visible; }, false);
        if (a === 'lock') ed.setLayers(() => { l.locked = !l.locked; }, false);
        if (a === 'up' || a === 'down') ed.setLayers((ls) => { const j = idx + (a === 'up' ? 1 : -1); [ls[idx], ls[j]] = [ls[j], ls[idx]]; });
        if (a === 'del' && await confirmBox(`Delete “${l.name}”?`)) ed.removeLayer(l.id);
        render();
      };
      row.querySelector('.lname').ondblclick = async () => {
        const n = await promptBox('Rename layer', l.name);
        if (n) { ed.setLayers((ls) => { ls.find((x) => x.id === l.id).name = n; }); render(); }
      };
      body.append(row);
    }
    const add = h(`<button class="btn ghost wide">${icon('plus', 16)} New layer</button>`);
    add.onclick = () => {
      const id = uid();
      ed.setLayers((ls) => ls.push({ id, name: `Layer ${ls.length + 1}`, visible: true, locked: false }));
      ed.activeLayer = id;
      render();
    };
    body.append(add);
  }

  // ----- outline -----
  function outline(body) {
    const items = [...ed.note.outline].sort((a, b) => a.page - b.page || a.y - b.y);
    for (const o of items) {
      const row = h(`<div class="orow"><span class="otitle">${esc(o.title)}</span>${ed.a4 ? `<span class="muted">p${o.page + 1}</span>` : ''}
        <button class="icon-btn sm" data-a="ren" title="Rename">${icon('text', 14)}</button>
        <button class="icon-btn sm danger" data-a="del" title="Remove">${icon('trash', 14)}</button></div>`);
      row.onclick = async (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (!a) return ed.goTo(o.page, o.x, o.y);
        if (a === 'del') { ed.pushHistory(); ed.note.outline = ed.note.outline.filter((x) => x.id !== o.id); ed.changed(); }
        if (a === 'ren') { const n = await promptBox('Rename outline entry', o.title, 'Title'); if (n) { ed.pushHistory(); ed.note.outline = ed.note.outline.map((x) => (x.id === o.id ? { ...x, title: n } : x)); ed.changed(); } }
        render();
      };
      body.append(row);
    }
    const add = h(`<button class="btn ghost wide">${icon('plus', 16)} Add entry at current view</button>`);
    add.onclick = async () => {
      const c = ed.viewCenter();
      const n = await promptBox('New outline entry', '', 'Title');
      if (!n || !c) return;
      ed.pushHistory();
      ed.note.outline = [...ed.note.outline, { id: uid(), title: n, page: c.i, x: c.x, y: c.y }];
      ed.changed();
      render();
    };
    body.append(add);
  }

  // ----- links / backlinks -----
  async function links(body) {
    const all = await ed.allNotes();
    const byTitle = new Map(all.map((n) => [n.title.trim().toLowerCase(), n]));
    const out = noteLinks(ed.note);
    const me = ed.note.title.trim().toLowerCase();
    const back = all.filter((n) => n.id !== ed.note.id && noteLinks(n).some((t) => t.toLowerCase() === me));
    const section = (title, items, empty) => {
      body.append(h(`<h4>${title}</h4>`));
      if (!items.length) body.append(h(`<p class="muted small">${empty}</p>`));
      for (const it of items) {
        const b = h(`<button class="linkrow ${it.missing ? 'missing' : ''}">${icon('note', 16)}<span>${esc(it.title)}</span>${it.missing ? '<em>create</em>' : ''}</button>`);
        b.onclick = () => ed.openByTitle(it.title);
        body.append(b);
      }
    };
    section('Links from this note', out.map((t) => ({ title: byTitle.get(t.toLowerCase())?.title ?? t, missing: !byTitle.has(t.toLowerCase()) })), 'No links yet.');
    section('Backlinks', back.map((n) => ({ title: n.title })), 'No other note links here yet.');
    const mentions = all.filter((n) => n.id !== ed.note.id && !back.includes(n) && me.length > 2 && noteText(n).toLowerCase().includes(me));
    if (mentions.length) section('Unlinked mentions', mentions.map((n) => ({ title: n.title })), '');
  }

  return { show, refresh, get tab() { return tab; } };
}
