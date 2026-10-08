// ─── Cancelling an enquirer prompt (PILOT-518) ───
//
// Ctrl-C at an enquirer prompt: Node's readline, in terminal mode and with no
// SIGINT listener, closes its own interface on Ctrl-C, and its keypress
// listener runs before enquirer's. enquirer's ctrl+c handler then cancels the
// prompt, and its cleanup calls `pause()` on that closed interface, which
// Node 24 rejects with ERR_USE_AFTER_CLOSE. The error escapes cancel() before
// it settles the prompt, so the prompt never rejects and the process dies of
// an unhandled rejection with enquirer's stack trace. (Esc cancels the same
// way but leaves readline open, so it never hit this.)

/** The part of an enquirer prompt instance the guard wraps. */
interface ClosablePrompt {
  close(): Promise<void>;
}

/**
 * enquirer `onRun` hook: lets Ctrl-C cancel the prompt cleanly. It wraps the
 * prompt's `close()` so the one cleanup step that finds readline already
 * closed (which is what the cleanup was about to do anyway) no longer aborts
 * the cancel; any other error still propagates. By the time it throws,
 * enquirer has already restored the terminal mode and removed its keypress
 * listener.
 */
export function tolerateClosedReadline(prompt: ClosablePrompt): void {
  const close = prompt.close.bind(prompt);
  prompt.close = async (): Promise<void> => {
    try {
      await close();
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 'ERR_USE_AFTER_CLOSE') throw err;
    }
  };
}

/** Whether a prompt rejected because the user cancelled it (Ctrl-C or Esc): enquirer rejects with an empty reason. */
export function isPromptCancel(err: unknown): boolean {
  return err === '' || (err instanceof Error && err.message === '');
}
