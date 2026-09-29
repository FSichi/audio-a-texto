# Audio a Texto

Extensión de Chrome que transcribe archivos de audio a texto **dentro del navegador**, con el modelo Whisper corriendo en la computadora del usuario. El audio nunca sale de la PC.

## Instalar (modo desarrollador)

1. Abrí `chrome://extensions`.
2. Activá **Modo de desarrollador** (arriba a la derecha).
3. **Cargar descomprimida** → elegí esta carpeta (`audio-a-texto`).
4. Fijá el ícono en la barra y hacé clic: se abre el panel lateral.

La primera transcripción descarga el modelo desde Hugging Face (~210 MB en calidad "Equilibrada"). Después queda guardado y funciona sin descargar nada.

## Cómo funciona

| Archivo | Qué hace |
|---|---|
| `manifest.json` | Manifest V3, panel lateral, CSP con `wasm-unsafe-eval` para el motor de IA. |
| `background.js` | Abre el panel al hacer clic en el ícono. |
| `sidepanel.html/.css/.js` | Interfaz: elegir archivos, progreso, resultados, exportar, historial. Decodifica el audio a 16 kHz mono con la Web Audio API. |
| `worker.js` | Corre Whisper con transformers.js en un Web Worker. Parte el audio en tramos de menos de 30 s cortando en silencios y saltea los tramos mudos. |
| `lib/` | transformers.js 4.3.0 y el motor ONNX Runtime (WASM), incluidos porque Chrome no deja cargar código remoto en extensiones. |

- **Motor:** usa la placa de video (WebGPU) si está disponible y, si no, el procesador (WebAssembly), que es más lento.
- **Modelos:** `onnx-community/whisper-tiny`, `whisper-base` y `whisper-small`.
- **Exporta:** TXT, SRT (subtítulos) y Markdown, con o sin marcas de tiempo.
- **Historial:** guarda las últimas 30 transcripciones en `chrome.storage.local`.

## Próximos pasos posibles

- Transcribir el audio de la pestaña actual (`chrome.tabCapture`).
- Modo "Pro" en la nube (Groq / OpenAI / Deepgram) detrás de un backend propio.
- Modelo `whisper-large-v3-turbo` para máxima precisión con WebGPU.
- Multi-hilo en CPU: agregar `cross_origin_embedder_policy` / `cross_origin_opener_policy` al manifest.
