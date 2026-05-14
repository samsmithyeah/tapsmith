import type { HierarchyNode, Bounds } from './hierarchy-utils.js'
import { parseBounds, getNodeRole } from './hierarchy-utils.js'
import { FORM_FIELD_ROLES } from './selector-generation.js'

// ─── Selector Parsing ───

export interface ParsedSelector {
  type: string
  value: string
  name?: string
  index?: number | 'first' | 'last'
}

// Matches: device.getByText("value"), device.getByRole("role", { name: "n" })
// Supports both single and double quotes, optional whitespace around args
const DEVICE_RE = /^device\.getBy(\w+)\(\s*(["'])(.*?)\2(?:\s*,\s*\{\s*name:\s*(["'])(.*?)\4\s*\})?\s*\)/
// Matches: webview.getByText("value"), webview.getByRole("role", { name: "n" })
const WEBVIEW_GETBY_RE = /^webview\.getBy(\w+)\(\s*(["'])(.*?)\2(?:\s*,\s*\{\s*name:\s*(["'])(.*?)\4\s*\})?\s*\)/
// Matches: webview.locator("css-selector")
const WEBVIEW_LOCATOR_RE = /^webview\.locator\(\s*(["'])(.*?)\1\s*\)/
// Matches: text("value"), contentDesc("value") — legacy/shorthand format
const SHORT_RE = /^(\w+)\(\s*(["'])(.*?)\2\s*\)/

// Matches trailing .first(), .last(), .nth(N)
const CHAIN_RE = /\.(first|last)\(\)$|\.nth\(\s*(\d+)\s*\)$/

function parseChain(input: string): { base: string; index?: number | 'first' | 'last' } {
  const match = input.match(CHAIN_RE)
  if (!match) return { base: input }
  const base = input.slice(0, match.index)
  if (match[1] === 'first') return { base, index: 'first' }
  if (match[1] === 'last') return { base, index: 'last' }
  return { base, index: parseInt(match[2], 10) }
}

export function parseSelectorString(input: string): ParsedSelector | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const { base, index } = parseChain(trimmed)

  // WebView locator: webview.locator("#email")
  const locatorMatch = base.match(WEBVIEW_LOCATOR_RE)
  if (locatorMatch) {
    return { type: 'wv-locator', value: locatorMatch[2], index }
  }

  // WebView getBy*: webview.getByRole("button", { name: "Login" })
  const wvMatch = base.match(WEBVIEW_GETBY_RE)
  if (wvMatch) {
    const method = wvMatch[1]
    const value = wvMatch[3]
    const name = wvMatch[5]
    const sel = mapWebViewMethod(method, value, name)
    if (sel) sel.index = index
    return sel
  }

  // Native device getBy*
  const deviceMatch = base.match(DEVICE_RE)
  if (deviceMatch) {
    const method = deviceMatch[1]
    const value = deviceMatch[3]
    const name = deviceMatch[5]
    const sel = mapDeviceMethod(method, value, name)
    if (sel) sel.index = index
    return sel
  }

  const shortMatch = base.match(SHORT_RE)
  if (shortMatch) {
    return { type: shortMatch[1], value: shortMatch[3], index }
  }

  return null
}

function mapDeviceMethod(method: string, value: string, name?: string): ParsedSelector | null {
  switch (method) {
    case 'Text': return { type: 'text', value }
    case 'Role': return { type: 'role', value, name }
    case 'Description': return { type: 'contentDesc', value }
    case 'Placeholder': return { type: 'hint', value }
    case 'TestId': return { type: 'testId', value }
    case 'Label': return { type: 'label', value }
    default: return null
  }
}

function mapWebViewMethod(method: string, value: string, name?: string): ParsedSelector | null {
  switch (method) {
    case 'Text': return { type: 'wv-text', value }
    case 'Role': return { type: 'wv-role', value, name }
    case 'Label': return { type: 'wv-label', value }
    case 'Placeholder': return { type: 'wv-placeholder', value }
    case 'TestId': return { type: 'wv-testid', value }
    default: return null
  }
}

// ─── Node Attribute Helpers ───
// Android uses: text, content-desc, resource-id, hint, class
// iOS uses: label, identifier, placeholderValue, type

function getNodeText(node: HierarchyNode): string {
  return node.attributes.get('text') ?? node.attributes.get('label') ?? ''
}

function getNodeContentDesc(node: HierarchyNode): string {
  return node.attributes.get('content-desc') ?? ''
}

function getNodeAccessibleName(node: HierarchyNode): string {
  return node.attributes.get('content-desc') || node.attributes.get('label') || node.attributes.get('text') || ''
}

function getNodeId(node: HierarchyNode): string {
  return node.attributes.get('resource-id') ?? node.attributes.get('identifier') ?? ''
}

function getNodeHint(node: HierarchyNode): string {
  return node.attributes.get('hint') ?? node.attributes.get('placeholderValue') ?? ''
}

function getNodeClassName(node: HierarchyNode): string {
  return node.attributes.get('class') ?? node.attributes.get('type') ?? node.tagName
}

// ─── Node Matching ───

function isWebViewNode(node: HierarchyNode): boolean {
  return node.attributes.get('webview') === 'true'
}

function nodeMatchesSelector(node: HierarchyNode, selector: ParsedSelector): boolean {
  // WebView selector types only match WebView nodes
  if (selector.type.startsWith('wv-')) {
    if (!isWebViewNode(node)) return false
    return webViewNodeMatchesSelector(node, selector)
  }

  // Native selector types match native nodes
  switch (selector.type) {
    case 'text':
      return getNodeText(node) === selector.value
    case 'textContains':
      return getNodeText(node).includes(selector.value)
    case 'contentDesc':
      return getNodeContentDesc(node) === selector.value
    case 'id': {
      const rid = getNodeId(node)
      return rid === selector.value
    }
    case 'className':
      return getNodeClassName(node) === selector.value
    case 'hint':
      return getNodeHint(node) === selector.value
    case 'label': {
      const role = getNodeRole(node)
      if (!FORM_FIELD_ROLES.has(role)) return false
      return getNodeAccessibleName(node) === selector.value
    }
    case 'testId': {
      const rid = getNodeId(node)
      return rid === selector.value || rid.endsWith(`:id/${selector.value}`)
    }
    case 'role': {
      const role = getNodeRole(node)
      if (role !== selector.value) return false
      if (selector.name) {
        return getNodeAccessibleName(node) === selector.name
      }
      return true
    }
    default:
      return false
  }
}

function webViewNodeMatchesSelector(node: HierarchyNode, selector: ParsedSelector): boolean {
  const tag = node.attributes.get('webview-tag') ?? ''
  const id = node.attributes.get('webview-id') ?? ''
  const text = node.attributes.get('text') ?? ''
  const ariaLabel = node.attributes.get('content-desc') ?? ''
  const placeholder = node.attributes.get('hint') ?? ''
  const testId = node.attributes.get('webview-testid') ?? ''
  const cssClass = node.attributes.get('webview-class') ?? ''

  switch (selector.type) {
    case 'wv-text':
      return text === selector.value
    case 'wv-role': {
      const role = getNodeRole(node)
      if (role !== selector.value) return false
      if (selector.name) {
        return (ariaLabel || text || placeholder) === selector.name
      }
      return true
    }
    case 'wv-label':
      return ariaLabel === selector.value
    case 'wv-placeholder':
      return placeholder === selector.value
    case 'wv-testid':
      return testId === selector.value
    case 'wv-locator':
      return matchCssSelector(selector.value, tag, id, cssClass)
    default:
      return false
  }
}

function matchCssSelector(css: string, tag: string, id: string, cssClass: string): boolean {
  // Simple CSS selector matching for the playground
  // Supports: #id, .class, tag, tag.class, tag#id
  const trimmed = css.trim()

  if (trimmed.startsWith('#')) {
    return id === trimmed.slice(1)
  }
  if (trimmed.startsWith('.')) {
    return cssClass.split(/\s+/).includes(trimmed.slice(1))
  }

  // tag#id
  const tagIdMatch = trimmed.match(/^(\w+)#(\S+)$/)
  if (tagIdMatch) {
    return tag === tagIdMatch[1] && id === tagIdMatch[2]
  }

  // tag.class
  const tagClassMatch = trimmed.match(/^(\w+)\.(\S+)$/)
  if (tagClassMatch) {
    return tag === tagClassMatch[1] && cssClass.split(/\s+/).includes(tagClassMatch[2])
  }

  // tag only
  return tag === trimmed
}

export function findMatchingNodes(roots: HierarchyNode[], selector: ParsedSelector): HierarchyNode[] {
  const all: HierarchyNode[] = []

  function walk(node: HierarchyNode) {
    if (nodeMatchesSelector(node, selector)) {
      all.push(node)
    }
    for (const child of node.children) {
      walk(child)
    }
  }

  for (const root of roots) {
    walk(root)
  }

  if (selector.index === undefined) return all
  if (selector.index === 'first') return all.length > 0 ? [all[0]] : []
  if (selector.index === 'last') return all.length > 0 ? [all[all.length - 1]] : []
  return all[selector.index] ? [all[selector.index]] : []
}

export function getNodeBounds(node: HierarchyNode): Bounds | null {
  const boundsStr = node.attributes.get('bounds')
  if (!boundsStr) return null
  return parseBounds(boundsStr)
}

// ─── Hit Testing ───

function boundsContains(bounds: Bounds, x: number, y: number): boolean {
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom
}

function boundsArea(bounds: Bounds): number {
  return (bounds.right - bounds.left) * (bounds.bottom - bounds.top)
}

export function hitTest(roots: HierarchyNode[], x: number, y: number): HierarchyNode | null {
  let best: HierarchyNode | null = null
  let bestArea = Infinity
  let bestIsWebView = false

  function walk(node: HierarchyNode) {
    const bounds = getNodeBounds(node)
    if (bounds && boundsContains(bounds, x, y)) {
      const area = boundsArea(bounds)
      const isWv = node.attributes.get('webview') === 'true'
      // Prefer WebView DOM nodes over native nodes at similar coordinates —
      // UIAutomator2/XCUITest also expose web content as native elements,
      // but the WebView DOM nodes produce better selectors (CSS-based).
      const shouldReplace = isWv && !bestIsWebView
        ? area <= bestArea * 1.5   // WebView node wins unless much larger
        : !isWv && bestIsWebView
          ? false                   // Never replace a WebView node with native
          : area < bestArea         // Same category: smallest wins
      if (shouldReplace) {
        best = node
        bestArea = area
        bestIsWebView = isWv
      }
    }
    for (const child of node.children) {
      walk(child)
    }
  }

  for (const root of roots) {
    walk(root)
  }
  return best
}
