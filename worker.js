// Worker que corre Whisper (transformers.js) fuera del hilo de la interfaz.
import { pipeline, env } from './lib/transformers.min.js';
import { opfsCache } from './model-store.js';

const SAMPLE_RATE = 16000;
// Whisper procesa ventanas de hasta 30 s. Cortamos cada ~28 s en el punto más silencioso.
const MAX_CHUNK_S = 29.5;
const MIN_CHUNK_S = 22;
const SILENCE_RMS = 0.004;

// Chrome no permite cargar código remoto en extensiones: el motor WASM va incluido en /lib.
env.allowLocalModels = false;
env.useWasmCache = false;
// Los modelos se guardan en OPFS (ver model-store.js), no en la Cache Storage.
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = opfsCache;
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('./lib/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
  wasm: new URL('./lib/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href,
};
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 1)
  : 1;

let transcriber = null;
let loadedKey = null;
let webgpuFailed = false;

// Modelos que solo corren en placa de video con soporte de media precisión (fp16).
const GPU_ONLY = {
  'onnx-community/whisper-large-v3-turbo': { encoder_model: 'fp16', decoder_model_merged: 'q4f16' },
};

async function getAdapter() {
  if (webgpuFailed) return null;
  try {
    return (navigator.gpu && (await navigator.gpu.requestAdapter())) || null;
  } catch {
    return null;
  }
}

async function load(model) {
  const adapter = await getAdapter();
  const webgpu = !!adapter;
  const device = webgpu ? 'webgpu' : 'wasm';
  const key = `${model}|${device}`;
  if (transcriber && loadedKey === key) return device;

  if (transcriber) await transcriber.dispose?.();
  transcriber = null;
  loadedKey = null;

  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      post({ type: 'download', file: p.file, loaded: p.loaded, total: p.total });
    }
  };

  if (GPU_ONLY[model]) {
    if (!adapter?.features.has('shader-f16')) {
      throw new Error('La calidad Máxima necesita una placa de video compatible. Elegí otra calidad en Ajustes.');
    }
    transcriber = await pipeline('automatic-speech-recognition', model, {
      device: 'webgpu',
      dtype: GPU_ONLY[model],
      progress_callback,
    });
    loadedKey = key;
    return 'webgpu';
  }

  const dtype = {
    encoder_model: 'fp32',
    decoder_model_merged: webgpu ? 'q4' : 'q8',
  };

  try {
    transcriber = await pipeline('automatic-speech-recognition', model, { device, dtype, progress_callback });
  } catch (err) {
    if (device !== 'webgpu') throw err;
    // Si WebGPU falla (drivers, GPU no soportada), caemos a CPU.
    webgpuFailed = true;
    transcriber = await pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
      progress_callback,
    });
    loadedKey = `${model}|wasm`;
    return 'wasm';
  }
  loadedKey = key;
  return device;
}

function rms(audio, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

// Divide el audio en tramos de <30 s cortando en el momento más silencioso.
function splitAudio(audio) {
  const chunks = [];
  const frame = Math.round(0.1 * SAMPLE_RATE);
  let start = 0;
  while (start < audio.length) {
    const hardEnd = start + Math.round(MAX_CHUNK_S * SAMPLE_RATE);
    if (hardEnd >= audio.length) {
      chunks.push([start, audio.length]);
      break;
    }
    let bestEnd = hardEnd;
    let bestEnergy = Infinity;
    for (let s = start + Math.round(MIN_CHUNK_S * SAMPLE_RATE); s + frame <= hardEnd; s += frame) {
      const e = rms(audio, s, s + frame);
      if (e < bestEnergy) {
        bestEnergy = e;
        bestEnd = s + Math.round(frame / 2);
      }
    }
    chunks.push([start, bestEnd]);
    start = bestEnd;
  }
  return chunks;
}

async function transcribe({ id, audio, language }) {
  const ranges = splitAudio(audio);
  const segments = [];
  const started = performance.now();

  for (let i = 0; i < ranges.length; i++) {
    const [s, e] = ranges[i];
    const offset = s / SAMPLE_RATE;
    const piece = audio.subarray(s, e);
    const duration = piece.length / SAMPLE_RATE;

    // Tramos en silencio: Whisper tiende a "inventar" texto, así que los salteamos.
    if (rms(piece, 0, piece.length) >= SILENCE_RMS) {
      const out = await transcriber(piece, {
        return_timestamps: true,
        task: 'transcribe',
        ...(language ? { language } : {}),
      });
      const parts = out.chunks?.length ? out.chunks : [{ text: out.text, timestamp: [0, duration] }];
      for (const c of parts) {
        const text = (c.text || '').trim();
        if (!text) continue;
        const [a, b] = c.timestamp || [0, duration];
        segments.push({
          start: offset + (a ?? 0),
          end: offset + Math.min(b ?? duration, duration),
          text,
        });
      }
    }

    post({
      type: 'progress',
      id,
      done: i + 1,
      total: ranges.length,
      segments,
      elapsed: (performance.now() - started) / 1000,
    });
  }

  post({ type: 'result', id, segments });
}

function post(msg) {
  self.postMessage(msg);
}

function errorMessage(err) {
  const msg = err?.message || String(err);
  if (err instanceof RangeError || /allocation failed|out of memory|OOM/i.test(msg)) {
    return 'No hay memoria suficiente para este modelo. Cerrá otras pestañas o elegí una calidad menor.';
  }
  return msg;
}

self.addEventListener('message', async ({ data }) => {
  try {
    if (data.type === 'load') {
      const device = await load(data.model);
      post({ type: 'ready', device });
    } else if (data.type === 'transcribe') {
      await transcribe(data);
    }
  } catch (err) {
    post({ type: 'error', id: data.id, message: errorMessage(err) });
  }
});

// Errores que ocurren fuera de nuestras promesas (dentro del motor) también deben llegar al panel,
// si no, la interfaz queda esperando para siempre.
self.addEventListener('unhandledrejection', (e) => {
  e.preventDefault();
  post({ type: 'error', message: errorMessage(e.reason) });
});
