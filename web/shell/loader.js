// GeneralsX Web - asset loader.
//
// Streams build.data (GAXD format): reads index from stream start,
// pipes compressed blob through DecompressionStream, splits decompressed
// data into files and writes them to OPFS/IDB concurrently (4 in parallel).
//
// GeneralsX @build web-port 06/07/2026

'use strict';

// GeneralsX @feature Lolendor 22/07/2026 Localize launch-screen runtime messages.
const gxText = (key, values) => window.gxI18n.t(key, values);

const gxUI = {
  overlay: null, detail: null,
  dlBar: null, dlVal: null, unBar: null, unVal: null,
  statusKey: null, statusValues: null,
  init() {
    this.overlay = document.getElementById('gx-overlay');
    this.detail = document.getElementById('gx-detail');
    this.dlBar = document.getElementById('gx-bar');
    this.dlVal = document.getElementById('gx-dl-val');
    this.unBar = document.getElementById('gx-bar2');
    this.unVal = document.getElementById('gx-un-val');
    window.addEventListener('gxlanguagechange', () => this.refreshLanguage());
  },
  error(msg) {
    console.error('[loader]', msg);
    const el = document.getElementById('gx-error');
    el.style.display = 'block';
    el.textContent = msg;
    document.getElementById('gx-progress-wrap').style.display = 'none';
  },
  download(done, total, detail) {
    const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
    this.dlBar.style.width = pct + '%';
    this.dlVal.textContent = total > 0 ? gxHuman(done) + ' / ' + gxHuman(total) : gxHuman(done);
    if (detail) this.detail.textContent = detail;
  },
  unpack(done, total) {
    const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
    this.unBar.style.width = pct + '%';
    this.unVal.textContent = done + ' / ' + total;
  },
  status(key, values) {
    this.statusKey = key;
    this.statusValues = values || null;
    this.detail.textContent = gxText(key, values);
  },
  refreshLanguage() {
    if (this.statusKey) this.detail.textContent = gxText(this.statusKey, this.statusValues);
  },
};

function gxHuman(b) {
  if (b > 1073741824) return (b / 1073741824).toFixed(2) + ' ' + gxText('unit.gb');
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' ' + gxText('unit.mb');
  if (b > 1024) return (b / 1024).toFixed(0) + ' ' + gxText('unit.kb');
  return b + ' ' + gxText('unit.b');
}

// ── Stream extraction (worker-driven, resumable) ─────────────────────────
// The dispatcher worker fetches build.data, slices it at segment boundaries,
// decompresses segments on a parallel brotli sub-worker pool, and writes files
// to OPFS in order. The main thread relays progress, persists a resume journal
// per completed segment, and runs a watchdog: if the worker goes silent for
// 60 s (deadlock, dropped promise, killed SW...) it is terminated and
// restarted from the journaled segment — a hang becomes an automatic resume.
// Returns { files, entries }.

async function gxStreamExtract(url, storage, journalKey) {
  const ver = (window.gxEngine && window.gxEngine.buildId) || 'dev';
  const wasmUrl = new URL('brotli_bg.wasm?v=' + ver, document.baseURI).href;
  const WATCHDOG_MS = 60000;
  const MAX_RESTARTS = 4;

  let restarts = 0;
  for (;;) {
    // Resume state from the journal (OPFS mode only; the worker re-validates
    // the etag/total before honoring it).
    let resume = null;
    if (storage.kind === 'opfs' && journalKey) {
      const j = await storage.readMeta(journalKey);
      if (j && Number.isInteger(j.seg) && j.etag)
        resume = { startSeg: j.seg + 1, etag: j.etag, total: j.total };
    }

    try {
      return await gxRunUnpackWorker(url, wasmUrl, storage, journalKey, resume, ver, WATCHDOG_MS);
    } catch (e) {
      if (e && e.gxWatchdog && restarts < MAX_RESTARTS) {
        restarts++;
        console.warn('[loader] воркер молчал ' + (WATCHDOG_MS / 1000) + 'с — перезапуск ' +
          restarts + '/' + MAX_RESTARTS + ' с докачкой');
        gxUI.status('loader.stalled', { attempt: restarts });
        continue;
      }
      throw e;
    }
  }
}

function gxRunUnpackWorker(url, wasmUrl, storage, journalKey, resume, ver, watchdogMs) {
  // The workers are tiny — always fetch fresh so a redeploy is never served a
  // stale cached Worker script. brotli_bg.wasm (~1 MB) is versioned by buildId.
  const bust = ver + '.' + (Date.now() >>> 0);
  const worker = new Worker('unpack-worker.js?v=' + bust);

  return new Promise((resolve, reject) => {
    let watchdog = null;
    const arm = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        try { worker.terminate(); } catch {}
        const err = new Error('unpack worker silent for ' + watchdogMs + 'ms');
        err.gxWatchdog = true;
        reject(err);
      }, watchdogMs);
    };
    const done = (fn) => (v) => { if (watchdog) clearTimeout(watchdog); try { worker.terminate(); } catch {} fn(v); };
    const ok = done(resolve), fail = done(reject);
    arm();

    worker.addEventListener('message', (ev) => {
      const m = ev.data;
      arm();                                          // any message = alive
      if (m.type === 'download') {
        gxUI.download(m.received, m.total);
      } else if (m.type === 'index') {
        gxUI.unpack(0, m.entries.length);
      } else if (m.type === 'progress') {
        gxUI.unpack(m.done, m.total);
        if (m.verifying) gxUI.status('loader.verifying');
      } else if (m.type === 'journal') {
        // Persist resume state; fire-and-forget (journal loss only costs re-work).
        if (storage.kind === 'opfs' && journalKey)
          storage.writeMeta(journalKey, { seg: m.seg, etag: m.etag, total: m.total }).catch(() => {});
      } else if (m.type === 'reconnect') {
        gxUI.status('loader.reconnecting', { attempt: m.attempt });
      } else if (m.type === 'complete') {
        ok({ files: m.files, entries: m.entries });
      } else if (m.type === 'error') {
        fail(new Error(m.message));
      }
    });
    worker.addEventListener('error', (e) => {
      const where = e.filename ? (' @ ' + e.filename + ':' + e.lineno) : '';
      console.error('[loader] worker error event:', e);
      fail(new Error('Worker: ' + (e.message || gxText('error.workerLoad')) + where));
    });
    worker.addEventListener('messageerror', (e) => {
      console.error('[loader] worker messageerror:', e);
      fail(new Error('Worker: ' + gxText('error.workerMessage')));
    });
    worker.postMessage({ type: 'start', url, wasmUrl, mode: storage.kind, resume, ver: bust });
  });
}

// ── Checks & init ────────────────────────────────────────────────────────────

async function gxCheckEnvironment() {
  if (!crossOriginIsolated) {
    if (window.gxCoiPending) {
      gxUI.status('loader.environment');
      await new Promise((r) => setTimeout(r, 4000));
    }
    if (!crossOriginIsolated) throw new Error(gxText('error.sharedArrayBuffer'));
  }
  if (typeof WebAssembly === 'undefined') throw new Error(gxText('error.webAssembly'));
}

// Torrent-deploy model: game data is provisioned into OPFS by an external
// step BEFORE the game is launched (see README.dz.md). Instead of trusting an
// "installed" marker, detect a real installation: at least one *.big in the
// selected game's asset directory (storage.root is already anchored at
// ccgenerals/) — GameData/ for Zero Hour, GameDataGenerals/ for the base game
// (?game=generals). For the IndexedDB fallback, look among the stored paths.
async function gxCheckInstalled(storage) {
  const isBaseGame = new URLSearchParams(location.search).get('game') === 'generals';
  if (storage.kind === 'opfs') {
    try {
      const dir = await storage.root.getDirectoryHandle(isBaseGame ? 'GameDataGenerals' : 'GameData');
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file' && name.toLowerCase().endsWith('.big')) return true;
      }
    } catch {}
    return false;
  }
  try {
    const paths = await storage.listPaths();
    return paths.some(p => typeof p === 'string' && p.toLowerCase().endsWith('.big') &&
      p.startsWith('GameDataGenerals/') === isBaseGame);
  } catch {
    return false;
  }
}

// IndexedDB mode: load every stored file into window.gxFiles for the engine
// (OPFS mode reads the mounted filesystem directly, so this is a no-op there).
async function gxMaterializeIdb(storage) {
  const paths = (await storage.listPaths()).filter(k => typeof k === 'string');
  const assetPaths = paths.filter(k => !k.startsWith('meta/'));
  const files = [];
  for (let i = 0; i < assetPaths.length; i++) {
    files.push({ path: assetPaths[i], data: await storage.readBytes(assetPaths[i]) });
    if (i % 20 === 0) gxUI.unpack(i, assetPaths.length);
  }
  gxUI.unpack(assetPaths.length, assetPaths.length);
  window.gxFiles = files;
}

// Wipe every browser-side store this app uses: OPFS (game files, meta,
// userdata), IndexedDB (gx-assets fallback + any others on the origin),
// Cache Storage, localStorage/sessionStorage settings, and the COI service
// worker registration. Used by the settings "Очистить все данные" button.
async function gxWipeAllStorage() {
  const jobs = [];

  // OPFS: remove every top-level entry.
  if (navigator.storage && navigator.storage.getDirectory) {
    jobs.push((async () => {
      try {
        const root = await navigator.storage.getDirectory();
        const names = [];
        for await (const [name] of root.entries()) names.push(name);
        for (const name of names) {
          await root.removeEntry(name, { recursive: true }).catch(() => {});
        }
      } catch (e) { console.warn('[wipe] OPFS:', e); }
    })());
  }

  // IndexedDB: delete every database on the origin (or at least ours).
  jobs.push((async () => {
    try {
      let names = ['gx-assets'];
      if (indexedDB.databases) {
        try {
          const dbs = await indexedDB.databases();
          names = dbs.map((d) => d.name).filter(Boolean);
        } catch {}
      }
      await Promise.all(names.map((n) => new Promise((res) => {
        const req = indexedDB.deleteDatabase(n);
        req.onsuccess = req.onerror = req.onblocked = () => res();
      })));
    } catch (e) { console.warn('[wipe] IDB:', e); }
  })());

  // Cache Storage (anything a SW or the browser cached under our origin).
  if (window.caches && caches.keys) {
    jobs.push((async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (e) { console.warn('[wipe] caches:', e); }
    })());
  }

  // Service workers (the COI worker re-registers itself on next load).
  if ('serviceWorker' in navigator) {
    jobs.push((async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      } catch (e) { console.warn('[wipe] sw:', e); }
    })());
  }

  await Promise.all(jobs);

  // Settings and per-tab identity last (sync, can't fail meaningfully).
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
}

async function gxLoadNetConfig() {
  try {
    const r = await fetch('ice.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const cfg = await r.json();
    if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length)
      window.gxNetConfig.iceServers = cfg.iceServers;
    if (cfg && Array.isArray(cfg.mqttBrokers) && cfg.mqttBrokers.length)
      window.gxNetConfig.mqttBrokers = cfg.mqttBrokers;
  } catch (e) {
    console.warn('[loader] ice.json не прочитан:', e);
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function gxBoot() {
  gxUI.init();

  try {
    await gxCheckEnvironment();
    await gxLoadNetConfig();

    const storage = await gxDetectStorage();
    console.log('[loader] хранилище:', storage.kind);
    window.gxStorageKind = storage.kind;
    document.getElementById('gx-storage-kind').textContent =
      storage.kind === 'opfs' ? 'OPFS' : 'IndexedDB (fallback)';

    // No start screen: the game boots straight into loading. Game data must
    // already be deployed into storage (torrent -> OPFS) before launch;
    // without it boot stops here with an error.
    const installed = await gxCheckInstalled(storage);
    if (!installed) {
      document.getElementById('gx-progress-wrap').style.display = 'none';
      gxUI.error(gxText('error.notInstalled'));
      return;
    }

    // Download the engine (wasm) into memory, with progress. Always needed —
    // the engine never fetches its own wasm later.
    gxUI.download(0, 0);
    gxUI.unpack(0, 0);
    gxUI.status('loader.engine');
    await gxPreloadEngine((received, total) => gxUI.download(received, total));

    // IndexedDB mode: materialize files into window.gxFiles for the engine.
    if (storage.kind === 'idb') {
      gxUI.status('loader.files');
      await gxMaterializeIdb(storage);
    }

    // Initialize CloudSDK and finish any remote restore before materializing
    // userdata for the wasm-side /idb/userdata mount. Reading gxUserFiles
    // first would leave the engine with the pre-restore snapshot.
    // GeneralsX @bugfix caiiiycuk 21/08/2026 Apply cloud userdata before engine startup.
    await window.gxUserStore.ready();
    if (typeof gxCloudInit === 'function') {
      try { await gxCloudInit(); } catch(e) { console.warn('[loader] Cloud-init failed:', e); }
    }

    // Userdata (Options.ini, saves, replays) lives in its own IndexedDB
    // database (gx-userdata), mounted by the engine at /idb/userdata:
    // restore it and expose the write-back hooks (see WebMain.cpp).
    // GeneralsX @feature caiiiycuk 14/08/2026
    window.gxUserFiles = await window.gxUserStore.readAll();
    window.gxIdbPutUserFile = (path, bytes) => window.gxUserStore.put(path, bytes);
    window.gxIdbPruneUserFiles = (paths) => window.gxUserStore.prune(paths);

    gxUI.status('loader.starting');
    document.getElementById('gx-progress-wrap').style.display = 'none';
    await gxStartGame();
    gxUI.overlay.style.display = 'none';
  } catch (e) {
    gxUI.error(e && e.message ? e.message : String(e));
  }
}

// The boot flow no longer downloads game data (torrent-deploy model) and has
// no start-screen UI, but the GAXD->OPFS unpack pipeline and the full-wipe
// helper stay exported for the external deployer page / devtools console.
window.gxStreamExtract = gxStreamExtract;
window.gxWipeAllStorage = gxWipeAllStorage;

window.addEventListener('DOMContentLoaded', gxBoot);
