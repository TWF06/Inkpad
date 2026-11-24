// "Save as" for the note being edited: PNG or JPEG pictures, an Inkpad file, print, and for an infinite canvas a PDF.
// Nothing is preselected: you pick the format each time. A page note is a PDF file already, so it has no PDF option.
// On the tablet apps the file goes to the share sheet (Files, Drive, email…); in a browser it downloads.
import * as R from './render.js';
import { noteFileBlob, NOTE_EXT } from './store.js';
import { modal, download, toast } from './ui.js';
import { loadZip } from './docconvert.js';

const SCALE = 2;   // pictures at twice the page size: sharp when zoomed or printed
const PT = 0.75;   // CSS pixels → PDF points
const safe = (s) => (s || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
const toBlob = (canvas, type, q) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('This page is too large to save as a picture'))), type, q));

/**
 * Ask which format and save the note in it.
 * opts: currentPage (index of the page on screen), save() writes pending edits first, print() opens the print screen.
 */
export async function saveAs(note, { currentPage = 0, save, print }) {
  const a4 = note.kind === 'a4', count = note.pages.length;
  const r = await modal({
    title: 'Save as', ok: 'Save',
    fields: [
      { name: 'format', label: 'Format', type: 'choice', value: null, required: true, options: [
        { value: 'png', html: '<b>PNG picture</b><small>Sharp, larger file</small>' },
        { value: 'jpg', html: '<b>JPEG picture</b><small>Smaller file, for photos and chats</small>' },
        ...(note.pdf ? [] : [
          { value: 'pdf', html: '<b>PDF</b><small>Opens anywhere</small>' },
          { value: 'inkpad', html: `<b>Inkpad file</b><small>Editable copy (${NOTE_EXT})</small>` },
        ]),
        { value: 'print', html: '<b>Print</b><small>Or save as PDF from the print screen</small>' },
      ] },
      ...(a4 && count > 1 ? [{ name: 'pages', label: 'Pages', type: 'choice', value: 'one', when: { field: 'format', is: ['png', 'jpg'] }, options: [
        { value: 'one', html: `<b>This page</b><small>Page ${currentPage + 1} of ${count}</small>` },
        { value: 'all', html: `<b>All pages</b><small>${count} pictures in a ZIP file</small>` },
      ] }] : []),
    ],
  });
  if (!r) return;
  const name = safe(note.title);
  try {
    if (r.format === 'print') return print();
    if (r.format === 'inkpad') { await save(); return download(`${name}${NOTE_EXT}`, noteFileBlob(note)); }
    if (r.format === 'pdf') return await savePdf(note, name, save);
    const type = r.format === 'png' ? 'image/png' : 'image/jpeg', ext = r.format;
    const picture = (i) => toBlob(R.renderPageCanvas(note, i, { scale: SCALE }), type, 0.92);
    if (r.pages === 'all') {
      toast(`Making ${count} pictures…`, 60000);
      const JSZip = await loadZip();
      const zip = new JSZip();
      const width = String(count).length;
      for (let i = 0; i < count; i++) zip.file(`${name} p${String(i + 1).padStart(width, '0')}.${ext}`, await picture(i));
      const blob = await zip.generateAsync({ type: 'blob' });
      toast('Pictures ready', 1200);
      return download(`${name} (pages).zip`, blob);
    }
    const i = a4 ? currentPage : 0;
    download(`${name}${a4 && count > 1 ? ` p${i + 1}` : ''}.${ext}`, await picture(i));
  } catch (err) {
    console.error(err);
    toast(err?.message?.includes('too large') ? err.message : 'Couldn’t save the note in that format', 4000);
  }
}

/** An infinite canvas (or a page note not stored as a PDF) as a PDF: one picture per page. */
async function savePdf(note, name, save) {
  toast('Making the PDF…', 60000);
  await save();
  const { PDFDocument } = await import('../vendor/pdf-lib/pdf-lib.esm.min.js');
  const doc = await PDFDocument.create();
  doc.setTitle(note.title || 'Untitled');
  doc.setCreator('Inkpad');
  for (let i = 0; i < note.pages.length; i++) {
    const canvas = R.renderPageCanvas(note, i, { scale: SCALE });
    const k = canvas.width / (note.kind === 'a4' ? R.pageSize(note.pages[i]).w : canvas.width / SCALE);   // pixels per CSS px
    const img = await doc.embedPng(new Uint8Array(await (await toBlob(canvas, 'image/png')).arrayBuffer()));
    const w = (canvas.width / k) * PT, h = (canvas.height / k) * PT;
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  const bytes = await doc.save();
  toast('PDF ready', 1200);
  download(`${name}.pdf`, new Blob([bytes], { type: 'application/pdf' }));
}
