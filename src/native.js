// When Inkpad runs as the Android or iPad app (Capacitor), these reach the native side; in a browser they're unused.
const cap = window.Capacitor;

export const isNative = !!cap?.isNativePlatform?.();
/** 'android' | 'ios' | 'web' */
export const platform = isNative ? cap.getPlatform() : 'web';
export const isIOS = platform === 'ios';
export const isAndroid = platform === 'android';

/** Native plugin (android/app/src/main/java/app/inkpad/notes/NotesFolderPlugin.java). */
export const NotesFolder = isNative ? cap.registerPlugin('NotesFolder') : null;

/** A file the native side put in the app's cache → a File the importer can read. */
export async function nativeFile({ path, name, mime }) {
  const blob = await (await fetch(cap.convertFileSrc(path))).blob();
  return new File([blob], name, { type: mime || blob.type });
}

export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
