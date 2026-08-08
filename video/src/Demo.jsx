import {
  AbsoluteFill, Audio, Series, staticFile, useCurrentFrame, useVideoConfig,
  spring, interpolate, Sequence,
} from "remotion";
import { scenes } from "./script.mjs";
import timing from "./timing.json";

const C = {
  bg: "#0a0e13", panel: "#0e141b", line: "#1e2b3a", ink: "#c8d6e5", dim: "#7c8fa4",
  ok: "#5ddba4", bad: "#ff7b72", accent: "#79c0ff", head: "#e8f0f8",
};
const SANS = 'Inter, "Segoe UI", system-ui, sans-serif';
const MONO = 'Consolas, "Cascadia Code", monospace';

/** Entrance value 0→1 with a settled spring; `delay` staggers siblings. */
const useEnter = (delay = 0) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 22 });
};

const Rise = ({ delay = 0, children, style }) => {
  const e = useEnter(delay);
  return (
    <div style={{ opacity: e, transform: `translateY(${(1 - e) * 26}px)`, ...style }}>
      {children}
    </div>
  );
};

// A slow drifting glow so full-screen text is never dead flat.
const Backdrop = () => {
  const frame = useCurrentFrame();
  const x = 50 + Math.sin(frame / 190) * 16;
  const y = 42 + Math.cos(frame / 240) * 14;
  return (
    <AbsoluteFill style={{
      background: `radial-gradient(1100px 700px at ${x}% ${y}%, #12202e 0%, ${C.bg} 62%)`,
    }} />
  );
};

const Heading = ({ children, delay = 0 }) => (
  <Rise delay={delay}>
    <div style={{
      fontFamily: SANS, fontSize: 62, fontWeight: 700, color: C.head,
      letterSpacing: -1.4, lineHeight: 1.1, marginBottom: 46,
    }}>{children}</div>
  </Rise>
);

const Pad = ({ children }) => (
  <AbsoluteFill style={{ padding: "120px 130px 260px", justifyContent: "center" }}>
    {children}
  </AbsoluteFill>
);

// ── scene kinds ─────────────────────────────────────────────────────────────

const TitleScene = ({ scene }) => {
  const e = useEnter(4);
  return (
    <Pad>
      <div style={{ textAlign: scene.outro ? "center" : "left" }}>
        <Rise delay={0}>
          <div style={{
            fontFamily: SANS, fontSize: 20, letterSpacing: 3.4, textTransform: "uppercase",
            color: C.accent, marginBottom: 30,
          }}>{scene.outro ? "See it yourself" : "Terminal 3 Agent Developer Kit"}</div>
        </Rise>
        <div style={{
          fontFamily: scene.outro ? MONO : SANS,
          fontSize: scene.outro ? 74 : 86, fontWeight: 700, color: C.head,
          letterSpacing: -2.4, lineHeight: 1.08, whiteSpace: "pre-line",
          opacity: e, transform: `translateY(${(1 - e) * 34}px)`,
        }}>{scene.title}</div>
        <Rise delay={16}>
          <div style={{
            fontFamily: scene.outro ? MONO : SANS, fontSize: 34, color: C.dim, marginTop: 34,
          }}>{scene.subtitle}</div>
        </Rise>
      </div>
    </Pad>
  );
};

const BulletsScene = ({ scene }) => (
  <Pad>
    <Heading>{scene.heading}</Heading>
    {scene.bullets.map((b, i) => (
      <Rise key={b} delay={14 + i * 12}>
        <div style={{
          display: "flex", gap: 24, alignItems: "flex-start", marginBottom: 30,
        }}>
          <div style={{
            width: 13, height: 13, borderRadius: 99, marginTop: 20, flexShrink: 0,
            background: scene.tone === "bad" ? C.bad : C.ok,
          }} />
          <div style={{ fontFamily: SANS, fontSize: 42, color: C.ink, lineHeight: 1.35 }}>{b}</div>
        </div>
      </Rise>
    ))}
    {scene.footer ? (
      <Rise delay={14 + scene.bullets.length * 12 + 8}>
        <div style={{
          marginTop: 30, padding: "18px 26px", borderRadius: 12,
          border: `1px solid ${C.line}`, background: C.panel,
          fontFamily: SANS, fontSize: 32, color: C.ok, display: "inline-block",
        }}>{scene.footer}</div>
      </Rise>
    ) : null}
  </Pad>
);

const FlowScene = ({ scene }) => (
  <Pad>
    <Heading>{scene.heading}</Heading>
    {scene.steps.map((s, i) => (
      <Rise key={s} delay={14 + i * 13}>
        <div style={{
          display: "flex", alignItems: "center", gap: 26, marginBottom: 22,
        }}>
          <div style={{
            width: 62, height: 62, borderRadius: 14, flexShrink: 0,
            border: `1px solid ${C.line}`, background: C.panel,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: MONO, fontSize: 30, color: C.accent,
          }}>{i + 1}</div>
          <div style={{
            flex: 1, padding: "22px 30px", borderRadius: 14,
            border: `1px solid ${C.line}`, background: C.panel,
            fontFamily: SANS, fontSize: 38, color: C.ink,
          }}>{s}</div>
        </div>
      </Rise>
    ))}
  </Pad>
);

const TerminalScene = ({ scene, durationInFrames }) => {
  const frame = useCurrentFrame();
  const e = useEnter(2);
  // Reveal lines across the first 65% of the scene, then hold so the last line
  // is readable rather than flashing past.
  const reveal = interpolate(frame, [10, durationInFrames * 0.65], [0, scene.lines.length], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const colour = { ok: C.ok, bad: C.bad, tag: C.accent, dim: C.dim, plain: C.ink };
  return (
    <Pad>
      <div style={{
        opacity: e, transform: `translateY(${(1 - e) * 22}px)`,
        border: `1px solid ${C.line}`, borderRadius: 18, overflow: "hidden",
        background: "#0b1118", boxShadow: "0 30px 90px rgba(0,0,0,.45)",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 12, padding: "20px 26px",
          background: "#131c26", borderBottom: `1px solid ${C.line}`,
        }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <div key={c} style={{ width: 15, height: 15, borderRadius: 99, background: c }} />
          ))}
          <div style={{ marginLeft: 14, fontFamily: SANS, fontSize: 24, color: C.dim }}>
            {scene.title}
          </div>
        </div>
        <div style={{ padding: "32px 34px", minHeight: 430 }}>
          {scene.lines.map((l, i) => {
            const shown = reveal - i;
            if (shown <= 0) return <div key={i} style={{ height: 46 }} />;
            const chars = Math.round(interpolate(shown, [0, 0.75], [0, l.t.length],
              { extrapolateRight: "clamp" }));
            return (
              <div key={i} style={{
                fontFamily: MONO, fontSize: 28, lineHeight: "46px",
                color: colour[l.c] ?? C.ink, whiteSpace: "pre",
              }}>{l.t.slice(0, chars) || " "}</div>
            );
          })}
        </div>
      </div>
    </Pad>
  );
};

const StatsScene = ({ scene }) => {
  const frame = useCurrentFrame();
  return (
    <Pad>
      <Heading>{scene.heading}</Heading>
      <div style={{ display: "flex", gap: 30 }}>
        {scene.stats.map((s, i) => {
          const e = useEnter(14 + i * 12);
          // Count up rather than pop in — the number is the point of the scene.
          const n = Math.round(interpolate(frame, [14 + i * 12, 14 + i * 12 + 34],
            [0, Number(s.n)], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
          return (
            <div key={s.n} style={{
              flex: 1, padding: "42px 34px", borderRadius: 18,
              border: `1px solid ${C.line}`, background: C.panel,
              opacity: e, transform: `translateY(${(1 - e) * 26}px)`,
            }}>
              <div style={{
                fontFamily: SANS, fontSize: 96, fontWeight: 700, color: C.head,
                letterSpacing: -3, lineHeight: 1,
              }}>{n}</div>
              <div style={{
                fontFamily: SANS, fontSize: 27, color: C.dim, marginTop: 16,
                whiteSpace: "pre-line", lineHeight: 1.4,
              }}>{s.label}</div>
            </div>
          );
        })}
      </div>
    </Pad>
  );
};

const KINDS = {
  title: TitleScene, bullets: BulletsScene, flow: FlowScene,
  terminal: TerminalScene, stats: StatsScene,
};

// ── captions ────────────────────────────────────────────────────────────────

const Captions = ({ cues }) => (
  <>
    {cues.map((cue, i) => (
      <Sequence key={i} from={cue.from} durationInFrames={cue.durationInFrames} layout="none">
        <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", padding: 84 }}>
          <div style={{
            maxWidth: 1450, textAlign: "center", padding: "20px 34px", borderRadius: 14,
            background: "rgba(6,10,14,.82)", border: `1px solid ${C.line}`,
            backdropFilter: "blur(6px)",
            fontFamily: SANS, fontSize: 36, lineHeight: 1.35, color: "#eaf2fa",
          }}>{cue.text}</div>
        </AbsoluteFill>
      </Sequence>
    ))}
  </>
);

// ── progress bar ────────────────────────────────────────────────────────────

const Progress = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end" }}>
      <div style={{ height: 5, background: "rgba(255,255,255,.07)" }}>
        <div style={{
          height: "100%", width: `${(frame / durationInFrames) * 100}%`,
          background: `linear-gradient(90deg, ${C.accent}, ${C.ok})`,
        }} />
      </div>
    </AbsoluteFill>
  );
};

// ── composition ─────────────────────────────────────────────────────────────

export const Demo = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    <Series>
      {timing.scenes.map((t) => {
        const scene = scenes.find((s) => s.id === t.id);
        const Scene = KINDS[scene.kind];
        return (
          <Series.Sequence key={t.id} durationInFrames={t.durationInFrames}>
            <Backdrop />
            <Scene scene={scene} durationInFrames={t.durationInFrames} />
            <Audio src={staticFile(t.audio)} />
            <Captions cues={t.captions} />
          </Series.Sequence>
        );
      })}
    </Series>
    <Progress />
  </AbsoluteFill>
);
