import React, { Fragment, type ReactNode } from 'react';
import { Marked } from 'marked';

// Older notes used __ for underline. Retain them without interpreting HTML.
export function normalizeClassroomMarkdown(value: string) {
  return value.replace(/(```[\s\S]*?```|`[^`\n]*`|__([^\n]+?)__)/g, (raw, _whole, underlined) =>
    underlined === undefined ? raw : '<u>' + underlined + '</u>',
  );
}
const markdown = new Marked({ gfm: true, breaks: true });
markdown.use({
  extensions: [
    {
      name: 'classroomUnderline',
      level: 'inline',
      start: (src) => src.indexOf('<u>'),
      tokenizer(src) {
        const match = /^<u>([\s\S]*?)<\/u>/.exec(src);
        if (!match) return;
        return {
          type: 'classroomUnderline',
          raw: match[0],
          tokens: this.lexer.inlineTokens(match[1]),
        };
      },
    },
  ],
});
type Piece = {
  type: string;
  raw?: string;
  text?: string;
  tokens?: Piece[];
  items?: Piece[];
  href?: string;
  ordered?: boolean;
  start?: number;
  depth?: number;
};
export function safeClassroomLink(value: string) {
  try {
    const url = new URL(value);
    if (['http:', 'https:', 'mailto:'].includes(url.protocol)) return url.href;
  } catch {}
  return undefined;
}
function nodes(pieces: Piece[], depth = 0): ReactNode {
  if (depth > 16) return pieces.map((piece) => piece.text ?? piece.raw ?? '').join('');
  return pieces.map((piece, index) => {
    const children = piece.tokens ? nodes(piece.tokens, depth + 1) : (piece.text ?? '');
    switch (piece.type) {
      case 'space':
        return null;
      case 'text':
      case 'escape':
        return <Fragment key={index}>{children}</Fragment>;
      case 'paragraph':
        return <p key={index}>{children}</p>;
      case 'strong':
        return <strong key={index}>{children}</strong>;
      case 'em':
        return <em key={index}>{children}</em>;
      case 'del':
        return <del key={index}>{children}</del>;
      case 'classroomUnderline':
        return <u key={index}>{children}</u>;
      case 'codespan':
        return <code key={index}>{piece.text}</code>;
      case 'code':
        return (
          <pre key={index}>
            <code>{piece.text}</code>
          </pre>
        );
      case 'br':
        return <br key={index} />;
      case 'hr':
        return <hr key={index} />;
      case 'heading':
        return (
          <div key={index} className={'formatted-heading level-' + piece.depth}>
            {children}
          </div>
        );
      case 'blockquote':
        return <blockquote key={index}>{children}</blockquote>;
      case 'list':
        return piece.ordered ? (
          <ol key={index} start={piece.start}>
            {nodes(piece.items ?? [], depth + 1)}
          </ol>
        ) : (
          <ul key={index}>{nodes(piece.items ?? [], depth + 1)}</ul>
        );
      case 'list_item':
        return (
          <li className="formatted-list-item" key={index}>
            {children}
          </li>
        );
      case 'link': {
        const href = safeClassroomLink(piece.href ?? '');
        return href ? (
          <a key={index} href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ) : (
          <Fragment key={index}>{children}</Fragment>
        );
      }
      case 'image':
        return <Fragment key={index}>{piece.text}</Fragment>;
      // HTML is never mounted. Only the exact, attribute-free <u> token above
      // can create an underline node, and its contents still use this renderer.
      default:
        return <Fragment key={index}>{piece.raw ?? piece.text ?? ''}</Fragment>;
    }
  });
}
export function RichMarkdown({ text }: { text: string }) {
  return (
    <div className="formatted-text" dir="auto">
      {nodes(markdown.lexer(normalizeClassroomMarkdown(text)) as unknown as Piece[])}
    </div>
  );
}
