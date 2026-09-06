import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Github, KeyRound } from 'lucide-react';
import {
  gitHostDeviceLogin,
  gitHostDeviceLoginAvailable,
  gitHostTokenSet,
  gitHostViewer,
  onGitHostDeviceLogin,
  shellOpenExternal,
} from '../../lib/tauri';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { cn } from '../../lib/cn';

interface Props {
  /** Called once a token is stored and confirmed working. */
  onSignedIn: () => void;
}

type Phase =
  | { step: 'idle' }
  | { step: 'starting' }
  | { step: 'waiting'; userCode: string; verificationUri: string };

/**
 * Sign-in screen for the GitHub tab.
 *
 * The device code is the whole point of this screen — the user has to read it
 * off here and type it into a browser — so it gets the space, and everything
 * else stays quiet. Token pasting is kept as a disclosure below: it's the
 * fallback for builds without an OAuth client id, and for anyone who'd rather
 * scope a token by hand.
 */
export function SignIn({ onSignedIn }: Props) {
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [deviceAvailable, setDeviceAvailable] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    void gitHostDeviceLoginAvailable()
      .then(setDeviceAvailable)
      .catch(() => setDeviceAvailable(false));
    return () => {
      unlistenRef.current?.();
    };
  }, []);

  // No client id compiled in — pasting a token is the only route, so open
  // that section rather than making the user find the disclosure.
  useEffect(() => {
    if (deviceAvailable === false) setShowToken(true);
  }, [deviceAvailable]);

  const startDeviceLogin = async () => {
    setError(null);
    setPhase({ step: 'starting' });
    try {
      const topic = await gitHostDeviceLogin();
      unlistenRef.current = await onGitHostDeviceLogin(topic, (ev) => {
        if (ev.kind === 'code') {
          setPhase({
            step: 'waiting',
            userCode: ev.payload.user_code,
            verificationUri: ev.payload.verification_uri,
          });
          void shellOpenExternal(ev.payload.verification_uri).catch(() => {
            /* the link is on screen either way */
          });
        } else if (ev.kind === 'done') {
          unlistenRef.current?.();
          unlistenRef.current = null;
          onSignedIn();
        } else {
          unlistenRef.current?.();
          unlistenRef.current = null;
          setError(ev.payload.message);
          setPhase({ step: 'idle' });
        }
      });
    } catch (e) {
      setError(String(e));
      setPhase({ step: 'idle' });
    }
  };

  const copyCode = (code: string) => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="flex h-full items-center justify-center px-8 py-12">
      <div className="w-full max-w-md">
        <span
          className="mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent-bright ring-1 ring-edge-1"
          aria-hidden
        >
          <Github size={20} strokeWidth={1.8} />
        </span>

        <h1 className="font-display text-lg font-semibold tracking-tight text-fg-base">
          Sign in to GitHub
        </h1>
        <p className="mt-1.5 max-w-sm font-display text-sm leading-relaxed text-fg-muted">
          Browse your repositories, issues, and pull requests here, and clone one straight
          into a workspace.
        </p>

        {phase.step === 'waiting' ? (
          <DeviceCode
            code={phase.userCode}
            uri={phase.verificationUri}
            copied={copied}
            onCopy={() => copyCode(phase.userCode)}
          />
        ) : (
          deviceAvailable !== false && (
            <button
              onClick={() => void startDeviceLogin()}
              disabled={phase.step === 'starting'}
              className={cn(
                'mt-6 flex h-9 items-center gap-2 rounded-lg px-4',
                'bg-surface-2 font-display text-sm font-medium text-fg-base',
                'ring-1 ring-inset ring-edge-2 transition-all duration-200 ease-apple',
                'hover:bg-surface-3 active:scale-[0.98]',
                'focus-visible:outline-none focus-visible:shadow-focus',
                'disabled:opacity-50',
              )}
            >
              <Github size={14} strokeWidth={2} />
              {phase.step === 'starting' ? 'Starting…' : 'Sign in to GitHub'}
            </button>
          )
        )}

        {error && (
          <div className="mt-5 flex items-start gap-2 rounded-xl bg-status-err/[0.08] px-3 py-2 font-display text-xs text-status-err/90 ring-1 ring-inset ring-status-err/20">
            <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-status-err" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-8 border-t border-edge-1 pt-5">
          {showToken ? (
            <TokenForm onSaved={onSignedIn} onError={setError} />
          ) : (
            <button
              onClick={() => setShowToken(true)}
              className="flex items-center gap-1.5 font-display text-xs text-fg-subtle transition-colors hover:text-fg-muted focus-visible:outline-none focus-visible:shadow-focus"
            >
              <KeyRound size={11} strokeWidth={2} />
              Paste a personal access token instead
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function DeviceCode({
  code,
  uri,
  copied,
  onCopy,
}: {
  code: string;
  uri: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="mt-6">
      <p className="font-display text-sm text-fg-muted">Enter this code on github.com:</p>

      {/* The one loud element on the screen. It has to be read off a display
          and typed somewhere else, so it gets size, spacing, and a plate. */}
      <div className="mt-2.5 flex items-center gap-2">
        <div className="rounded-xl bg-surface-1 px-5 py-3 ring-1 ring-inset ring-edge-2">
          <span className="select-all font-mono text-2xl font-medium tracking-[0.22em] text-fg-base">
            {code}
          </span>
        </div>
        <button
          onClick={onCopy}
          aria-label="Copy code"
          title="Copy code"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-fg-subtle transition-all duration-200 ease-apple hover:bg-surface-2 hover:text-fg-base active:scale-90 focus-visible:outline-none focus-visible:shadow-focus"
        >
          {copied ? (
            <Check size={14} strokeWidth={2.2} className="text-status-ok" />
          ) : (
            <Copy size={14} strokeWidth={2} />
          )}
        </button>
      </div>

      <button
        onClick={() => void shellOpenExternal(uri)}
        className="mt-3 flex items-center gap-1.5 font-mono text-xs text-fg-subtle transition-colors hover:text-accent-bright focus-visible:outline-none focus-visible:shadow-focus"
      >
        <ExternalLink size={11} strokeWidth={2} />
        {uri.replace(/^https?:\/\//, '')}
      </button>

      <p className="mt-5 flex items-center gap-2 font-display text-xs text-fg-subtle">
        <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-accent" />
        Waiting for you to approve it
      </p>
    </div>
  );
}

function TokenForm({
  onSaved,
  onError,
}: {
  onSaved: () => void;
  onError: (message: string | null) => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    setBusy(true);
    onError(null);
    try {
      await gitHostTokenSet('github', trimmed);
      // Confirm it works before declaring success — a typo'd token would
      // otherwise land the user in a workspace where every request fails.
      await gitHostViewer();
      onSaved();
    } catch (e) {
      onError(`That token didn't work: ${String(e)}`);
      setBusy(false);
    }
  };

  return (
    <div>
      <label
        htmlFor="gh-token"
        className="font-display text-xs font-medium text-fg-muted"
      >
        Personal access token
      </label>
      <p className="mt-1 font-display text-xs leading-relaxed text-fg-subtle">
        Needs the <span className="font-mono">repo</span>,{' '}
        <span className="font-mono">workflow</span>,{' '}
        <span className="font-mono">read:org</span>, and{' '}
        <span className="font-mono">notifications</span> scopes. It's stored in your
        operating system's credential vault, not in Arc.
      </p>
      <div className="mt-2.5 flex gap-2">
        <input
          id="gh-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
          placeholder="ghp_…"
          spellCheck={false}
          autoComplete="off"
          className="h-8 min-w-0 flex-1 rounded-lg bg-surface-1 px-2.5 font-mono text-xs text-fg-base ring-1 ring-inset ring-edge-2 placeholder:text-fg-subtle/60 focus:outline-none focus:shadow-focus"
        />
        <button
          onClick={() => void save()}
          disabled={busy || !token.trim()}
          className="h-8 shrink-0 rounded-lg bg-surface-2 px-3 font-display text-xs font-medium text-fg-base ring-1 ring-inset ring-edge-2 transition-all duration-200 ease-apple hover:bg-surface-3 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40"
        >
          {busy ? 'Checking…' : 'Save token'}
        </button>
      </div>
    </div>
  );
}
