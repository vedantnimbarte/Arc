import React, { Suspense, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { SettingsPage } from './components/SettingsPage';
import { rehydrateSettingsFromBroadcast, useSettings } from './state/settings';
import { onSettingsChanged } from './lib/tauri';
import './index.css';

const GitPage = React.lazy(() =>
  import('./components/GitPage').then((m) => ({ default: m.GitPage })),
);

// One frontend bundle, three entry points. The Settings and Git windows
// are opened with `?view=settings` / `?view=git` (see rust/window.rs);
// main.tsx dispatches on that flag so we don't have to ship extra html.
const view =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('view')
    : null;

function Root() {
  const hydrateSettings = useSettings((s) => s.hydrateSettings);
  const hydrateSecrets = useSettings((s) => s.hydrateSecrets);

  // Both windows hydrate from SQLite on boot so themes/fonts apply
  // immediately, and both subscribe to `settings://changed` so a save
  // in one window propagates to the other.
  useEffect(() => {
    void hydrateSettings();
  }, [hydrateSettings]);
  useEffect(() => {
    void hydrateSecrets();
  }, [hydrateSecrets]);

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
  return <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
