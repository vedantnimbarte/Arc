import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderOpen, PanelLeftOpen, ShieldAlert, Sparkles } from 'lucide-react';
import { cn } from '../../lib/cn';
import {
  claudeSessionsList,
  fsPickFolder,
  isTauri,
  type ClaudePermissionMode,
  type ClaudeSessionMeta,
} from '../../lib/tauri';
import {
  claudeWindow,
  disposeClaudeWindow,
  useClaudeCode,
  type ClaudeChatItem,
  type ClaudeWindowPrefs,
} from '../../state/claudeCode';
import { useSettings } from '../../state/settings';
import { useFiles } from '../../state/files';
import { useWorkspace } from '../../state/workspace';
import { ChatMarkdown } from '../ChatMarkdown';
import { AttachmentNames, ChatRow, EditedFiles, basename } from './ClaudePanel';
import { ClaudeComposer } from './ClaudeComposer';
import { ClaudeHistoryRail, sessionLabel } from './ClaudeHistoryRail';

interface WindowBlob extends ClaudeWindowPrefs {
  sessionId: string | null;
}

/** The tab's saved blob, failing closed to Settings defaults — a corrupt blob
 *  should open a fresh window, not a broken one. */
function parseBlob(json: string | undefined): WindowBlob {
  const s = useSettings.getState();
  let o: Partial<WindowBlob> = {};
  try {
    o = JSON.parse(json ?? '{}') as Partial<WindowBlob>;
  } catch {
    /* defaults below */
  }
  return {
    cwd: typeof o.cwd === 'string' ? o.cwd : useFiles.getState().root,
    sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
    model: typeof o.model === 'string' ? o.model : s.claudeModel,
    permissionMode: (typeof o.permissionMode === 'string'
      ? o.permissionMode
      : s.claudePermissionMode) as ClaudePermissionMode,
    sidebarHidden: o.sidebarHidden === true,
  };
}

/**
 * Claude Code as a full window: a conversation per window, the folder's
 * history on the left, and a composer that doubles as the approval card.
 * Each window is an independent session — its own folder, model and
 * permission mode — so several can run side by side.
 */
export function ClaudeWindow({ tabId }: { tabId: string }) {
  const status = useClaudeCode((s) => s.status);
  const detect = useClaudeCode((s) => s.detect);
  const [initial] = useState(() =>
    parseBlob(useWorkspace.getState().tabs.find((t) => t.id === tabId)?.apiClientState),
  );
  const [store] = useState(() => claudeWindow(tabId, initial));

  const cwd = store((s) => s.cwd);
  const sessionId = store((s) => s.sessionId);
  const chat = store((s) => s.chat);
  const streaming = store((s) => s.streaming);
  const pending = store((s) => s.pending);
  const denials = store((s) => s.denials);
  const costUsd = store((s) => s.costUsd);
  const hidden = store((s) => s.sidebarHidden);
  const mode = store((s) => s.permissionMode);

  const [sessions, setSessions] = useState<ClaudeSessionMeta[]>([]);
  const [refresh, setRefresh] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const remote = !!cwd?.startsWith('ssh://');

  useEffect(() => {
    if (status === 'checking') void detect();
  }, [status, detect]);

  // Persist the window's prefs with its tab, only when they actually change —
  // the store also changes on every streamed token.
  useEffect(() => {
    let last = '';
    return store.subscribe((s) => {
      const next = JSON.stringify({
        cwd: s.cwd,
        sessionId: s.sessionId,
        model: s.model,
        permissionMode: s.permissionMode,
        sidebarHidden: s.sidebarHidden,
      });
      if (next === last) return;
      last = next;
      useWorkspace.getState().setApiClientState(tabId, next);
    });
  }, [store, tabId]);

  // Reopen the conversation this tab was showing.
  useEffect(() => {
    if (initial.sessionId && initial.cwd && !store.getState().sessionId) {
      void store.getState().loadSession(initial.cwd, initial.sessionId);
    }
  }, [initial, store]);

  // Portals stay mounted while their tab exists, so an unmount with the tab
  // gone is a close. (StrictMode's rehearsal unmount leaves the tab in place.)
  useEffect(
    () => () => {
      setTimeout(() => {
        if (!useWorkspace.getState().tabs.some((t) => t.id === tabId)) disposeClaudeWindow(tabId);
      }, 0);
    },
    [tabId],
  );

  // The folder's history. Refetched when a turn starts or ends, since that's
  // when the CLI writes a new session or a new title.
  useEffect(() => {
    if (!cwd || remote || !isTauri) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    claudeSessionsList(cwd)
      .then((r) => !cancelled && setSessions(r))
      .catch(() => !cancelled && setSessions([]));
    return () => {
      cancelled = true;
    };
  }, [cwd, remote, streaming, refresh]);

  // Follow the tail while a turn streams — only when already near the bottom,
  // so scrolling up to read an earlier result isn't yanked away.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [chat, pending]);

  // A freshly opened conversation starts at its end, like any chat.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId]);

  if (status !== 'ready') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-bg-base px-6 text-center">
        <Sparkles size={20} strokeWidth={1.6} className="text-fg-subtle" />
        {status === 'checking' ? (
          <p className="font-display text-sm text-fg-subtle">Looking for the Claude Code CLI…</p>
        ) : (
          <>
            <p className="font-display text-base text-fg-muted">Claude Code isn&rsquo;t installed</p>
            <p className="max-w-sm font-display text-sm leading-relaxed text-fg-subtle">
              Install the <code className="font-mono">claude</code> CLI and sign in, then reopen
              this tab. ARC uses your existing login.
            </p>
          </>
        )}
      </div>
    );
  }

  const pickFolder = async () => {
    const dir = await fsPickFolder(cwd);
    if (!dir || dir === cwd) return;
    store.getState().newChat();
    store.setState({ cwd: dir });
  };

  const open = (id: string) => {
    if (id === sessionId || !cwd) return;
    void store.getState().loadSession(cwd, id);
  };

  const active = sessions.find((s) => s.id === sessionId);
  const title = active ? sessionLabel(active) : sessionId ? 'Conversation' : 'New chat';
  const empty = chat.length === 0 && !pending;

  return (
    <div className="relative flex h-full min-h-0 bg-bg-base">
      {!hidden && (
        <ClaudeHistoryRail
          cwd={cwd}
          sessions={sessions}
          activeId={sessionId}
          busy={streaming}
          onOpen={open}
          onNew={() => store.getState().newChat()}
          onDeleted={(id) => {
            if (id === store.getState().sessionId) store.getState().newChat();
            setRefresh((n) => n + 1);
          }}
          onHide={() => store.setState({ sidebarHidden: true })}
        />
      )}
      {hidden && (
        <button
          type="button"
          onClick={() => store.setState({ sidebarHidden: false })}
          aria-label="Show conversations"
          title="Show conversations"
          className="absolute left-2 top-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-bg-panel text-fg-muted shadow-control ring-1 ring-edge-2 transition-colors hover:text-fg-base"
        >
          <PanelLeftOpen size={14} strokeWidth={1.9} />
        </button>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={cn(
            'flex h-10 shrink-0 items-center gap-2 border-b border-border-hairline pr-3',
            hidden ? 'pl-11' : 'pl-3',
          )}
        >
          <button
            type="button"
            onClick={() => void pickFolder()}
            disabled={streaming}
            title={cwd ? `Claude runs in ${cwd}. Click to change folder.` : 'Choose a folder'}
            className="flex h-7 min-w-0 max-w-[40%] shrink-0 items-center gap-1.5 rounded-md px-2 font-display text-sm text-fg-base transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            <FolderOpen size={13} strokeWidth={1.9} className="shrink-0 text-fg-muted" />
            <span className="truncate">{cwd ? basename(cwd) : 'Choose folder'}</span>
            <ChevronDown size={12} strokeWidth={2} className="shrink-0 text-fg-subtle" />
          </button>
          <span className="min-w-0 flex-1 truncate font-display text-sm text-fg-muted">{title}</span>
          {costUsd > 0 && (
            <span
              className="shrink-0 font-mono text-xs tabular-nums text-fg-subtle"
              title="Spent in this window's turns"
            >
              ${costUsd.toFixed(2)}
            </span>
          )}
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-6 py-6">
            {remote ? (
              <EmptyNote>
                Claude Code runs on this machine. Pick a local folder to start.
              </EmptyNote>
            ) : empty ? (
              <EmptyState cwd={cwd} recent={sessions.slice(0, 3)} onOpen={open} />
            ) : (
              <div className="flex flex-col gap-4">
                {chat.map((item, i) => (
                  <Row key={i} item={item} root={cwd} />
                ))}
                {streaming && !pending && (
                  <span className="animate-pulse-soft font-display text-sm text-fg-subtle">
                    Working…
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="mx-auto w-full max-w-[760px] shrink-0 px-6 pb-5">
          {denials.length > 0 && (
            <p className="mb-2 flex items-start gap-1.5 font-display text-xs text-status-warn">
              <ShieldAlert size={13} strokeWidth={2} className="mt-px shrink-0" />
              <span>
                Blocked by the {mode} mode: {denials.join(', ')}
              </span>
            </p>
          )}
          <div className="mb-2 overflow-hidden rounded-md empty:hidden">
            <EditedFiles store={store} />
          </div>
          {!remote && <ClaudeComposer store={store} />}
        </div>
      </div>
    </div>
  );
}

/** Transcript rows, set as a document: prompts are marked by a rule rather
 *  than a bubble, answers read as body text, and everything else is the
 *  panel's compact one-liner. */
function Row({ item, root }: { item: ClaudeChatItem; root: string | null }) {
  if (item.kind === 'user') {
    return (
      <div className="border-l-2 border-edge-2 pl-3">
        <ChatMarkdown text={item.text} className="md-roomy text-fg-muted" />
        <AttachmentNames names={item.attachments} />
      </div>
    );
  }
  if (item.kind === 'assistant') return <ChatMarkdown text={item.text} className="md-roomy" />;
  return (
    <div className="-mx-1 text-xs">
      <ChatRow item={item} root={root} />
    </div>
  );
}

function EmptyState({
  cwd,
  recent,
  onOpen,
}: {
  cwd: string | null;
  recent: ClaudeSessionMeta[];
  onOpen: (id: string) => void;
}) {
  if (!cwd) return <EmptyNote>Choose a folder above to start a conversation.</EmptyNote>;
  return (
    <div className="pt-[12vh]">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-fg-base">
        {basename(cwd)}
      </h1>
      <p className="mt-1 truncate font-mono text-xs text-fg-subtle">{cwd}</p>
      {recent.length > 0 && (
        <div className="mt-8">
          <h2 className="font-display text-xs text-fg-subtle">Pick up where you left off</h2>
          <ul className="mt-2">
            {recent.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onOpen(s.id)}
                  className="flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2 -mx-2"
                >
                  <span className="min-w-0 flex-1 truncate font-display text-sm text-fg-base">
                    {sessionLabel(s)}
                  </span>
                  <span className="shrink-0 font-display text-2xs text-fg-subtle">
                    {new Date(s.updatedAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="pt-[18vh] text-center font-display text-sm text-fg-subtle">{children}</p>;
}
