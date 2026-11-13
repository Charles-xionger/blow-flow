"use client";

import { useState } from "react";
import { Check, Loader2, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ProjectFolder, WorkspaceCommand } from "@/lib/workspace/types";
import type { ActionDialog } from "./action-dialog";
import styles from "./workspace.module.css";

interface Props {
  dialog: ActionDialog;
  folders: ProjectFolder[];
  busy: boolean;
  onClose(): void;
  onSubmit(command: WorkspaceCommand, successMessage: string): Promise<void>;
}

export function WorkspaceActionDialog({ dialog, folders, busy, onClose, onSubmit }: Props) {
  const [value, setValue] = useState(dialog.field?.initialValue ?? "");
  const invalid = dialog.field?.type === "name" && !value.trim();
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className={styles.dialog} showCloseButton={!busy}>
        <form onSubmit={event => {
          event.preventDefault();
          if (!busy && !invalid) void onSubmit(dialog.command(value), dialog.successMessage ?? "操作完成");
        }}>
          <DialogHeader>
            <DialogTitle>{dialog.title}</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>{dialog.description}</DialogDescription>
          </DialogHeader>
          {dialog.field?.type === "name" ? (
            <label className={styles.fieldLabel}>名称
              <input autoFocus aria-label="名称" maxLength={200} value={value} onChange={event => setValue(event.target.value)} placeholder="输入名称" disabled={busy} />
            </label>
          ) : dialog.field?.type === "folder" ? (
            <label className={styles.fieldLabel}>目标位置
              <select aria-label="目标文件夹" value={value} onChange={event => setValue(event.target.value)} disabled={busy}>
                <option value="">根目录</option>
                {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
            </label>
          ) : null}
          <DialogFooter className={styles.dialogFooter}>
            <button type="button" className={styles.outlineButton} disabled={busy} onClick={onClose}>取消</button>
            <button type="submit" className={dialog.destructive ? styles.dangerButton : styles.primaryButton} disabled={busy || invalid}>
              {busy ? <Loader2 size={16} className={styles.spin} /> : dialog.destructive ? <Trash2 size={16} /> : <Check size={16} />}
              {dialog.confirmLabel ?? "确认"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
