import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { normalizeClassroomMarkdown, safeClassroomLink } from './rich-markdown';

export default function RichTextEditor({
  value,
  onChange,
  label,
  disabled = false,
  maxLength = 10000,
  onSubmit,
  onUndo,
  onRedo,
  placeholder = '',
  compact = false,
  toolbarActions,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  maxLength?: number;
  onSubmit?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  placeholder?: string;
  compact?: boolean;
  toolbarActions?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const callbacks = useRef({ value, onChange, onSubmit, onUndo, onRedo });
  callbacks.current = { value, onChange, onSubmit, onUndo, onRedo };
  const lastSent = useRef(value),
    applying = useRef(false);
  const moreMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (moreMenu.current?.open && !moreMenu.current.contains(event.target as Node))
        moreMenu.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const [error, setError] = useState(''),
    [linkOpen, setLinkOpen] = useState(false),
    [link, setLink] = useState('');
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: false, protocols: ['http', 'https', 'mailto'] },
        undoRedo: onUndo ? false : undefined,
      }),
      Markdown,
    ],
    content: normalizeClassroomMarkdown(value),
    contentType: 'markdown',
    editable: !disabled,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': label,
        'aria-multiline': 'true',
        'data-placeholder': placeholder,
        dir: 'auto',
      },
      handleKeyDown: (_view, event) => {
        if (event.isComposing) return false;
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 'z' &&
          callbacks.current.onUndo
        ) {
          event.preventDefault();
          (event.shiftKey ? callbacks.current.onRedo : callbacks.current.onUndo)?.();
          return true;
        }
        if (event.key === 'Enter' && !event.shiftKey && callbacks.current.onSubmit) {
          event.preventDefault();
          callbacks.current.onSubmit();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      if (applying.current) return;
      const next = editor.getMarkdown();
      if (next.length > maxLength) {
        setError(t('editorLimit'));
        editor.commands.setContent(normalizeClassroomMarkdown(callbacks.current.value), {
          contentType: 'markdown',
          emitUpdate: false,
        });
        return;
      }
      setError('');
      lastSent.current = next;
      callbacks.current.onChange(next);
    },
  });
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive('bold'),
      italic: editor?.isActive('italic'),
      underline: editor?.isActive('underline'),
      strike: editor?.isActive('strike'),
      bullet: editor?.isActive('bulletList'),
      ordered: editor?.isActive('orderedList'),
      empty: editor?.isEmpty ?? true,
    }),
  });
  useEffect(() => {
    editor?.setEditable(!disabled, false);
    editor?.setOptions({
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-label': label,
          'aria-readonly': String(disabled),
          'aria-multiline': 'true',
          'data-placeholder': placeholder,
          dir: 'auto',
        },
      },
    });
  }, [editor, disabled, label, placeholder]);
  useEffect(() => {
    if (
      !editor ||
      value === lastSent.current ||
      editor.getMarkdown() === normalizeClassroomMarkdown(value)
    )
      return;
    const { from, to } = editor.state.selection;
    applying.current = true;
    editor.commands.setContent(normalizeClassroomMarkdown(value), {
      contentType: 'markdown',
      emitUpdate: false,
    });
    const end = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: Math.min(from, end), to: Math.min(to, end) });
    lastSent.current = value;
    applying.current = false;
  }, [editor, value]);
  const button = (key: string, content: React.ReactNode, action: () => void, active?: boolean) => (
    <button
      type="button"
      key={key}
      aria-label={t(key)}
      title={t(key)}
      aria-pressed={active}
      disabled={disabled || !editor}
      onMouseDown={(event) => event.preventDefault()}
      onClick={action}
    >
      {content}
    </button>
  );
  return (
    <div className="rich-text-editor" data-empty={state?.empty} data-compact={compact}>
      <div className="rich-text-toolbar" role="toolbar" aria-label={t('textFormatting')}>
        {toolbarActions}
        {button(
          'format_bold',
          <b>B</b>,
          () => editor?.chain().focus().toggleBold().run(),
          state?.bold,
        )}
        {button(
          'format_italic',
          <i>I</i>,
          () => editor?.chain().focus().toggleItalic().run(),
          state?.italic,
        )}
        {button(
          'format_underline',
          <u>U</u>,
          () => editor?.chain().focus().toggleUnderline().run(),
          state?.underline,
        )}
        {!compact && (
          <>
            {button(
              'format_strike',
              <s>S</s>,
              () => editor?.chain().focus().toggleStrike().run(),
              state?.strike,
            )}
            {button(
              'format_list',
              '•',
              () => editor?.chain().focus().toggleBulletList().run(),
              state?.bullet,
            )}
            {button(
              'format_orderedList',
              '1.',
              () => editor?.chain().focus().toggleOrderedList().run(),
              state?.ordered,
            )}
            {button('undo', '↶', () => (onUndo ? onUndo() : editor?.chain().focus().undo().run()))}
            {button('redo', '↷', () => (onRedo ? onRedo() : editor?.chain().focus().redo().run()))}
          </>
        )}
        <details
          className="rich-text-more"
          ref={moreMenu}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.currentTarget.open = false;
              event.currentTarget.querySelector('summary')?.focus();
            }
          }}
        >
          <summary aria-label={t('moreOptions')} title={t('moreOptions')}>
            ⋯
          </summary>
          <div
            onClick={(event) => {
              if ((event.target as Element).closest('button') && moreMenu.current)
                moreMenu.current.open = false;
            }}
          >
            {compact && (
              <>
                {button(
                  'format_strike',
                  <s>S</s>,
                  () => editor?.chain().focus().toggleStrike().run(),
                  state?.strike,
                )}
                {button(
                  'format_list',
                  '•',
                  () => editor?.chain().focus().toggleBulletList().run(),
                  state?.bullet,
                )}
                {button(
                  'format_orderedList',
                  '1.',
                  () => editor?.chain().focus().toggleOrderedList().run(),
                  state?.ordered,
                )}
                {button('undo', '↶', () =>
                  onUndo ? onUndo() : editor?.chain().focus().undo().run(),
                )}
                {button('redo', '↷', () =>
                  onRedo ? onRedo() : editor?.chain().focus().redo().run(),
                )}
              </>
            )}
            {button('format_heading', 'H', () =>
              editor?.chain().focus().toggleHeading({ level: 2 }).run(),
            )}
            {button('format_code', '</>', () => editor?.chain().focus().toggleCode().run())}
            {button('format_quote', '❞', () => editor?.chain().focus().toggleBlockquote().run())}
            {button('format_link', '↗', () => {
              setLink(editor?.getAttributes('link').href ?? '');
              setLinkOpen((current) => !current);
            })}
          </div>
        </details>
      </div>
      {linkOpen && (
        <div className="rich-text-link">
          <label>
            {t('editorLink')}
            <input
              type="url"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              if (!link.trim()) editor?.chain().focus().extendMarkRange('link').unsetLink().run();
              else {
                const href = safeClassroomLink(link);
                if (!href) return;
                editor?.chain().focus().extendMarkRange('link').setLink({ href }).run();
              }
              setLinkOpen(false);
            }}
          >
            {t('editorApplyLink')}
          </button>
        </div>
      )}
      <EditorContent editor={editor} />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
