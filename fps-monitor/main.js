const el = document.createElement('div');
el.id = 'terra-fps-stats';
el.innerHTML = '<span><span class="v" data-k="fps">--</span><small>fps</small></span>';
document.body.append(el);

const fpsEl = el.querySelector('[data-k="fps"]');
let running = true;
let frameCount = 0;
let lastTime = performance.now();

// Calculate and update FPS every second
const loop = (now) => {
  if (!running) return;
  frameCount++;

  const delta = now - lastTime;
  if (delta >= 1000) {
    fpsEl.textContent = Math.round((frameCount * 1000) / delta);
    frameCount = 0;
    lastTime = now;
  }

  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

terra.onCleanup(() => {
  running = false;
  el.remove();
});

terra.log('FPS monitor ready');
