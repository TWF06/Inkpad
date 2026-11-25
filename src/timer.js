// Floating focus timer: countdown, stopwatch, Pomodoro. State survives navigation between notes.
import { h, icon, toast } from './ui.js';

const S = { mode: 'pomodoro', running: false, elapsed: 0, startedAt: 0, minutes: 10, phase: 'focus', round: 1, el: null, tick: 0 };
const POMO = { focus: 25, break: 5, long: 15 };

const target = () => (S.mode === 'countdown' ? S.minutes * 60e3 : S.mode === 'pomodoro' ? POMO[S.phase] * 60e3 : Infinity);
const now = () => S.elapsed + (S.running ? Date.now() - S.startedAt : 0);
const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(s / 60); return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

function beep() {
  try {
    const ac = new AudioContext();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 880; g.gain.setValueAtTime(0.2, ac.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t + 0.3);
      o.connect(g).connect(ac.destination); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.3);
    });
  } catch {}
}

function finish() {
  beep();
  let msg = 'Timer finished';
  if (S.mode === 'pomodoro') {
    if (S.phase === 'focus') { S.phase = S.round % 4 === 0 ? 'long' : 'break'; msg = 'Break'; }
    else { S.phase = 'focus'; S.round++; msg = 'Focus'; }
    S.elapsed = 0; S.startedAt = Date.now();
  } else { S.running = false; S.elapsed = 0; }
  toast(msg, 4000);
  if ('Notification' in window && Notification.permission === 'granted') {
    // Android Chrome only allows notifications through the service worker; the constructor throws there
    navigator.serviceWorker?.getRegistration?.().then((r) => (r ? r.showNotification('Inkpad', { body: msg }) : new Notification('Inkpad', { body: msg }))).catch(() => {});
  }
}

function loop() {
  if (S.running && now() >= target()) finish();
  render();
  S.tick = S.running ? setTimeout(loop, 250) : 0;
}

function render() {
  if (!S.el) return;
  const t = target();
  S.el.querySelector('.tm-time').textContent = fmt(t === Infinity ? now() : t - now());
  S.el.querySelector('.tm-phase').textContent = S.mode === 'pomodoro' ? `${S.phase === 'focus' ? 'Focus' : S.phase === 'long' ? 'Long break' : 'Break'} · round ${S.round}` : S.mode === 'countdown' ? 'Countdown' : 'Stopwatch';
  S.el.querySelector('[data-a=toggle]').textContent = S.running ? 'Pause' : 'Start';
  S.el.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === S.mode));
  S.el.querySelector('.tm-min').hidden = S.mode !== 'countdown' || S.running;
}

export function toggleTimer() {
  if (S.el) { S.el.remove(); S.el = null; return; }
  S.el = h(`<div class="timer">
    <div class="tm-head">${icon('timer', 16)}<span class="tm-phase"></span><button class="icon-btn sm" data-a="close">${icon('close', 14)}</button></div>
    <div class="tm-modes"><button data-m="pomodoro">Pomodoro</button><button data-m="countdown">Countdown</button><button data-m="stopwatch">Stopwatch</button></div>
    <div class="tm-time">00:00</div>
    <label class="tm-min">Minutes <input type="number" min="1" max="600" value="${S.minutes}"></label>
    <div class="tm-actions"><button class="btn primary" data-a="toggle">Start</button><button class="btn ghost" data-a="reset">Reset</button></div>
  </div>`);
  S.el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.m) { S.mode = b.dataset.m; S.running = false; S.elapsed = 0; S.phase = 'focus'; S.round = 1; }
    if (b.dataset.a === 'close') return toggleTimer();
    if (b.dataset.a === 'toggle') {
      if (S.running) { S.elapsed = now(); S.running = false; }
      else { S.startedAt = Date.now(); S.running = true; if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()?.catch?.(() => {}); }
    }
    if (b.dataset.a === 'reset') { S.running = false; S.elapsed = 0; S.phase = 'focus'; S.round = 1; }
    clearTimeout(S.tick);
    loop();
  });
  S.el.querySelector('.tm-min input').addEventListener('change', (e) => { S.minutes = Math.max(1, Number(e.target.value) || 10); render(); });
  // drag by header
  const head = S.el.querySelector('.tm-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = S.el.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
    const move = (ev) => { S.el.style.left = ev.clientX - ox + 'px'; S.el.style.top = ev.clientY - oy + 'px'; S.el.style.right = 'auto'; };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
  document.body.append(S.el);
  clearTimeout(S.tick);
  loop();
}
