// Almacenamiento de modelos en el sistema de archivos privado del navegador (OPFS).
//
// La Cache Storage de Chrome tiene un tope por archivo y falla con el encoder de 1,3 GB
// de la calidad Máxima (y al fallar puede vaciarse entera). OPFS escribe en disco sin ese tope.
// transformers.js lo usa como caché propia (env.customCache): solo necesita match() y put().
//
// Estructura: models/<org>__<repo>/<ruta del archivo con "/" cambiado por "__">

const ROOT = 'models';
const LEGACY_CACHE = 'transformers-cache';

function locate(key) {
  const m = key.match(/huggingface\.co\/([^/]+)\/([^/]+)\/resolve\/[^/]+\/(.+)$/);
  if (m) return { dir: `${m[1]}__${m[2]}`, name: m[3].replaceAll('/', '__') };
  return { dir: '_otros', name: encodeURIComponent(key) };
}

async function modelsDir(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT, { create });
}

export const opfsCache = {
  async match(key) {
    try {
      const { dir, name } = locate(key);
      const folder = await (await modelsDir(false)).getDirectoryHandle(dir);
      const file = await (await folder.getFileHandle(name)).getFile();
      // El File se lee desde disco a medida que se consume: no se copia entero a memoria.
      return new Response(file, { headers: { 'content-length': String(file.size) } });
    } catch {
      return undefined;
    }
  },

  async put(key, response, progress_callback) {
    const { dir, name } = locate(key);
    const folder = await (await modelsDir(true)).getDirectoryHandle(dir, { create: true });
    // Se escribe en un .part y se renombra al final: una descarga cortada nunca queda como válida.
    const partName = `${name}.part`;
    const part = await folder.getFileHandle(partName, { create: true });
    try {
      const total = Number(response.headers.get('content-length')) || 0;
      let loaded = 0;
      const counter = new TransformStream({
        transform(chunk, controller) {
          loaded += chunk.byteLength;
          progress_callback?.({ progress: total ? (loaded / total) * 100 : 0, loaded, total });
          controller.enqueue(chunk);
        },
      });
      await response.body.pipeThrough(counter).pipeTo(await part.createWritable());
      await part.move(name);
    } catch (err) {
      await folder.removeEntry(partName).catch(() => {});
      throw err;
    }
  },
};

/** Devuelve Map<id del modelo ("org/repo"), bytes ocupados>. */
export async function listModels() {
  const usage = new Map();
  let root;
  try {
    root = await modelsDir(false);
  } catch {
    return usage;
  }
  for await (const [dirName, folder] of root.entries()) {
    if (folder.kind !== 'directory') continue;
    let bytes = 0;
    for await (const [fileName, handle] of folder.entries()) {
      if (handle.kind === 'file' && !fileName.endsWith('.part')) bytes += (await handle.getFile()).size;
    }
    if (bytes) usage.set(dirName.replace('__', '/'), bytes);
  }
  return usage;
}

export async function deleteModel(id) {
  try {
    await (await modelsDir(false)).removeEntry(id.replace('/', '__'), { recursive: true });
  } catch {}
}

export async function clearModels() {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(ROOT, { recursive: true }).catch(() => {});
  // Versiones anteriores guardaban los modelos en la Cache Storage.
  if ('caches' in self) await caches.delete(LEGACY_CACHE);
}
