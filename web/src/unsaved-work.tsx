import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';

/**
 * Work that would be lost by navigating away.
 *
 * A settings screen keeps its edits in memory until someone presses save, so
 * leaving the page throws them away. Measured before this existed: typing into
 * an admin field and clicking anything in the sidebar discarded it silently —
 * no warning going out, and no trace coming back, the field simply read what it
 * had before. Not being told is worse than the loss, because the card had shown
 * the new value the whole time it was being typed.
 *
 * A page registers a question to ask; the shell asks it before it navigates.
 * React Router's own blocker would be the natural home for this, and it needs a
 * data router — the route tree here is built from auth state inside the app, so
 * adopting one would mean restructuring how the admin route is gated. That is
 * not a change to make for a warning dialog.
 *
 * What this covers is the sidebar and the shell's own navigation, which is the
 * path someone actually takes, plus closing the tab through beforeunload. It
 * does not cover the browser's back button; nothing short of the router can.
 */

/** Returns true to go ahead, false to stay. */
export type LeaveGuard = () => Promise<boolean>;

interface UnsavedWork {
  /** Registers the question to ask, or null when there is nothing to lose. */
  guard: (ask: LeaveGuard | null) => void;
  /** Asks it. True when navigation should proceed. */
  confirmLeaving: LeaveGuard;
}

const context = createContext<UnsavedWork>({
  guard: () => undefined,
  confirmLeaving: async () => true,
});

export function UnsavedWorkProvider({ children }: { children: ReactNode }) {
  // A ref rather than state: registering must not re-render the shell, and the
  // value is only ever read at the moment of navigating.
  const ask = useRef<LeaveGuard | null>(null);

  const guard = useCallback((next: LeaveGuard | null) => {
    ask.current = next;
  }, []);

  const confirmLeaving = useCallback<LeaveGuard>(async () => {
    const current = ask.current;
    if (!current) return true;
    return current();
  }, []);

  const value = useMemo(() => ({ guard, confirmLeaving }), [guard, confirmLeaving]);
  return <context.Provider value={value}>{children}</context.Provider>;
}

export const useUnsavedWork = () => useContext(context);
