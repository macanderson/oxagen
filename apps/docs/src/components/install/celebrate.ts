/**
 * celebrate() — the install-button celebration sequence:
 *
 *   1. confetti cannons fire from the lower-left and lower-right corners,
 *   2. a burst of applause plays (~2.4s),
 *   3. an iconic 70s-superhero one-liner follows ("It's a bird! It's a
 *      plane! It's Superman!" — Superman: The Movie, 1978), ≤5s.
 *
 * Everything is generated on-device: the confetti is a throwaway <canvas>,
 * the applause is WebAudio-synthesised noise-burst claps, and the one-liner
 * is spoken via the Web Speech API — no bundled audio assets, nothing
 * copyrighted shipped. Confetti honours `prefers-reduced-motion`; audio is
 * always user-initiated (the click), so autoplay policies are satisfied.
 */

const EMBER = ["#fd9a4b", "#f07650", "#eb5c5e", "#38d39f", "#f8f6f1"];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  color: string;
  angle: number;
  spin: number;
  drag: number;
}

function spawnBurst(originX: number, originY: number, towardRight: boolean): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < 90; i++) {
    // aim the cannon up and toward the centre of the screen
    const base = towardRight ? -Math.PI / 3 : (-2 * Math.PI) / 3;
    const angle = base + (Math.random() - 0.5) * (Math.PI / 4);
    const speed = 13 + Math.random() * 13;
    particles.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 5 + Math.random() * 6,
      h: 3 + Math.random() * 5,
      color: EMBER[Math.floor(Math.random() * EMBER.length)] as string,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.32,
      drag: 0.985 - Math.random() * 0.012,
    });
  }
  return particles;
}

function fireConfetti(): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.cssText =
    "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const h = window.innerHeight;
  const w = window.innerWidth;
  let particles = [...spawnBurst(-10, h + 10, true), ...spawnBurst(w + 10, h + 10, false)];
  // a second volley shortly after the first, for a fuller sky
  const volley = setTimeout(() => {
    particles.push(...spawnBurst(-10, h + 10, true), ...spawnBurst(w + 10, h + 10, false));
  }, 260);

  const started = performance.now();
  function frame(now: number): void {
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    particles = particles.filter((p) => p.y < h + 40);
    for (const p of particles) {
      p.vx *= p.drag;
      p.vy = p.vy * p.drag + 0.42; // gravity
      p.x += p.vx;
      p.y += p.vy;
      p.angle += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (particles.length > 0 && now - started < 5200) {
      requestAnimationFrame(frame);
    } else {
      clearTimeout(volley);
      canvas.remove();
    }
  }
  requestAnimationFrame(frame);
}

/** Synthesise ~2.4s of applause: dozens of short, decaying noise-burst claps. */
function playApplause(ctx: AudioContext, onended: () => void): void {
  const duration = 2.4;
  const rate = ctx.sampleRate;
  const buffer = ctx.createBuffer(2, Math.ceil(duration * rate), rate);

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let clap = 0; clap < 150; clap++) {
      // crowd envelope: swells fast, tails off at the end
      const t0 = Math.random() * (duration - 0.08);
      const crowd = Math.min(1, t0 / 0.25) * Math.min(1, (duration - t0) / 0.6);
      const start = Math.floor(t0 * rate);
      const len = Math.floor((0.015 + Math.random() * 0.02) * rate);
      const gain = (0.18 + Math.random() * 0.28) * crowd;
      for (let i = 0; i < len && start + i < data.length; i++) {
        const idx = start + i;
        data[idx] = (data[idx] ?? 0) + (Math.random() * 2 - 1) * gain * Math.exp(-i / (len * 0.28));
      }
    }
  }

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  // tame the raw noise into something hand-shaped
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 2400;
  filter.Q.value = 0.7;
  const out = ctx.createGain();
  out.gain.value = 0.8;
  src.connect(filter).connect(out).connect(ctx.destination);
  src.onended = onended;
  src.start();
}

/** The iconic line, spoken with a touch of 70s-announcer drama. ≤5s. */
function playSuperheroLine(): void {
  if (!("speechSynthesis" in window)) return;
  const line = new SpeechSynthesisUtterance("It's a bird! It's a plane! It's Superman!");
  line.rate = 0.95;
  line.pitch = 0.8;
  line.volume = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(line);
}

let audioCtx: AudioContext | null = null;

export function celebrate(): void {
  fireConfetti();
  try {
    audioCtx ??= new AudioContext();
    void audioCtx.resume();
    playApplause(audioCtx, playSuperheroLine);
  } catch {
    /* no audio available — confetti already fired, degrade silently */
  }
}
