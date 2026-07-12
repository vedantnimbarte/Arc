import React, { Component, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { Splash } from './components/Splash';
import { SettingsPage } from './components/SettingsPage';
import { rehydrateSettingsFromBroadcast, useSettings } from './state/settings';
import { onSettingsChanged } from './lib/tauri';
import './index.css';

const GitPage = React.lazy(() =>
  import('./components/GitPage').then((m) => ({ default: m.GitPage })),
);

// One frontend bundle, three entry points. Standalone windows pass a `view`
// query param so main.tsx can dispatch — see rust/window.rs for the
// Settings and Git launchers.
const view =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('view')
    : null;

function Root() {
  const hydrateSettings = useSettings((s) => s.hydrateSettings);

  // Both windows hydrate from SQLite on boot so themes/fonts apply
  // immediately, and both subscribe to `settings://changed` so a save
  // in one window propagates to the other.
  useEffect(() => {
    void hydrateSettings();
  }, [hydrateSettings]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onSettingsChanged(() => {
      void rehydrateSettingsFromBroadcast();
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  if (view === 'settings') return <SettingsPage />;
  if (view === 'git')
    return (
      <Suspense fallback={null}>
        <GitPage />
      </Suspense>
    );
  return (
    <>
      <App />
      <Splash />
    </>
  );
}

/**
 * Last-resort boundary around the whole app. `TabErrorBoundary` only wraps tab
 * content, so a throw in the shell (Sidebar / TabBar / StatusBar /
 * App itself) would otherwise unmount everything to a blank white window with
 * no way out. This keeps a reload affordance on screen instead.
 */
class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[app] crashed:', error, info.componentStack);
  }
  override render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: 'flex',
            height: '100vh',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: 24,
            fontFamily: 'system-ui, sans-serif',
            color: '#e5e7eb',
            background: '#101014',
          }}
        >
          <div style={{ maxWidth: 420 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>ARC hit an error</div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 16, wordBreak: 'break-word' }}>
              {this.state.error.message || 'unknown error'}
            </div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                border: '1px solid #3a3a44',
                borderRadius: 6,
                padding: '6px 14px',
                fontSize: 12,
                color: '#e5e7eb',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <Root />
    </RootErrorBoundary>
  </React.StrictMode>,
);
