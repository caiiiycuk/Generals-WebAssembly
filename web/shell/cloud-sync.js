// GeneralsX Web - Cloud sync for user data via jsdos-cloud-sdk.
//
// gx-userdata uses the SDK's IDBFS-compatible FILE_DATA schema (storage.js).
// CloudSDK owns serialization, validation, LZ4 compression and deserialization;
// this file only coordinates boot ordering, local-change tracking and the UI.
//
// GeneralsX @feature caiiiycuk 21/08/2026 Synchronize userdata through CloudSDK's IDBFS API.

'use strict';

(() => {
  const GX_CLOUD_DB = 'gx-userdata';
  const GX_CLOUD_KEY = 'generalsx-backup.idbfs';

  let cloudReady = false;
  let initPromise = null;
  let mountPromise = null;
  let pushPromise = null;
  let hideWidget = null;

  function cloudUnavailableMessage(error) {
    const message = error && error.message ? error.message : String(error);
    return message.includes('Not logged in') || message.includes('not premium');
  }

  function mountWidgetOnce() {
    if (mountPromise) return mountPromise;
    if (!window.CloudSDKUI || typeof window.CloudSDKUI.mount !== 'function')
      return Promise.resolve(false);

    mountPromise = Promise.resolve()
      .then(() => window.CloudSDKUI.mount())
      .then((hide) => {
        hideWidget = typeof hide === 'function' ? hide : null;
        return true;
      })
      .catch((error) => {
        console.warn('[cloud-sync] widget mount failed:', error);
        return false;
      });
    return mountPromise;
  }

  async function initializeCloudSync() {
    const userStore = window.gxUserStore;
    if (!userStore) {
      console.warn('[cloud-sync] gxUserStore is unavailable');
      cloudReady = true;
      return false;
    }

    await userStore.ready();
    if (!window.CloudSDKUI) {
      cloudReady = true;
      return false;
    }

    await mountWidgetOnce();

    // A local write that was not acknowledged by a successful cloud push
    // must survive the next boot. Push it later instead of replacing it with
    // an older remote snapshot.
    if (userStore.hasUnsyncedChanges()) {
      console.log('[cloud-sync] local userdata is newer; initial pull skipped');
      cloudReady = true;
      return true;
    }

    try {
      const restored = await window.CloudSDKUI.pullIDBFSStorage(GX_CLOUD_KEY, GX_CLOUD_DB);
      if (restored) {
        userStore.markSynced();
        console.log('[cloud-sync] userdata restored through CloudSDK');
      } else {
        console.log('[cloud-sync] no cloud userdata found');
      }
      return restored;
    } catch (error) {
      if (cloudUnavailableMessage(error)) {
        console.log('[cloud-sync] pull skipped: cloud saves are not enabled');
      } else {
        console.warn('[cloud-sync] initial pull failed:', error);
      }
      return false;
    } finally {
      cloudReady = true;
    }
  }

  function gxCloudInit() {
    if (!initPromise) {
      initPromise = initializeCloudSync().catch((error) => {
        cloudReady = true;
        console.warn('[cloud-sync] initialization failed:', error);
        return false;
      });
    }
    return initPromise;
  }

  async function pushUserdata() {
    const userStore = window.gxUserStore;
    if (!cloudReady || !window.CloudSDKUI || !userStore) return false;
    if (pushPromise) return pushPromise;

    pushPromise = (async () => {
      // C++ starts IndexedDB write-back immediately before this call. Wait for
      // every put/prune transaction so CloudSDK serializes a coherent snapshot.
      await userStore.whenIdle();
      if (!userStore.hasUnsyncedChanges()) return true;

      const revision = userStore.revision();
      const pushed = await window.CloudSDKUI.pushIDBFSStorage(GX_CLOUD_KEY, GX_CLOUD_DB);
      if (pushed && userStore.revision() === revision) {
        userStore.markSynced(revision);
        console.log('[cloud-sync] userdata synchronized through CloudSDK');
      } else if (!pushed) {
        console.log('[cloud-sync] push skipped: cloud saves are not enabled');
      }
      return pushed;
    })().catch((error) => {
      console.warn('[cloud-sync] push failed:', error);
      return false;
    }).finally(() => {
      pushPromise = null;
    });

    return pushPromise;
  }

  window.gxCloudSync = {
    init: gxCloudInit,
    pushPeriodic: pushUserdata,
    forcePushToStorage: pushUserdata,
  };
  window.gxCloudInit = gxCloudInit;
  window.gxCloudSyncEnabled = () => cloudReady;
  window.gxCloudSyncHideWidget = async () => {
    if (hideWidget) hideWidget();
  };

  console.log('[cloud-sync] script loaded');
})();
