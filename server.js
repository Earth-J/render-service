require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const http = require('http');
const Canvas = require('@napi-rs/canvas');
const GIFEncoder = require('gif-encoder-2');

const DEFAULT_GIF_DELAY_MS = parseInt(process.env.RENDER_DEFAULT_GIF_DELAY_MS || '180');
const JSON_LIMIT = process.env.JSON_LIMIT || '8mb';
const MAX_WIDTH = parseInt(process.env.RENDER_MAX_WIDTH || '1024');
const MAX_HEIGHT = parseInt(process.env.RENDER_MAX_HEIGHT || '1024');
const MAX_LAYERS = parseInt(process.env.RENDER_MAX_LAYERS || '50');
const MAX_FRAMES = parseInt(process.env.RENDER_MAX_FRAMES || '120');
const CACHE_TTL_MS = parseInt(process.env.RENDER_CACHE_TTL_MS || '60000');
const CACHE_MAX_ITEMS = parseInt(process.env.RENDER_CACHE_MAX_ITEMS || '1000');
const REQUEST_TIMEOUT_MS = parseInt(process.env.RENDER_REQUEST_TIMEOUT_MS || '15000');
const FRAME_FETCH_CONCURRENCY = parseInt(process.env.RENDER_FRAME_FETCH_CONCURRENCY || '10');
const STATIC_FETCH_CONCURRENCY = parseInt(process.env.RENDER_STATIC_FETCH_CONCURRENCY || '10');

const RENDER_DEBUG = process.env.RENDER_DEBUG === '1';
function rdbg(tag, data) { if (RENDER_DEBUG) { try { console.log('[RENDER_DEBUG]', tag, data || ''); } catch(_){} } }

const app = express();
app.use(express.json({ limit: JSON_LIMIT }));

const PORT = process.env.PORT || 8081;
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const API_KEY = process.env.API_KEY || undefined;
const ASSET_BASE_URL = (process.env.ASSET_BASE_URL || 'https://cdn.jsdelivr.net/gh/Earth-J/cdn-files@main').replace(/\/$/, '');

const jobs = new Map();
const inFlightByKey = new Map(); // cacheKey -> Promise<string outUrl>

// keep-alive agents for better performance
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });

// simple concurrency limiter
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 4);
let activeRenders = 0;
const waitQueue = [];
function acquire() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (activeRenders < MAX_CONCURRENCY) {
        activeRenders += 1;
        resolve();
      } else {
        waitQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}
function release() {
  activeRenders = Math.max(0, activeRenders - 1);
  const next = waitQueue.shift();
  if (next) next();
}

function auth(req, res, next) {
  if (!API_KEY) return next();
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (token === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function resolveCdnUrlByLayer(layer) {
  // layer: { type, key }
  const key = slugify(layer.key);
  let url = null;
  switch (layer.type) {
    case 'room-bg':
    case 'room_bg':
    case 'roomBg':
      url = `${ASSET_BASE_URL}/backgrounds/${key || 'default'}.png`;
      break;
    case 'background':
      url = `${ASSET_BASE_URL}/backgrounds/default.png`;
      break;
    case 'floor':
      url = `${ASSET_BASE_URL}/floor/${key}.png`;
      break;
    case 'furniture':
      url = `${ASSET_BASE_URL}/furniture/${key}.png`;
      break;
    case 'wallpaper-left':
    case 'wallpaper_left':
    case 'wallpaperLeft':
      url = `${ASSET_BASE_URL}/wallpaper/left/${key}.png`;
      break;
    case 'wallpaper-right':
    case 'wallpaper_right':
    case 'wallpaperRight':
      url = `${ASSET_BASE_URL}/wallpaper/right/${key}.png`;
      break;
    default:
      url = null;
  }
  rdbg('resolveCdnUrlByLayer', { type: layer.type, key, url });
  return url;
}

// Simple LRU-ish TTL cache
class SimpleCache {
  constructor(max = 1000) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt && e.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }
  set(key, value, ttlMs) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
    return value;
  }
}

const bufferCache = new SimpleCache(CACHE_MAX_ITEMS);
const imageCache = new SimpleCache(Math.max(200, Math.floor(CACHE_MAX_ITEMS / 2)));

function parseDataUrl(dataUrl) {
  try {
    const m = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl);
    if (!m) return null;
    return Buffer.from(m[2], 'base64');
  } catch (_) {
    return null;
  }
}

function fetchBuffer(url) {
  const key = `buf:${url}`;
  const cached = bufferCache.get(key);
  if (cached) return Promise.resolve(cached);
  // support data: URLs
  if (url.startsWith('data:')) {
    const buf = parseDataUrl(url);
    if (!buf) return Promise.reject(new Error('INVALID_DATA_URL'));
    bufferCache.set(key, buf, CACHE_TTL_MS);
    return Promise.resolve(buf);
  }
  return new Promise((resolve, reject) => {
    try {
      const isHttps = url.startsWith('https');
      const lib = isHttps ? https : http;
      const agent = isHttps ? httpsAgent : httpAgent;
      const req = lib.get(url, { agent }, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          rdbg('fetchBuffer.httpError', { url, status: res.statusCode });
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          bufferCache.set(key, buf, CACHE_TTL_MS);
          resolve(buf);
        });
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        rdbg('fetchBuffer.timeout', { url, timeoutMs: REQUEST_TIMEOUT_MS });
        req.destroy(new Error('HTTP_REQUEST_TIMEOUT'));
      });
      req.on('error', (e) => { rdbg('fetchBuffer.error', { url, message: e?.message }); reject(e); });
    } catch (e) {
      rdbg('fetchBuffer.throw', { url, message: e?.message });
      reject(e);
    }
  });
}

function swapImageExtension(url) {
  if (!url) return null;
  if (/\.png(\?.*)?$/i.test(url)) return url.replace(/\.png(\?.*)?$/i, '.gif$1');
  if (/\.gif(\?.*)?$/i.test(url)) return url.replace(/\.gif(\?.*)?$/i, '.png$1');
  return null;
}

async function fetchImageWithFallback(url) {
  try {
    return await fetchBuffer(url);
  } catch (e) {
    const alt = swapImageExtension(url);
    if (alt) {
      rdbg('fetchImageWithFallback.alt', { url, alt });
      return await fetchBuffer(alt);
    }
    throw e;
  }
}

async function loadImageCached(urlOrBufferKey, buffer) {
  const key = `img:${urlOrBufferKey}`;
  const cached = imageCache.get(key);
  if (cached) return cached;
  const img = await Canvas.loadImage(buffer);
  return imageCache.set(key, img, CACHE_TTL_MS);
}

async function composePng(width, height, layers, backgroundHex) {
  rdbg('composePng.start', { width, height, layers: layers?.length, backgroundHex });
  const canvas = Canvas.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (backgroundHex) {
    try { ctx.fillStyle = backgroundHex; } catch (_) { /* ignore invalid */ }
    ctx.fillRect(0, 0, width, height);
  }
  const decoded = await mapWithConcurrency(layers, STATIC_FETCH_CONCURRENCY, async (layer) => {
    if (!layer || !layer.url) return null;
    try {
      const buf = await fetchImageWithFallback(layer.url);
      const img = await loadImageCached(layer.url, buf);
      return { img, draw: layer.draw || { x: 0, y: 0, w: width, h: height } };
    } catch (e) { rdbg('composePng.loadSkip', { url: layer?.url, message: e?.message }); return null; }
  });
  for (const it of decoded) {
    if (!it) continue;
    const d = it.draw;
    ctx.drawImage(it.img, d.x || 0, d.y || 0, d.w || width, d.h || height);
  }
  return canvas.encode('png');
}

async function composeGif(width, height, layers, options) {
  const delayMs = Number((options && options.delayMs) || DEFAULT_GIF_DELAY_MS);
  const repeat = Number(options?.repeat ?? 0);
  const quality = Number(options?.quality || 10);
  const wantTransparent = Boolean(options?.transparent);
  const transparentHex = String(options?.transparentColorHex || '#ff00ff');
  const transparentInt = parseInt(transparentHex.replace('#',''), 16);
  const backgroundHex = String(options?.backgroundColorHex || '');
  rdbg('composeGif.start', { width, height, layers: layers?.length, delayMs, repeat, quality, wantTransparent, backgroundHex });

  // เตรียมเลเยอร์ตามลำดับเดิม (interleaved)
  const decodedLayers = [];
  let maxFrames = 0;
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.type === 'pet_gif_frames' && Array.isArray(layer.frames) && layer.frames.length > 0) {
      const frames = await mapWithConcurrency(layer.frames, FRAME_FETCH_CONCURRENCY, async (fr) => {
        const url = fr?.url;
        if (!url) return null;
        try {
          const buf = await fetchImageWithFallback(url);
          const img = await loadImageCached(url, buf);
          return { img, draw: fr.draw || layer.draw || { x: 0, y: 0, w: width, h: height } };
        } catch (e) { rdbg('composeGif.frameSkip', { url, message: e?.message }); return null; }
      });
      const perFrame = frames.filter(Boolean);
      if (perFrame.length > 0) {
        decodedLayers.push({ kind: 'frames', frames: perFrame });
        maxFrames = Math.max(maxFrames, perFrame.length);
      }
    } else if (layer.url) {
      try {
        const buf = await fetchImageWithFallback(layer.url);
        const img = await loadImageCached(layer.url, buf);
        decodedLayers.push({ kind: 'static', img, draw: layer.draw || { x: 0, y: 0, w: width, h: height } });
      } catch (e) { rdbg('composeGif.staticSkip', { url: layer.url, message: e?.message }); /* skip static */ }
    }
  }

  if (maxFrames === 0) {
    rdbg('composeGif.noFrames', {});
    // ไม่มีเฟรมเคลื่อนไหวเลย
    return { format: 'png', buffer: await composePng(width, height, layers, backgroundHex) };
  }

  const encoder = new GIFEncoder(width, height, 'octree');
  encoder.setDelay(delayMs);
  encoder.setRepeat(repeat);
  encoder.setQuality(quality);
  if (wantTransparent && Number.isFinite(transparentInt)) {
    try { encoder.setTransparent(transparentInt); } catch (_) { /* ignore */ }
  }
  encoder.start();

  const canvas = Canvas.createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  for (let i = 0; i < maxFrames; i++) {
    if (backgroundHex) {
      try { ctx.fillStyle = backgroundHex; } catch (_) { /* ignore invalid */ }
      ctx.fillRect(0, 0, width, height);
    }
    for (const l of decodedLayers) {
      if (l.kind === 'static') {
        const d = l.draw;
        ctx.drawImage(l.img, d.x || 0, d.y || 0, d.w || width, d.h || height);
      } else if (l.kind === 'frames') {
        const f = l.frames[i % l.frames.length];
        if (!f) continue;
        const d = f.draw || { x: 0, y: 0, w: width, h: height };
        ctx.drawImage(f.img, d.x || 0, d.y || 0, d.w || width, d.h || height);
      }
    }
    const rgba = ctx.getImageData(0, 0, width, height).data;
    encoder.addFrame(rgba);
    ctx.clearRect(0, 0, width, height);
  }

  encoder.finish();
  const out = Buffer.from(encoder.out.getData());
  rdbg('composeGif.done', { bytes: out.length });
  return { format: 'gif', buffer: out };
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function stableHashPayload(payload) {
  const size = { w: payload?.size?.width || 300, h: payload?.size?.height || 300 };
  const layers = (payload.layers || []).map(l => {
    const base = {
      type: String(l.type || ''),
      key: String(l.key || ''),
      url: l.url ? String(l.url) : undefined,
      draw: {
        x: Number(l.draw?.x || 0),
        y: Number(l.draw?.y || 0),
        w: Number(l.draw?.w || size.w),
        h: Number(l.draw?.h || size.h)
      }
    };
    if (String(l.type) === 'pet_gif_frames' && Array.isArray(l.frames)) {
      base.frames = l.frames.map(fr => ({
        url: String(fr.url || ''),
        draw: {
          x: Number(fr.draw?.x || base.draw.x),
          y: Number(fr.draw?.y || base.draw.y),
          w: Number(fr.draw?.w || base.draw.w),
          h: Number(fr.draw?.h || base.draw.h)
        }
      }));
    }
    return base;
  });
  const gifOptions = payload.gifOptions ? {
    delayMs: Number(payload.gifOptions.delayMs || 0),
    repeat: Number(payload.gifOptions.repeat ?? 0),
    quality: Number(payload.gifOptions.quality || 0),
    transparent: Boolean(payload.gifOptions.transparent || false),
    transparentColorHex: String(payload.gifOptions.transparentColorHex || ''),
    backgroundColorHex: String(payload.gifOptions.backgroundColorHex || '')
  } : undefined;
  const data = JSON.stringify({ size, layers, format: payload.format || 'png', gifOptions });
  return crypto.createHash('sha1').update(data).digest('hex');
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  let active = 0;
  return await new Promise((resolve, reject) => {
    const next = () => {
      if (index >= items.length && active === 0) return resolve(results);
      if (index >= items.length) return;
      while (active < limit && index < items.length) {
        const i = index++;
        active++;
        Promise.resolve()
          .then(() => mapper(items[i], i))
          .then((res) => { results[i] = res; })
          .catch((err) => { results[i] = undefined; rdbg('mapWithConcurrency.err', { i, message: err?.message }); })
          .finally(() => { active--; next(); });
      }
    };
    next();
  });
}

app.post('/jobs', auth, async (req, res) => {
  const payload = req.body || {};
  // validate โครงสร้างขั้นต่ำ
  if (!payload || !payload.guild || !payload.user || !payload.layers || !Array.isArray(payload.layers)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // validate ขนาดภาพ/จำนวนเลเยอร์/จำนวนเฟรม
  const width = Number(payload.size?.width || 300);
  const height = Number(payload.size?.height || 300);
  if (width > MAX_WIDTH || height > MAX_HEIGHT) {
    return res.status(400).json({ error: 'Size too large' });
  }
  if (payload.layers.length > MAX_LAYERS) {
    return res.status(400).json({ error: 'Too many layers' });
  }
  let frameCountEstimate = 0;
  for (const l of payload.layers) {
    if (String(l?.type) === 'pet_gif_frames' && Array.isArray(l.frames)) {
      frameCountEstimate = Math.max(frameCountEstimate, l.frames.length);
    }
  }
  if (frameCountEstimate > MAX_FRAMES) {
    return res.status(400).json({ error: 'Too many frames' });
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'pending', createdAt: Date.now(), payload });
  rdbg('job.accepted', { jobId, width, height, layers: payload.layers.length, wantsGif: String(payload.format || '').toLowerCase() === 'gif' });

  (async () => {
    try {
      const { payload } = jobs.get(jobId);
      const width = payload.size?.width || 300;
      const height = payload.size?.height || 300;
      const layersIn = Array.isArray(payload.layers) ? payload.layers : [];

      // ต้องการ GIF หรือไม่ และมีเฟรมจริงหรือไม่
      const wantsGif = String(payload.format || '').toLowerCase() === 'gif' || layersIn.some(l => l && String(l.type) === 'pet_gif_frames');

      // สร้างคีย์แคชจาก payload (รวม frames)
      const cacheKey = stableHashPayload(payload);
      const outDir = path.join(__dirname, 'out');
      ensureDirSync(outDir);

      // ตรวจไฟล์ที่เคยเรนเดอร์ไว้ทั้งสองนามสกุล
      const outGif = path.join(outDir, `${cacheKey}.gif`);
      const outPng = path.join(outDir, `${cacheKey}.png`);
      if (fs.existsSync(outGif)) {
        const url = `${BASE_URL}/out/${path.basename(outGif)}`;
        jobs.set(jobId, { status: 'done', url, format: 'gif', createdAt: jobs.get(jobId).createdAt, finishedAt: Date.now(), payload });
        rdbg('job.cacheHit', { jobId, url });
        return;
      }
      if (fs.existsSync(outPng)) {
        const url = `${BASE_URL}/out/${path.basename(outPng)}`;
        jobs.set(jobId, { status: 'done', url, format: 'png', createdAt: jobs.get(jobId).createdAt, finishedAt: Date.now(), payload });
        rdbg('job.cacheHit', { jobId, url });
        return;
      }

      // de-dup: ถ้ามี render cacheKey นี้อยู่ ให้รอผลลัพธ์เดิม
      if (inFlightByKey.has(cacheKey)) {
        const p = inFlightByKey.get(cacheKey);
        const url = await p.catch(() => null);
        if (url) {
          jobs.set(jobId, { status: 'done', url, format: url.endsWith('.gif') ? 'gif' : 'png', createdAt: jobs.get(jobId).createdAt, finishedAt: Date.now(), payload });
          rdbg('job.dedup', { jobId, url });
          return;
        }
        // ถ้า p ล้มเหลว ให้ตกไปเรนเดอร์ต่อด้านล่าง
      }

      // สร้างเลเยอร์ตามลำดับเดิม (คง order) และ resolve URL ให้ static
      const resolvedLayers = [];
      for (const l of layersIn) {
        if (!l) continue;
        if (String(l.type) === 'pet_gif_frames' && Array.isArray(l.frames)) {
          resolvedLayers.push(l);
        } else {
          const directUrl = l.url ? String(l.url) : null;
          const url = directUrl || resolveCdnUrlByLayer(l);
          if (!url) continue;
          resolvedLayers.push({ type: 'static', url, draw: l.draw });
        }
      }
      rdbg('job.layers.resolved', { jobId, count: resolvedLayers.length });

      // เริ่มงาน render ภายใต้ concurrency limit และผูก promise ไว้สำหรับ de-dup
      const renderPromise = (async () => {
        await acquire();
        try {
          // ตัดสินใจฟอร์แมตจริงตามเลเยอร์
          const hasFrames = resolvedLayers.some(l => String(l.type) === 'pet_gif_frames');
          if (wantsGif && hasFrames) {
            const { format, buffer } = await composeGif(width, height, resolvedLayers, payload.gifOptions || {});
            const ext = (format === 'gif') ? 'gif' : 'png';
            const outPath = path.join(outDir, `${cacheKey}.${ext}`);
            await fsp.writeFile(outPath, buffer);
            return `${BASE_URL}/out/${path.basename(outPath)}`;
          } else {
            const pngBuf = await composePng(width, height, resolvedLayers, payload.backgroundColorHex || (payload.gifOptions && payload.gifOptions.backgroundColorHex) || '')
            const outPath = path.join(outDir, `${cacheKey}.png`);
            await fsp.writeFile(outPath, pngBuf);
            return `${BASE_URL}/out/${path.basename(outPath)}`;
          }
        } finally {
          release();
        }
      })();
      inFlightByKey.set(cacheKey, renderPromise);
      const url = await renderPromise;
      inFlightByKey.delete(cacheKey);
      jobs.set(jobId, { status: 'done', url, format: url.endsWith('.gif') ? 'gif' : 'png', createdAt: jobs.get(jobId).createdAt, finishedAt: Date.now(), payload });
      rdbg('job.done', { jobId, url });
    } catch (e) {
      jobs.set(jobId, { status: 'error', error: e.message || String(e), createdAt: jobs.get(jobId)?.createdAt || Date.now(), finishedAt: Date.now() });
      rdbg('job.error', { jobId, message: e?.message });
    }
  })();

  res.json({ jobId });
});

app.get('/jobs/:id', auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

// เสิร์ฟผลลัพธ์ที่ compose แล้ว พร้อม cache header ยาว
app.use('/out', express.static(path.join(__dirname, 'out'), { maxAge: '365d', immutable: true, etag: true }));

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'render-service', version: '0.6.0-lru-dataurl', assetBaseUrl: ASSET_BASE_URL, maxConcurrency: MAX_CONCURRENCY });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'healthy', timestamp: Date.now() });
});

app.listen(PORT, () => {
  console.log(`Render service running at ${BASE_URL}`);
});
