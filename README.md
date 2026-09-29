# Audio a Texto

Extensión de Chrome que transcribe audio a texto **dentro del navegador**, con el modelo Whisper corriendo en la computadora del usuario. El audio nunca sale de la PC.

## Instalar (modo desarrollador)

1. Abrí `chrome://extensions`.
2. Activá **Modo de desarrollador** (arriba a la derecha).
3. **Cargar descomprimida** → elegí esta carpeta (`audio-a-texto`).
4. Fijá el ícono en la barra y hacé clic: se abre el panel lateral.

Después de cambiar el código, tocá **Recargar** en la tarjeta de la extensión y volvé a abrir el panel.

La primera transcripción con cada calidad descarga el modelo desde Hugging Face. Después queda guardado y funciona sin descargar nada.

## Funciones

- **Archivos:** MP3, WAV, M4A, AAC, FLAC, OGG, OPUS, WEBM y MP4 (se usa el audio). Varios a la vez, en cola.
- **Grabar la pestaña:** captura el audio de la pestaña activa (`chrome.tabCapture`), lo sigue reproduciendo por los parlantes y al detener lo transcribe. Chrome solo lo permite en la pestaña donde se abrió el panel desde el ícono; el contenido con DRM (Netflix, etc.) llega en silencio.
- **Calidades:**

  | Calidad | Modelo | Descarga | Requisitos |
  |---|---|---|---|
  | Rápida | `onnx-community/whisper-tiny` | ~120 MB | — |
  | Equilibrada | `onnx-community/whisper-base` | ~210 MB | — |
  | Precisa | `onnx-community/whisper-small` | ~590 MB | — |
  | Máxima | `onnx-community/whisper-large-v3-turbo` | ~1,5 GB | Placa de video con WebGPU y `shader-f16` |

- **Resultado:** reproductor que resalta el párrafo que suena y salta al tocar un párrafo; copiar; exportar TXT, SRT y Markdown, con o sin marcas de tiempo.
- **Historial:** las últimas 30 transcripciones, con búsqueda (`chrome.storage.local`).
- **Almacenamiento:** en Ajustes se ve cuánto ocupa cada modelo, y se pueden borrar de a uno o todos, además del historial.

## Cómo funciona

| Archivo | Qué hace |
|---|---|
| `manifest.json` | Manifest V3, panel lateral, permisos `tabCapture` y `storage`, CSP con `wasm-unsafe-eval` para el motor de IA. |
| `background.js` | Abre el panel al hacer clic en el ícono. |
| `sidepanel.html/.css/.js` | Interfaz. Decodifica el audio a 16 kHz mono con la Web Audio API, graba la pestaña con `MediaRecorder` y maneja cola, resultados, historial y ajustes. |
| `worker.js` | Corre Whisper con transformers.js en un Web Worker. Parte el audio en tramos de menos de 30 s cortando en silencios y saltea los tramos mudos. |
| `model-store.js` | Guarda los modelos en OPFS (sistema de archivos privado del navegador), enchufado a transformers.js como caché propia. |
| `lib/` | transformers.js 4.3.0 y el motor ONNX Runtime (WASM), incluidos porque Chrome no deja cargar código remoto en extensiones. |

- **Motor:** usa la placa de video (WebGPU) si está disponible y, si no, el procesador (WebAssembly), que es más lento.
- **Por qué OPFS y no la Cache Storage:** la Cache Storage de Chrome tiene un tope por archivo y falla al guardar el encoder de 1,3 GB de la calidad Máxima (y al fallar puede vaciarse entera). OPFS escribe en disco sin ese tope.

## Próximos pasos posibles

- Transcripción en vivo de la pestaña (tramos de ~10 s mientras suena).
- Modo "Pro" en la nube (Groq / OpenAI / Deepgram) detrás de un backend propio.
- Multi-hilo en CPU: agregar `cross_origin_embedder_policy` / `cross_origin_opener_policy` al manifest.
