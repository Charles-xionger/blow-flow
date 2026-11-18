'use client';

import { type Editor, type JSONContent, Node } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Placeholder, UndoRedo } from '@tiptap/extensions';
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type ReactNodeViewProps } from '@tiptap/react';
import { Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SkillSummary } from '@/lib/agent/skills';
import styles from './AgentSidebar.module.css';

type ComposerValue = { text: string; skills: SkillSummary[] };
type Menu = { from: number; items: SkillSummary[]; index: number; trigger: '$' | '/' };

export function sameSkillSelection(left: SkillSummary[], right: SkillSummary[]) {
  return left.length === right.length && left.every((skill, index) => skill.id === right[index]?.id);
}

function SkillMentionTag({ node, selected }: ReactNodeViewProps) {
  return <NodeViewWrapper
    as="span"
    aria-label={`Skill：${node.attrs.name}`}
    className={styles.composerSkill}
    contentEditable={false}
    data-selected={selected || undefined}
    data-skill-id={node.attrs.id}
  ><Sparkles size={12}/><span>{node.attrs.name}</span></NodeViewWrapper>;
}

const SkillMention = Node.create({
  name: 'skillMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ id: { default: null }, name: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-skill-id]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', { 'data-skill-id': HTMLAttributes.id, ...HTMLAttributes }],
  addKeyboardShortcuts() {
    const remove = (direction: 'before' | 'after') => () => this.editor.commands.command(({ state, tr }) => {
      const { empty, $anchor, anchor } = state.selection;
      const node = direction === 'before' ? $anchor.nodeBefore : $anchor.nodeAfter;
      if (!empty || node?.type.name !== this.name) return false;
      if (direction === 'before') tr.delete(anchor - node.nodeSize, anchor);
      else tr.delete(anchor, anchor + node.nodeSize);
      return true;
    });
    return { Backspace: remove('before'), Delete: remove('after') };
  },
  addNodeView: () => ReactNodeViewRenderer(SkillMentionTag, { as: 'span' }),
});

function toDocument(value: string, selectedSkills: SkillSummary[]): JSONContent {
  const lines = value.split('\n');
  return {
    type: 'doc',
    content: lines.map((line, paragraphIndex) => {
      const content: JSONContent[] = [];
      if (paragraphIndex === 0) {
        selectedSkills.forEach((skill, index) => {
          if (index) content.push({ type: 'text', text: ' ' });
          content.push({ type: 'skillMention', attrs: { id: skill.id, name: skill.name } });
        });
        if (selectedSkills.length && line) content.push({ type: 'text', text: ' ' });
      }
      if (line) content.push({ type: 'text', text: line });
      return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
    }),
  };
}

function readValue(document: JSONContent, availableSkills: SkillSummary[]): ComposerValue {
  const byId = new Map(availableSkills.map(skill => [skill.id, skill]));
  const skills: SkillSummary[] = [];
  const paragraphs = document.content?.map(paragraph => {
    let text = '';
    paragraph.content?.forEach(inline => {
      if (inline.type === 'skillMention') {
        const skill = byId.get(inline.attrs?.id);
        if (skill && !skills.some(selected => selected.id === skill.id)) skills.push(skill);
      } else if (inline.text) text += inline.text;
    });
    return text;
  }) ?? [];
  return { text: paragraphs.join('\n').trimStart(), skills };
}

function readTrigger(editor: Editor) {
  const { $from, empty } = editor.state.selection;
  if (!empty || editor.view.composing) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
  const match = /(?:^|\s)([$/])([\p{L}\p{N}-]*)$/u.exec(before);
  if (!match) return null;
  const tokenLength = 1 + (match[2]?.length ?? 0);
  return {
    from: $from.pos - tokenLength,
    query: match[2]?.toLocaleLowerCase() ?? '',
    trigger: match[1] as '$' | '/',
  };
}

export function AgentComposerEditor({
  disabled,
  focusRequest,
  onChange,
  onSubmit,
  selectedSkills,
  skills,
  value,
  waiting,
}: {
  disabled: boolean;
  focusRequest: number;
  onChange: (value: ComposerValue) => void;
  onSubmit: () => void;
  selectedSkills: SkillSummary[];
  skills: SkillSummary[];
  value: string;
  waiting: boolean;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const latest = useRef({ menu, onChange, onSubmit, selectedSkills, skills });
  useEffect(() => { latest.current = { menu, onChange, onSubmit, selectedSkills, skills }; }, [menu, onChange, onSubmit, selectedSkills, skills]);

  const showMenu = (next: Menu | null) => {
    latest.current.menu = next;
    setMenu(next);
  };
  const refreshMenu = (editor: Editor) => {
    const trigger = readTrigger(editor);
    if (!trigger) return showMenu(null);
    const items = latest.current.skills.filter(skill =>
      `${skill.id} ${skill.name} ${skill.description}`.toLocaleLowerCase().includes(trigger.query),
    ).slice(0, 8);
    const previous = latest.current.menu;
    showMenu(items.length ? {
      ...trigger,
      items,
      index: previous?.from === trigger.from ? Math.min(previous.index, items.length - 1) : 0,
    } : null);
  };
  const choose = (editor: Editor, skill: SkillSummary, from: number) => {
    const to = editor.state.selection.from;
    if (latest.current.selectedSkills.some(selected => selected.id === skill.id)) {
      editor.chain().focus().deleteRange({ from, to }).run();
    } else {
      editor.chain().focus().deleteRange({ from, to }).insertContent([
        { type: 'skillMention', attrs: { id: skill.id, name: skill.name } },
        { type: 'text', text: ' ' },
      ]).run();
    }
    showMenu(null);
  };

  const editor = useEditor({
    extensions: [Document, Paragraph, Text, UndoRedo, Placeholder.configure({
      placeholder: waiting ? '回答或修改要求…' : '描述你的创作想法，输入 / 或 $ 选择技能…',
    }), SkillMention],
    content: toDocument(value, selectedSkills),
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editable: !disabled,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': '创作要求',
        'aria-multiline': 'true',
        class: styles.composerEditorContent,
      },
      handleKeyDown(_view, event) {
        if (event.isComposing) {
          if (event.key === 'Enter') event.preventDefault();
          return event.key === 'Enter';
        }
        const open = latest.current.menu;
        if (open) {
          const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
          if (step) {
            showMenu({ ...open, index: (open.index + step + open.items.length) % open.items.length });
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            if (editorRef.current) choose(editorRef.current, open.items[open.index]!, open.from);
            return true;
          }
          if (event.key === 'Escape') {
            editorRef.current?.chain().focus().deleteRange({ from: open.from, to: editorRef.current.state.selection.from }).run();
            showMenu(null);
            return true;
          }
        }
        if (event.key === 'Enter' && event.shiftKey) {
          event.preventDefault();
          editorRef.current?.commands.splitBlock();
          return true;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          latest.current.onSubmit();
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor }) => { editorRef.current = editor; },
    onDestroy: () => { editorRef.current = null; },
    onUpdate: ({ editor }) => latest.current.onChange(readValue(editor.getJSON(), latest.current.skills)),
    onTransaction: ({ editor }) => refreshMenu(editor),
    onBlur: () => showMenu(null),
  });

  useEffect(() => { editor?.setEditable(!disabled); }, [disabled, editor]);
  useEffect(() => {
    if (!editor) return;
    const current = readValue(editor.getJSON(), skills);
    if (editor.isDestroyed || editor.view.composing || (current.text === value && sameSkillSelection(current.skills, selectedSkills))) return;
    editor.commands.setContent(toDocument(value, selectedSkills), { emitUpdate: false });
  }, [editor, selectedSkills, skills, value]);
  useEffect(() => { if (focusRequest) editor?.commands.focus('end'); }, [editor, focusRequest]);

  return <div className={styles.composerEditor}>
    <EditorContent editor={editor}/>
    {menu ? <div id="agent-skill-menu" role="listbox" aria-label="选择创作技能" className={styles.skillMenu}>
      {menu.items.map((skill, index) => <button
        key={skill.id}
        role="option"
        aria-selected={index === menu.index}
        className={styles.skillOption}
        onMouseDown={event => event.preventDefault()}
        onMouseEnter={() => showMenu({ ...menu, index })}
        onClick={() => { if (editor) choose(editor, skill, menu.from); }}
        type="button"
      ><strong>{skill.name}</strong><span>{skill.description}</span><small>{menu.trigger}{skill.id}</small></button>)}
    </div> : null}
  </div>;
}
