"use client";

import { useEffect } from "react";
import type { JSONContent } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { Fragment, Slice } from "@tiptap/pm/model";
import { EditorContent, useEditor } from "@tiptap/react";
import { promptText, type Segment } from "@/lib/canvas/prompt";

const toDocument = (segments: Segment[]): JSONContent => ({
  type: "doc",
  content: promptText(segments).split("\n")
    .map(line => line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" }),
});

const toSegments = (text: string): Segment[] => text ? [{ text }] : [];
const blockSeparator = { blockSeparator: "\n" };

/** Mounted only while the console is open. Tiptap documents stop at this boundary; callers see segments. */
export function PromptEditor({ value, placeholder, onChange }: {
  value: Segment[];
  placeholder?: string;
  onChange: (segments: Segment[]) => void;
}) {
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, UndoRedo, Placeholder.configure({ placeholder })],
    content: toDocument(value),
    immediatelyRender: true, // Only ever mounted after a client-side selection, so there is no SSR to match.
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        role: "textbox", "aria-label": "提示词", "aria-multiline": "true",
        class: "nokey min-h-14 max-h-40 overflow-y-auto whitespace-pre-wrap break-words px-1 text-sm leading-6 outline-none",
      },
      handlePaste(view, event) {
        const { schema, tr } = view.state;
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return true; // Nothing to paste, such as a copied image; keep the selection.
        const paragraphs = text.split(/\r?\n/).map(line => schema.nodes.paragraph.create(null, line ? schema.text(line) : undefined));
        view.dispatch(tr.replaceSelection(new Slice(Fragment.from(paragraphs), 1, 1)).scrollIntoView());
        return true;
      },
    },
    onUpdate: ({ editor }) => onChange(toSegments(editor.getText(blockSeparator))),
  });

  // Outside changes such as draft recovery; our own edits already match, so typing is never reset.
  useEffect(() => {
    if (editor.view.composing || editor.getText(blockSeparator) === promptText(value)) return;
    editor.commands.setContent(toDocument(value), { emitUpdate: false });
  }, [editor, value]);

  return <EditorContent editor={editor}
    className="[&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-left [&_.is-editor-empty:first-child]:before:h-0 [&_.is-editor-empty:first-child]:before:text-zinc-500 [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]" />;
}
