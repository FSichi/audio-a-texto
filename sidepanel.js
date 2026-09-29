import { listModels, deleteModel as removeModel, clearModels } from './model-store.js';

const SAMPLE_RATE = 16000;
const HISTORY_LIMIT = 30;

const MODELS = {
  'onnx-community/whisper-tiny': 'Rápida',
  'onnx-community/whisper-base': 'Equilibrada',
  'onnx-community/whisper-small': 'Precisa',
  'onnx-community/whisper-large-v3-turbo': 'Máxima',
};
const DEFAULT_MODEL = 'onnx-community/whisper-base';
// Tamaño conocido de descarga: los archivos se piden de a uno y sin esto la barra "retrocede".
const DOWNLOAD_BYTES = { 'onnx-community/whisper-large-v3-turbo': 1.47e9 };

const $ = (sel, root = document) => root.querySelector(sel);
const els = {
  back: $('#back'),
  title: $('#title'),
  openHistory: $('#open-history'),
  openSettings: $('#open-settings'),
  settings: $('#settings'),
  language: $('#language'),
  summary: $('#summary'),
  drop: $('#drop'),
  file: $('#file'),
  job: $('#job'),
  jobTitle: $('#job-title'),
  jobDetail: $('#job-detail'),
  jobPreview: $('#job-preview'),
  progressFill: $('#progress-fill'),
  cancel: $('#cancel'),
  results: $('#results'),
  viewHome: $('#view-home'),
  viewHistory: $('#view-history'),
  historySearch: $('#history-search'),
  historyList: $('#history-list'),
  historyEmpty: $('#history-empty'),
  engine: $('#engine'),
  engineDot: $('#engine-dot'),
  toast: $('#toast'),
  tpl: $('#result-tpl'),
  optMax: $('#opt-max'),
  maxNote: $('#max-note'),
  storageTotal: $('#storage-total'),
  modelList: $('#model-list'),
  clearModels: $('#clear-models'),
  clearHistory: $('#clear-history'),
  record: $('#record'),
  recorder: $('#recorder'),
  recTime: $('#rec-time'),
  recLevel: $('#rec-level'),
  recStop: $('#rec-stop'),
  recDiscard: $('#rec-discard'),
};

// ---------- Íconos (trazos estilo Lucide) ----------
const ICONS = {
  back: '<path d="m15 18-6-6 6-6"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  upload: '<path d="M12 15V3m0 0-4 4m4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
};

function icon(name) {
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach((el) => {
    el.outerHTML = icon(el.dataset.icon);
  });
}

// ---------- Almacenamiento (chrome.storage o localStorage si se abre como página) ----------
const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage?.local;
const store = {
  async get(key, fallback) {
    if (hasChromeStorage) {
      const r = await chrome.storage.local.get(key);
      return r[key] ?? fallback;
    }
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  async set(key, value) {
    if (hasChromeStorage) return chrome.storage.local.set({ [key]: value });
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

// ---------- Ajustes ----------
function selectedModel() {
  return $('input[name="model"]:checked').value;
}

function updateSummary() {
  const lang = els.language.selectedOptions[0].textContent.replace('Detectar automáticamente', 'Idioma automático');
  els.summary.textContent = `${lang} · Calidad ${MODELS[selectedModel()].toLowerCase()}`;
}

function toggleSettings(open = els.settings.hidden) {
  els.settings.hidden = !open;
  els.openSettings.setAttribute('aria-expanded', String(open));
  if (open) renderStorage();
}

// La calidad Máxima (large-v3-turbo) solo corre en placas de video con fp16.
async function checkMaxSupport() {
  let ok = false;
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    ok = !!adapter?.features.has('shader-f16');
  } catch {}
  if (ok) return;
  const radio = $('input', els.optMax);
  radio.disabled = true;
  els.optMax.classList.add('disabled');
  els.optMax.title = 'Tu placa de video no es compatible con esta calidad';
  els.maxNote.textContent = 'No disponible aquí';
  if (radio.checked) {
    $(`input[name="model"][value="${DEFAULT_MODEL}"]`).checked = true;
    updateSummary();
  }
}

// ---------- Worker con el modelo ----------
let worker = null;
let loadedModel = null;
let pending = null; // { resolve, reject, onEvent }

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', ({ data }) => {
    if (!pending) return;
    if (data.type === 'error') {
      const p = pending;
      pending = null;
      p.reject(new Error(data.message));
    } else if (data.type === 'ready' || data.type === 'result') {
      const p = pending;
      pending = null;
      p.resolve(data);
    } else {
      pending.onEvent?.(data);
    }
  });
  worker.addEventListener('error', (e) => {
    if (!pending) return;
    const p = pending;
    pending = null;
    p.reject(new Error(e.message || 'Falló el motor de transcripción.'));
  });
  return worker;
}

function request(msg, transfer = [], onEvent) {
  return new Promise((resolve, reject) => {
    pending = { resolve, reject, onEvent };
    getWorker().postMessage(msg, transfer);
  });
}

class Cancelled extends Error {}

function cancel() {
  if (worker) worker.terminate();
  worker = null;
  loadedModel = null;
  queue.length = 0;
  cancelled = true;
  if (pending) {
    const p = pending;
    pending = null;
    p.reject(new Cancelled());
  }
}

function setEngine(device) {
  const gpu = device === 'webgpu';
  els.engine.textContent = gpu ? 'Placa de video' : 'Procesador';
  els.engine.title = gpu ? 'WebGPU: rápido' : 'WebAssembly: más lento';
  els.engineDot.className = `dot ${gpu ? 'gpu' : 'cpu'}`;
}

async function ensureModel(model) {
  if (loadedModel === model) return;
  const files = new Map();
  // Si ya está en disco, los eventos de progreso son de lectura, no de descarga.
  const downloaded = (await listModels()).has(model);
  showJob('Preparando el modelo de IA', downloaded ? 'Cargándolo desde el disco…' : 'Solo la primera vez', null);
  const { device } = await request({ type: 'load', model }, [], (ev) => {
    if (ev.type !== 'download') return;
    files.set(ev.file, ev);
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    total = Math.max(total, DOWNLOAD_BYTES[model] ?? 0);
    if (loaded >= total * 0.995) {
      // Archivos listos: falta cargarlo en memoria, que en modelos grandes lleva unos segundos.
      showJob('Preparando el modelo de IA', 'Cargándolo en memoria…', null);
    } else if (downloaded) {
      showJob('Cargando el modelo de IA', `${Math.round((loaded / total) * 100)} %`, loaded / total);
    } else {
      showJob('Descargando el modelo de IA', `${formatSize(loaded)} de ${formatSize(total)} · solo la primera vez`, loaded / total);
    }
  });
  loadedModel = model;
  setEngine(device);
}

// ---------- Audio ----------
async function decodeAudio(file) {
  const buf = await file.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const decoded = await ctx.decodeAudioData(buf);
    const n = decoded.numberOfChannels;
    const mono = new Float32Array(decoded.length);
    for (let c = 0; c < n; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / n;
    }
    return mono;
  } finally {
    ctx.close();
  }
}

// ---------- Cola de archivos ----------
const queue = [];
let busy = false;
let cancelled = false;

function enqueue(files) {
  const list = [...files].filter((f) => f.type.startsWith('audio/') || f.type.startsWith('video/') || /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm|mp4)$/i.test(f.name));
  if (!list.length) {
    toast('Ese archivo no parece ser un audio');
    return;
  }
  queue.push(...list);
  toggleSettings(false);
  if (!busy) runQueue();
}

async function runQueue() {
  busy = true;
  cancelled = false;
  els.drop.classList.add('busy');
  while (queue.length && !cancelled) {
    const file = queue.shift();
    try {
      await processFile(file);
    } catch (err) {
      if (err instanceof Cancelled) break;
      console.error(err);
      renderError(file.name, err.message);
    }
  }
  busy = false;
  els.drop.classList.remove('busy');
  els.job.hidden = true;
  updateDropSize();
}

async function processFile(file) {
  const more = () => (queue.length ? ` · ${queue.length} en cola` : '');
  showJob(file.name, `Leyendo el audio${more()}`, null);

  let audio;
  try {
    audio = await decodeAudio(file);
  } catch {
    throw new Error('No se pudo leer el archivo. Probá con otro formato (MP3 o WAV).');
  }
  if (cancelled) throw new Cancelled();
  const duration = audio.length / SAMPLE_RATE;

  const model = selectedModel();
  await ensureModel(model);

  const id = crypto.randomUUID();
  const language = els.language.value || null;
  showJob(file.name, `Transcribiendo${more()}`, 0);

  const { segments } = await request({ type: 'transcribe', id, audio, language }, [audio.buffer], (ev) => {
    if (ev.type !== 'progress') return;
    const remaining = (ev.elapsed / ev.done) * (ev.total - ev.done);
    const eta = ev.done < ev.total ? ` · quedan ~${formatDuration(remaining)}` : '';
    showJob(file.name, `${Math.round((ev.done / ev.total) * 100)} %${eta}${more()}`, ev.done / ev.total);
    const last = ev.segments.slice(-3).map((s) => s.text).join(' ');
    els.jobPreview.textContent = last;
  });

  const item = {
    id,
    name: file.name,
    duration,
    date: new Date().toISOString(),
    language: language || 'auto',
    model: model.split('/').pop(),
    segments,
  };
  const card = renderResult(item, {
    audioUrl: URL.createObjectURL(file),
    onRemove: (c) => {
      c.remove();
      updateDropSize();
    },
  });
  els.results.prepend(card);
  await addToHistory(item);
}

// ---------- Estado ----------
function showJob(title, detail = '', progress = null) {
  els.job.hidden = false;
  els.jobTitle.textContent = title;
  els.jobDetail.textContent = detail;
  if (progress === 0 || progress == null) els.jobPreview.textContent = '';
  if (progress == null) {
    els.progressFill.classList.add('indeterminate');
    els.progressFill.style.width = '';
  } else {
    els.progressFill.classList.remove('indeterminate');
    els.progressFill.style.width = `${Math.round(progress * 100)}%`;
  }
}

function updateDropSize() {
  els.drop.classList.toggle('compact', els.results.children.length > 0);
}

let toastTimer;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 1800);
}

// ---------- Formato del texto ----------
function toParagraphs(segments) {
  const paras = [];
  let cur = null;
  let prevEnd = 0;
  for (const s of segments) {
    const gap = s.start - prevEnd;
    const long = cur && cur.text.length > 250 && /[.?!…]$/.test(cur.text);
    if (!cur || gap > 1 || long) {
      cur = { start: s.start, end: s.end, text: s.text };
      paras.push(cur);
    } else {
      cur.text += ' ' + s.text;
      cur.end = s.end;
    }
    prevEnd = s.end;
  }
  return paras;
}

function clock(sec, withMs = false) {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  if (withMs) return `${pad(h)}:${pad(m)}:${pad(s)},${pad(Math.round((total % 1) * 1000) % 1000, 3)}`;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatDuration(sec) {
  if (!isFinite(sec)) return '…';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function wordCount(item) {
  return item.segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
}

function buildExport(item, format, withTimes) {
  const paras = toParagraphs(item.segments);
  if (format === 'srt') {
    return item.segments
      .map((s, i) => `${i + 1}\n${clock(s.start, true)} --> ${clock(Math.max(s.end, s.start + 0.5), true)}\n${s.text}\n`)
      .join('\n');
  }
  if (format === 'md') {
    const date = new Date(item.date).toLocaleString('es-AR');
    const lines = paras.map((p) => (withTimes ? `**[${clock(p.start)}]** ${p.text}` : p.text));
    return `# ${item.name}\n\n_Transcripto el ${date} · duración ${clock(item.duration)}_\n\n${lines.join('\n\n')}\n`;
  }
  return paras.map((p) => (withTimes ? `[${clock(p.start)}] ${p.text}` : p.text)).join('\n\n') + '\n';
}

function download(item, format, withTimes) {
  const content = buildExport(item, format, withTimes);
  const type = format === 'md' ? 'text/markdown' : 'text/plain';
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${item.name.replace(/\.[^.]+$/, '')}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Descargando ${format.toUpperCase()}`);
}

// ---------- Tarjetas de resultado ----------
function renderResult(item, { audioUrl = null, onRemove }) {
  const card = els.tpl.content.firstElementChild.cloneNode(true);
  hydrateIcons(card);
  const textEl = $('.text', card);
  const timesBtn = $('.times', card);

  $('.name', card).textContent = item.name;
  $('.name', card).title = item.name;
  $('.meta', card).textContent = `${clock(item.duration)} · ${wordCount(item)} palabras · ${formatDate(item.date)}`;

  // Texto en párrafos, con marca de tiempo por párrafo.
  const paras = toParagraphs(item.segments);
  const paraEls = paras.map((p) => {
    const el = document.createElement('p');
    el.className = 'para';
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = clock(p.start);
    el.append(ts, p.text);
    textEl.append(el);
    return el;
  });
  if (!paras.length) textEl.innerHTML = '<p class="para no-speech">No se detectó voz en este audio.</p>';

  let showTimes = false;
  timesBtn.addEventListener('click', () => {
    showTimes = !showTimes;
    textEl.classList.toggle('show-times', showTimes);
    timesBtn.setAttribute('aria-pressed', String(showTimes));
  });

  if (audioUrl) setupPlayer(card, audioUrl, item.duration, paras, paraEls);

  const copyBtn = $('.copy', card);
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(buildExport(item, 'txt', showTimes).trim());
    toast('Texto copiado');
  });
  card.querySelectorAll('.dl').forEach((btn) =>
    btn.addEventListener('click', () => download(item, btn.dataset.format, showTimes)),
  );
  $('.remove', card).addEventListener('click', () => {
    card.dispatchEvent(new Event('dispose'));
    onRemove(card);
  });
  return card;
}

// Reproductor: sigue la lectura resaltando el párrafo y permite saltar con un clic.
const players = new Set();

function setupPlayer(card, url, duration, paras, paraEls) {
  const player = $('.player', card);
  const playBtn = $('.play', card);
  const seek = $('.seek', card);
  const time = $('.time', card);
  const audio = new Audio(url);
  // Las grabaciones WebM no traen duración en el archivo: usamos la del audio decodificado.
  const total = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration);
  player.hidden = false;

  const setPlayIcon = () => {
    playBtn.innerHTML = icon(audio.paused ? 'play' : 'pause');
    playBtn.title = audio.paused ? 'Reproducir' : 'Pausar';
  };
  setPlayIcon();

  playBtn.addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
  players.add(audio);
  audio.addEventListener('play', () => {
    // Solo un audio sonando a la vez.
    players.forEach((other) => other !== audio && other.pause());
    setPlayIcon();
  });
  audio.addEventListener('pause', setPlayIcon);
  audio.addEventListener('ended', setPlayIcon);

  let active = -1;
  audio.addEventListener('timeupdate', () => {
    const t = audio.currentTime;
    seek.value = String(Math.round((t / total()) * 1000));
    time.textContent = clock(t);
    let idx = -1;
    for (let i = 0; i < paras.length && paras[i].start <= t + 0.05; i++) idx = i;
    if (idx !== active) {
      paraEls[active]?.classList.remove('active');
      paraEls[idx]?.classList.add('active');
      if (!audio.paused) paraEls[idx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      active = idx;
    }
  });
  seek.addEventListener('input', () => {
    audio.currentTime = (Number(seek.value) / 1000) * total();
  });

  card.addEventListener('dispose', () => {
    audio.pause();
    players.delete(audio);
    URL.revokeObjectURL(url);
  });

  paraEls.forEach((el, i) => {
    el.classList.add('seekable');
    el.title = `Reproducir desde ${clock(paras[i].start)}`;
    el.addEventListener('click', () => {
      if (getSelection().toString()) return; // no interrumpir si está seleccionando texto
      audio.currentTime = paras[i].start;
      audio.play();
    });
  });
}

function renderError(name, message) {
  const card = document.createElement('div');
  card.className = 'error-card';
  const title = document.createElement('strong');
  title.textContent = name;
  const msg = document.createElement('p');
  msg.textContent = message;
  card.append(title, msg);
  els.results.prepend(card);
  updateDropSize();
}

// ---------- Historial ----------
async function addToHistory(item) {
  const history = await store.get('history', []);
  history.unshift(item);
  await store.set('history', history.slice(0, HISTORY_LIMIT));
}

async function removeFromHistory(id) {
  const history = await store.get('history', []);
  await store.set('history', history.filter((x) => x.id !== id));
}

async function renderHistory() {
  const history = await store.get('history', []);
  const q = els.historySearch.value.trim().toLowerCase();
  const items = q
    ? history.filter((h) => h.name.toLowerCase().includes(q) || h.segments.some((s) => s.text.toLowerCase().includes(q)))
    : history;

  els.historyList.replaceChildren(
    ...items.map((item) => {
      const details = document.createElement('details');
      details.className = 'hist';
      const summary = document.createElement('summary');
      const info = document.createElement('div');
      info.className = 'hist-info';
      const name = document.createElement('strong');
      name.textContent = item.name;
      const meta = document.createElement('span');
      meta.textContent = `${formatDate(item.date)} · ${clock(item.duration)} · ${wordCount(item)} palabras`;
      info.append(name, meta);
      const del = document.createElement('button');
      del.className = 'icon-btn sm';
      del.title = 'Borrar del historial';
      del.innerHTML = icon('trash');
      del.addEventListener('click', async (e) => {
        e.preventDefault();
        details.remove();
        await removeFromHistory(item.id);
        els.historyEmpty.hidden = els.historyList.children.length > 0;
        toast('Borrado del historial');
      });
      summary.innerHTML = `<span class="chev">${icon('chevron')}</span>`;
      summary.append(info, del);
      details.append(summary);
      details.addEventListener('toggle', () => {
        if (details.open && details.children.length === 1) {
          details.append(renderResult(item, { onRemove: () => {} }));
        }
      }, { once: false });
      return details;
    }),
  );
  els.historyEmpty.textContent = q ? 'No hay resultados para esa búsqueda.' : 'No hay transcripciones guardadas.';
  els.historyEmpty.hidden = items.length > 0;
}

function showView(view) {
  const history = view === 'history';
  els.viewHome.hidden = history;
  els.viewHistory.hidden = !history;
  els.back.hidden = !history;
  els.openHistory.hidden = history;
  els.openSettings.hidden = history;
  els.title.textContent = history ? 'Historial' : 'Audio a Texto';
  if (history) {
    toggleSettings(false);
    els.historySearch.value = '';
    renderHistory();
  }
}

// ---------- Almacenamiento de modelos ----------
// Los modelos viven en OPFS (ver model-store.js).
async function renderStorage() {
  const usage = await listModels();
  const rows = [...usage].map(([id, size]) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = MODELS[id] ?? id;
    const sz = document.createElement('span');
    sz.className = 'size';
    sz.textContent = formatSize(size);
    const del = document.createElement('button');
    del.className = 'icon-btn sm';
    del.title = `Borrar el modelo ${MODELS[id] ?? id}`;
    del.innerHTML = icon('trash');
    del.addEventListener('click', () => deleteModel(id));
    li.append(name, sz, del);
    return li;
  });
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'No hay modelos descargados.';
    rows.push(li);
  }
  els.modelList.replaceChildren(...rows);
  els.clearModels.disabled = usage.size === 0;

  const total = [...usage.values()].reduce((a, b) => a + b, 0);
  els.storageTotal.textContent = total ? `${formatSize(total)} en uso` : '';
}

function formatSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toLocaleString('es-AR', { maximumFractionDigits: 1 })} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

// Liberar el modelo en memoria antes de borrar sus archivos.
function releaseEngine() {
  if (worker) worker.terminate();
  worker = null;
  loadedModel = null;
  els.engine.textContent = 'Motor sin cargar';
  els.engineDot.className = 'dot';
}

async function deleteModel(id) {
  if (busy) return toast('Esperá a que termine la transcripción');
  if (loadedModel === id) releaseEngine();
  await removeModel(id);
  toast(`Modelo ${MODELS[id] ?? id} borrado`);
  renderStorage();
}

// Botón destructivo en dos pasos: el primer clic pide confirmación.
function confirmButton(btn, action) {
  const label = btn.innerHTML;
  let timer;
  btn.addEventListener('click', async () => {
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.textContent = '¿Seguro? Tocá de nuevo';
      timer = setTimeout(reset, 3000);
      return;
    }
    reset();
    await action();
  });
  function reset() {
    clearTimeout(timer);
    btn.classList.remove('confirm');
    btn.innerHTML = label;
  }
}

confirmButton(els.clearModels, async () => {
  if (busy) return toast('Esperá a que termine la transcripción');
  releaseEngine();
  await clearModels();
  toast('Modelos borrados');
  renderStorage();
});

confirmButton(els.clearHistory, async () => {
  await store.set('history', []);
  toast('Historial borrado');
});

// ---------- Grabación de la pestaña ----------
const LEVEL_BARS = 40;
let rec = null;

function callbackToPromise(fn) {
  return new Promise((resolve, reject) =>
    fn((value) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(value))),
  );
}

async function getTabStream() {
  if (typeof chrome !== 'undefined' && chrome.tabCapture?.getMediaStreamId) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const streamId = await callbackToPromise((cb) => chrome.tabCapture.getMediaStreamId({ targetTabId: tab?.id }, cb));
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
    // Capturar la pestaña la silencia: reenviamos el sonido a los parlantes.
    return { stream, playback: true };
  }
  // Fuera de la extensión (el panel abierto como página): compartir una pestaña con su audio.
  const shared = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  shared.getVideoTracks().forEach((t) => t.stop());
  if (!shared.getAudioTracks().length) throw new Error('No se compartió audio. Marcá "Compartir audio de la pestaña".');
  return { stream: new MediaStream(shared.getAudioTracks()), playback: false };
}

function friendlyCaptureError(err) {
  const msg = err?.message || '';
  if (/invoked|activeTab|permission/i.test(msg)) {
    return 'Chrome solo deja grabar la pestaña donde abriste el panel. Cerralo y volvé a abrirlo desde el ícono de la extensión estando en esa pestaña.';
  }
  if (/active stream/i.test(msg)) return 'Esta pestaña ya se está grabando.';
  if (/chrome:\/\/|webstore|Chrome pages/i.test(msg)) return 'Chrome no permite grabar sus páginas internas ni la Web Store.';
  if (err?.name === 'NotAllowedError') return 'Se canceló el permiso para grabar.';
  return msg || 'No se pudo grabar la pestaña.';
}

async function startRecording() {
  let capture;
  try {
    capture = await getTabStream();
  } catch (err) {
    console.error(err);
    renderError('Grabación de pestaña', friendlyCaptureError(err));
    return;
  }
  const { stream, playback } = capture;

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  if (playback) source.connect(ctx.destination);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.addEventListener('dataavailable', (e) => e.data.size && chunks.push(e.data));
  recorder.start(1000);

  rec = { stream, ctx, recorder, chunks, started: Date.now(), timer: 0, meter: 0 };
  // Si se cierra la pestaña o se corta la captura, nos quedamos con lo grabado.
  stream.getAudioTracks()[0]?.addEventListener('ended', () => stopRecording(true));

  els.record.hidden = true;
  els.recorder.hidden = false;
  els.recLevel.replaceChildren(...Array.from({ length: LEVEL_BARS }, () => document.createElement('i')));
  const bars = [...els.recLevel.children];
  const levels = new Array(LEVEL_BARS).fill(0);
  const buf = new Float32Array(analyser.fftSize);
  rec.meter = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    levels.shift();
    levels.push(Math.min(1, Math.sqrt(sum / buf.length) * 4));
    bars.forEach((b, i) => (b.style.height = `${Math.max(2, levels[i] * 28)}px`));
  }, 70);
  const updateTime = () => (els.recTime.textContent = clock((Date.now() - rec.started) / 1000));
  updateTime();
  rec.timer = setInterval(updateTime, 250);
}

async function stopRecording(keep) {
  if (!rec) return;
  const r = rec;
  rec = null;
  clearInterval(r.meter);
  clearInterval(r.timer);
  await new Promise((resolve) => {
    if (r.recorder.state === 'inactive') return resolve();
    r.recorder.addEventListener('stop', resolve, { once: true });
    r.recorder.stop();
  });
  r.stream.getTracks().forEach((t) => t.stop());
  r.ctx.close();
  els.recorder.hidden = true;
  els.record.hidden = false;

  if (!keep) return toast('Grabación descartada');
  const seconds = (Date.now() - r.started) / 1000;
  if (seconds < 1 || !r.chunks.length) return toast('La grabación fue demasiado corta');
  const type = r.recorder.mimeType || 'audio/webm';
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `Pestaña ${pad(d.getDate())}-${pad(d.getMonth() + 1)} ${pad(d.getHours())}.${pad(d.getMinutes())}.webm`;
  enqueue([new File([new Blob(r.chunks, { type })], name, { type })]);
}

// ---------- Eventos ----------
hydrateIcons();
checkMaxSupport();

els.record.addEventListener('click', startRecording);
els.recStop.addEventListener('click', () => stopRecording(true));
els.recDiscard.addEventListener('click', () => stopRecording(false));

els.openSettings.addEventListener('click', () => toggleSettings());
els.summary.addEventListener('click', () => toggleSettings(true));
els.openHistory.addEventListener('click', () => showView('history'));
els.back.addEventListener('click', () => showView('home'));
els.historySearch.addEventListener('input', renderHistory);

els.file.addEventListener('change', () => {
  enqueue(els.file.files);
  els.file.value = '';
});
['dragenter', 'dragover'].forEach((t) =>
  els.drop.addEventListener(t, (e) => {
    e.preventDefault();
    els.drop.classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((t) => els.drop.addEventListener(t, () => els.drop.classList.remove('over')));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  enqueue(e.dataTransfer.files);
});
// Evita que soltar un archivo fuera de la zona lo abra en el panel.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (!els.viewHome.hidden && !busy) enqueue(e.dataTransfer.files);
});

els.cancel.addEventListener('click', () => {
  cancel();
  toast('Transcripción cancelada');
});

// Preferencias guardadas.
(async () => {
  const [lang, model] = await Promise.all([store.get('language', null), store.get('model', null)]);
  if (lang != null) els.language.value = lang;
  const radio = model && $(`input[name="model"][value="${model}"]`);
  if (radio && !radio.disabled) radio.checked = true;
  updateSummary();
})();
els.language.addEventListener('change', () => {
  store.set('language', els.language.value);
  updateSummary();
});
document.querySelectorAll('input[name="model"]').forEach((r) =>
  r.addEventListener('change', () => {
    store.set('model', selectedModel());
    updateSummary();
  }),
);
updateSummary();
