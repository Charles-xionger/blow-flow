"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { type Editor, type JSONContent, Node } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { Fragment, Slice } from "@tiptap/pm/model";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type ReactNodeViewProps } from "@tiptap/react";
import type { Segment, UpstreamNode } from "@/lib/canvas/prompt";
import { UpstreamThumbnail, upstreamTitle } from "./NodeConnections";

const toDocument = (segments: Segment[]): JSONContent => {
  const paragraphs: JSONContent[][] = [[]];
  for (const segment of segments) {
    if ("ref" in segment) { paragraphs[paragraphs.length - 1].push({ type: "nodeReference", attrs: { ref: segment.ref } }); continue; }
    segment.text.split("\n").forEach((line, index) => {
      if (index) paragraphs.push([]);
      if (line) paragraphs[paragraphs.length - 1].push({ type: "text", text: line });
    });
  }
  return { type: "doc", content: paragraphs.map(content => content.length ? { type: "paragraph", content } : { type: "paragraph" }) };
};

const toSegments = (document: JSONContent): Segment[] => {
  const segments: Segment[] = [];
  const addText = (text: string) => {
    const last = segments[segments.length - 1];
    if (last && "text" in last) last.text += text; else segments.push({ text });
  };
  document.content?.forEach((paragraph, index) => {
    if (index) addText("\n");
    paragraph.content?.forEach(inline => {
      if (inline.type === "nodeReference") segments.push({ ref: inline.attrs?.ref });
      else if (inline.text) addText(inline.text);
    });
  });
  return segments;
};

const UpstreamContext = createContext<UpstreamNode[]>([]);

/** Follows the live upstream list, so numbers stay right when the order changes. */
function NodeReferenceTag({ node, selected }: ReactNodeViewProps) {
  const upstream = useContext(UpstreamContext).find(candidate => candidate.id === node.attrs.ref);
  return (
    <NodeViewWrapper as="span" data-node-reference title={upstream && upstreamTitle(upstream)} contentEditable={false}
      className={`mx-0.5 inline-flex select-none items-center gap-1 rounded-md bg-white/10 py-px pl-0.5 pr-1.5 align-baseline text-xs leading-5 ${selected ? "ring-1 ring-violet-400" : ""}`}>
      {upstream && <UpstreamThumbnail node={upstream} className="h-4 w-4 rounded text-[9px]" />}
      {upstream?.label ?? "节点"}
    </NodeViewWrapper>
  );
}

const NodeReference = Node.create({
  name: "nodeReference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ ref: { default: null } }),
  parseHTML: () => [{ tag: "span[data-node-reference]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", { "data-node-reference": "", ...HTMLAttributes }],
  // Delete the tag as one piece; native deletion around non-editable inline content is unreliable.
  addKeyboardShortcuts() {
    const remove = (direction: "before" | "after") => () => this.editor.commands.command(({ state, tr }) => {
      const { empty, $anchor, anchor } = state.selection;
      const node = direction === "before" ? $anchor.nodeBefore : $anchor.nodeAfter;
      if (!empty || node?.type.name !== this.name) return false;
      if (direction === "before") tr.delete(anchor - node.nodeSize, anchor); else tr.delete(anchor, anchor + node.nodeSize);
      return true;
    });
    return { Backspace: remove("before"), Delete: remove("after") };
  },
  addNodeView: () => ReactNodeViewRenderer(NodeReferenceTag, { as: "span" }),
});

type Menu = { from: number; items: UpstreamNode[]; index: number };

/** The `@` being typed before the cursor. Waits out IME composition, so pinyin never opens the menu. */
function readTrigger(editor: Editor) {
  const { $from, empty } = editor.state.selection;
  if (!empty || editor.view.composing) return null;
  const match = /@([^\s@\ufffc]*)$/.exec($from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc"));
  return match && { from: $from.pos - match[0].length, query: match[1] };
}

/** Mounted only while the console is open. Tiptap documents stop at this boundary; callers see segments. */
export function PromptEditor({ value, upstream, placeholder, onChange }: {
  value: Segment[];
  upstream: UpstreamNode[];
  placeholder?: string;
  onChange: (segments: Segment[]) => void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const latest = useRef({ menu, upstream, dismissedFrom: undefined as number | undefined });
  useEffect(() => { latest.current.menu = menu; latest.current.upstream = upstream; }, [menu, upstream]);

  const showMenu = (next: Menu | null) => {
    latest.current.menu = next;
    setMenu(next);
  };
  const refreshMenu = (editor: Editor) => {
    const trigger = readTrigger(editor);
    // Escape dismisses only this `@`; once it is gone, the next one opens the menu again.
    if (trigger?.from !== latest.current.dismissedFrom) latest.current.dismissedFrom = undefined;
    const items = !trigger || trigger.from === latest.current.dismissedFrom ? [] : latest.current.upstream
      .filter(node => node.name.includes(trigger.query) || node.label.includes(trigger.query));
    const previous = latest.current.menu;
    showMenu(trigger && items.length ? { from: trigger.from, items, index: previous?.from === trigger.from ? Math.min(previous.index, items.length - 1) : 0 } : null);
  };
  const insert = (editor: Editor, node: UpstreamNode, from: number) => {
    editor.chain().focus().insertContentAt({ from, to: editor.state.selection.from }, { type: "nodeReference", attrs: { ref: node.id } }).run();
  };

  const editor = useEditor({
    extensions: [Document, Paragraph, Text, UndoRedo, Placeholder.configure({ placeholder }),
      NodeReference],
    content: toDocument(value),
    immediatelyRender: true, // Only ever mounted after a client-side selection, so there is no SSR to match.
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        role: "textbox", "aria-label": "提示词", "aria-multiline": "true",
        class: "nokey min-h-14 max-h-40 overflow-y-auto whitespace-pre-wrap break-words px-1 text-sm leading-6 outline-none",
      },
      // References leave the editor as plain text, because pasting only keeps plain text.
      clipboardTextSerializer: slice => slice.content.textBetween(0, slice.content.size, "\n",
        leaf => `@${latest.current.upstream.find(node => node.id === leaf.attrs.ref)?.name ?? "节点"}`),
      handlePaste(view, event) {
        const { schema, tr } = view.state;
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return true; // Nothing to paste, such as a copied image; keep the selection.
        const paragraphs = text.split(/\r?\n/).map(line => schema.nodes.paragraph.create(null, line ? schema.text(line) : undefined));
        view.dispatch(tr.replaceSelection(new Slice(Fragment.from(paragraphs), 1, 1)).scrollIntoView());
        return true;
      },
      handleKeyDown(_view, event) {
        const open = latest.current.menu;
        if (!open || event.isComposing) return false;
        const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        if (step) {
          showMenu({ ...open, index: (open.index + step + open.items.length) % open.items.length });
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          if (editorRef.current) insert(editorRef.current, open.items[open.index], open.from);
          return true;
        }
        if (event.key === "Escape") {
          latest.current.dismissedFrom = open.from;
          showMenu(null);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => onChange(toSegments(editor.getJSON())),
    onTransaction: ({ editor }) => refreshMenu(editor),
    onBlur: () => showMenu(null),
  });
  const editorRef = useRef(editor);

  // Outside changes such as draft recovery; our own edits already match, so typing is never reset.
  useEffect(() => {
    // Reference tags are React node views, which flushSync on creation; React forbids that inside an effect.
    queueMicrotask(() => {
      if (editor.isDestroyed || editor.view.composing || JSON.stringify(toSegments(editor.getJSON())) === JSON.stringify(value)) return;
      // Out of history: undo must not bring back a reference whose connection is gone.
      editor.chain().setMeta("addToHistory", false).setContent(toDocument(value), { emitUpdate: false }).run();
    });
  }, [editor, value]);

  return (
    <UpstreamContext.Provider value={upstream}>
      <div className="relative">
        <EditorContent editor={editor}
          className="[&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-left [&_.is-editor-empty:first-child]:before:h-0 [&_.is-editor-empty:first-child]:before:text-zinc-500 [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]" />
        {menu && (
          <div role="listbox" aria-label="引用连接的节点" className="absolute bottom-full left-0 z-20 mb-1 w-52 rounded-xl border border-white/10 bg-[#262626] p-1 shadow-2xl">
            {menu.items.map((node, index) => (
              <button key={node.id} type="button" role="option" aria-selected={index === menu.index}
                onMouseDown={event => { event.preventDefault(); insert(editor, node, menu.from); }}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-zinc-200 ${index === menu.index ? "bg-white/10" : ""}`}>
                <UpstreamThumbnail node={node} className="h-6 w-6 shrink-0 rounded text-[10px]" />
                <span className="flex-1 truncate">{node.label}</span>
                {node.label !== node.name && <span className="truncate text-[11px] text-zinc-500">{node.name}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </UpstreamContext.Provider>
  );
}
