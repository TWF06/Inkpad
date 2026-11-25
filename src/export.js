// "Save as" for the note being edited: its own file (the PDF the note is, or an Inkpad file for an infinite canvas),
// PDF, or PNG pictures; or print. Nothing is preselected: you pick each time.
// On the tablet apps the file goes to the share sheet (Files, Drive, email…); in a browser it downloads.
import * as R from './render.js';
import { store, noteFileBlob, NOTE_EXT } from './store.js';
import { modal, download, shareFile, toast } from './ui.js';
import { isNative } from './native.js';

// JSZip (vendored, a classic script) for "all pages as a ZIP"
let zipLib;
const loadZip = () => (zipLib ??= new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = new URL('../vendor/jszip/jszip.min.js', import.meta.url).href;
  s.onload = () => res(window.JSZip);
  s.onerror = () => { zipLib = null; rej(new Error('Could not load the ZIP library')); };
  document.head.append(s);
}));

const SCALE = 2;   // pictures at twice the page size: sharp when zoomed or printed
const PT = 0.75;   // CSS pixels → PDF points
const KIND = { '.pdf': ['PDF', 'application/pdf'] };
const safe = (s) => (s || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
const toBlob = (canvas, type, q) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('This page is too large to save as a picture'))), type, q));

/** Every page drawn completely: the pictures on it (PDF pages too) loaded first. */
async function pageCanvas(note, i) {
  await R.preloadImages(note.pages[i].elements.filter((e) => e.type === 'image').map((e) => e.src));
  return R.renderPageCanvas(note, i, { scale: SCALE });
}

/**
 * Ask which format and save the note in it.
 * opts: currentPage (index of the page on screen), save() writes pending edits first, print() opens the print screen.
 */
export async function saveAs(note, { currentPage = 0, save, print }) {
  const a4 = note.kind === 'a4', count = note.pages.length;
  const ext = note.pdf ? (/\.[a-z0-9]+$/i.exec(note.pdf)?.[0] || '.pdf').toLowerCase() : NOTE_EXT;
  const [kindName] = KIND[ext] || ['Inkpad file'];
  const r = await modal({
    title: 'Save as', ok: 'Save',
    fields: [
      { name: 'format', label: 'Format', type: 'choice', value: null, required: true, options: [
        { value: 'own', html: `<b>${kindName} (${ext})</b><small>${note.pdf ? 'This note’s own file, with your writing' : 'Editable copy of this note'}</small>` },
        ...(ext !== '.pdf' ? [{ value: 'pdf', html: '<b>PDF</b><small>Opens anywhere</small>' }] : []),
        { value: 'png', html: '<b>PNG picture</b><small>One picture per page</small>' },
        { value: 'print', html: '<b>Print</b><small>Or save as PDF from the print screen</small>' },
      ] },
      ...(a4 && count > 1 ? [{ name: 'pages', label: 'Pages', type: 'choice', value: 'one', when: { field: 'format', is: 'png' }, options: [
        { value: 'one', html: `<b>This page</b><small>Page ${currentPage + 1} of ${count}</small>` },
        { value: 'all', html: `<b>All pages</b><small>${count} pictures in a ZIP file</small>` },
      ] }] : []),
    ],
  });
  if (!r) return;
  const name = safe(note.title);
  try {
    if (r.format === 'print') return print();
    if (r.format === 'own') return await saveOwn(note, name, ext, save);
    if (r.format === 'pdf') return await savePdf(note, name, save);
    const picture = async (i) => toBlob(await pageCanvas(note, i), 'image/png');
    if (r.pages === 'all') {
      toast(`Making ${count} pictures…`, 60000);
      const JSZip = await loadZip();
      const zip = new JSZip();
      const width = String(count).length;
      for (let i = 0; i < count; i++) zip.file(`${name} p${String(i + 1).padStart(width, '0')}.png`, await picture(i));
      const blob = await zip.generateAsync({ type: 'blob' });
      toast('Pictures ready', 1200);
      return download(`${name} (pages).zip`, blob);
    }
    const i = a4 ? currentPage : 0;
    download(`${name}${a4 && count > 1 ? ` p${i + 1}` : ''}.png`, await picture(i));
  } catch (err) {
    console.error(err);
    toast(err?.message?.includes('too large') ? err.message : 'Couldn’t save the note in that format', 4000);
  }
}

/** The note's own file: the PDF with the latest writing in it, or an Inkpad file. */
async function saveOwn(note, name, ext, save) {
  await save();
  if (!note.pdf) return download(`${name}${NOTE_EXT}`, noteFileBlob(note));
  toast('Getting the file ready…', 60000);
  await store.flush(note);
  await (await import('./pdfnote.js')).settled(note.id);
  toast('Ready', 1000);
  if (isNative) return shareFile(`${name}${ext}`, { path: note.pdf }, KIND[ext]?.[1] || 'application/octet-stream');
  return download(`${name}${ext}`, await store.openDocument(note.pdf));
}

/** A PDF of the note as it looks in Inkpad: one picture per page. */
async function savePdf(note, name, save) {
  toast('Making the PDF…', 60000);
  await save();
  const { PDFDocument } = await import('../vendor/pdf-lib/pdf-lib.esm.min.js');
  const doc = await PDFDocument.create();
  doc.setTitle(note.title || 'Untitled');
  doc.setCreator('Inkpad');
  for (let i = 0; i < note.pages.length; i++) {
    const canvas = await pageCanvas(note, i);
    const k = canvas.width / (note.kind === 'a4' ? R.pageSize(note.pages[i]).w : canvas.width / SCALE);   // pixels per CSS px
    const img = await doc.embedJpg(new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer()));
    const w = (canvas.width / k) * PT, h = (canvas.height / k) * PT;
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    canvas.width = canvas.height = 0;
  }
  const bytes = await doc.save();
  toast('PDF ready', 1200);
  download(`${name}.pdf`, new Blob([bytes], { type: 'application/pdf' }));
}
