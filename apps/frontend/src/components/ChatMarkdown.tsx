import { useEffect, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { highlightCode } from '@lezer/highlight';
import type { LanguageSupport } from '@codemirror/language';
import { catppuccinHighlight, loadLanguage } from '../lib/codeLanguages';
import { fenceLanguageFile, inlineCodeTarget, splitPath } from '../lib/chatMarkdown';
import { copyText } from '../lib/clipboard';
import { isRemotePath } from '../lib/remote';
import { fsReadDir, isTauri, shellOpenExternal } from '../lib/tauri';
import { useFiles } from '../state/files';
import { useWorkspace } from '../state/workspace';
import { cn } from '../lib/cn';

/**
 * Markdown as agents write it — headings, lists, tables, fenced code — for the
 * agent panel's chat rows. Rendered live: a streaming reply re-renders at most
 * once a frame, so a half-written fence or table can look unfinished for a
 * moment until the rest arrives.
 *
 * Same safety as the editor's preview: `marked` then DOMPurify, no `<style>`
 * or `<form>`. Images are dropped too — an agent reply has no base to resolve
 * a relative image against, and remote ones are blocked by the CSP anyway.
 *
 * Code blocks get the editor's highlighting and a copy button. Inline code
 * that names a file in the workspace (`src/app.ts:42`) opens it on click.
 */
export function ChatMarkdown({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => renderInto(el, text));
    return () => cancelAnimationFrame(frame);
  }, [text]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    const copy = target.closest<HTMLButtonElement>('button.md-copy');
    if (copy) {
      const code = copy.closest('.md-codeblock')?.querySelector('pre code');
      copyText(code?.textContent ?? '', 'Code');
      return;
    }

    const path = target.closest<HTMLElement>('code.md-path');
    if (path?.dataset.path) {
      const line = Number(path.dataset.line) || undefined;
      useWorkspace.getState().openFile(path.dataset.path, undefined, line ? { line } : undefined);
      return;
    }

    const anchor = target.closest('a');
    if (anchor) {
      // Never navigate the webview itself.
      e.preventDefault();
      const href = anchor.getAttribute('href') ?? '';
      if (/^(https?:|mailto:)/i.test(href)) {
        if (isTauri) void shellOpenExternal(href).catch(() => {});
        else window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      const file = inlineCodeTarget(decodeURI(href), useFiles.getState().root);
      if (file) {
        useWorkspace.getState().openFile(file.path, undefined, file.line ? { line: file.line } : undefined);
      }
    }
  };

  return (
    <div
      ref={ref}
      onClick={onClick}
      onAuxClick={onClick}
      className={cn('md-preview md-chat selectable', className)}
    />
  );
}

function renderInto(el: HTMLElement, md: string) {
  const html = marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
  const fragment = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'img'],
    RETURN_DOM_FRAGMENT: true,
  });

  for (const pre of fragment.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const lang = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1];
    if (lang) highlight(code, fenceLanguageFile(lang));
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'md-copy';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy code');
    // The button lives beside the <pre>, not in it: a long line scrolls the
    // <pre> sideways, and a button inside would scroll away with it.
    const block = document.createElement('div');
    block.className = 'md-codeblock';
    pre.replaceWith(block);
    block.append(pre, copy);
  }

  const root = useFiles.getState().root;
  if (isTauri && root && !isRemotePath(root)) {
    for (const code of fragment.querySelectorAll<HTMLElement>(':not(pre) > code')) {
      const target = inlineCodeTarget(code.textContent ?? '', root);
      if (!target) continue;
      // Only paths that exist become links; the check lands after render,
      // and a node replaced by a newer render meanwhile is simply skipped.
      void fileExists(target.path).then((exists) => {
        if (!exists || !code.isConnected) return;
        code.classList.add('md-path');
        code.dataset.path = target.path;
        if (target.line) code.dataset.line = String(target.line);
        code.title = `Open ${target.path}${target.line ? `:${target.line}` : ''}`;
      });
    }
  }

  el.replaceChildren(fragment);
}

// ─── syntax highlighting ─────────────────────────────────────────────────

/** Grammars by stand-in filename. `null` = no grammar for that language. */
const grammars = new Map<string, LanguageSupport | null | Promise<LanguageSupport | null>>();

/** Colour a code block with the editor's grammar and palette. Synchronous
 *  once a grammar has loaded, so a streaming block doesn't flash plain on
 *  every chunk; the first block of a language colours in when it arrives. */
function highlight(code: HTMLElement, file: string) {
  const cached = grammars.get(file);
  if (cached === null) return;
  if (cached && !(cached instanceof Promise)) {
    paint(code, cached);
    return;
  }
  const pending = cached ?? loadLanguage(file).catch(() => null);
  if (!cached) {
    grammars.set(file, pending);
    void pending.then((support) => grammars.set(file, support));
  }
  void pending.then((support) => {
    if (support && code.isConnected) paint(code, support);
  });
}

function paint(code: HTMLElement, support: LanguageSupport) {
  mountHighlightStyles();
  const source = code.textContent ?? '';
  const out = document.createDocumentFragment();
  highlightCode(
    source,
    support.language.parser.parse(source),
    catppuccinHighlight,
    (text, classes) => {
      if (!classes) {
        out.append(text);
        return;
      }
      const span = document.createElement('span');
      span.className = classes;
      span.textContent = text;
      out.append(span);
    },
    () => out.append('\n'),
  );
  code.replaceChildren(out);
}

let stylesMounted = false;

/** The highlight classes' CSS normally arrives with an open editor; the chat
 *  can be the only thing on screen that uses them. */
function mountHighlightStyles() {
  if (stylesMounted) return;
  stylesMounted = true;
  const rules = catppuccinHighlight.module?.getRules();
  if (!rules) return;
  const style = document.createElement('style');
  style.dataset.arcChatHighlight = '';
  style.textContent = rules;
  document.head.append(style);
}

// ─── path existence ──────────────────────────────────────────────────────

/** How long a directory listing is trusted. Agents create files as they go,
 *  so a path that didn't exist a minute ago may well exist now. */
const LISTING_TTL_MS = 10_000;
const listings = new Map<string, { at: number; names: Promise<Set<string>> }>();

function fileExists(path: string): Promise<boolean> {
  const { dir, name } = splitPath(path);
  if (!dir) return Promise.resolve(false);
  let listing = listings.get(dir);
  if (!listing || Date.now() - listing.at > LISTING_TTL_MS) {
    listing = {
      at: Date.now(),
      names: fsReadDir(dir).then(
        (entries) => new Set(entries.map((e) => e.name)),
        () => new Set<string>(),
      ),
    };
    listings.set(dir, listing);
  }
  return listing.names.then((names) => names.has(name));
}
