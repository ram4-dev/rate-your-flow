import {
  AbsoluteFill,
  Composition,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";

const COLORS = {
  cobalt: "#244FE8",
  mist: "#EDF3FF",
  white: "#FFFFFF",
  ink: "#172844",
  blue: "#A9C5FF",
  amber: "#F0AD56",
  line: "#C9D9FC",
};

const FONT = '"Arial Rounded MT Bold", "Avenir Next", Avenir, Arial, sans-serif';
const MONO = '"SFMono-Regular", Consolas, "Liberation Mono", monospace';
const ease = Easing.bezier(0.16, 1, 0.3, 1);

const appear = (frame: number, from: number, forFrames = 24) =>
  interpolate(frame, [from, from + forFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

const vanish = (frame: number, from: number, forFrames = 18) =>
  interpolate(frame, [from, from + forFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

const sceneOpacity = (frame: number, start: number, end: number) =>
  appear(frame, start) * vanish(frame, end - 18);

const Scene = ({
  start,
  end,
  children,
}: {
  start: number;
  end: number;
  children: React.ReactNode;
}) => {
  const frame = useCurrentFrame();
  const opacity = sceneOpacity(frame, start, end);
  return <AbsoluteFill style={{opacity}}>{children}</AbsoluteFill>;
};

const Wordmark = ({light = false}: {light?: boolean}) => (
  <div style={{display: "flex", alignItems: "center", gap: 16}}>
    <div
      style={{
        width: 42,
        height: 42,
        borderRadius: 13,
        background: light ? COLORS.white : COLORS.cobalt,
        display: "grid",
        placeItems: "center",
        color: light ? COLORS.cobalt : COLORS.white,
        fontSize: 25,
        fontFamily: FONT,
        fontWeight: 900,
      }}
    >
      r
    </div>
    <span
      style={{
        color: light ? COLORS.white : COLORS.ink,
        fontFamily: FONT,
        fontSize: 28,
        letterSpacing: -1.2,
      }}
    >
      rate your flow
    </span>
  </div>
);

const DotGrid = ({inverse = false}: {inverse?: boolean}) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      opacity: inverse ? 0.13 : 0.28,
      backgroundImage: `radial-gradient(${inverse ? COLORS.white : COLORS.cobalt} 1.6px, transparent 1.7px)`,
      backgroundSize: "30px 30px",
      maskImage: "linear-gradient(120deg, black, transparent 68%)",
    }}
  />
);

const BranchingFlow = ({frame, bright = false}: {frame: number; bright?: boolean}) => {
  const progress = interpolate(frame, [20, 118], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const stroke = bright ? COLORS.white : COLORS.cobalt;
  return (
    <svg viewBox="0 0 540 470" style={{width: "100%", height: "100%", overflow: "visible"}}>
      <path d="M50 72 C130 72, 128 163, 207 163 S278 82, 370 82 S422 165, 489 165" fill="none" stroke={stroke} strokeWidth="8" strokeLinecap="round" strokeDasharray="700" strokeDashoffset={700 * (1 - progress)} opacity=".84" />
      <path d="M50 72 C132 72, 116 286, 217 286 S300 372, 470 372" fill="none" stroke={stroke} strokeWidth="8" strokeLinecap="round" strokeDasharray="800" strokeDashoffset={800 * (1 - progress)} opacity=".48" />
      <path d="M207 163 C240 163, 262 244, 333 244 S414 269, 490 269" fill="none" stroke={stroke} strokeWidth="8" strokeLinecap="round" strokeDasharray="600" strokeDashoffset={600 * (1 - progress)} opacity=".66" />
      {[ [50,72], [207,163], [370,82], [489,165], [217,286], [333,244], [490,269], [470,372] ].map(([cx, cy], index) => {
        const scale = appear(frame, 18 + index * 9, 18);
        return <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={15} fill={bright ? COLORS.cobalt : COLORS.white} stroke={stroke} strokeWidth="7" style={{transformOrigin: `${cx}px ${cy}px`, transform: `scale(${scale})`}} />;
      })}
      <circle cx="50" cy="72" r="8" fill={bright ? COLORS.white : COLORS.cobalt} />
    </svg>
  );
};

const Terminal = ({frame}: {frame: number}) => {
  const typed = interpolate(frame, [180, 227], [0, 4], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const commands = ["r", "ry", "ryf", "ryf_"];
  return (
    <div
      style={{
        width: 840,
        height: 410,
        borderRadius: 34,
        background: COLORS.ink,
        boxShadow: "0 32px 70px rgba(23,40,68,.28)",
        padding: "38px 42px",
        color: COLORS.white,
        fontFamily: MONO,
      }}
    >
      <div style={{display: "flex", gap: 12, marginBottom: 66}}>
        {["#F28482", "#F0AD56", "#A9C5FF"].map((color) => <span key={color} style={{width: 16, height: 16, borderRadius: 99, background: color}} />)}
      </div>
      <div style={{fontSize: 50, letterSpacing: -2}}>
        <span style={{color: COLORS.blue}}>❯</span>{" "}
        <span>{commands[Math.min(3, Math.floor(typed))]}</span>
        <span style={{opacity: Math.floor(frame / 12) % 2 === 0 ? 1 : 0, color: COLORS.amber}}>▍</span>
      </div>
      <div style={{marginTop: 46, fontFamily: FONT, fontSize: 29, color: "#D8E3FF", opacity: appear(frame, 230)}}>
        Your coding flow, made visible.
      </div>
    </div>
  );
};

const SessionStrip = ({frame}: {frame: number}) => {
  const rows = Array.from({length: 8}, (_, index) => index);
  return (
    <div style={{width: 870, display: "flex", flexDirection: "column", gap: 20}}>
      {rows.map((row) => {
        const width = [0.82, 0.57, 0.74, 0.92, 0.66, 0.8, 0.5, 0.88][row];
        const delay = 330 + row * 9;
        const opacity = appear(frame, delay, 20);
        return <div key={row} style={{display: "flex", alignItems: "center", gap: 20, opacity, translate: `${interpolate(frame, [delay, delay + 20], [40, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease})}px 0`}}>
          <div style={{width: 17, height: 17, borderRadius: 99, background: row === 6 ? COLORS.amber : COLORS.cobalt}} />
          <div style={{height: 26, borderRadius: 99, width: `${width * 100}%`, background: row === 6 ? "#FFD79F" : COLORS.blue}} />
        </div>;
      })}
    </div>
  );
};

const Metric = ({label, score, color}: {label: string; score: number; color: string}) => (
  <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", gap: 20}}>
    <span style={{fontFamily: FONT, color: COLORS.ink, fontSize: 28}}>{label}</span>
    <div style={{display: "flex", alignItems: "center", gap: 12}}>
      <div style={{width: 164, height: 12, borderRadius: 99, background: COLORS.mist, overflow: "hidden"}}>
        <div style={{width: `${score}%`, height: "100%", borderRadius: 99, background: color}} />
      </div>
      <span style={{fontFamily: MONO, color: COLORS.ink, fontSize: 24}}>{score}</span>
    </div>
  </div>
);

const ReportCard = ({frame}: {frame: number}) => {
  const score = Math.round(interpolate(frame, [515, 575], [0, 82], {extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease}));
  return (
    <div style={{width: 830, borderRadius: 36, background: COLORS.white, padding: "42px 46px", boxShadow: "0 30px 72px rgba(23,40,68,.18)"}}>
      <div style={{display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: `2px solid ${COLORS.mist}`, paddingBottom: 28}}>
        <div>
          <div style={{fontFamily: FONT, fontSize: 27, color: COLORS.cobalt}}>RATE YOUR FLOW</div>
          <div style={{fontFamily: FONT, fontSize: 40, color: COLORS.ink, letterSpacing: -1.5, marginTop: 8}}>Illustrative report</div>
        </div>
        <div style={{fontFamily: FONT, fontSize: 63, color: COLORS.cobalt, letterSpacing: -4}}>{score}</div>
      </div>
      <div style={{display: "flex", flexDirection: "column", gap: 14, marginTop: 28}}>
        <Metric label="Reliability" score={88} color={COLORS.cobalt} />
        <Metric label="Communication" score={81} color={COLORS.cobalt} />
        <Metric label="Context efficiency" score={76} color={COLORS.amber} />
        <Metric label="Productivity" score={85} color={COLORS.cobalt} />
        <Metric label="Hygiene" score={80} color={COLORS.cobalt} />
      </div>
      <div style={{marginTop: 24, paddingTop: 20, borderTop: `2px solid ${COLORS.mist}`, fontFamily: FONT, fontSize: 22, color: "#5B6B88"}}>A concise HTML report, saved locally.</div>
    </div>
  );
};

const Stage = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{background: COLORS.mist, overflow: "hidden"}}>
      <Scene start={0} end={165}>
        <DotGrid />
        <div style={{position: "absolute", top: 82, left: 86}}><Wordmark /></div>
        <div style={{position: "absolute", left: 86, top: 244, width: 500}}>
          <div style={{fontFamily: FONT, color: COLORS.cobalt, fontSize: 31, letterSpacing: 2, opacity: appear(frame, 12)}}>YOUR SESSIONS HAVE A STORY.</div>
          <div style={{fontFamily: FONT, color: COLORS.ink, fontSize: 91, lineHeight: 0.94, letterSpacing: -5, marginTop: 28, opacity: appear(frame, 22), translate: `0 ${interpolate(frame, [22, 48], [34, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease})}px`}}>Rate<br/>your flow.</div>
        </div>
        <div style={{position: "absolute", right: -3, top: 270, width: 555, height: 486, opacity: appear(frame, 34)}}><BranchingFlow frame={frame} /></div>
        <div style={{position: "absolute", left: 86, bottom: 90, fontFamily: FONT, color: COLORS.ink, fontSize: 33, opacity: appear(frame, 57)}}>Feedback on how you work with coding agents.</div>
      </Scene>

      <Scene start={150} end={316}>
        <div style={{position: "absolute", inset: 0, background: COLORS.cobalt}} />
        <DotGrid inverse />
        <div style={{position: "absolute", top: 82, left: 86}}><Wordmark light /></div>
        <div style={{position: "absolute", top: 228, left: 100, fontFamily: FONT, color: COLORS.white, fontSize: 76, lineHeight: .98, letterSpacing: -4, opacity: appear(frame, 163)}}>One command.<br/>A clearer view.</div>
        <div style={{position: "absolute", left: 120, top: 518, opacity: appear(frame, 174), scale: interpolate(frame, [174, 204], [.94, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease})}}><Terminal frame={frame} /></div>
      </Scene>

      <Scene start={301} end={476}>
        <div style={{position: "absolute", inset: 0, background: COLORS.white}} />
        <div style={{position: "absolute", width: 620, height: 620, right: -240, top: -100, borderRadius: 999, background: COLORS.mist}} />
        <div style={{position: "absolute", top: 82, left: 86}}><Wordmark /></div>
        <div style={{position: "absolute", left: 86, top: 210, fontFamily: FONT, color: COLORS.ink, fontSize: 73, lineHeight: .98, letterSpacing: -4, opacity: appear(frame, 316)}}>Start with the<br/><span style={{color: COLORS.cobalt}}>latest 50.</span></div>
        <div style={{position: "absolute", left: 90, top: 470}}><SessionStrip frame={frame} /></div>
        <div style={{position: "absolute", left: 90, bottom: 76, display: "flex", gap: 16, alignItems: "center", opacity: appear(frame, 399)}}>
          <div style={{width: 15, height: 15, borderRadius: 99, background: COLORS.amber}} />
          <div style={{fontFamily: FONT, color: "#5B6B88", fontSize: 27}}>The last 50 sessions from your past 90 days.</div>
        </div>
      </Scene>

      <Scene start={461} end={641}>
        <div style={{position: "absolute", inset: 0, background: COLORS.mist}} />
        <DotGrid />
        <div style={{position: "absolute", top: 82, left: 86}}><Wordmark /></div>
        <div style={{position: "absolute", left: 90, top: 182, fontFamily: FONT, color: COLORS.ink, fontSize: 61, lineHeight: 1, letterSpacing: -3, opacity: appear(frame, 478)}}>See the shape of<br/>your work.</div>
        <div style={{position: "absolute", left: 126, top: 385, opacity: appear(frame, 494), scale: interpolate(frame, [494, 524], [.94, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease})}}><ReportCard frame={frame} /></div>
      </Scene>

      <Scene start={626} end={810}>
        <div style={{position: "absolute", inset: 0, background: COLORS.ink}} />
        <DotGrid inverse />
        <div style={{position: "absolute", right: -92, bottom: -120, width: 680, height: 680, borderRadius: 999, background: COLORS.cobalt, opacity: .9}} />
        <div style={{position: "absolute", top: 80, left: 86}}><Wordmark light /></div>
        <div style={{position: "absolute", left: 86, top: 246, fontFamily: FONT, color: COLORS.white, fontSize: 96, lineHeight: .91, letterSpacing: -5, opacity: appear(frame, 640)}}>Make your<br/><span style={{color: COLORS.blue}}>next session</span><br/>count.</div>
        <div style={{position: "absolute", left: 86, bottom: 142, fontFamily: FONT, color: COLORS.white, fontSize: 39, opacity: appear(frame, 676)}}>Rate Your Flow</div>
        <div style={{position: "absolute", left: 86, bottom: 83, fontFamily: MONO, color: COLORS.blue, fontSize: 32, opacity: appear(frame, 692)}}>@ram4_dev</div>
        <div style={{position: "absolute", right: 88, bottom: 96, width: 270, height: 240, opacity: appear(frame, 660)}}><BranchingFlow frame={frame - 625} bright /></div>
      </Scene>
    </AbsoluteFill>
  );
};

export const RateYourFlowComposition = () => (
  <Composition
    id="RateYourFlowX"
    component={Stage}
    durationInFrames={810}
    fps={30}
    width={1080}
    height={1080}
  />
);
