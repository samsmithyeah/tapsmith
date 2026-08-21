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
 * A file node containing the given tests, grouped into suite nodes by their
 * suite chain — the same shape `suiteToTreeNode` produces, where bare tests
 * come first and suites follow.
 */
export function fileNode(filePath: string, tests: TestSpec[]): TestTreeNode {
  const bare = tests.filter((t) => !t.suites?.length)
  const grouped = new Map<string, TestSpec[]>()
  for (const t of tests) {
    if (!t.suites?.length) continue
    const key = t.suites.join(" > ")
    const list = grouped.get(key)
    if (list) list.push(t)
    else grouped.set(key, [t])
  }

  const children: TestTreeNode[] = [
    ...bare.map((t) => testNode(filePath, t.name)),
    ...[...grouped.entries()].map(([key, specs]) =>
      suiteNode(
        filePath,
        key.split(" > "),
        specs.map((t) => testNode(filePath, t.name, t.suites)),
      ),
    ),
  ]

  return {
    id: filePath,
    type: "file",
    name: basename(filePath),
    filePath,
    fullName: basename(filePath),
    status: "idle",
    children,
  }
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
