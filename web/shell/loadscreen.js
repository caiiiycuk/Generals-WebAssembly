// GeneralsX Web - load-screen frame receiver (main thread).
//
// During map load the game pthread is blocked and OffscreenCanvas frames are
// never composited (browsers only push them when the worker yields). The
// engine-side pump (LoadScreen.cpp, gxWebPumpLoadFrame) glReadPixels() the
// just-rendered ORIGINAL load-screen frame — non-destructively, the game
// canvas is never touched — and hands the RGBA pixels here via
// MAIN_THREAD_EM_ASM. We paint them onto a fullscreen overlay canvas, so the
// player sees the real load screen (background art, portraits, per-player
// progress bars) exactly as the engine rendered it.
//
// GL rows are bottom-up; the overlay flips via ctx.scale(1,-1) so the frame
// lands upright without a CPU flip pass.
//
// GeneralsX @build web-port loadscreen 09/07/2026

'use strict';

const gxLoadScreen = {
  canvas: null,
  ctx: null,
  active: false,
  activeLoads: 0,

  _ensure() {
    if (this.canvas) return;
    const cv = document.createElement('canvas');
    cv.id = 'gx-loadframe';
    cv.style.cssText =
      // GeneralsX @bugfix caiiiycuk 21/08/2026 The loading-frame mirror
      // must outlive and cover all shell UI, including the launch overlay.
      'position:fixed;inset:0;width:100vw;height:100vh;z-index:100;' +
      // GL readback rows are bottom-up. Flip the canvas during compositing
      // rather than copying the canvas onto itself every frame.
      'transform:scaleY(-1);' +
      'display:none;background:#000;pointer-events:none;';
    document.body.appendChild(cv);
    this.canvas = cv;
    this.ctx = cv.getContext('2d');
  },

  begin() {
    this._ensure();
    this.activeLoads++;
    this.active = true;
    this.canvas.style.display = 'block';
    // The engine can enter a load screen before onRuntimeInitialized() lets
    // loader.js hide this launch overlay. Do it here as the authoritative
    // hand-off, otherwise its z-index can cover the mirrored game frame.
    const launchOverlay = document.getElementById('gx-overlay');
    if (launchOverlay) launchOverlay.style.display = 'none';
  },

  // px: Uint8Array RGBA, bottom-up (GL readback). w/h in pixels.
  frameRGBA(px, w, h) {
    if (!this.active) return;
    this._ensure();
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const img = new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, w * h * 4), w, h);
    this.ctx.putImageData(img, 0, 0);
  },

  end() {
    // A new load screen can be initialized before the old instance is
    // destroyed. Keep the mirror visible until the last active instance ends.
    if (this.activeLoads > 0) this.activeLoads--;
    if (this.activeLoads > 0) return;
    this.active = false;
    if (this.canvas) this.canvas.style.display = 'none';
  },
};

window.gxLoadScreen = gxLoadScreen;
