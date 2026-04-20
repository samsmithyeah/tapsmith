import type { HierarchyNode, Bounds } from './hierarchy-utils.js'
import { parseBounds } from './hierarchy-utils.js'

// ─── Selector Parsing ───

export interface ParsedSelector {
  type: string
  value: string
  name?: string
}

// Matches: device.getByText("value"), device.getByRole("role", { name: "n" })
// Supports both single and double quotes, optional whitespace around args
const DEVICE_RE = /^device\.getBy(\w+)\(\s*(["'])(.*?)\2(?:\s*,\s*\{\s*name:\s*(["'])(.*?)\4\s*\})?\s*\)$/
// Matches: text("value"), contentDesc("value") — legacy/shorthand format
const SHORT_RE = /^(\w+)\(\s*(["'])(.*?)\2\s*\)$/

export function parseSelectorString(input: string): ParsedSelector | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const deviceMatch = trimmed.match(DEVICE_RE)
  if (deviceMatch) {
    const method = deviceMatch[1]
    const value = deviceMatch[3]
    const name = deviceMatch[5]
    return mapDeviceMethod(method, value, name)
  }

  const shortMatch = trimmed.match(SHORT_RE)
  if (shortMatch) {
    return { type: shortMatch[1], value: shortMatch[3] }
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
  return node.attributes.get('content-desc') ?? node.attributes.get('label') ?? ''
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

// Role detection (simplified — matches selector-generation.ts)
const ANDROID_CLASS_TO_ROLE: Record<string, string> = {
  'android.widget.Button': 'button',
  'android.widget.ImageButton': 'button',
  'com.google.android.material.button.MaterialButton': 'button',
  'androidx.appcompat.widget.AppCompatButton': 'button',
  'android.widget.EditText': 'textfield',
  'android.widget.AutoCompleteTextView': 'textfield',
  'com.google.android.material.textfield.TextInputEditText': 'textfield',
  'androidx.appcompat.widget.AppCompatEditText': 'textfield',
  'android.widget.CheckBox': 'checkbox',
  'android.widget.Switch': 'switch',
  'android.widget.ImageView': 'image',
  'android.widget.TextView': 'text',
  'androidx.appcompat.widget.AppCompatTextView': 'text',
  'android.widget.SearchView': 'searchfield',
  'android.widget.RadioButton': 'radiobutton',
}

const IOS_TYPE_TO_ROLE: Record<string, string> = {
  'XCUIElementTypeButton': 'button',
  'XCUIElementTypeTextField': 'textfield',
  'XCUIElementTypeSecureTextField': 'textfield',
  'XCUIElementTypeTextView': 'textfield',
  'XCUIElementTypeSwitch': 'switch',
  'XCUIElementTypeImage': 'image',
  'XCUIElementTypeStaticText': 'text',
  'XCUIElementTypeSearchField': 'searchfield',
  'XCUIElementTypeSlider': 'seekbar',
  'XCUIElementTypeRadioButton': 'radiobutton',
}

function getNodeRole(node: HierarchyNode): string {
  const className = node.attributes.get('class')
  if (className) return ANDROID_CLASS_TO_ROLE[className] ?? ''
  const iosType = node.attributes.get('type') ?? node.tagName
  return IOS_TYPE_TO_ROLE[iosType] ?? ''
}

// ─── Node Matching ───

function nodeMatchesSelector(node: HierarchyNode, selector: ParsedSelector): boolean {
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
    case 'testId': {
      const rid = getNodeId(node)
      return rid === selector.value || rid.endsWith(`:id/${selector.value}`)
    }
    case 'role': {
      const role = getNodeRole(node)
      if (role !== selector.value) return false
      if (selector.name) {
        const accessibleName = getNodeContentDesc(node) || getNodeText(node)
        return accessibleName === selector.name
      }
      return true
    }
    default:
      return false
  }
}

export function findMatchingNodes(roots: HierarchyNode[], selector: ParsedSelector): HierarchyNode[] {
  const results: HierarchyNode[] = []

  function walk(node: HierarchyNode) {
    if (nodeMatchesSelector(node, selector)) {
      results.push(node)
    }
    for (const child of node.children) {
      walk(child)
    }
  }

  for (const root of roots) {
    walk(root)
  }
  return results
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

  function walk(node: HierarchyNode) {
    const bounds = getNodeBounds(node)
    if (bounds && boundsContains(bounds, x, y)) {
      const area = boundsArea(bounds)
      if (area < bestArea) {
        best = node
        bestArea = area
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
