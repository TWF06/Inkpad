# Inkpad — feature spec

Inkpad is a handwriting and PDF notes app for Android tablets and iPads with a stylus / Apple Pencil (Capacitor apps sharing one web code base), also running in desktop browsers.

## Features and status

| Feature | Status | Notes |
|---|---|---|
| Infinite Canvas & A4 notes | ✅ | Notebook type chosen at creation |
| Pen with pressure / adaptive stroke width | ✅ | Pointer Events pressure, velocity fallback, smoothing |
| Highlighter | ✅ | Translucent, drawn under ink |
| Eraser (whole / part) | ✅ | *Whole* removes whole strokes and shapes; *Part* cuts away only what it covers. Never touches text, pictures or PDF pages |
| Lasso select → move / recolor / delete / duplicate | ✅ | |
| Auto-shape | ✅ | Hold pen still at stroke end → line / rect / ellipse / triangle |
| Color set & tool collection | ✅ | Editable palette, width presets |
| Template library | ✅ | Blank, lined, grid, dot, Cornell |
| Text boxes / typing | ✅ | |
| Images | ✅ | Camera button, gallery, drag-drop, paste; move & corner-resize; pen returns after placing |
| Tables | ✅ | Simple rows × cols grid element |
| Layers | ✅ | Add / hide / lock / reorder / rename |
| Bidirectional links | ✅ | `[[Note title]]` in text → link + backlinks panel |
| Smart outline | ✅ | Outline entries per page, jump to |
| Page overview sidebar | ✅ | A4 mode: add / reorder / delete pages |
| Infinite folder system | ✅ | Nested folders, move, rename, search |
| Local storage | ✅ | One `.inkpad` file per note in a folder on the device; no database |
| Local backup | ✅ | Notes are files: copy the folder. Old JSON backups still import via Open file |
| Export | ✅ | PNG per page, PDF via print |
| Timer (countdown / Pomodoro) | ✅ | Floating widget |
| Dark theme | ✅ | Auto / Light / Dark in the library sidebar; only the interface, paper keeps its own colour |
| Deleted notes → device Trash | ✅ | Android 11+: Android's own prompt, then Files app → Trash for 30 days. Deleted for good (after asking) only where there's no Trash |
| Undo / redo, zoom / pan, palm rejection | ✅ | Stylus-only is the default; toggle in toolbar |
| PDF import & annotation | ✅ | PDF.js (vendored); pages on a locked background layer |
| Word / PowerPoint / Excel / CSV / text / Markdown / HTML | ✅ | Converted to a PDF on the device (`src/docconvert.js`), then a normal PDF note. Old binary formats (.doc/.ppt/.xls) get a "save as .docx/PDF" message |
| Open files from device / camera / share sheet | ✅ | File chooser, camera capture, drag-drop, paste, PWA share target |
| iPad app | ✅ | Capacitor iOS project in `ios/` (iPadOS 17.4+); native `NotesFolderPlugin.swift` mirrors the Android plugin. Built with Xcode on a Mac |
| Split screen | ✅ | Two notes, or the same note twice (one shared note and undo history, changes show in both). Drag the bar to resize; top / bottom on an upright tablet. Keyboard goes to the pane last touched |
| Handwriting → text, dictionary, translate, AI | ⏳ | Needs ML / API service |
| Cloud sync | ⏳ | Needs a backend |
| Audio recording | ⏳ | |

## Architecture

- Static web app, no build step. Libraries vendored in `vendor/`: PDF.js, pdf-lib, JSZip, docx-preview. `node server.js` serves it on http://localhost:5173.
- `src/importer.js` — reading pictures / PDFs / backups from the device.
- `src/docconvert.js` — Word (docx-preview), PowerPoint, Excel, CSV, text, Markdown, HTML → page pictures → a PDF (pdf-lib). Laid out in a hidden frame, drawn through SVG `foreignObject`.
- `sw.js` — offline cache + share-target receiver.
- `src/store.js` — notes as files: a user-picked folder (File System Access API) or the app's private folder (OPFS). Only the picked folder's handle is kept in IndexedDB, since browsers can remember it nowhere else.
- `src/library.js` — folder / note browser.
- `src/editor.js` — canvas editor: tools, camera, layers, undo.
- `src/render.js` — stroke geometry and drawing.
- `src/shapes.js` — auto-shape recognition.
- `src/split.js` — split screen: two panes, the note picker, one shared note when both panes show the same file.
- `src/theme.js` — light / dark interface, loaded in `<head>` so it never flashes.
- `src/panels.js` — layers, outline, links, pages, timer.

## Data model

```
Folder { id, name, parentId, createdAt }
Note   { id, title, folderId, kind: 'infinite'|'a4', template, pages: Page[],
         layers: Layer[], outline: {id,title,pageIndex,x,y}[], updatedAt }
Page   { id, elements: Element[] }      // infinite canvas = one page
Layer  { id, name, visible, locked }
Element = Stroke | Shape | Text | Image | Table, each with { id, layerId, type }
Stroke { points: [x,y,pressure][], color, width, tool: 'pen'|'highlighter' }
```
