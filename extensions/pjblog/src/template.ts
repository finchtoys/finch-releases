/**
 * Minimal mustache-subset template engine (zero dependency).
 *
 * Supported syntax:
 *   {{path.to.value}}     — HTML-escaped interpolation
 *   {{{path}}}            — raw interpolation
 *   {{#path}}...{{/path}} — section: array → repeat, truthy → render once with scope push
 *   {{^path}}...{{/path}} — inverted section: falsy / empty array
 */

export type TemplateData = Record<string, unknown>;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lookup(stack: unknown[], path: string): unknown {
  if (path === '.') return stack[stack.length - 1];
  for (let i = stack.length - 1; i >= 0; i--) {
    const scope = stack[i];
    if (scope == null || typeof scope !== 'object') continue;
    let cur: unknown = scope;
    let found = true;
    for (const part of path.split('.')) {
      if (cur != null && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        found = false;
        break;
      }
    }
    if (found) return cur;
  }
  return undefined;
}

interface Token {
  type: 'text' | 'var' | 'raw' | 'section' | 'inverted';
  value: string;
  children?: Token[];
}

function parse(tpl: string): Token[] {
  const root: Token[] = [];
  const stack: { tokens: Token[]; name: string }[] = [{ tokens: root, name: '' }];
  const re = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([#^/]?)\s*([^}]+?)\s*\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tpl))) {
    const cur = stack[stack.length - 1].tokens;
    if (m.index > last) cur.push({ type: 'text', value: tpl.slice(last, m.index) });
    last = re.lastIndex;
    if (m[1] !== undefined) {
      cur.push({ type: 'raw', value: m[1] });
      continue;
    }
    const sigil = m[2];
    const name = m[3];
    if (sigil === '#' || sigil === '^') {
      const token: Token = { type: sigil === '#' ? 'section' : 'inverted', value: name, children: [] };
      cur.push(token);
      stack.push({ tokens: token.children!, name });
    } else if (sigil === '/') {
      if (stack.length > 1) stack.pop();
    } else {
      cur.push({ type: 'var', value: name });
    }
  }
  const cur = stack[stack.length - 1].tokens;
  if (last < tpl.length) cur.push({ type: 'text', value: tpl.slice(last) });
  return root;
}

function renderTokens(tokens: Token[], stack: unknown[]): string {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        out += t.value;
        break;
      case 'var': {
        const v = lookup(stack, t.value);
        out += v == null ? '' : escapeHtml(String(v));
        break;
      }
      case 'raw': {
        const v = lookup(stack, t.value);
        out += v == null ? '' : String(v);
        break;
      }
      case 'section': {
        const v = lookup(stack, t.value);
        if (Array.isArray(v)) {
          for (const item of v) out += renderTokens(t.children!, [...stack, item]);
        } else if (v) {
          out += renderTokens(t.children!, typeof v === 'object' ? [...stack, v] : stack);
        }
        break;
      }
      case 'inverted': {
        const v = lookup(stack, t.value);
        if (!v || (Array.isArray(v) && v.length === 0)) out += renderTokens(t.children!, stack);
        break;
      }
    }
  }
  return out;
}

export function renderTemplate(tpl: string, data: TemplateData): string {
  return renderTokens(parse(tpl), [data]);
}
