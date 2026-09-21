import { useEffect, useRef, useState } from "react";

export type BlackHoleMessage = {
  id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  };
};

type Particle = {
  id: string;
  text: string;
  authorName: string;
  color: string;
  // Angle around the black hole, derived from the message ID so each message
  // keeps the same slot across reloads.
  angle: number;
  // Depth on the 30-day age scale: 0 = newest (outer rim), 1 = oldest (horizon).
  depth: number;
  timestampMs: number;
  bornAt: number;
};

type Props = {
  messages: BlackHoleMessage[];
};

const MAX_PARTICLES = 500;
const OUTER_RADIUS_FACTOR = 0.45; // fraction of min(width, height)
const EVENT_HORIZON_FACTOR = 0.06;
const ACCRETION_DISK_INNER = 0.09;
const ACCRETION_DISK_OUTER = 0.22;

function hashColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 80%, 65%)`;
}

function truncate(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

export function BlackHoleCanvas({ messages }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<Map<string, Particle>>(new Map());
  const messagesRef = useRef<Array<BlackHoleMessage & { rankedDepth: number }>>(
      messages.map((m, i, arr) => ({
        ...m,
        rankedDepth: arr.length <= 1 ? 0 : i / (arr.length - 1),
      })),
    );
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  // Screen-space cache of streak positions for hover hit-testing.
  const streaksRef = useRef<
    Array<{ x1: number; y1: number; x2: number; y2: number; id: string }>
  >([]);
  const [hovered, setHovered] = useState<BlackHoleMessage | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  // Keep latest messages accessible from the animation loop without restarting it.
  useEffect(() => {
    // Compute ranked depth (0 = newest, 1 = oldest) so the disc is always
    // fully populated from rim to horizon, independent of absolute age.
    const total = messages.length;
    const ranked = messages.map((m, i) => ({
      ...m,
      rankedDepth: total <= 1 ? 0 : i / (total - 1),
    }));
    console.log(
      `[BlackHoleCanvas] messages prop updated → ${messages.length} message(s)` +
        (messages.length > 0 ? `, newest id: ${messages[0].id}` : ""),
    );
    messagesRef.current = ranked;
  }, [messages]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      console.warn("[BlackHoleCanvas] canvas ref is null on mount");
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      console.warn("[BlackHoleCanvas] 2D context unavailable");
      return;
    }
    console.log("[BlackHoleCanvas] animation effect mounted");

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;

    const tick = (now: number) => {
      const { w, h } = sizeRef.current;
      const cx = w / 2;
      const cy = h / 2;
      const minDim = Math.min(w, h);
      const outerR = minDim * OUTER_RADIUS_FACTOR;
      const horizonR = minDim * EVENT_HORIZON_FACTOR;
      const diskInner = minDim * ACCRETION_DISK_INNER;
      const diskOuter = minDim * ACCRETION_DISK_OUTER;

      // Spawn new particles for messages we haven't seen yet.
      const seen = particlesRef.current;
      const incoming = messagesRef.current;
      let idx = 0;
      for (const m of incoming) {
        const i = idx++;
        if (seen.has(m.id)) continue;
        if (seen.size >= MAX_PARTICLES) {
          // Evict the particle with the oldest message timestamp.
          let oldestId: string | null = null;
          let oldestTs = Infinity;
          for (const [id, p] of seen) {
            if (p.timestampMs < oldestTs) {
              oldestTs = p.timestampMs;
              oldestId = id;
            }
          }
          if (oldestId) seen.delete(oldestId);
        }
        const timestampMs = new Date(m.timestamp).getTime();
        seen.set(m.id, {
          id: m.id,
          text: truncate(m.content || "(empty)"),
          authorName: m.author.displayName,
          color: hashColor(m.author.id),
          // Golden-angle spiral distributes dense streaks across the disc
          // instead of bundling them on one ring.
          angle: (i * 2.39996) % (Math.PI * 2),
          depth: m.rankedDepth,
          timestampMs,
          bornAt: now,
        });
      }

      // Clear with a slight trail for motion blur.
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      ctx.fillRect(0, 0, w, h);

      // Accretion disk glow.
      const diskGrad = ctx.createRadialGradient(
        cx,
        cy,
        diskInner * 0.6,
        cx,
        cy,
        diskOuter,
      );
      diskGrad.addColorStop(0, "rgba(255, 180, 80, 0.0)");
      diskGrad.addColorStop(0.35, "rgba(255, 160, 60, 0.18)");
      diskGrad.addColorStop(0.7, "rgba(255, 110, 40, 0.10)");
      diskGrad.addColorStop(1, "rgba(255, 80, 20, 0.0)");
      ctx.fillStyle = diskGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, diskOuter, 0, Math.PI * 2);
      ctx.fill();

      // Photon ring / event horizon.
      const ringGrad = ctx.createRadialGradient(
        cx,
        cy,
        horizonR * 0.6,
        cx,
        cy,
        horizonR * 1.6,
      );
      ringGrad.addColorStop(0, "rgba(0, 0, 0, 1)");
      ringGrad.addColorStop(0.7, "rgba(255, 200, 120, 0.55)");
      ringGrad.addColorStop(1, "rgba(255, 200, 120, 0)");
      ctx.fillStyle = ringGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, horizonR * 1.6, 0, Math.PI * 2);
      ctx.fill();

      // Solid black core.
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.arc(cx, cy, horizonR, 0, Math.PI * 2);
      ctx.fill();

      // Draw particles as hyperspace streaks radiating from the black hole.
      // Screen-space segments are cached for hover hit-testing.
      streaksRef.current = [];
      for (const p of seen.values()) {
        // Ranked depth → radius: sqrt spacing spreads shallow depths outward
        // so the disc fills evenly instead of clumping at the rim.
        const baseR = horizonR * 1.2 + (outerR - horizonR * 1.2) * Math.sqrt(1 - p.depth);
        const streakLen = 14 + (1 - p.depth) * (outerR * 0.4);
        const lineWidth = Math.max(0.75, 2.6 - p.depth * 1.6);

        const cos = Math.cos(p.angle);
        const sin = Math.sin(p.angle);
        const x1 = cx + cos * baseR;
        const y1 = cy + sin * baseR;
        const x2 = cx + cos * (baseR + streakLen);
        const y2 = cy + sin * (baseR + streakLen);

        const ageMs = now - p.bornAt;
        const fadeIn = Math.min(1, ageMs / 600);
        const depthAlpha = 0.9 - p.depth * 0.45;
        const alpha = fadeIn * depthAlpha;

        // Glow pass (wide, low alpha).
        ctx.save();
        ctx.globalAlpha = alpha * 0.35;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = lineWidth * 3;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        // Core pass (thin, bright).
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();

        streaksRef.current.push({ x1, y1, x2, y2, id: p.id });
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    // Hover: hit-test cached streak segments, expand message on hover.
    const HIT_PX = 10;
    const onMouseMove = (e: MouseEvent) => {
      const mx = e.clientX;
      const my = e.clientY;
      let hit: string | null = null;
      for (const s of streaksRef.current) {
        // Distance from point to segment.
        const dx = s.x2 - s.x1;
        const dy = s.y2 - s.y1;
        const lenSq = dx * dx + dy * dy;
        const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((mx - s.x1) * dx + (my - s.y1) * dy) / lenSq));
        const px = s.x1 + t * dx;
        const py = s.y1 + t * dy;
        if (Math.hypot(mx - px, my - py) <= HIT_PX) {
          hit = s.id;
          break;
        }
      }
      if (hit) {
        const msg = messagesRef.current.find((m) => m.id === hit);
        if (msg) {
          setHovered(msg);
          setHoverPos({ x: mx, y: my });
        }
      } else {
        setHovered(null);
        setHoverPos(null);
      }
    };
    window.addEventListener("mousemove", onMouseMove);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="bh-canvas" />
      {hovered && hoverPos && (
        <div
          className="bh-hover-card"
          style={{ left: hoverPos.x + 14, top: hoverPos.y + 14 }}
        >
          <div className="bh-hover-author">{hovered.author.displayName}</div>
          <div className="bh-hover-text">{hovered.content || "(empty message)"}</div>
          <div className="bh-hover-time">
            {new Date(hovered.timestamp).toLocaleString()}
          </div>
        </div>
      )}
    </>
  );
}
