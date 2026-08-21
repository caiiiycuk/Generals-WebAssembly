// GeneralsX Web - asset storage layer.
//
// Two drivers behind one async interface:
//   - OpfsStorage:  Origin Private File System (preferred; durable, fast,
//                   and readable synchronously by the wasm side via WASMFS).
//   - IdbStorage:   IndexedDB fallback for environments where OPFS is not
//                   available. The wasm side cannot read IndexedDB directly,
//                   so at boot the loader materializes files as ArrayBuffers
//                   on window.gxFiles and the C++ side copies them into a
//                   WASMFS js-file backend mount (data lives in JS memory,
//                   not in the wasm heap).
//
// Both drivers store the game files under a flat "path -> bytes" model plus
// a small metadata record (installed manifest) used for delta updates.
//
// GeneralsX @build web-port 05/07/2026 - Web port Phase 1

'use strict';

const GX_DB_NAME = 'gx-assets';
const GX_DB_STORE = 'files';
const GX_DB_META = 'meta';

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

async function gxDetectStorage() {
  // ?storage=idb forces the IndexedDB fallback (testing / broken-OPFS escape hatch).
  const forced = new URLSearchParams(location.search).get('storage');
  if (forced === 'idb') {
    console.warn('[storage] IndexedDB forced via ?storage=idb');
    return await IdbStorage.open();
  }
  // OPFS needs a secure context; also probe that it actually works (some
  // browsers expose navigator.storage but fail on getDirectory).
  if (window.isSecureContext && navigator.storage && navigator.storage.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      // Probe write access.
      const probe = await root.getFileHandle('.gx-probe', { create: true });
      await root.removeEntry('.gx-probe');
      void probe;
      // Everything (GameData/, GameDataGenerals/, meta/, userdata/) lives in
      // the game's own ccgenerals/ subdirectory, not in the shared OPFS root —
      // the wasm side mounts the same base (GX_OPFS_BASE in WebMain.cpp).
      const base = await root.getDirectoryHandle('ccgenerals', { create: true });
      return new OpfsStorage(base);
    } catch (e) {
      console.warn('[storage] OPFS probe failed, falling back to IndexedDB:', e);
    }
  }
  if (window.indexedDB) {
    const db = await IdbStorage.open();
    return db;
  }
  // GeneralsX @feature Lolendor 22/07/2026 Localize launch-screen storage errors.
  throw new Error(window.gxI18n.t('error.storage'));
}

// ---------------------------------------------------------------------------
// OPFS driver
// ---------------------------------------------------------------------------


// Where a manifest path lands inside the storage root. Regular assets live under
// GameData/ (the ZH install); paths already prefixed with GameDataGenerals/ are the
// optional base-game install and live as a sibling, so the engine's recursive
// primary *.big scan of GameData/ never picks them up out of order.
function gxStoragePath(path) {
  return path.startsWith('GameDataGenerals/') ? path : 'GameData/' + path;
}

class OpfsStorage {
  constructor(root) {
    this.kind = 'opfs';
    this.root = root;
  }

  async _dir(path, create) {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    let dir = this.root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return { dir, name };
  }

  async readMeta(key) {
    try {
      const { dir, name } = await this._dir('meta/' + key + '.json', false);
      const fh = await dir.getFileHandle(name);
      const f = await fh.getFile();
      return JSON.parse(await f.text());
    } catch {
      return null;
    }
  }

  async writeMeta(key, value) {
    const { dir, name } = await this._dir('meta/' + key + '.json', true);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(value));
    await w.close();
  }

  async has(path) {
    try {
      const { dir, name } = await this._dir(gxStoragePath(path), false);
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async fileSize(path) {
    try {
      const { dir, name } = await this._dir(gxStoragePath(path), false);
      const fh = await dir.getFileHandle(name);
      const f = await fh.getFile();
      return f.size;
    } catch {
      return -1;
    }
  }

  // Streams a Response body into the file, reporting progress. Returns bytes written.
  async writeStream(path, response, onProgress) {
    const { dir, name } = await this._dir(gxStoragePath(path), true);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    const reader = response.body.getReader();
    let written = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await w.write(value);
      written += value.byteLength;
      if (onProgress) onProgress(value.byteLength);
    }
    await w.close();
    return written;
  }

  async readBytes(path) {
    const { dir, name } = await this._dir(gxStoragePath(path), false);
    const fh = await dir.getFileHandle(name);
    const f = await fh.getFile();
    return await f.arrayBuffer();
  }

  async listPaths() {
    const paths = [];
    async function walk(dir, prefix) {
      for await (const [name, handle] of dir) {
        const full = prefix ? prefix + '/' + name : name;
        if (handle.kind === 'file') paths.push(full);
        else await walk(handle, full);
      }
    }
    await walk(this.root, '');
    // Filter out meta/ and userdata/ for the caller's convenience.
    return paths.filter(p => !p.startsWith('meta/'));
  }

  async remove(path) {
    try {
      const { dir, name } = await this._dir(gxStoragePath(path), false);
      await dir.removeEntry(name);
    } catch {}
  }

  async requestPersist() {
    try {
      if (navigator.storage.persist) {
        const ok = await navigator.storage.persist();
        console.log('[storage] navigator.storage.persist() ->', ok);
      }
    } catch {}
  }

  async writeBlob(path, blob) {
    const { dir, name } = await this._dir(gxStoragePath(path), true);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  async estimate() {
    try {
      return await navigator.storage.estimate();
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// IndexedDB driver (fallback)
// ---------------------------------------------------------------------------

class IdbStorage {
  constructor(db) {
    this.kind = 'idb';
    this.db = db;
  }

  static open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(GX_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(GX_DB_STORE)) db.createObjectStore(GX_DB_STORE);
        if (!db.objectStoreNames.contains(GX_DB_META)) db.createObjectStore(GX_DB_META);
      };
      req.onsuccess = () => resolve(new IdbStorage(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  _tx(store, mode) {
    return this.db.transaction(store, mode).objectStore(store);
  }

  _req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  async readMeta(key) {
    const v = await this._req(this._tx(GX_DB_META, 'readonly').get(key));
    return v === undefined ? null : v;
  }

  async writeMeta(key, value) {
    await this._req(this._tx(GX_DB_META, 'readwrite').put(value, key));
  }

  async has(path) {
    const keys = await this._req(this._tx(GX_DB_STORE, 'readonly').getKey(path));
    return keys !== undefined;
  }

  async fileSize(path) {
    const blob = await this._req(this._tx(GX_DB_STORE, 'readonly').get(path));
    return blob ? blob.size : -1;
  }

  // IDB has no streaming writes: buffer the response, then put() the Blob.
  async writeStream(path, response, onProgress) {
    const reader = response.body.getReader();
    const chunks = [];
    let written = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      written += value.byteLength;
      if (onProgress) onProgress(value.byteLength);
    }
    const blob = new Blob(chunks);
    await this._req(this._tx(GX_DB_STORE, 'readwrite').put(blob, path));
    return written;
  }

  async readBytes(path) {
    const blob = await this._req(this._tx(GX_DB_STORE, 'readonly').get(path));
    if (!blob) throw new Error('missing in IndexedDB: ' + path);
    return await blob.arrayBuffer();
  }

  async remove(path) {
    await this._req(this._tx(GX_DB_STORE, 'readwrite').delete(path));
  }

  // Direct blob write (userdata write-back path).
  async writeBlob(path, blob) {
    await this._req(this._tx(GX_DB_STORE, 'readwrite').put(blob, path));
  }

  async listPaths() {
    return await this._req(this._tx(GX_DB_STORE, 'readonly').getAllKeys());
  }

  async requestPersist() {
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    } catch {}
  }

  async estimate() {
    try {
      return navigator.storage && navigator.storage.estimate
        ? await navigator.storage.estimate()
        : null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Userdata store (gx-userdata) - Options.ini, saves, replays.
//
// A separate IndexedDB database, independent from game assets: OPFS holds
// only the torrent-deployed game data, so a redeploy or asset wipe never
// touches user files. The engine mounts a WASMFS js-file backend at
// /idb/userdata (classic emscripten IDBFS is unavailable under -sWASMFS,
// which the OPFS asset backend requires), restores it from here at boot
// (window.gxUserFiles) and syncs changes back through
// window.gxIdbPutUserFile / window.gxIdbPruneUserFiles - the same
// mount+syncfs semantics IDBFS provides on the legacy FS.
//
// GeneralsX @feature caiiiycuk 14/08/2026
// ---------------------------------------------------------------------------

// jsdos-cloud-sdk's pushIDBFSStorage()/pullIDBFSStorage() APIs serialize this
// exact Emscripten IDBFS schema. Keep the version/store/value layout aligned
// with IDBFSStorage in cloud-sdk.js; cloud serialization must stay inside the
// SDK rather than being duplicated by the GeneralsX shell.
// GeneralsX @feature caiiiycuk 21/08/2026 Use the CloudSDK IDBFS format for userdata sync.
const GX_USER_DB = 'gx-userdata';
const GX_USER_DB_VERSION = 21;
const GX_USER_STORE = 'FILE_DATA';
const GX_USER_LEGACY_STORE = 'files';
const GX_USER_FILE_MODE = 0x81b6; // S_IFREG | 0666, matching IDBFS files.
const GX_USER_REVISION_KEY = 'gx.cloud.userdata.revision';
const GX_USER_SYNCED_REVISION_KEY = 'gx.cloud.userdata.syncedRevision';

let gxUserDbPromise = null;
let gxUserRevision = 0;
let gxUserSyncedRevision = 0;
let gxUserRevisionLoaded = false;

function gxUserReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function gxUserTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function gxLoadUserRevisions(fileCount) {
  if (gxUserRevisionLoaded) return;

  let revision = null;
  let syncedRevision = null;
  try {
    revision = localStorage.getItem(GX_USER_REVISION_KEY);
    syncedRevision = localStorage.getItem(GX_USER_SYNCED_REVISION_KEY);
  } catch {}

  const parsedRevision = revision === null ? NaN : Number(revision);
  const parsedSynced = syncedRevision === null ? NaN : Number(syncedRevision);
  if (Number.isSafeInteger(parsedRevision) && parsedRevision >= 0 &&
      Number.isSafeInteger(parsedSynced) && parsedSynced >= 0) {
    gxUserRevision = parsedRevision;
    gxUserSyncedRevision = parsedSynced;
  } else {
    // Existing records predate cloud-sync metadata and must win over a stale
    // remote snapshot on the first upgraded launch.
    gxUserRevision = fileCount > 0 ? 1 : 0;
    gxUserSyncedRevision = 0;
  }
  gxUserRevisionLoaded = true;
  gxPersistUserRevisions();
}

function gxPersistUserRevisions() {
  try {
    localStorage.setItem(GX_USER_REVISION_KEY, String(gxUserRevision));
    localStorage.setItem(GX_USER_SYNCED_REVISION_KEY, String(gxUserSyncedRevision));
  } catch {}
}

function gxMarkUserdataDirty() {
  if (!gxUserRevisionLoaded) gxLoadUserRevisions(0);
  gxUserRevision++;
  gxPersistUserRevisions();
  return gxUserRevision;
}

async function gxLegacyUserBytes(value) {
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

async function gxMigrateLegacyUserStore(db) {
  if (!db.objectStoreNames.contains(GX_USER_LEGACY_STORE)) return;

  const targetTx = db.transaction(GX_USER_STORE, 'readonly');
  const targetCountPromise = gxUserReq(targetTx.objectStore(GX_USER_STORE).count());
  const targetDone = gxUserTxDone(targetTx);
  const targetCount = await targetCountPromise;
  await targetDone;

  if (targetCount === 0) {
    const readTx = db.transaction(GX_USER_LEGACY_STORE, 'readonly');
    const legacy = readTx.objectStore(GX_USER_LEGACY_STORE);
    const keysPromise = gxUserReq(legacy.getAllKeys());
    const valuesPromise = gxUserReq(legacy.getAll());
    const readDone = gxUserTxDone(readTx);
    const [keys, values] = await Promise.all([keysPromise, valuesPromise]);
    await readDone;

    const entries = [];
    for (let i = 0; i < keys.length; i++) {
      const bytes = await gxLegacyUserBytes(values[i]);
      if (bytes) entries.push({ path: keys[i], bytes });
    }

    if (entries.length > 0) {
      const writeTx = db.transaction(GX_USER_STORE, 'readwrite');
      const target = writeTx.objectStore(GX_USER_STORE);
      for (const entry of entries) {
        target.put({
          timestamp: new Date(),
          mode: GX_USER_FILE_MODE,
          contents: new Int8Array(entry.bytes),
        }, entry.path);
      }
      await gxUserTxDone(writeTx);
      console.log('[storage] migrated', entries.length, 'userdata file(s) to CloudSDK IDBFS format');
    }
  }

  // Never leave stale legacy records that could be re-imported after the user
  // intentionally deletes every save/replay from the new store.
  const clearTx = db.transaction(GX_USER_LEGACY_STORE, 'readwrite');
  clearTx.objectStore(GX_USER_LEGACY_STORE).clear();
  await gxUserTxDone(clearTx);
}

function gxUserDbOpen() {
  if (gxUserDbPromise) return gxUserDbPromise;

  gxUserDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(GX_USER_DB, GX_USER_DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(GX_USER_STORE))
        req.result.createObjectStore(GX_USER_STORE).createIndex('timestamp', 'timestamp');
    };
    req.onsuccess = async () => {
      try {
        await gxMigrateLegacyUserStore(req.result);
        resolve(req.result);
      } catch (e) {
        req.result.close();
        gxUserDbPromise = null;
        reject(e);
      }
    };
    req.onerror = () => {
      gxUserDbPromise = null;
      reject(req.error);
    };
  });
  return gxUserDbPromise;
}

const gxUserStore = {
  _pending: new Set(),

  _track(promise) {
    this._pending.add(promise);
    promise.then(
      () => this._pending.delete(promise),
      () => this._pending.delete(promise),
    );
    return promise;
  },

  async ready() {
    const db = await gxUserDbOpen();
    const tx = db.transaction(GX_USER_STORE, 'readonly');
    const countPromise = gxUserReq(tx.objectStore(GX_USER_STORE).count());
    const done = gxUserTxDone(tx);
    const count = await countPromise;
    await done;
    gxLoadUserRevisions(count);
  },

  async whenIdle() {
    while (this._pending.size > 0) {
      await Promise.allSettled(Array.from(this._pending));
    }
  },

  revision() {
    if (!gxUserRevisionLoaded) gxLoadUserRevisions(0);
    return gxUserRevision;
  },

  hasUnsyncedChanges() {
    if (!gxUserRevisionLoaded) gxLoadUserRevisions(0);
    return gxUserRevision !== gxUserSyncedRevision;
  },

  markSynced(revision) {
    if (!gxUserRevisionLoaded) gxLoadUserRevisions(0);
    if (revision === undefined || revision === gxUserRevision)
      gxUserSyncedRevision = gxUserRevision;
    gxPersistUserRevisions();
  },

  // Every stored file as [{path, data:ArrayBuffer}] - the engine copies them
  // into its /idb/userdata mount at boot.
  async readAll() {
    try {
      await this.ready();
      const db = await gxUserDbOpen();
      const tx = db.transaction(GX_USER_STORE, 'readonly');
      const store = tx.objectStore(GX_USER_STORE);
      const keysPromise = gxUserReq(store.getAllKeys());
      const valuesPromise = gxUserReq(store.getAll());
      const done = gxUserTxDone(tx);
      const [keys, values] = await Promise.all([keysPromise, valuesPromise]);
      await done;

      const out = [];
      for (let i = 0; i < keys.length; i++) {
        const contents = values[i] && values[i].contents;
        if (contents === undefined) continue;
        const bytes = contents instanceof ArrayBuffer
          ? new Uint8Array(contents)
          : new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
        out.push({ path: keys[i], data: bytes.slice().buffer });
      }
      return out;
    } catch (e) {
      console.warn('[storage] userdata restore failed:', e);
      return [];
    }
  },

  put(path, bytes) {
    gxMarkUserdataDirty();
    const operation = (async () => {
      const db = await gxUserDbOpen();
      const tx = db.transaction(GX_USER_STORE, 'readwrite');
      const view = bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      tx.objectStore(GX_USER_STORE).put({
        timestamp: new Date(),
        mode: GX_USER_FILE_MODE,
        contents: new Int8Array(view),
      }, path);
      await gxUserTxDone(tx);
      return true;
    })().catch((e) => {
      console.warn('[storage] userdata write-back failed:', path, e);
      return false;
    });
    return this._track(operation);
  },

  // Delete records whose path is not on the survivor list (files removed
  // in-game: saves, replays).
  prune(keepPaths) {
    const operation = (async () => {
      const keep = new Set(keepPaths);
      const db = await gxUserDbOpen();
      const tx = db.transaction(GX_USER_STORE, 'readwrite');
      const store = tx.objectStore(GX_USER_STORE);
      const keys = await gxUserReq(store.getAllKeys());
      let changed = false;
      for (const key of keys) {
        if (!keep.has(key)) {
          store.delete(key);
          changed = true;
        }
      }
      if (changed) gxMarkUserdataDirty();
      await gxUserTxDone(tx);
      return true;
    })().catch((e) => {
      console.warn('[storage] userdata prune failed:', e);
      return false;
    });
    return this._track(operation);
  },
};

window.gxUserStore = gxUserStore;
window.gxDetectStorage = gxDetectStorage;
