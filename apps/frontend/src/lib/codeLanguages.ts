import type { LanguageSupport } from '@codemirror/language';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { pathToLanguageId } from '@arc/editor';
import { MOCHA } from './fileIcons';

// Shared by the editor and by anything else that shows code in ARC's colours
// (the agent chat's code blocks), so both highlight the same way.

/**
 * Map filename → CodeMirror language extension. The `pathToLanguageId`
 * helper (in `@arc/editor`) does the pure extension→id mapping; this
 * function lazy-imports the matching `@codemirror/lang-*` package so each
 * language ships as its own Vite chunk.
 */
export async function loadLanguage(path: string): Promise<LanguageSupport | null> {
  const id = pathToLanguageId(path);
  if (id === null || id === 'plain') return null;
  switch (id) {
    case 'javascript':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: false });
    case 'javascript-jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'typescript':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'typescript-jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'html':
      return (await import('@codemirror/lang-html')).html();
    case 'css':
      return (await import('@codemirror/lang-css')).css();
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'python':
      return (await import('@codemirror/lang-python')).python();
    case 'rust':
      return (await import('@codemirror/lang-rust')).rust();
    case 'cpp':
      return (await import('@codemirror/lang-cpp')).cpp();
    case 'go':
      return (await import('@codemirror/lang-go')).go();
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case 'sql':
      return (await import('@codemirror/lang-sql')).sql();
    case 'xml':
      return (await import('@codemirror/lang-xml')).xml();
    case 'php':
      return (await import('@codemirror/lang-php')).php();
    case 'java':
      return (await import('@codemirror/lang-java')).java();
  }
}

/**
 * Catppuccin Mocha syntax highlight — uses the same palette as the file
 * icons, so editor + tree share one visual identity.
 */
export const catppuccinHighlight = HighlightStyle.define([
  { tag: t.keyword, color: MOCHA.mauve },
  { tag: t.controlKeyword, color: MOCHA.mauve, fontStyle: 'italic' },
  { tag: t.moduleKeyword, color: MOCHA.mauve },
  { tag: t.operatorKeyword, color: MOCHA.mauve },
  { tag: t.definitionKeyword, color: MOCHA.mauve },

  { tag: [t.string, t.special(t.string)], color: MOCHA.green },
  { tag: t.regexp, color: MOCHA.peach },
  { tag: t.escape, color: MOCHA.pink },

  { tag: [t.number, t.bool, t.null, t.atom], color: MOCHA.peach },

  { tag: t.comment, color: MOCHA.overlay1, fontStyle: 'italic' },
  { tag: t.lineComment, color: MOCHA.overlay1, fontStyle: 'italic' },
  { tag: t.blockComment, color: MOCHA.overlay1, fontStyle: 'italic' },

  { tag: [t.variableName, t.standard(t.variableName)], color: MOCHA.text },
  { tag: t.definition(t.variableName), color: MOCHA.text },
  { tag: t.local(t.variableName), color: MOCHA.text },

  { tag: t.propertyName, color: MOCHA.blue },
  { tag: t.definition(t.propertyName), color: MOCHA.blue },

  { tag: t.function(t.variableName), color: MOCHA.blue },
  { tag: t.function(t.propertyName), color: MOCHA.blue },
  { tag: t.definition(t.function(t.variableName)), color: MOCHA.blue },

  { tag: [t.className, t.definition(t.className), t.typeName, t.definition(t.typeName)], color: MOCHA.yellow },
  { tag: t.namespace, color: MOCHA.yellow },

  { tag: t.tagName, color: MOCHA.mauve },
  { tag: t.attributeName, color: MOCHA.yellow },
  { tag: t.attributeValue, color: MOCHA.green },

  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.brace, t.paren, t.squareBracket, t.angleBracket], color: MOCHA.overlay2 },

  // Markdown
  { tag: t.heading, color: MOCHA.red, fontWeight: '600' },
  { tag: t.link, color: MOCHA.sapphire, textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic', color: MOCHA.text },
  { tag: t.strong, fontWeight: '600', color: MOCHA.text },
  { tag: t.url, color: MOCHA.sapphire },
  { tag: t.monospace, color: MOCHA.peach, fontFamily: 'inherit' },

  { tag: t.invalid, color: MOCHA.red, textDecoration: 'underline' },
]);
