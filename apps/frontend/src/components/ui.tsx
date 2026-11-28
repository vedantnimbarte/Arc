import { forwardRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { CircleAlert, X } from 'lucide-react';
import { friendlyError } from '../lib/friendlyError';
import { cn } from '../lib/cn';

// Shared controls for the tool tabs and Settings. Each tool used to style its
// own buttons and fields, so the same action looked different in every tab.
// New and touched UI uses these; untouched code migrates as it's edited.

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  // Dark text on the accent: light text on the pale blue fails contrast.
  primary: 'bg-accent text-[#0d1a26] hover:bg-accent-bright',
  secondary: 'bg-bg-panel text-fg-base hover:bg-bg-hover',
  ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg-base',
  danger: 'bg-status-err/15 text-status-err hover:bg-status-err/25',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: LucideIcon;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-display font-medium transition-colors duration-150',
        'disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
        BUTTON_VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {Icon && <Icon size={size === 'sm' ? 13 : 14} strokeWidth={2} className="shrink-0" />}
      {children}
    </button>
  );
});

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Set for code-like values (URLs, ids, paths); interface text stays in Inter. */
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { mono, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      spellCheck={false}
      autoComplete="off"
      className={cn(
        'h-8 min-w-0 rounded-md bg-bg-base px-2.5 text-sm text-fg-base ring-1 ring-inset ring-edge-2',
        'placeholder:text-fg-subtle focus:outline-none focus:ring-accent/50 disabled:opacity-50',
        mono ? 'font-mono text-xs' : 'font-display',
        className,
      )}
      {...rest}
    />
  );
});

/** What an empty view says: what goes here, and the one thing to do next. */
export function EmptyState({
  icon: Icon,
  title,
  body,
  children,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  body?: ReactNode;
  /** Actions, usually one primary Button. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex h-full w-full items-center justify-center p-8', className)}>
      <div className="flex max-w-sm flex-col items-center text-center">
        {Icon && <Icon size={22} strokeWidth={1.7} className="mb-3 text-fg-subtle" />}
        <div className="font-display text-base font-semibold text-fg-base">{title}</div>
        {body && <div className="mt-1.5 font-display text-sm leading-relaxed text-fg-muted">{body}</div>}
        {children && <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div>}
      </div>
    </div>
  );
}

/** One error line in plain words, with the raw text behind "Details". Pass the
 *  thrown value; `friendlyError` picks the sentence. */
export function ErrorNote({
  error,
  message: override,
  onDismiss,
  className,
}: {
  error: unknown;
  /** Use this sentence instead of `friendlyError`'s, when the screen knows
   *  better (a 401 on a sign-in form means a bad token, not "signed out"). */
  message?: string;
  onDismiss?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const friendly = friendlyError(error);
  const message = override ?? friendly.message;
  // With a custom sentence the raw text is always worth offering.
  const detail = override ? String(error ?? '') : friendly.detail;
  return (
    <div
      role="alert"
      className={cn('flex gap-2 rounded-md bg-status-err/10 px-3 py-2 font-display text-sm', className)}
    >
      <CircleAlert size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-status-err" />
      <div className="min-w-0 flex-1">
        <div className="text-fg-base">{message}</div>
        {detail && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="mt-0.5 text-xs text-fg-muted hover:text-fg-base"
            aria-expanded={open}
          >
            {open ? 'Hide details' : 'Details'}
          </button>
        )}
        {open && detail && (
          <pre className="selectable mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-fg-muted">
            {detail}
          </pre>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-subtle hover:text-fg-base"
        >
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
