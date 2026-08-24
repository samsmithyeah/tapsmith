// Builders for `test-tree` payloads.
//
// The node `id` scheme is not cosmetic: the SPA keys expansion, selection and
// status updates off it, so these builders reproduce exactly what the real
// server emits. See `ui-discover.ts:36-90` (file/suite/test nodes) and
// `ui-server.ts:763-800` (project nodes and the `project::<name>::` id prefix
// that keeps one file's state independent across projects).

import type { TestTreeNode } from "../../protocol.js"

export interface TestSpec {
  name: string
  /** Suite chain above this test, outermost first. */
  suites?: string[]
}

/** A test node, id'd and full-named the way `ui-discover.ts` does. */
export function testNode(filePath: string, name: string, suites: string[] = []): TestTreeNode {
  const fullName = [...suites, name].join(" > ")
  return {
    id: `${filePath}::${fullName}`,
    type: "test",
    name,
    filePath,
    fullName,
    status: "idle",
  }
}

/** A suite node. `name` is the last segment; `fullName` is the whole chain. */
export function suiteNode(
  filePath: string,
  suites: string[],
  children: TestTreeNode[],
): TestTreeNode {
  const fullName = suites.join(" > ")
  return {
    id: `${filePath}::${fullName}`,
    type: "suite",
    name: suites[suites.length - 1],
    filePath,
    fullName,
    status: "idle",
    children,
  }
}

/**
 * A file node containing the given tests, grouped the way `suiteToTreeNode`
 * groups them: bare tests first, then suites — and **nested** one level per
 * segment of the suite chain, so `suites: ["A", "B"]` yields suite `A` holding
 * suite `A > B`, not a single flattened node.
 */
export function fileNode(filePath: string, tests: TestSpec[]): TestTreeNode {
  return {
    id: filePath,
    type: "file",
    name: basename(filePath),
    filePath,
    fullName: basename(filePath),
    status: "idle",
    children: groupBySuite(filePath, tests, 0),
  }
}

/**
 * Group tests by the suite segment at `depth`, recursing so each segment becomes
 * its own node. Tests with no segment left at this depth come first, matching
 * the runner's ordering.
 */
function groupBySuite(filePath: string, tests: TestSpec[], depth: number): TestTreeNode[] {
  const bare = tests.filter((t) => (t.suites?.length ?? 0) <= depth)
  const nested = tests.filter((t) => (t.suites?.length ?? 0) > depth)

  const groups = new Map<string, TestSpec[]>()
  for (const t of nested) {
    const segment = t.suites![depth]
    const list = groups.get(segment)
    if (list) list.push(t)
    else groups.set(segment, [t])
  }

  return [
    ...bare.map((t) => testNode(filePath, t.name, t.suites ?? [])),
    ...[...groups.entries()].map(([, specs]) =>
      suiteNode(
        filePath,
        specs[0].suites!.slice(0, depth + 1),
        groupBySuite(filePath, specs, depth + 1),
      ),
    ),
  ]
}

/**
 * Wrap files in a project node, prefixing descendant ids exactly as
 * `cloneNodeWithIdPrefix` does so each project owns independent client state.
 */
export function projectNode(
  name: string,
  files: TestTreeNode[],
  options: { dependencies?: string[] } = {},
): TestTreeNode {
  const prefix = `project::${name}::`
  return {
    id: `project::${name}`,
    type: "project",
    name,
    filePath: "",
    fullName: name,
    status: "idle",
    children: files.map((f) => withIdPrefix(f, prefix)),
    dependencies: options.dependencies?.length ? options.dependencies : undefined,
  }
}

function withIdPrefix(node: TestTreeNode, prefix: string): TestTreeNode {
  return {
    ...node,
    id: `${prefix}${node.id}`,
    children: node.children?.map((c) => withIdPrefix(c, prefix)),
  }
}

function basename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath
}
