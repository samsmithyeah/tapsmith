/**
 * The `--json` contract shared by every CLI command that has one (`init`,
 * `verify`, `doctor`, `list-devices`, `telemetry`, `ios setup-device`).
 *
 * stdout carries exactly one JSON document. When the command could not do
 * its job it is the error envelope below and the exit code is 1; otherwise
 * it is the command's own result object, which never has a top-level
 * `error` key. Optional keys are left out rather than set to `null`.
 * The schemas are documented in docs/api-reference.md (CLI → JSON output);
 * changing one is a breaking change for scripts and agents.
 */

// ─── Error envelope ───

export interface CliJsonError {
  /** Stable, SCREAMING_SNAKE machine code (e.g. `BAD_ARGS`, `DAEMON_NOT_FOUND`). */
  code: string;
  /** For a person; may span several lines (verify's RUN_FAILED carries the run's stderr). */
  message: string;
  /** What to do about it, often the exact command to run. */
  fix?: string;
  /** The choices that made the command undecidable (init's `AMBIGUOUS_*` codes). */
  candidates?: string[];
}

export interface CliJsonErrorEnvelope {
  error: CliJsonError;
}

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/** Remove ANSI escape sequences: --json output carries none. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '');
}

/**
 * Build the error envelope, leaving out the optional keys that are not set.
 * Text that came from elsewhere (a child's coloured stderr, an error message)
 * is stripped of ANSI codes here, so no caller has to remember to.
 */
export function jsonError(
  code: string,
  message: string,
  opts: { fix?: string; candidates?: string[] } = {},
): CliJsonErrorEnvelope {
  const error: CliJsonError = { code, message: stripAnsi(message) };
  if (opts.fix !== undefined) error.fix = stripAnsi(opts.fix);
  if (opts.candidates !== undefined) error.candidates = opts.candidates.map(stripAnsi);
  return { error };
}

/** Every `--json` document, success or error, is printed the same way. */
export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

// ─── Health checks ───

export type JsonCheckStatus = 'pass' | 'warn' | 'fail';

/** One row of a health checklist (`doctor`, `ios setup-device`). */
export interface JsonCheck {
  /** Stable id to match on; the label may hold values (a version) and its wording may change. */
  id: string;
  status: JsonCheckStatus;
  label: string;
  /** What the text output prints dimmed after the label: a path, a source, a list of names. */
  detail?: string;
  /** How to fix a `warn` or `fail`; may span several lines. */
  fix?: string;
}
