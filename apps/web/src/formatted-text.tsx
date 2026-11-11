import { Fragment, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { RichMarkdown } from './rich-markdown';

// Render a bounded Markdown subset as React nodes; user HTML is always text.
function inline(text: string): ReactNode[] {
  const pattern =
    /(\*\*([^\n]+?)\*\*|__([^\n]+?)__|~~([^\n]+?)~~|`([^`\n]+)`|\*([^*\n]+)\*|\[([^\]\n]+)\]\(([^\s)]+)\))/g;
  const result: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > offset) result.push(text.slice(offset, match.index));
    const key = String(match.index);
    if (match[2]) result.push(<strong key={key}>{match[2]}</strong>);
    else if (match[3]) result.push(<u key={key}>{match[3]}</u>);
    else if (match[4]) result.push(<del key={key}>{match[4]}</del>);
    else if (match[5]) result.push(<code key={key}>{match[5]}</code>);
    else if (match[6]) result.push(<em key={key}>{match[6]}</em>);
    else {
      let url: URL | undefined;
      try {
        url = new URL(match[8]);
      } catch {}
      result.push(
        url && ['https:', 'http:', 'mailto:'].includes(url.protocol) ? (
          <a key={key} href={url.href} target="_blank" rel="noopener noreferrer">
            {match[7]}
          </a>
        ) : (
          match[0]
        ),
      );
    }
    offset = match.index! + match[0].length;
  }
  if (offset < text.length) result.push(text.slice(offset));
  return result;
}
export function FormattedText({ text }: { text: string }) {
  return <RichMarkdown text={text} />;
}
export type TextFormat =
  'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'heading' | 'list' | 'quote' | 'link';
export function applyTextFormat(input: HTMLTextAreaElement, format: TextFormat) {
  const start = input.selectionStart,
    end = input.selectionEnd,
    selected = input.value.slice(start, end);
  const marks: Record<TextFormat, [string, string]> = {
    bold: ['**', '**'],
    italic: ['*', '*'],
    underline: ['__', '__'],
    strike: ['~~', '~~'],
    code: ['`', '`'],
    heading: ['## ', ''],
    list: ['- ', ''],
    quote: ['> ', ''],
    link: ['[', '](https://)'],
  };
  const [before, after] = marks[format];
  const prefix =
    ['heading', 'list', 'quote'].includes(format) && start > 0 && input.value[start - 1] !== '\n'
      ? '\n'
      : '';
  const addition = prefix + before + selected + after;
  const value = input.value.slice(0, start) + addition + input.value.slice(end);
  if (input.maxLength > 0 && value.length > input.maxLength) return;
  return {
    value,
    start: start + prefix.length + before.length,
    end: start + prefix.length + before.length + selected.length,
  };
}
export function TextFormattingToolbar({
  target,
  onChange,
  disabled = false,
}: {
  target: RefObject<HTMLTextAreaElement | null>;
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="text-formatting-toolbar" role="toolbar" aria-label={t('textFormatting')}>
      {(
        [
          'bold',
          'italic',
          'underline',
          'strike',
          'code',
          'heading',
          'list',
          'quote',
          'link',
        ] as TextFormat[]
      ).map((format) => (
        <button
          type="button"
          key={format}
          disabled={disabled}
          aria-label={t('format_' + format)}
          title={t('format_' + format)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const input = target.current;
            if (!input) return;
            const next = applyTextFormat(input, format);
            if (!next) return;
            if (onChange) onChange(next.value);
            else input.value = next.value;
            requestAnimationFrame(() => {
              input.focus();
              input.setSelectionRange(next.start, next.end);
            });
          }}
        >
          {
            {
              bold: <b>B</b>,
              italic: <i>I</i>,
              underline: <u>U</u>,
              strike: <s>S</s>,
              code: '</>',
              heading: 'H',
              list: '☷',
              quote: '❞',
              link: '↗',
            }[format]
          }
        </button>
      ))}
    </div>
  );
}
