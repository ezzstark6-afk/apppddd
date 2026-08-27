/**
 * Relógio de quadros para o caminho de compatibilidade do Firefox.
 *
 * Firefox reduz drasticamente requestAnimationFrame/requestVideoFrameCallback
 * quando a página fica em segundo plano. Um Worker não depende da pintura da
 * aba e mantém a captura andando enquanto a pessoa usa a janela transmitida.
 */
let timer = null;
let nextAt = 0;
let interval = 1000 / 30;

const clampFps = (value) => Math.max(1, Math.min(60, Number(value) || 30));

function stop() {
  if (timer !== null) globalThis.clearTimeout(timer);
  timer = null;
}

function schedule() {
  stop();
  const now = performance.now();
  if (!nextAt || nextAt < now - interval) nextAt = now;
  nextAt += interval;
  timer = globalThis.setTimeout(tick, Math.max(0, nextAt - performance.now()));
}

function tick() {
  globalThis.postMessage({ type: 'tick' });
  schedule();
}

globalThis.onmessage = ({ data }) => {
  if (data?.type === 'stop') return stop();
  if (data?.type !== 'start' && data?.type !== 'fps') return;

  interval = 1000 / clampFps(data.fps);
  nextAt = performance.now();
  schedule();
};
