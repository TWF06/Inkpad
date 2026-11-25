package app.inkpad.notes;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * The notes folder on the tablet, through Android's own folder chooser (Storage Access Framework).
 * The user picks the folder once; Android keeps the permission until the app is uninstalled,
 * so the app can always read and write it afterwards without asking again.
 *
 * Also: files shared to Inkpad from other apps, and printing / saving as PDF.
 */
@CapacitorPlugin(name = "NotesFolder")
public class NotesFolderPlugin extends Plugin {
    private static final String PREFS = "inkpad";
    private static final String KEY = "notesFolder";
    private static final int RW = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

    private final List<Uri> shared = new ArrayList<>();
    private WebView printView; // kept alive until Android has taken the print job

    // ---------- the folder ----------

    private SharedPreferences prefs() { return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    /** The chosen folder, if Android still lets us write to it. */
    private Uri folder() {
        String s = prefs().getString(KEY, null);
        if (s == null) return null;
        Uri tree = Uri.parse(s);
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (p.getUri().equals(tree) && p.isReadPermission() && p.isWritePermission()) return tree;
        }
        return null;
    }

    private Uri folderDoc(Uri tree) { return DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)); }

    private String displayName(Uri doc) {
        try (Cursor c = getContext().getContentResolver().query(doc, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {}
        return "Notes";
    }

    @PluginMethod
    public void current(PluginCall call) {
        JSObject r = new JSObject();
        Uri tree = folder();
        r.put("connected", tree != null && exists(folderDoc(tree)));
        if (tree != null) r.put("name", displayName(folderDoc(tree)));
        call.resolve(r);
    }

    @PluginMethod
    public void pick(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(RW | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, i, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        JSObject r = new JSObject();
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            r.put("picked", false);
            call.resolve(r);
            return;
        }
        Uri tree = data.getData();
        ContentResolver cr = getContext().getContentResolver();
        try {
            cr.takePersistableUriPermission(tree, RW);
        } catch (SecurityException e) {
            call.reject("Android did not allow access to that folder", e);
            return;
        }
        Uri old = folder();
        if (old != null && !old.equals(tree)) {
            try { cr.releasePersistableUriPermission(old, RW); } catch (Exception ignored) {}
        }
        prefs().edit().putString(KEY, tree.toString()).apply();
        r.put("picked", true);
        r.put("name", displayName(folderDoc(tree)));
        call.resolve(r);
    }

    // ---------- files in the folder ----------

    private static final String[] COLS = {
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        DocumentsContract.Document.COLUMN_SIZE,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
    };

    private Uri requireFolder(PluginCall call) {
        Uri tree = folder();
        if (tree == null) call.reject("No notes folder", "NO_FOLDER");
        return tree;
    }

    /** Document id of the child called `name` inside the folder `parentId` (a file, or a folder if dir), or null. */
    private String child(Uri tree, String parentId, String name, boolean dir) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        try (Cursor c = getContext().getContentResolver().query(children, COLS, null, null, null)) {
            while (c != null && c.moveToNext()) {
                if (name.equals(c.getString(1)) && dir == DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(4))) return c.getString(0);
            }
        }
        return null;
    }

    /** Document id of the folder at `dirPath` ("" = the notes folder, "A/B" = a subfolder), or null. */
    private String dirId(Uri tree, String dirPath) {
        String id = DocumentsContract.getTreeDocumentId(tree);
        if (dirPath == null || dirPath.isEmpty()) return id;
        for (String part : dirPath.split("/")) {
            if (part.isEmpty()) continue;
            if (part.equals("..") || part.equals(".")) return null;
            id = child(tree, id, part, true);
            if (id == null) return null;
        }
        return id;
    }

    private static String dirOf(String path) { int i = path.lastIndexOf('/'); return i < 0 ? "" : path.substring(0, i); }
    private static String nameOf(String path) { return path.substring(path.lastIndexOf('/') + 1); }

    /** Document URI of a file at `path` (relative to the notes folder, may be in a subfolder), or null. */
    private Uri find(Uri tree, String path) {
        String parent = dirId(tree, dirOf(path));
        if (parent == null) return null;
        String id = child(tree, parent, nameOf(path), false);
        return id == null ? null : DocumentsContract.buildDocumentUriUsingTree(tree, id);
    }

    private boolean exists(Uri doc) {
        try (Cursor c = getContext().getContentResolver().query(doc, new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID}, null, null, null)) {
            return c != null && c.moveToFirst();
        } catch (Exception e) {
            return false;
        }
    }

    private JSObject info(Uri doc, String name) {
        JSObject o = new JSObject();
        o.put("name", name);
        try (Cursor c = getContext().getContentResolver().query(doc, COLS, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                o.put("lastModified", c.getLong(2));
                o.put("size", c.getLong(3));
            }
        }
        return o;
    }

    private static final int MAX_DEPTH = 6;
    private static final int MAX_ENTRIES = 5000;

    /** Files and subfolders below `parentId`; paths are relative to the notes folder ("A/B/note.inkpad"). */
    private void walk(Uri tree, String parentId, String prefix, int depth, JSArray files, JSArray dirs, int[] count) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        List<String[]> sub = new ArrayList<>();
        try (Cursor c = getContext().getContentResolver().query(children, COLS, null, null, null)) {
            while (c != null && c.moveToNext() && count[0] < MAX_ENTRIES) {
                String name = c.getString(1);
                if (name == null || name.startsWith(".")) continue; // hidden files and folders
                String path = prefix + name;
                count[0]++;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(4))) {
                    JSObject d = new JSObject();
                    d.put("path", path);
                    d.put("name", name);
                    dirs.put(d);
                    sub.add(new String[]{c.getString(0), path});
                } else {
                    JSObject o = new JSObject();
                    o.put("path", path);
                    o.put("name", name);
                    o.put("lastModified", c.getLong(2));
                    o.put("size", c.getLong(3));
                    files.put(o);
                }
            }
        }
        if (depth >= MAX_DEPTH) return;
        for (String[] d : sub) walk(tree, d[0], d[1] + "/", depth + 1, files, dirs, count);
    }

    /** list() -> { files: [{path, name, lastModified, size}], dirs: [{path, name}] }, subfolders included. */
    @PluginMethod
    public void list(PluginCall call) {
        Uri tree = requireFolder(call);
        if (tree == null) return;
        JSArray files = new JSArray();
        JSArray dirs = new JSArray();
        try {
            walk(tree, DocumentsContract.getTreeDocumentId(tree), "", 0, files, dirs, new int[]{0});
        } catch (Exception e) {
            call.reject("Could not list the notes folder", e);
            return;
        }
        JSObject r = new JSObject();
        r.put("files", files);
        r.put("dirs", dirs);
        call.resolve(r);
    }

    @PluginMethod
    public void read(PluginCall call) {
        Uri tree = requireFolder(call);
        if (tree == null) return;
        String name = call.getString("name", "");
        Uri doc = find(tree, name);
        if (doc == null) { call.reject("Not found: " + name, "NOT_FOUND"); return; }
        try (InputStream in = getContext().getContentResolver().openInputStream(doc)) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[65536];
            int n;
            while ((n = in.read(b)) > 0) buf.write(b, 0, n);
            JSObject r = new JSObject();
            r.put("data", buf.toString(StandardCharsets.UTF_8.name()));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not read " + name, e);
        }
    }

    /** write({ name, data, encoding?: 'utf8' | 'base64', mime? }) — creates or replaces the file. */
    @PluginMethod
    public void write(PluginCall call) {
        Uri tree = requireFolder(call);
        if (tree == null) return;
        String name = call.getString("name", "");
        String data = call.getString("data", "");
        boolean base64 = "base64".equals(call.getString("encoding", "utf8"));
        String mime = call.getString("mime", "application/octet-stream");
        ContentResolver cr = getContext().getContentResolver();
        try {
            Uri doc = find(tree, name);
            String dir = dirOf(name);
            if (doc == null) {
                String parent = dirId(tree, dir);
                if (parent == null) throw new Exception("the folder " + dir + " is gone");
                doc = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, parent), mime, nameOf(name));
            }
            if (doc == null) throw new Exception("could not create the file");
            byte[] bytes = base64 ? Base64.decode(data, Base64.DEFAULT) : data.getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = cr.openOutputStream(doc, "wt")) {
                out.write(bytes);
            }
            String actual = displayName(doc); // Android may adjust the name
            JSObject r = info(doc, actual);
            r.put("path", dir.isEmpty() ? actual : dir + "/" + actual);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not save " + name, e);
        }
    }

    /**
     * replace({ name, data (base64), mime }) — replaces a file safely: the new content goes into a hidden temporary
     * file first; only when it is completely written is the old file deleted and the new one given its name.
     * A crash or full storage half-way leaves the old file untouched.
     */
    @PluginMethod
    public void replace(PluginCall call) {
        Uri tree = requireFolder(call);
        if (tree == null) return;
        String name = call.getString("name", "");
        String mime = call.getString("mime", "application/octet-stream");
        ContentResolver cr = getContext().getContentResolver();
        try {
            String dir = dirOf(name), parent = dirId(tree, dir);
            if (parent == null) throw new Exception("the folder " + dir + " is gone");
            Uri parentDoc = DocumentsContract.buildDocumentUriUsingTree(tree, parent);
            String tmpName = "." + nameOf(name) + ".inkpad-tmp";
            Uri old = find(tree, joinPath(dir, tmpName));
            if (old != null) DocumentsContract.deleteDocument(cr, old);
            Uri tmp = DocumentsContract.createDocument(cr, parentDoc, mime, tmpName);
            if (tmp == null) throw new Exception("could not create a temporary file");
            try (OutputStream out = cr.openOutputStream(tmp, "wt")) {
                out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            }
            Uri cur = find(tree, name);
            if (cur != null) DocumentsContract.deleteDocument(cr, cur);
            Uri done = DocumentsContract.renameDocument(cr, tmp, nameOf(name));
            if (done == null) done = tmp;
            JSObject r = info(done, displayName(done));
            r.put("path", joinPath(dir, displayName(done)));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not save " + name, e);
        }
    }

    /** move({ name, to }) — rename and/or move a file to another folder inside the notes folder. */
    @PluginMethod
    public void move(PluginCall call) {
        Uri tree = requireFolder(call);
        if (tree == null) return;
        String name = call.getString("name", ""), to = call.getString("to", "");
        ContentResolver cr = getContext().getContentResolver();
        try {
            Uri doc = find(tree, name);
            if (doc == null) throw new Exception("not found");
            if (!dirOf(name).equals(dirOf(to))) {
                String from = dirId(tree, dirOf(name)), dest = dirId(tree, dirOf(to));
                if (from == null || dest == null) throw new Exception("folder not found");
                Uri moved = DocumentsContract.moveDocument(cr, doc, DocumentsContract.buildDocumentUriUsingTree(tree, from), DocumentsContract.buildDocumentUriUsingTree(tree, dest));
                if (moved != null) doc = moved;
            }
            if (!nameOf(name).equals(nameOf(to))) {
                Uri renamed = DocumentsContract.renameDocument(cr, doc, nameOf(to));
                if (renamed != null) doc = renamed;
            }
            JSObject r = info(doc, displayName(doc));
            r.put("path", joinPath(dirOf(to), displayName(doc)));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not move " + name, e);
        }
    }

    private static String joinPath(String dir, String name) { return dir.isEmpty() ? name : dir + "/" + name; }

    @PluginMethod
    public void remove(PluginCall call) {
        Uri tree = requireFolder(call);
        if (tree == null) return;
        Uri doc = find(tree, call.getString("name", ""));
        try {
            if (doc != null) DocumentsContract.deleteDocument(getContext().getContentResolver(), doc);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not delete", e);
        }
    }

    // ---------- the device's Trash ("Recently deleted") ----------

    private ActivityResultLauncher<IntentSenderRequest> trashLauncher;
    private PluginCall trashCall; // waiting for the answer to Android's "move to trash?" prompt

    /**
     * trash({ names: [...] }) — move files of the notes folder to the device's Trash (Android 11+). Android asks the
     * user first with its own prompt; resolves { trashed: true } when they allowed it, { trashed: false } when not.
     * Rejects with code "UNSUPPORTED" when the device has no Trash for these files (older Android, or a file the
     * media store doesn't know, such as on some SD cards): nothing was changed then.
     * Trashed files stay hidden in the folder as ".trashed-…" for 30 days; restoring them (Files app → Trash) brings
     * them back under their own name, and Inkpad finds them again on its next look at the folder.
     */
    @PluginMethod
    public void trash(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) { call.reject("This Android version has no Trash", "UNSUPPORTED"); return; }
        Uri tree = requireFolder(call);
        if (tree == null) return;
        JSArray names = call.getArray("names");
        List<Uri> media = new ArrayList<>();
        try {
            for (int i = 0; names != null && i < names.length(); i++) {
                Uri doc = find(tree, names.getString(i));
                if (doc == null) continue; // already gone
                Uri m = MediaStore.getMediaUri(getContext(), doc);
                if (m == null) { call.reject("No Trash for " + names.getString(i), "UNSUPPORTED"); return; }
                media.add(m);
            }
        } catch (Exception e) {
            call.reject("No Trash for these files", "UNSUPPORTED", e);
            return;
        }
        JSObject r = new JSObject();
        if (media.isEmpty()) { r.put("trashed", true); call.resolve(r); return; }
        if (trashCall != null) { call.reject("Already asking to move files to the Trash"); return; }
        try {
            PendingIntent pi = MediaStore.createTrashRequest(getContext().getContentResolver(), media, true);
            trashCall = call;
            trashLauncher.launch(new IntentSenderRequest.Builder(pi.getIntentSender()).build());
        } catch (Exception e) {
            trashCall = null;
            call.reject("No Trash for these files", "UNSUPPORTED", e);
        }
    }

    private void trashAnswered(ActivityResult result) {
        PluginCall call = trashCall;
        trashCall = null;
        if (call == null) return;
        JSObject r = new JSObject();
        r.put("trashed", result.getResultCode() == Activity.RESULT_OK);
        call.resolve(r);
    }

    // ---------- files shared to Inkpad from other apps ----------

    @Override
    public void load() {
        // registered here, while the activity is being created (Android allows it only before it starts)
        trashLauncher = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), this::trashAnswered);
        collect(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (collect(intent)) notifyListeners("shared", new JSObject());
    }

    /**
     * Only files another app hands over through its own content provider. Any app can send Inkpad an intent, so a
     * file:// path or a content:// address of Inkpad's own provider would make Inkpad copy its own private files
     * (preferences, WebView data, the cache) into the notes folder where the sender could read them.
     */
    private boolean acceptable(Uri u) {
        if (u == null || !ContentResolver.SCHEME_CONTENT.equals(u.getScheme())) return false;
        String auth = u.getAuthority();
        return auth != null && !auth.startsWith(getContext().getPackageName());
    }

    private static final int MAX_SHARED = 20;

    private boolean collect(Intent intent) {
        if (intent == null || intent.getAction() == null) return false;
        String a = intent.getAction();
        boolean got = false;
        List<Uri> in = new ArrayList<>();
        try {
            if (Intent.ACTION_SEND.equals(a)) {
                Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) in.add(u);
            } else if (Intent.ACTION_SEND_MULTIPLE.equals(a)) {
                ArrayList<Uri> us = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (us != null) in.addAll(us);
            } else if (Intent.ACTION_VIEW.equals(a) && intent.getData() != null) {
                in.add(intent.getData());
            }
        } catch (Exception ignored) {} // a malformed intent from another app must not crash Inkpad
        for (Uri u : in) {
            if (shared.size() >= MAX_SHARED) break;
            if (acceptable(u)) { shared.add(u); got = true; }
        }
        if (got) getActivity().setIntent(new Intent(Intent.ACTION_MAIN)); // don't open them again after a restart
        return got;
    }

    /** Copy a document into the app's cache so the web side can read it with Capacitor.convertFileSrc. */
    private JSObject toCache(Uri u, String name) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        File dir = new File(getContext().getCacheDir(), "shared");
        dir.mkdirs();
        // the web side reads each copy straight away: older copies are no longer needed
        File[] old = dir.listFiles();
        long cutoff = System.currentTimeMillis() - 2 * 60 * 1000;
        if (old != null) for (File o : old) if (o.lastModified() < cutoff) o.delete();
        File f = new File(dir, System.currentTimeMillis() + "-" + name.replaceAll("[\\\\/]", "_"));
        try (InputStream in = cr.openInputStream(u); OutputStream o = new FileOutputStream(f)) {
            byte[] b = new byte[65536];
            int n;
            while ((n = in.read(b)) > 0) o.write(b, 0, n);
        }
        JSObject x = new JSObject();
        x.put("path", f.getAbsolutePath());
        x.put("name", name);
        x.put("mime", cr.getType(u));
        return x;
    }

    /** copyToCache({ name }) — a PDF or picture in the notes folder, ready to be opened. */
    @PluginMethod
    public void copyToCache(PluginCall call) {
        Uri tree = requireFolder(call);
        if (tree == null) return;
        String name = call.getString("name", "");
        Uri doc = find(tree, name);
        if (doc == null) { call.reject("Not found: " + name, "NOT_FOUND"); return; }
        try {
            call.resolve(toCache(doc, nameOf(name)));
        } catch (Exception e) {
            call.reject("Could not open " + name, e);
        }
    }

    /** Copies shared files into the app's cache and returns their paths, to be read with Capacitor.convertFileSrc. */
    @PluginMethod
    public void takeShared(PluginCall call) {
        JSArray out = new JSArray();
        ContentResolver cr = getContext().getContentResolver();
        for (Uri u : new ArrayList<>(shared)) {
            String name = "shared";
            try (Cursor c = cr.query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst() && c.getString(0) != null) name = c.getString(0);
            } catch (Exception ignored) {}
            try { out.put(toCache(u, name)); } catch (Exception ignored) {}
        }
        shared.clear();
        JSObject r = new JSObject();
        r.put("files", out);
        call.resolve(r);
    }

    // ---------- share ----------

    /**
     * share({ name?, data?, filename, mime }) — open Android's Share menu (Drive, email, chat apps, Files…) for a file:
     * a file in the notes folder (name = its path there) or bytes from the web side (data, base64).
     * The file is copied into the app's cache and handed over through the FileProvider, read-only.
     */
    @PluginMethod
    public void share(PluginCall call) {
        String filename = call.getString("filename", "Inkpad").replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", " ").trim();
        if (filename.isEmpty() || filename.matches("\\.+")) filename = "Inkpad";
        String mime = call.getString("mime", "application/octet-stream");
        try {
            File dir = new File(getContext().getCacheDir(), "outbox");
            dir.mkdirs();
            File[] old = dir.listFiles();   // earlier shares: the receiving app has had its copy by now
            long cutoff = System.currentTimeMillis() - 10 * 60 * 1000;
            if (old != null) for (File o : old) if (o.lastModified() < cutoff) o.delete();
            File sub = new File(dir, String.valueOf(System.currentTimeMillis()));
            sub.mkdirs();
            File f = new File(sub, filename);   // its own folder, so the receiver sees the real file name
            String name = call.getString("name", null);
            if (name != null) {
                Uri tree = requireFolder(call);
                if (tree == null) return;
                Uri doc = find(tree, name);
                if (doc == null) { call.reject("Not found: " + name, "NOT_FOUND"); return; }
                try (InputStream in = getContext().getContentResolver().openInputStream(doc); OutputStream o = new FileOutputStream(f)) {
                    byte[] b = new byte[65536];
                    int n;
                    while ((n = in.read(b)) > 0) o.write(b, 0, n);
                }
            } else {
                try (OutputStream o = new FileOutputStream(f)) { o.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT)); }
            }
            Uri uri = androidx.core.content.FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.putExtra(Intent.EXTRA_TITLE, filename);
            send.setClipData(android.content.ClipData.newRawUri(filename, uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, filename);
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().runOnUiThread(() -> {
                try { getActivity().startActivity(chooser); call.resolve(); }
                catch (Exception e) { call.reject("Nothing can share this file", e); }
            });
        } catch (Exception e) {
            call.reject("Could not share " + filename, e);
        }
    }

    // ---------- print / save as PDF ----------

    @PluginMethod
    public void print(PluginCall call) {
        String html = call.getString("html", "");
        String title = call.getString("title", "Inkpad");
        getActivity().runOnUiThread(() -> {
            WebView v = new WebView(getActivity());
            // the pages are plain pictures: this view needs no script and no access to files on the device
            v.getSettings().setJavaScriptEnabled(false);
            v.getSettings().setAllowFileAccess(false);
            v.getSettings().setAllowContentAccess(false);
            printView = v;
            v.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                    pm.print(title, view.createPrintDocumentAdapter(title), new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
                    call.resolve();
                }
            });
            v.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        });
    }
}
