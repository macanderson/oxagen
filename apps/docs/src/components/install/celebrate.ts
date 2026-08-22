/**
 * celebrate() — the install-button celebration: confetti cannons fire from
 * the lower-left and lower-right corners of the screen.
 *
 * The confetti is a throwaway <canvas> generated on-device — no assets, no
 * dependencies — and honours `prefers-reduced-motion` (no confetti for
 * reduced-motion users; the button's copied state is the feedback).
 */

const EMBER = ["#A37200", "#FFB000", "#FFCB66", "#7BC98A", "#F1EDEA"];

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

function spawnBurst(
  originX: number,
  originY: number,
  towardRight: boolean,
): Particle[] {
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

export function celebrate(): void {
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
  let particles = [
    ...spawnBurst(-10, h + 10, true),
    ...spawnBurst(w + 10, h + 10, false),
  ];
  // a second volley shortly after the first, for a fuller sky
  const volley = setTimeout(() => {
    particles.push(
      ...spawnBurst(-10, h + 10, true),
      ...spawnBurst(w + 10, h + 10, false),
    );
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
