import { useState, useMemo, useCallback, useRef, useEffect } from 'preact/hooks';

// ─── Types ───

export interface HierarchyNode {
  tagName: string
  attributes: Map<string, string>
  children: HierarchyNode[]
  depth: number
}

export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

interface Props {
  xml: string
  onNodeSelect?: (bounds: Bounds | null) => void
}

// ─── XML Parser ───

function parseHierarchyXml(xml: string): HierarchyNode[] {
  const roots: HierarchyNode[] = [];
  const stack: HierarchyNode[] = [];

  // Match self-closing tags, opening tags, and closing tags
  const tagRe = /<(\/?)([a-zA-Z_][\w.]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(xml)) !== null) {
    const isClosing = match[1] === '/';
    const tagName = match[2];
    const attrsStr = match[3];
    const isSelfClosing = match[4] === '/';

    if (isClosing) {
      // Pop the stack
      if (stack.length > 0) stack.pop();
      continue;
    }

    // Parse attributes
    const attributes = new Map<string, string>();
    const attrRe = /([\w:.-]+)="([^"]*)"/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(attrsStr)) !== null) {
      attributes.set(attrMatch[1], attrMatch[2]);
    }

    const node: HierarchyNode = {
      tagName,
      attributes,
      children: [],
      depth: stack.length,
    };

    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      roots.push(node);
    }

    if (!isSelfClosing) {
      stack.push(node);
    }
  }

  return roots;
}

// ─── Bounds Parser ───

function parseBounds(boundsStr: string): Bounds | null {
  const match = boundsStr.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!match) return null;
  return {
    left: parseInt(match[1], 10),
    top: parseInt(match[2], 10),
    right: parseInt(match[3], 10),
    bottom: parseInt(match[4], 10),
  };
}

// ─── Selector Generator ───

function generateSelector(node: HierarchyNode): string {
  const contentDesc = node.attributes.get('content-desc');
  if (contentDesc) return `contentDesc("${contentDesc}")`;

  const resourceId = node.attributes.get('resource-id');
  if (resourceId) return `id("${resourceId}")`;

  const text = node.attributes.get('text');
  if (text) return `text("${text}")`;

  const className = node.attributes.get('class') ?? node.tagName;
  return `className("${className}")`;
}

// ─── Short Class Name ───

function shortClassName(fullName: string): string {
  const parts = fullName.split('.');
  return parts[parts.length - 1];
}

// ─── Search Match ───

function nodeMatchesSearch(node: HierarchyNode, searchLower: string): boolean {
  for (const value of node.attributes.values()) {
    if (value.toLowerCase().includes(searchLower)) return true;
  }
  if (node.tagName.toLowerCase().includes(searchLower)) return true;
  return false;
}

function subtreeMatchesSearch(node: HierarchyNode, searchLower: string): boolean {
  if (nodeMatchesSearch(node, searchLower)) return true;
  return node.children.some(child => subtreeMatchesSearch(child, searchLower));
}

// ─── Truncate ───

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

// ─── Tree Node Component ───

interface TreeNodeProps {
  node: HierarchyNode
  selectedNode: HierarchyNode | null
  onSelect: (node: HierarchyNode) => void
  searchLower: string
  defaultExpanded: boolean
}

function TreeNode({ node, selectedNode, onSelect, searchLower, defaultExpanded }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = node.children.length > 0;
  const isSelected = node === selectedNode;

  // When searching, auto-expand nodes whose subtrees match
  const forceExpanded = searchLower !== '' && hasChildren && subtreeMatchesSearch(node, searchLower);
  const isExpanded = forceExpanded || expanded;

  // If searching and this node doesn't match and no child subtree matches, hide it
  if (searchLower !== '' && !subtreeMatchesSearch(node, searchLower)) {
    return null;
  }

  const isDirectMatch = searchLower !== '' && nodeMatchesSearch(node, searchLower);

  const text = node.attributes.get('text');
  const resourceId = node.attributes.get('resource-id');
  const contentDesc = node.attributes.get('content-desc');

  const inlineAttrs: string[] = [];
  if (text) inlineAttrs.push(`text="${truncate(text, 30)}"`);
  if (resourceId) inlineAttrs.push(`id="${truncate(resourceId, 40)}"`);
  if (contentDesc) inlineAttrs.push(`desc="${truncate(contentDesc, 30)}"`);

  const toggleExpand = (e: MouseEvent) => {
    e.stopPropagation();
    setExpanded(prev => !prev);
  };

  return (
    <div>
      <div
        class={`ht-row${isSelected ? ' ht-selected' : ''}${isDirectMatch ? ' ht-search-match' : ''}`}
        style={{ paddingLeft: `${node.depth * 16 + 4}px` }}
        onClick={() => onSelect(node)}
      >
        <span
          class={`ht-toggle${hasChildren ? '' : ' ht-toggle-leaf'}`}
          onClick={hasChildren ? toggleExpand : undefined}
        >
          {hasChildren ? (isExpanded ? '\u25BE' : '\u25B8') : '\u00A0'}
        </span>
        <span class="ht-tag">{shortClassName(node.tagName)}</span>
        {inlineAttrs.length > 0 && (
          <span class="ht-inline-attrs">
            {inlineAttrs.map((attr, i) => {
              const eqIdx = attr.indexOf('=');
              const name = attr.slice(0, eqIdx);
              const val = attr.slice(eqIdx);
              return (
                <span key={i}>
                  {i > 0 ? ' ' : ''}
                  <span class="ht-attr-name">{name}</span>
                  <span class="ht-attr-val">{val}</span>
                </span>
              );
            })}
          </span>
        )}
      </div>
      {isExpanded && hasChildren && (
        <div>
          {node.children.map((child, i) => (
            <TreeNode
              key={i}
              node={child}
              selectedNode={selectedNode}
              onSelect={onSelect}
              searchLower={searchLower}
              defaultExpanded={child.depth < 2}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Property Sheet ───

function PropertySheet({ node }: { node: HierarchyNode }) {
  const [copied, setCopied] = useState(false);
  const selector = generateSelector(node);

  const handleCopy = () => {
    navigator.clipboard.writeText(selector).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const entries = [...node.attributes.entries()];

  return (
    <div class="ht-props">
      <div class="ht-props-header">
        <span class="ht-props-title">{node.tagName}</span>
        <button class="ht-copy-btn" onClick={handleCopy}>
          {copied ? 'Copied!' : `Copy: ${selector}`}
        </button>
      </div>
      <div class="ht-props-grid">
        {entries.map(([name, value]) => (
          <div key={name} class="ht-props-row">
            <span class="ht-props-name">{name}</span>
            <span class="ht-props-value">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Styles ───

const HIERARCHY_TREE_STYLES = `
  .ht-container { display: flex; flex-direction: column; height: 100%; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; }
  .ht-search { padding: 6px 8px; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
  .ht-search input { width: 100%; padding: 4px 8px; background: var(--color-bg); border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-text-secondary); font-size: 12px; outline: none; font-family: inherit; }
  .ht-search input:focus { border-color: var(--color-accent); }
  .ht-tree { flex: 1; overflow-y: auto; overflow-x: auto; min-height: 0; }
  .ht-row { display: flex; align-items: center; gap: 4px; padding: 1px 4px; cursor: pointer; white-space: nowrap; line-height: 1.6; }
  .ht-row:hover { background: var(--color-bg-hover); }
  .ht-row.ht-selected { background: var(--color-bg-selected); }
  .ht-row.ht-search-match { background: var(--color-highlight); }
  .ht-row.ht-selected.ht-search-match { background: var(--color-bg-selected); }
  .ht-toggle { width: 12px; flex-shrink: 0; cursor: pointer; color: var(--color-text-muted); text-align: center; user-select: none; }
  .ht-toggle-leaf { cursor: default; }
  .ht-tag { color: var(--color-success); font-weight: 500; flex-shrink: 0; }
  .ht-inline-attrs { color: var(--color-text-muted); margin-left: 6px; overflow: hidden; text-overflow: ellipsis; }
  .ht-attr-name { color: var(--color-attr); }
  .ht-attr-val { color: var(--color-string); }

  .ht-props { border-top: 1px solid var(--color-border); flex-shrink: 0; max-height: 40%; overflow-y: auto; }
  .ht-props-header { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); }
  .ht-props-title { color: var(--color-success); font-weight: 600; font-size: 11px; }
  .ht-copy-btn { margin-left: auto; padding: 2px 8px; background: var(--color-bg-tertiary); border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-accent); cursor: pointer; font-size: 10px; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; white-space: nowrap; max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
  .ht-copy-btn:hover { background: var(--color-border); }
  .ht-props-grid { padding: 4px 8px; }
  .ht-props-row { display: grid; grid-template-columns: 140px 1fr; gap: 8px; padding: 1px 0; line-height: 1.5; }
  .ht-props-name { color: var(--color-attr); overflow: hidden; text-overflow: ellipsis; }
  .ht-props-value { color: var(--color-text-secondary); word-break: break-all; }
`;

let htStylesInjected = false;
function injectHtStyles() {
  if (htStylesInjected) return;
  htStylesInjected = true;
  const el = document.createElement('style');
  el.textContent = HIERARCHY_TREE_STYLES;
  document.head.appendChild(el);
}

// ─── Main Component ───

export function HierarchyTree({ xml, onNodeSelect }: Props) {
  injectHtStyles();

  const [search, setSearch] = useState('');
  const [selectedNode, setSelectedNode] = useState<HierarchyNode | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const roots = useMemo(() => parseHierarchyXml(xml), [xml]);

  // Reset selection when XML changes
  useEffect(() => {
    setSelectedNode(null);
    onNodeSelect?.(null);
  }, [xml]);

  const searchLower = search.toLowerCase();

  const handleNodeSelect = useCallback((node: HierarchyNode) => {
    setSelectedNode(prev => {
      if (prev === node) {
        onNodeSelect?.(null);
        return null;
      }
      const boundsStr = node.attributes.get('bounds');
      if (boundsStr) {
        const bounds = parseBounds(boundsStr);
        onNodeSelect?.(bounds);
      } else {
        onNodeSelect?.(null);
      }
      return node;
    });
  }, [onNodeSelect]);

  return (
    <div class="ht-container">
      <div class="ht-search">
        <input
          type="text"
          placeholder="Search hierarchy (class, text, id)..."
          value={search}
          onInput={e => setSearch((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="ht-tree" ref={treeRef}>
        {roots.map((root, i) => (
          <TreeNode
            key={i}
            node={root}
            selectedNode={selectedNode}
            onSelect={handleNodeSelect}
            searchLower={searchLower}
            defaultExpanded={root.depth < 2}
          />
        ))}
      </div>
      {selectedNode && <PropertySheet node={selectedNode} />}
    </div>
  );
}
