/**
 * Whether a test's fully-qualified name (`describe > test`) matches a `test`
 * filter. Case-insensitive substring match — intentionally grep-like, so it
 * subsumes exact-name and describe-prefix matches and may match several tests.
 *
 * This is distinct from `grep`/`grepInvert`, which are `RegExp` by contract;
 * `test`/`testFilter` is a forgiving substring so callers (and LLM agents) can
 * pass a bare fragment of a test name and have it just work.
 */
export function matchesTestFilter(fullName: string, filter: string): boolean {
  return fullName.toLowerCase().includes(filter.toLowerCase());
}
