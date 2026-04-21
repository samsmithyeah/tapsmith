import type { HierarchyNode } from './hierarchy-utils.js'
import { getNodeRole } from './hierarchy-utils.js'

function escapeQuotes(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

// ─── Attribute Helpers ───

function isWebViewNode(node: HierarchyNode): boolean {
  return node.attributes.get('webview') === 'true'
}

function getRole(node: HierarchyNode): string | null {
  return getNodeRole(node) || null
}

function getText(node: HierarchyNode): string {
  return node.attributes.get('text') ?? node.attributes.get('label') ?? ''
}

function getContentDesc(node: HierarchyNode): string {
  return node.attributes.get('content-desc') ?? ''
}

function getLabel(node: HierarchyNode): string {
  return node.attributes.get('label') ?? ''
}

function getHint(node: HierarchyNode): string {
  return node.attributes.get('hint') ?? node.attributes.get('placeholderValue') ?? ''
}

function getResourceId(node: HierarchyNode): string {
  return node.attributes.get('resource-id') ?? node.attributes.get('identifier') ?? ''
}

function isIos(node: HierarchyNode): boolean {
  return node.tagName.startsWith('XCUI') || node.attributes.has('type')
}

// ─── WebView Role Mapping (HTML tag → Pilot role) ───

const HTML_TAG_TO_ROLE: Record<string, string> = {
  button: 'button',
  a: 'link',
  input: 'textfield',
  textarea: 'textfield',
  select: 'combobox',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  img: 'image',
  ul: 'list', ol: 'list',
  li: 'listitem',
  progress: 'progressbar',
  dialog: 'dialog',
}

function getWebViewRole(node: HierarchyNode): string | null {
  const explicitRole = node.attributes.get('webview-role')
  if (explicitRole) return explicitRole

  const tag = node.attributes.get('webview-tag') ?? ''
  const inputType = node.attributes.get('webview-type') ?? ''

  // input type → role
  if (tag === 'input') {
    if (inputType === 'checkbox') return 'checkbox'
    if (inputType === 'radio') return 'radio'
    if (inputType === 'range') return 'slider'
    if (inputType === 'button' || inputType === 'submit' || inputType === 'reset') return 'button'
    return 'textfield'
  }

  return HTML_TAG_TO_ROLE[tag] ?? null
}

// ─── Selector Generation ───

export interface GeneratedSelector {
  code: string
  label: string
  priority: number
}

export function generateSelectors(node: HierarchyNode): GeneratedSelector[] {
  if (isWebViewNode(node)) {
    return generateWebViewSelectors(node)
  }
  return generateNativeSelectors(node)
}

function generateWebViewSelectors(node: HierarchyNode): GeneratedSelector[] {
  const selectors: GeneratedSelector[] = []
  const tag = node.attributes.get('webview-tag') ?? ''
  const id = node.attributes.get('webview-id') ?? ''
  const text = getText(node)
  const ariaLabel = getContentDesc(node)
  const placeholder = getHint(node)
  const testId = node.attributes.get('webview-testid') ?? ''
  const role = getWebViewRole(node)

  // 1. Role + name (highest priority)
  // For inputs, placeholder serves as accessible name when no label/aria-label exists
  const accessibleName = ariaLabel || text || placeholder
  if (role && accessibleName) {
    selectors.push({
      code: `webview.getByRole("${escapeQuotes(role)}", { name: "${escapeQuotes(accessibleName)}" })`,
      label: 'Role + name',
      priority: 1,
    })
  }

  // 2. Role alone
  if (role && !accessibleName) {
    selectors.push({
      code: `webview.getByRole("${escapeQuotes(role)}")`,
      label: 'Role',
      priority: 2,
    })
  }

  // 3. Text content
  if (text) {
    selectors.push({
      code: `webview.getByText("${escapeQuotes(text)}")`,
      label: 'Text',
      priority: 3,
    })
  }

  // 4. aria-label
  if (ariaLabel) {
    selectors.push({
      code: `webview.getByLabel("${escapeQuotes(ariaLabel)}")`,
      label: 'Label',
      priority: 4,
    })
  }

  // 5. Placeholder
  if (placeholder) {
    selectors.push({
      code: `webview.getByPlaceholder("${escapeQuotes(placeholder)}")`,
      label: 'Placeholder',
      priority: 5,
    })
  }

  // 6. Test ID
  if (testId) {
    selectors.push({
      code: `webview.getByTestId("${escapeQuotes(testId)}")`,
      label: 'Test ID',
      priority: 6,
    })
  }

  // 7. CSS id selector
  if (id) {
    selectors.push({
      code: `webview.locator("#${escapeQuotes(id)}")`,
      label: 'CSS #id',
      priority: 7,
    })
  }

  // 8. CSS tag selector (fallback)
  if (tag) {
    const cssClass = (node.attributes.get('webview-class') ?? '').split(/\s+/).filter(Boolean)[0]
    if (cssClass) {
      selectors.push({
        code: `webview.locator("${tag}.${escapeQuotes(cssClass)}")`,
        label: 'CSS tag.class',
        priority: 8,
      })
    } else {
      selectors.push({
        code: `webview.locator("${escapeQuotes(tag)}")`,
        label: 'CSS tag',
        priority: 9,
      })
    }
  }

  const seen = new Set<string>()
  return selectors
    .sort((a, b) => a.priority - b.priority)
    .filter(s => {
      if (seen.has(s.code)) return false
      seen.add(s.code)
      return true
    })
}

function generateNativeSelectors(node: HierarchyNode): GeneratedSelector[] {
  const selectors: GeneratedSelector[] = []
  const role = getRole(node)
  const text = getText(node)
  const contentDesc = getContentDesc(node)
  const label = getLabel(node)
  const hint = getHint(node)
  const resourceId = getResourceId(node)
  const ios = isIos(node)

  // The accessible name for role-based selectors: on iOS use label, on
  // Android prefer content-desc, then text.
  const accessibleName = ios ? label : (contentDesc || text)

  // 1. Role + name (highest priority — Testing Library #1)
  if (role && accessibleName) {
    selectors.push({
      code: `device.getByRole("${escapeQuotes(role)}", { name: "${escapeQuotes(accessibleName)}" })`,
      label: 'Role + name',
      priority: 1,
    })
  }

  // 2. Role without name
  if (role && !accessibleName) {
    selectors.push({
      code: `device.getByRole("${escapeQuotes(role)}")`,
      label: 'Role',
      priority: 2,
    })
  }

  // 3. Text (Testing Library #2 — visible text)
  if (text) {
    selectors.push({
      code: `device.getByText("${escapeQuotes(text)}")`,
      label: 'Text',
      priority: 3,
    })
  }

  // 4. iOS label as text (when label serves as visible text, not content-desc)
  if (ios && label && !text) {
    selectors.push({
      code: `device.getByText("${escapeQuotes(label)}")`,
      label: 'Text (label)',
      priority: 3,
    })
  }

  // 5. Description / accessibility label (Testing Library #3)
  if (contentDesc) {
    selectors.push({
      code: `device.getByDescription("${escapeQuotes(contentDesc)}")`,
      label: 'Description',
      priority: 4,
    })
  }
  if (ios && label && contentDesc !== label) {
    selectors.push({
      code: `device.getByDescription("${escapeQuotes(label)}")`,
      label: 'Description (label)',
      priority: 4,
    })
  }

  // 6. Placeholder / hint (Testing Library #4)
  if (hint) {
    selectors.push({
      code: `device.getByPlaceholder("${escapeQuotes(hint)}")`,
      label: 'Placeholder',
      priority: 5,
    })
  }

  // 7. Test ID (Testing Library #5)
  const testIdFromResource = extractTestId(resourceId)
  if (testIdFromResource) {
    selectors.push({
      code: `device.getByTestId("${escapeQuotes(testIdFromResource)}")`,
      label: 'Test ID',
      priority: 6,
    })
  }

  // Sort by priority, deduplicate by code
  const seen = new Set<string>()
  return selectors
    .sort((a, b) => a.priority - b.priority)
    .filter(s => {
      if (seen.has(s.code)) return false
      seen.add(s.code)
      return true
    })
}

function extractTestId(resourceId: string): string | null {
  if (!resourceId) return null
  const colonIdx = resourceId.indexOf(':id/')
  if (colonIdx !== -1) return resourceId.slice(colonIdx + 4)
  return resourceId
}

export function generateBestSelector(node: HierarchyNode): string {
  const selectors = generateSelectors(node)
  return selectors.length > 0 ? selectors[0].code : `// No selector available`
}
