import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../state/settings';
import { useWorkspace } from '../state/workspace';

// The features Arc unifies, cycled one at a time through a single mono slot —
// a nod to the workspace's terminal heart and the circuit traces in the mark.
const FEATURES = ['terminal', 'editor', 'git', 'ssh', 'api'] as const;

// Flicker guard only. The splash exists to cover hydration, not to perform —
// it lifts the moment both stores are ready. Anything longer is startup time
// we're choosing to spend.
const MIN_MS = 220;
const CYCLE_MS = 1000;
// Keep in sync with `.splash-overlay.is-leaving` in index.css.
const EXIT_MS = 260;

// Cool, low-saturation aurora that drifts behind the frosted glass and gives
// the refraction something to bend. The one deliberate step off monochrome.
const AURORA = [
  { color: '#3f6fe6', size: 540, top: '4%', left: '2%' },
  { color: '#22b6d6', size: 470, top: '46%', left: '52%' },
  { color: '#7d68ee', size: 500, top: '30%', left: '30%' },
];

/**
 * Boot splash for the main window. A single frosted liquid-glass card floats
 * over a slow aurora while the app hydrates, then lifts away. Mounted once in
 * main.tsx, only for `<App />` (Settings/Git sub-windows skip it). No props.
 *
 * All motion is CSS (see the `splash-*` block in index.css) — this renders on
 * the boot path, so it must not drag an animation runtime into the entry chunk.
 */
export function Splash() {
  const settingsHydrated = useSettings((s) => s.settingsHydrated);
  const workspaceHydrated = useWorkspace((s) => s.hydrated);
  const [minElapsed, setMinElapsed] = useState(false);
  // 'up' → covering the app, 'leaving' → playing the exit, 'gone' → unmounted.
  const [phase, setPhase] = useState<'up' | 'leaving' | 'gone'>('up');

  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), MIN_MS);
    return () => clearTimeout(t);
  }, []);

  const ready = settingsHydrated && workspaceHydrated && minElapsed;

  // Drive the exit ourselves — CSS can animate the lift, but only JS can
  // unmount afterwards, and unmounting is the point: the card and the aurora
  // orbs animate on infinite loops, so an overlay left parked at opacity 0
  // keeps the compositor busy for the whole session.
  //
  // `ready` alone is the dependency, and a ref latches the transition. Adding
  // `phase` here would re-run the effect the moment we set 'leaving', and the
  // cleanup would cancel the very timer meant to unmount us.
  const exitingRef = useRef(false);
  useEffect(() => {
    if (!ready || exitingRef.current) return;
    exitingRef.current = true;
    setPhase('leaving');
    const t = setTimeout(() => setPhase('gone'), EXIT_MS);
    return () => clearTimeout(t);
  }, [ready]);

  if (phase === 'gone') return null;
  return <SplashOverlay leaving={phase === 'leaving'} />;
}

function SplashOverlay({ leaving }: { leaving: boolean }) {
  return (
    <div
      className={`splash-overlay${leaving ? ' is-leaving' : ''}`}
      // @ts-expect-error -- Tauri drag region attribute keeps the frameless window draggable.
      style={{ WebkitAppRegion: 'drag' }}
    >
      {/* Aurora — cool blooms drifting behind the glass. */}
      <div aria-hidden className="splash-aurora">
        {AURORA.map((a, i) => (
          <div
            key={i}
            className={`splash-orb splash-orb-${i + 1}`}
            style={{
              top: a.top,
              left: a.left,
              width: a.size,
              height: a.size,
              background: `radial-gradient(circle, ${a.color} 0%, rgba(0,0,0,0) 68%)`,
            }}
          />
        ))}
      </div>

      {/* Vignette — darkens the edges so focus lands on the card. */}
      <div aria-hidden className="splash-vignette" />

      {/* The glass card — entrance on the wrapper, slow float on the card. */}
      <div className="splash-card-wrap">
        <div className="splash-card">
          {/* Specular sheen — sweeps across the surface once on entrance. */}
          <div aria-hidden className="splash-sheen" />

          {/* Logo, with a soft static glow so it lifts off the frosted plane. */}
          <div className="splash-logo-wrap">
            <div aria-hidden className="splash-logo-glow" />
            <img
              src="/arc-logo.png"
              alt="Arc"
              width={92}
              height={92}
              draggable={false}
              className="splash-logo"
            />
          </div>

          {/* Wordmark — the app name. Solid light fill (WebKitGTK, Tauri's Linux
              webview, doesn't reliably support background-clip:text, which would
              render this invisible), with a soft shadow for a little metal. */}
          <h1 className="splash-wordmark">
            {['A', 'R', 'C'].map((c, i) => (
              <span key={c} style={{ animationDelay: `${0.06 + i * 0.05}s` }}>
                {c}
              </span>
            ))}
          </h1>

          {/* Tagline — grounded in the real feature set. */}
          <p className="splash-tagline">one workspace for your terminal, code &amp; git</p>

          {/* Etched hairline dividing the identity from the live feature ticker. */}
          <div aria-hidden className="splash-rule" />

          {/* The signature: a single mono slot cycling through what Arc unifies. */}
          <FeatureSlot />
        </div>
      </div>
    </div>
  );
}

function FeatureSlot() {
  const [i, setI] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % FEATURES.length), CYCLE_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="splash-ticker">
      <span className="splash-ticker-dash">&mdash;</span>
      {/* Fixed width keeps the dashes still while words swap through. */}
      <div className="splash-ticker-slot">
        {/* `key` restarts the CSS enter animation on each swap. */}
        <span key={FEATURES[i]}>{FEATURES[i]}</span>
      </div>
      <span className="splash-ticker-dash">&mdash;</span>
    </div>
  );
}
