# Inkpad

A handwriting and PDF notes app for **Android tablets** and **iPads**, made for writing with a stylus or Apple Pencil. It also runs in desktop browsers.

Notes are plain files in a folder on your device: no account, no server, no database. Nothing is ever uploaded.

## Features

**Writing**
- Pen with pressure and smoothing, highlighter, and an eraser that removes whole strokes or only the part it covers
- Lasso to select, move, recolour, duplicate or delete, including dragging items onto another page
- Auto-shape: draw a line, rectangle, ellipse or triangle and hold still to straighten it
- Text boxes, tables and pictures (camera, gallery, paste, drag and drop)
- Palm rejection: the stylus writes, fingers pan and zoom

**Notes**
- A4 page notes (portrait or landscape) or an infinite canvas
- Paper: blank, lined, grid, dot grid or Cornell; white, cream or dark
- Layers, a page overview, an outline, and `[[Note title]]` links with backlinks
- Split screen: two notes side by side, or the same note twice (e.g. read page 1 while writing on page 9)
- Focus timer (countdown / Pomodoro)

**Files**
- Write on PDFs: your writing is saved into the PDF itself and stays editable
- Opens Word, PowerPoint, Excel, CSV, Markdown, text and web pages by turning them into a PDF on the device
- Nested folders, search, and a light, dark or automatic theme
- Deleted notes go to the device's Trash / Recently Deleted
- Share, export pages as PNG, or print / save as PDF

## Platforms

| Platform | How | Notes folder |
|---|---|---|
| Android tablet | Capacitor app (`android/`) | A folder picked once with Android's folder chooser, e.g. `Documents/Inkpad` |
| iPad (iPadOS 17.4+) | Capacitor app (`ios/`), built with Xcode on a Mac | A folder in iCloud Drive or On My iPad, or Inkpad's own folder (Files → On My iPad › Inkpad) |
| Desktop browser | Static web app | A folder picked in the browser (Chrome, Edge), or the browser's private storage |

The apps share one web code base (`index.html`, `styles.css`, `src/`). Each has a small native plugin with the same methods: [NotesFolderPlugin.java](android/app/src/main/java/app/inkpad/notes/NotesFolderPlugin.java) for Android and [NotesFolderPlugin.swift](ios/App/App/NotesFolderPlugin.swift) for iOS. They provide the notes folder, the Trash, sharing, printing and files opened with Inkpad.

## Getting started

Needs [Node.js](https://nodejs.org) 18 or newer.

```sh
git clone https://github.com/TWF06/Inkpad.git
cd Inkpad
npm install
npm start
```

Open http://localhost:5173. There is no build step: the libraries are already in `vendor/`.

Reading and writing files only works on `https://` or `localhost`. On a plain `http://<pc-ip>` address the app explains this instead of opening.

### Android app

Needs Android Studio, or the Android SDK plus JDK 21.

```sh
npm run android:apk
```

The APK is at `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to the tablet and open it to install (allow "install unknown apps" for your file manager), or with the tablet connected over USB:

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run android:open` opens the project in Android Studio instead. After changing anything in `src/`, `styles.css` or `index.html`, run `npm run android:sync` (or `android:apk`) so the app gets the new files.

### iPad app

Needs a **Mac with Xcode** (Apple only allows iOS apps to be built and signed there) and an Apple ID.

```sh
npm run ios:sync
npm run ios:open
```

1. Xcode opens. Click **App** in the left column → **Signing & Capabilities** → *Team*: pick your Apple ID (Xcode → Settings → Accounts to add it). If Xcode says the bundle id `app.inkpad.notes` is taken, change it to one of your own, e.g. `com.yourname.inkpad`.
2. Connect the iPad with a cable, choose it at the top of the Xcode window, and press ▶ Run.
3. The first time, trust your developer certificate on the iPad: Settings → General → VPN & Device Management. Turn on Developer Mode if asked.

With a free Apple ID the app works for 7 days; then run it from Xcode again. A paid Apple Developer account lets it last a year and allows TestFlight and the App Store. After changing the web code, run `npm run ios:sync`.

### Web app

Upload only the app files to a static HTTPS host (GitHub Pages, Netlify, Cloudflare Pages…): `index.html`, `styles.css`, `icon.svg`, `manifest.webmanifest`, `sw.js`, `src/`, `vendor/`. The page carries its own Content-Security-Policy, so no host configuration is needed.

In Chrome on an Android tablet, menu → **Add to Home screen / Install app** installs it. It then works offline and appears in the share sheet (this needs HTTPS).

## Where notes are saved

On first start Inkpad asks where to keep notes:

- **Choose a folder** (recommended). Each note is a file there: an infinite canvas is a `<title>.inkpad` file, and a page note is a PDF with your writing inside it. The app's folder tree is `inkpad-folders.json`. You can see, copy, back up or share the files with the Files app, and change the folder any time from the library sidebar. Subfolders show in the library as folders (marked *on device*) with their notes, PDFs and pictures.
- **Keep them inside the app.** On the iPad this is Inkpad's own folder, which the Files app still shows. On Android and in browsers it is the app's private storage; use *Save a copy* or *Share…* in a note's menu to get a note out.

**Backup:** copy the notes folder elsewhere. Any `.inkpad` file opens with **Open file**.

**Deleting** a note on Android moves it to the device's Trash after Android's own prompt, and on the iPad to Recently Deleted. Restore it from the Files app within 30 days.

## Importing files

Nothing is uploaded: the app uses the device's own file chooser, gallery or camera.

| Where | What you can do |
|---|---|
| Library → **Open file** | Open a PDF, a document (see below), pictures, or an Inkpad file. A PDF becomes a note you can write on; pictures become a note with one picture per page. |
| Note → camera button | Take a photo and put it on the page you're writing on. |
| Note → picture button | Pictures, a photo, or a PDF / document added after the current page. |
| Drag and drop, paste | Drop PDFs or pictures onto the library or a page; paste a picture or text onto the page. |
| Other apps | **Share → Inkpad** (Android) or **Open in… → Inkpad** (iPad) for PDFs and pictures. |

**Documents:** Word (.docx), PowerPoint (.pptx), Excel (.xlsx), CSV, text, Markdown and web pages are turned into a PDF on the device. The PDF is saved next to your notes and opens like any PDF. Word files are cut into pages between lines, each slide is one page, and wide sheets get a landscape page.

The limits: the pages are pictures of the document, so text can't be selected. PowerPoint charts, SmartArt and EMF/WMF pictures aren't drawn, and Word headers and footers are left out. Older formats (.doc, .ppt, .xls, .rtf, .odt) need to be saved as .docx / .pptx / .xlsx or PDF first.

PDF pages sit on a locked **PDF** layer at the bottom, so the pen, eraser and lasso only touch your own writing on top.

## Using it

| Action | How |
|---|---|
| Tools | Pen `P`, Highlighter `H`, Eraser `E`, Lasso `L`, Text `T`, pan: hold `Space` |
| Eraser | *Whole* erases whole strokes, *Part* only what it covers (switch in the eraser's bar) |
| Move between pages | Select with the lasso and drag it onto another page |
| Auto-shape | Draw a shape with the pen, then hold still for half a second |
| Zoom / pan | Pinch and drag with two fingers; Ctrl + scroll / scroll; `Ctrl` `+` `-` `0`; trackpad pinch on iPad |
| Stylus | On by default: the stylus writes, fingers pan and zoom. With no stylus, tap the stylus button to write with a finger |
| Split screen | The split button in a note: pick another note or *This note again*. Drag the bar to resize; ✕ closes that side. Upright, the panes stack |
| Dark theme | Library sidebar → Auto / Light / Dark. Only the app turns dark; pages keep their paper colour |
| Link notes | Type `[[Note title]]` in a text box or table cell; tap it with Lasso or Pan to open it |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` (shared between both sides when a note is open twice) |

## Project layout

```
index.html, styles.css    the app page and its styles
src/                      the app (plain ES modules, no build step)
  app.js                  routing, first-run, window locks
  library.js              folders and notes
  editor.js, render.js    the canvas editor and drawing
  split.js                split screen
  store.js                notes as files (picked folder, app storage, native plugin)
  pdfnote.js, pdfwork.js  PDF notes: writing into PDFs in a worker
  importer.js, docconvert.js  pictures, PDFs and Office documents
  theme.js                light / dark interface
vendor/                   PDF.js, pdf-lib, JSZip, docx-preview, Capacitor runtime
android/, ios/            the Capacitor apps
sw.js                     offline cache and share target (web app)
server.js                 local development server
```

[SPEC.md](SPEC.md) lists every feature with its status, plus the data model.

## Third-party libraries

Bundled in `vendor/`, each with its license file: [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT), [JSZip](https://github.com/Stuk/jszip) (MIT / GPLv3), [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) (Apache-2.0) and [Capacitor](https://capacitorjs.com) (MIT).
