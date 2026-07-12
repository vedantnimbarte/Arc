import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useSettings } from '../state/settings';
import { useWorkspace } from '../state/workspace';

// The features Arc unifies, cycled one at a time through a single mono slot —
// a nod to the workspace's terminal heart and the circuit traces in the mark.
const FEATURES = ['terminal', 'editor', 'git', 'ssh', 'api'] as const;

// Hold the splash at least this long so a fast boot never flickers it, then
// dismiss once both stores have hydrated from SQLite.
const MIN_MS = 3000;
const CYCLE_MS = 1000;

const EASE = [0.22, 1, 0.36, 1] as const;

// Cool, low-saturation aurora that drifts behind the frosted glass and gives
// the refraction something to bend. The one deliberate step off monochrome.
const AURORA = [
  { color: '#3f6fe6', size: 540, top: '4%', left: '2%', drift: { x: [0, 46, -18, 0], y: [0, -34, 22, 0], s: [1, 1.12, 1.04, 1] }, dur: 23 },
  { color: '#22b6d6', size: 470, top: '46%', left: '52%', drift: { x: [0, -40, 24, 0], y: [0, 30, -16, 0], s: [1, 1.08, 1.14, 1] }, dur: 27 },
  { color: '#7d68ee', size: 500, top: '30%', left: '30%', drift: { x: [0, 28, -34, 0], y: [0, -22, 30, 0], s: [1.05, 1, 1.1, 1.05] }, dur: 31 },
];

/**
 * Boot splash for the main window. A single frosted liquid-glass card floats
 * over a slow aurora while the app hydrates, then lifts away. Mounted once in
 * main.tsx, only for `<App />` (Settings/Git sub-windows skip it). No props.
 */
export function Splash() {
  const settingsHydrated = useSettings((s) => s.settingsHydrated);
  const workspaceHydrated = useWorkspace((s) => s.hydrated);
  const [minElapsed, setMinElapsed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), MIN_MS);
    return () => clearTimeout(t);
  }, []);

  const ready = settingsHydrated && workspaceHydrated && minElapsed;

  return (
    <AnimatePresence>{!ready && <SplashOverlay key="splash" />}</AnimatePresence>
  );
}

function SplashOverlay() {
  const reduce = useReducedMotion();

  return (
    <motion.div
      // Opaque from the first paint so the app never flashes through beneath it;
      // only the exit animates.
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.04, filter: 'blur(8px)' }}
      transition={{ duration: reduce ? 0.25 : 0.6, ease: EASE }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(120% 120% at 50% 42%, #0d0d10 0%, #08080a 100%)',
        userSelect: 'none',
        // @ts-expect-error -- Tauri drag region attribute keeps the frameless window draggable.
        WebkitAppRegion: 'drag',
      }}
    >
      {/* Aurora — cool blooms drifting behind the glass. */}
      <div aria-hidden style={{ position: 'absolute', inset: '-12%', zIndex: 0 }}>
        {AURORA.map((a, i) => (
          <motion.div
            key={i}
            animate={reduce ? undefined : { x: a.drift.x, y: a.drift.y, scale: a.drift.s }}
            transition={reduce ? undefined : { duration: a.dur, ease: 'easeInOut', repeat: Infinity }}
            style={{
              position: 'absolute',
              top: a.top,
              left: a.left,
              width: a.size,
              height: a.size,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${a.color} 0%, rgba(0,0,0,0) 68%)`,
              opacity: 0.5,
              filter: 'blur(64px)',
              mixBlendMode: 'screen',
            }}
          />
        ))}
      </div>

      {/* Vignette — darkens the edges so focus lands on the card. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 1,
          background: 'radial-gradient(115% 115% at 50% 46%, rgba(8,8,10,0) 32%, #08080a 76%)',
          pointerEvents: 'none',
        }}
      />

      {/* The glass card — entrance on the outer wrapper, slow float on the inner. */}
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: reduce ? 0.3 : 0.9, ease: EASE }}
        style={{ position: 'relative', zIndex: 2 }}
      >
        <motion.div
          animate={reduce ? undefined : { y: [0, -7, 0] }}
          transition={reduce ? undefined : { duration: 6.5, ease: 'easeInOut', repeat: Infinity, delay: 1 }}
          style={{
            position: 'relative',
            overflow: 'hidden',
            width: 'min(86vw, 384px)',
            padding: '42px 40px 34px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 18,
            borderRadius: 30,
            border: '1px solid rgba(255,255,255,0.14)',
            background:
              'linear-gradient(158deg, rgba(255,255,255,0.13) 0%, rgba(255,255,255,0.04) 46%, rgba(255,255,255,0.02) 100%)',
            backdropFilter: 'blur(30px) saturate(1.7)',
            WebkitBackdropFilter: 'blur(30px) saturate(1.7)',
            boxShadow:
              'inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -1px 0 rgba(255,255,255,0.05), 0 34px 90px -24px rgba(0,0,0,0.8)',
          }}
        >
          {/* Specular sheen — sweeps across the surface once on entrance. */}
          {!reduce && (
            <motion.div
              aria-hidden
              initial={{ x: '-130%' }}
              animate={{ x: '130%' }}
              transition={{ delay: 0.6, duration: 1.15, ease: EASE }}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '55%',
                height: '100%',
                transform: 'skewX(-16deg)',
                background:
                  'linear-gradient(105deg, transparent 0%, rgba(255,255,255,0.16) 50%, transparent 100%)',
                mixBlendMode: 'screen',
                pointerEvents: 'none',
              }}
            />
          )}

          {/* Logo, with a soft static glow so it lifts off the frosted plane. */}
          <div style={{ position: 'relative', display: 'grid', placeItems: 'center' }}>
            <div
              aria-hidden
              style={{
                position: 'absolute',
                width: 150,
                height: 150,
                borderRadius: '50%',
                background:
                  'radial-gradient(circle, rgba(200,214,236,0.28) 0%, rgba(150,170,210,0) 66%)',
                filter: 'blur(10px)',
              }}
            />
            <motion.img
              src="/arc-logo.png"
              alt="Arc"
              width={92}
              height={92}
              draggable={false}
              initial={{ opacity: 0, scale: reduce ? 1 : 0.9, filter: reduce ? 'none' : 'blur(10px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
              transition={{ delay: reduce ? 0 : 0.35, duration: reduce ? 0.3 : 0.75, ease: EASE }}
              style={{ position: 'relative', width: 92, height: 92 }}
            />
          </div>

          {/* Wordmark — the app name. Solid light fill (WebKitGTK, Tauri's Linux
              webview, doesn't reliably support background-clip:text, which would
              render this invisible), with a soft shadow for a little metal. */}
          <motion.h1
            variants={{ show: { transition: { staggerChildren: 0.08, delayChildren: 0.5 } } }}
            initial="hidden"
            animate="show"
            style={{
              margin: 0,
              paddingLeft: '0.34em',
              display: 'flex',
              // JetBrains Mono — the app's code/terminal face — ties the name to
              // the workspace's identity. Already loaded in index.html.
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontWeight: 600,
              fontSize: 40,
              letterSpacing: '0.34em',
              color: '#eef1f6',
              textShadow: '0 1px 1px rgba(0,0,0,0.35), 0 0 18px rgba(200,214,236,0.25)',
            }}
          >
            {['A', 'R', 'C'].map((c) => (
              <motion.span
                key={c}
                variants={{
                  hidden: reduce ? { opacity: 0 } : { opacity: 0, y: 16, filter: 'blur(6px)' },
                  show: {
                    opacity: 1,
                    y: 0,
                    filter: 'blur(0px)',
                    transition: { duration: reduce ? 0.3 : 0.6, ease: EASE },
                  },
                }}
              >
                {c}
              </motion.span>
            ))}
          </motion.h1>

          {/* Tagline — grounded in the real feature set. */}
          <motion.p
            initial={{ opacity: 0, y: reduce ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduce ? 0.2 : 0.9, duration: reduce ? 0.3 : 0.6, ease: EASE }}
            style={{
              margin: 0,
              fontFamily: "'Inter', system-ui, sans-serif",
              fontSize: 13,
              fontWeight: 400,
              letterSpacing: '0.01em',
              color: 'rgba(230,234,242,0.6)',
              textAlign: 'center',
            }}
          >
            one workspace for your terminal, code &amp; git
          </motion.p>

          {/* Etched hairline dividing the identity from the live feature ticker. */}
          <motion.div
            aria-hidden
            initial={{ opacity: 0, scaleX: 0 }}
            animate={{ opacity: 1, scaleX: 1 }}
            transition={{ delay: reduce ? 0.3 : 1.05, duration: 0.6, ease: EASE }}
            style={{
              width: 72,
              height: 1,
              background:
                'linear-gradient(90deg, transparent, rgba(255,255,255,0.28), transparent)',
            }}
          />

          {/* The signature: a single mono slot cycling through what Arc unifies. */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: reduce ? 0.3 : 1.15, duration: 0.5 }}
          >
            <FeatureSlot reduce={!!reduce} />
          </motion.div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

function FeatureSlot({ reduce }: { reduce: boolean }) {
  const [i, setI] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % FEATURES.length), CYCLE_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.28em',
        textTransform: 'uppercase',
      }}
    >
      <span style={{ color: 'rgba(220,226,238,0.24)' }}>&mdash;</span>
      {/* Fixed width keeps the dashes still while words swap through. */}
      <div style={{ position: 'relative', width: 96, height: 16, overflow: 'hidden' }}>
        <AnimatePresence mode="wait">
          <motion.span
            key={FEATURES[i]}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: reduce ? 0.2 : 0.32, ease: EASE }}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              color: 'rgba(232,236,244,0.74)',
            }}
          >
            {FEATURES[i]}
          </motion.span>
        </AnimatePresence>
      </div>
      <span style={{ color: 'rgba(220,226,238,0.24)' }}>&mdash;</span>
    </div>
  );
}
