import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Native `title` attributes render an OS-styled box after a long delay. The
// sidebar, Now panel and header use <Tooltip> (components/ui/tooltip.tsx);
// give icon-only controls an aria-label and wrap them in it instead.
const GUARDED_FILES = [
  'components/layout/sidebar.tsx',
  'components/layout/now-panel.tsx',
  'components/layout/header.tsx',
  'components/layout/header-utilities.tsx',
  'components/layout/page-header.tsx',
  'components/layout/project-title-menu.tsx',
  'components/notif/UnreadBell.tsx',
];

// Components whose own `title` prop is content, not a DOM attribute.
const COMPONENTS_WITH_TITLE_PROP = new Set(['QueryErrorState']);

function titleAttributes(file: string): string[] {
  const path = resolve(import.meta.dirname, '../..', file);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === 'title' &&
      ts.isJsxAttributes(node.parent)
    ) {
      const tag = node.parent.parent.tagName.getText(source);
      if (!COMPONENTS_WITH_TITLE_PROP.has(tag)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${file}:${line + 1} <${tag} title=…>`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('native title attributes', () => {
  it('stay out of the sidebar, Now panel and header', () => {
    expect(GUARDED_FILES.flatMap(titleAttributes)).toEqual([]);
  });
});
