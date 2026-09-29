const SAMPLE_RATE = 16000;
const HISTORY_LIMIT = 30;

const $ = (sel) => document.querySelector(sel);
const els = {
  language: $('#language'),
  model: $('#model'),
  engine: $('#engine'),
  drop: $('#drop'),
  file: $('#file'),
  status: $('#status'),
  statusText: $('#status-text'),
  statusDetail: $('#status-detail'),
  barFill: $('#bar-fill'),
  cancel: $('#cancel'),
  results: $('#results'),
  historyList: $('#history-list'),
  historyEmpty: $('#history-empty'),
  tpl: $('#result-tpl'),
};

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
  if (pending) {
    const p = pending;
    pending = null;
    p.reject(new Cancelled());
  }
  cancelled = true;
}

async function ensureModel(model) {
  if (loadedModel === model) return;
  const files = new Map();
  showStatus('Descargando el modelo de IA…', 'Solo la primera vez. Después queda guardado.', 0);
  const { device } = await request({ type: 'load', model }, [], (ev) => {
    if (ev.type !== 'download') return;
    files.set(ev.file, ev);
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    showStatus(
      'Descargando el modelo de IA…',
      `${formatMB(loaded)} de ${formatMB(total)} · solo la primera vez`,
      total ? loaded / total : 0,
    );
  });
  loadedModel = model;
  els.engine.textContent = device === 'webgpu'
    ? 'Motor: placa de video (WebGPU) · rápido'
    : 'Motor: procesador (WebAssembly) · más lento';
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
  if (!list.length) return;
  queue.push(...list);
  if (!busy) runQueue();
}

async function runQueue() {
  busy = true;
  cancelled = false;
  els.drop.classList.add('disabled');
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
  els.drop.classList.remove('disabled');
  hideStatus();
}

async function processFile(file) {
  const pendingCount = queue.length ? ` (${queue.length} más en cola)` : '';
  showStatus(`Leyendo ${file.name}…`, pendingCount.trim(), null);

  let audio;
  try {
    audio = await decodeAudio(file);
  } catch {
    throw new Error('No se pudo leer el archivo. Probá con otro formato (MP3 o WAV).');
  }
  if (cancelled) throw new Cancelled();
  const duration = audio.length / SAMPLE_RATE;

  const model = els.model.value;
  await ensureModel(model);

  const id = crypto.randomUUID();
  const language = els.language.value || null;
  showStatus(`Transcribiendo ${file.name}`, 'Arrancando…', 0);

  const { segments } = await request({ type: 'transcribe', id, audio, language }, [audio.buffer], (ev) => {
    if (ev.type !== 'progress') return;
    const remaining = (ev.elapsed / ev.done) * (ev.total - ev.done);
    showStatus(
      `Transcribiendo ${file.name}`,
      `Parte ${ev.done} de ${ev.total} · faltan ~${formatDuration(remaining)}${pendingCount}`,
      ev.done / ev.total,
    );
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
  els.results.prepend(renderResult(item, { onRemove: (card) => card.remove() }));
  await addToHistory(item);
}

// ---------- Estado ----------
function showStatus(text, detail = '', progress = null) {
  els.status.hidden = false;
  els.statusText.textContent = text;
  els.statusDetail.textContent = detail;
  if (progress == null) {
    els.barFill.classList.add('indeterminate');
    els.barFill.style.width = '';
  } else {
    els.barFill.classList.remove('indeterminate');
    els.barFill.style.width = `${Math.round(progress * 100)}%`;
  }
}

function hideStatus() {
  els.status.hidden = true;
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
      cur = { start: s.start, text: s.text };
      paras.push(cur);
    } else {
      cur.text += ' ' + s.text;
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

function formatMB(bytes) {
  return `${Math.round(bytes / 1e6)} MB`;
}

function buildExport(item, format, withTimes) {
  const paras = toParagraphs(item.segments);
  if (format === 'srt') {
    return item.segments
      .map((s, i) => `${i + 1}\n${clock(s.start, true)} --> ${clock(Math.max(s.end, s.start + 0.5), true)}\n${s.text}\n`)
      .join('\n');
  }
  const body = paras.map((p) => (withTimes ? `[${clock(p.start)}] ${p.text}` : p.text));
  if (format === 'md') {
    const date = new Date(item.date).toLocaleString('es-AR');
    const lines = paras.map((p) => (withTimes ? `**[${clock(p.start)}]** ${p.text}` : p.text));
    return `# ${item.name}\n\n_Transcripto el ${date} · duración ${clock(item.duration)}_\n\n${lines.join('\n\n')}\n`;
  }
  return body.join('\n\n') + '\n';
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
}

// ---------- Tarjetas de resultado ----------
function renderResult(item, { onRemove }) {
  const card = els.tpl.content.firstElementChild.cloneNode(true);
  const textEl = card.querySelector('.text');
  const timesEl = card.querySelector('.show-times');
  card.querySelector('.name').textContent = item.name;
  const date = new Date(item.date).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  const words = item.segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  card.querySelector('.meta').textContent = `${clock(item.duration)} · ${words} palabras · ${date}`;

  const paint = () => {
    textEl.replaceChildren();
    const paras = toParagraphs(item.segments);
    if (!paras.length) {
      textEl.innerHTML = '<p class="empty">No se detectó voz en este audio.</p>';
      return;
    }
    for (const p of paras) {
      const el = document.createElement('p');
      if (timesEl.checked) {
        const ts = document.createElement('span');
        ts.className = 'ts';
        ts.textContent = clock(p.start);
        el.append(ts);
      }
      el.append(p.text);
      textEl.append(el);
    }
  };
  timesEl.addEventListener('change', paint);
  paint();

  const copyBtn = card.querySelector('.copy');
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(buildExport(item, 'txt', timesEl.checked).trim());
    copyBtn.textContent = '¡Copiado!';
    setTimeout(() => (copyBtn.textContent = 'Copiar'), 1500);
  });
  card.querySelectorAll('.dl').forEach((btn) =>
    btn.addEventListener('click', () => download(item, btn.dataset.format, timesEl.checked)),
  );
  card.querySelector('.remove').addEventListener('click', () => onRemove(card));
  return card;
}

function renderError(name, message) {
  const card = document.createElement('article');
  card.className = 'card';
  const title = document.createElement('strong');
  title.textContent = name;
  const msg = document.createElement('p');
  msg.className = 'error';
  msg.textContent = message;
  card.append(title, msg);
  els.results.prepend(card);
}

// ---------- Historial ----------
async function addToHistory(item) {
  const history = await store.get('history', []);
  history.unshift(item);
  await store.set('history', history.slice(0, HISTORY_LIMIT));
}

async function showHistory() {
  const history = await store.get('history', []);
  els.historyList.replaceChildren(
    ...history.map((item) =>
      renderResult(item, {
        onRemove: async (card) => {
          card.remove();
          const h = await store.get('history', []);
          await store.set('history', h.filter((x) => x.id !== item.id));
          els.historyEmpty.hidden = els.historyList.children.length > 0;
        },
      }),
    ),
  );
  els.historyEmpty.hidden = history.length > 0;
}

// ---------- Eventos ----------
document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    const view = tab.dataset.view;
    $('#view-transcribe').hidden = view !== 'transcribe';
    $('#view-history').hidden = view !== 'history';
    if (view === 'history') showHistory();
  }),
);

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
['dragleave', 'drop'].forEach((t) =>
  els.drop.addEventListener(t, () => els.drop.classList.remove('over')),
);
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  enqueue(e.dataTransfer.files);
});
// Evita que soltar un archivo fuera de la zona lo abra en el panel.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

els.cancel.addEventListener('click', cancel);

for (const key of ['language', 'model']) {
  store.get(key, null).then((v) => {
    if (v != null) els[key].value = v;
  });
  els[key].addEventListener('change', () => store.set(key, els[key].value));
}
