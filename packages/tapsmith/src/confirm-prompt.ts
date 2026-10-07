// ─── Yes/no prompts (PILOT-562) ───

/** The parts of enquirer's boolean prompt that `format` is called with as `this`. */
interface BooleanPromptLike {
  state: { submitted: boolean; cancelled?: boolean };
  styles: { success(s: string): string };
}

/**
 * enquirer's confirm prompt echoes its value as a boolean: `(Y/n) › true`
 * while it waits and `(Y/n) · true` once answered, which reads as a rendering
 * bug. Show nothing while it waits (the `(Y/n)` hint already marks the
 * default) or once cancelled (enquirer marks a cancelled prompt submitted
 * too), and `yes` or `no` once answered.
 */
function formatConfirm(this: BooleanPromptLike, value: unknown): string {
  if (!this.state.submitted || this.state.cancelled) return '';
  return this.styles.success(value ? 'yes' : 'no');
}

/** A yes/no question for enquirer, rendering its answer as yes/no. */
export function confirmQuestion(message: string, initial: boolean): {
  type: 'confirm';
  message: string;
  initial: boolean;
  format: (this: BooleanPromptLike, value: unknown) => string;
} {
  return { type: 'confirm', message, initial, format: formatConfirm };
}
