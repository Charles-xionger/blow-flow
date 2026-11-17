"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { BrandMark } from "@/components/ui/brand-mark";
import { ArrowDownUp, ArrowLeft, ChevronRight, Folder, FolderOpen, FolderPlus, Grid2X2, Home, ImageIcon, LayoutGrid, List, Loader2, MoreHorizontal, Plus, RotateCcw, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";
import { PersonalSpaceMenu } from "./PersonalSpaceMenu";
import { workspaceActionDialog, type ActionDialog, type WorkspaceAction } from "./action-dialog";
import type { ProjectFolder, ProjectSummary, WorkspaceCommand, WorkspaceData } from "@/lib/workspace/types";
import { createWorkspaceProject, runWorkspaceCommand } from "@/lib/workspace/client";
import styles from "./workspace.module.css";

const VIEW_KEY = "ai-flow-workspace-view-v1";
const VIEW_EVENT = "workspace-view-change";
function readView() {
  try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"; } catch { return "grid"; }
}
function subscribeView(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(VIEW_EVENT, listener);
  return () => { window.removeEventListener("storage", listener); window.removeEventListener(VIEW_EVENT, listener); };
}
const date = (time: number) => new Date(time).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function relativeDate(time: number) {
  const days = Math.max(0, Math.floor((Date.now() - time) / 86400000));
  return days === 0 ? "今天" : days === 1 ? "昨天" : days < 30 ? `${days} 天前` : new Date(time).toLocaleDateString("zh-CN");
}

type Entry = { kind: "project"; value: ProjectSummary } | { kind: "folder"; value: ProjectFolder };

function ProjectCover({ project }: { project: ProjectSummary }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return project.coverUrl && failedUrl !== project.coverUrl ? (
    // Covers can be data URLs or images from user-configured media hosts.
    // eslint-disable-next-line @next/next/no-img-element
    <img className={styles.coverImage} src={project.coverUrl} alt="" loading="lazy" decoding="async" onError={() => setFailedUrl(project.coverUrl)} />
  ) : <div className={styles.placeholder}><span className={styles.placeholderLines} /><ImageIcon size={28} strokeWidth={1.2} /><span>创作从这里开始</span></div>;
}

export default function Workspace() {
  const router = useRouter();
  const search = useSearchParams();
  const trash = search.get("trash") === "true";
  const folderId = trash ? null : search.get("folder");
  const [data, setData] = useState<WorkspaceData>({ projects: [], folders: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("updated-desc");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [modal, setModal] = useState<ActionDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [temporaryView, setTemporaryView] = useState<"grid" | "list" | null>(null);
  const loadVersion = useRef(0);
  const savedView = useSyncExternalStore(subscribeView, readView, () => "grid");
  const view = temporaryView ?? savedView;
  const currentFolder = data.folders.find(folder => folder.id === folderId);

  const load = useCallback(async (signal?: AbortSignal) => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspace${trash ? "?trash=true" : ""}`, { cache: "no-store", signal });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "项目加载失败");
      if (!signal?.aborted && version === loadVersion.current) setData(result.data);
    } catch (error) {
      if (!signal?.aborted && version === loadVersion.current) setError(error instanceof Error ? error.message : "项目加载失败");
    } finally { if (!signal?.aborted && version === loadVersion.current) setLoading(false); }
  }, [trash]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!(event.target as Element).closest("[data-workspace-menu]")) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    document.addEventListener("click", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", escape); };
  }, []);

  const entries = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const projects: Entry[] = data.projects
      .filter(project => (trash || term || project.folderId === folderId) && project.name.toLocaleLowerCase().includes(term))
      .map(value => ({ kind: "project", value }));
    const folders: Entry[] = !trash && !folderId ? data.folders.filter(folder => folder.name.toLocaleLowerCase().includes(term)).map(value => ({ kind: "folder", value })) : [];
    const items = [...(filter !== "projects" ? folders : []), ...(filter !== "folders" || trash ? projects : [])];
    const field = sort.startsWith("created") ? "createdAt" : "updatedAt";
    const direction = sort.endsWith("asc") ? 1 : -1;
    return items.sort((a, b) => a.kind !== b.kind ? a.kind === "folder" ? -1 : 1 : direction * (a.value[field] - b.value[field]) || a.value.id.localeCompare(b.value.id));
  }, [data, query, trash, folderId, filter, sort]);
  const visibleProjects = entries.flatMap(entry => entry.kind === "project" ? [entry.value] : []);
  const selectedProjects = visibleProjects.filter(project => selection.has(project.id));
  const allSelected = visibleProjects.length > 0 && selectedProjects.length === visibleProjects.length;
  const folderNames = new Map(data.folders.map(folder => [folder.id, folder.name]));

  function changeView(next: "grid" | "list") {
    setTemporaryView(next);
    try { localStorage.setItem(VIEW_KEY, next); window.dispatchEvent(new Event(VIEW_EVENT)); setTemporaryView(null); } catch { /* The view remains usable if storage is unavailable. */ }
  }
  function navigate(url: string) {
    setSelection(new Set()); setSelecting(false); setQuery(""); setFilter("all"); setMenu(null);
    router.push(url);
  }
  function toggle(id: string) {
    setSelecting(true);
    setSelection(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function showModal(next: WorkspaceAction) {
    setMenu(null);
    setModal(workspaceActionDialog(next, folderId));
  }
  async function createProject() {
    setBusy(true);
    try {
      const id = await createWorkspaceProject(folderId);
      router.push(`/canvas?project=${encodeURIComponent(id)}`);
    } catch (error) { toast.error(error instanceof Error ? error.message : "创建失败"); setBusy(false); }
  }
  async function submit(operation: WorkspaceCommand, successMessage: string) {
    setBusy(true);
    try {
      await runWorkspaceCommand(operation);
      setModal(null); setSelection(new Set()); setSelecting(false);
      toast.success(successMessage);
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  }

  function actions(entry: Entry) {
    return <div className={styles.menuWrap} data-workspace-menu>
      <button className={styles.iconButton} aria-label={`${entry.value.name}的更多操作`} aria-expanded={menu === entry.value.id} aria-haspopup="menu" onClick={() => setMenu(menu === entry.value.id ? null : entry.value.id)}><MoreHorizontal size={19} /></button>
      {menu === entry.value.id ? <div className={styles.menu} role="menu" aria-label={`${entry.value.name}的操作`}>
        {entry.kind === "folder" ? <>
          <button role="menuitem" onClick={() => navigate(`/workspace?folder=${encodeURIComponent(entry.value.id)}`)}>打开文件夹</button>
          <button role="menuitem" onClick={() => showModal({ kind: "rename-folder", folder: entry.value })}>重命名</button>
          <button role="menuitem" className={styles.dangerText} onClick={() => showModal({ kind: "delete-folder", folder: entry.value })}>删除文件夹</button>
        </> : trash ? <>
          <button role="menuitem" onClick={() => showModal({ kind: "restore", projects: [entry.value] })}>恢复项目</button>
          <button role="menuitem" className={styles.dangerText} onClick={() => showModal({ kind: "purge", projects: [entry.value] })}>永久删除</button>
        </> : <>
          <Link role="menuitem" href={`/canvas?project=${encodeURIComponent(entry.value.id)}`} prefetch={false}>打开画布</Link>
          <Link role="menuitem" href={`/canvas/history?project=${encodeURIComponent(entry.value.id)}`} prefetch={false}>操作历史</Link>
          <button role="menuitem" onClick={() => showModal({ kind: "rename-project", projects: [entry.value] })}>重命名</button>
          <button role="menuitem" onClick={() => { toggle(entry.value.id); setMenu(null); }}>选择</button>
          <button role="menuitem" onClick={() => showModal({ kind: "move", projects: [entry.value] })}>移动至文件夹</button>
          <button role="menuitem" className={styles.dangerText} onClick={() => showModal({ kind: "trash", projects: [entry.value] })}>移入回收站</button>
        </>}
      </div> : null}
    </div>;
  }
  function checkbox(project: ProjectSummary) {
    return <input type="checkbox" aria-label={`选择 ${project.name}`} checked={selection.has(project.id)} onChange={() => toggle(project.id)} className={styles.checkbox} />;
  }
  function openEntry(entry: Entry) {
    if (entry.kind === "folder") navigate(`/workspace?folder=${encodeURIComponent(entry.value.id)}`);
    else if (selecting || trash) toggle(entry.value.id);
    else router.push(`/canvas?project=${encodeURIComponent(entry.value.id)}`);
  }

  return <div className={styles.workspace}>
    <header className={styles.header}>
      <Link href="/workspace" className={styles.brand} aria-label="Blow Flow 工作空间"><span className={styles.brandMark}><BrandMark /></span>Blow <span className={styles.brandLight}>Flow</span></Link>
      <nav aria-label="主导航" className={styles.navigation}>
        <button disabled title="主页即将推出"><Home size={17} />主页<span className={styles.soon}>即将推出</span></button>
        <Link href="/workspace" aria-current="page"><Grid2X2 size={17} />工作空间</Link>
      </nav>
      <PersonalSpaceMenu />
    </header>

    <main className={styles.main}>
      <div className={styles.intro}><div><p className={styles.eyebrow}>WORKSPACE</p><h1>{trash ? "回收站" : currentFolder ? currentFolder.name : "工作空间"}</h1><p>{trash ? "删除的项目会保留在这里，直到你将它们恢复或永久删除。" : "整理灵感，继续你的下一次创作。"}</p></div><span className={styles.projectCount}>{data.projects.length} 个{trash ? "已删除" : ""}项目</span></div>
      <div className={styles.toolbar}>
        <div className={styles.tabs} role="tablist" aria-label="项目范围">
          <button role="tab" aria-selected={!trash} onClick={() => navigate("/workspace")}>个人项目</button>
          <button role="tab" aria-selected={trash} onClick={() => navigate("/workspace?trash=true")}><Trash2 size={15} />回收站</button>
        </div>
        <div className={styles.tools}>
          <label className={styles.search}><Search size={17} /><input aria-label="搜索项目和文件夹" placeholder="搜索项目和文件夹" value={query} onChange={event => { setQuery(event.target.value); setSelection(new Set()); }} />{query ? <button aria-label="清除搜索" onClick={() => setQuery("")}><X size={14} /></button> : null}</label>
          {!trash && !folderId ? <label className={styles.selectControl}><SlidersHorizontal size={15} /><select aria-label="筛选类型" value={filter} onChange={event => { setFilter(event.target.value); setSelection(new Set()); }}><option value="all">显示全部</option><option value="folders">仅文件夹</option><option value="projects">仅项目</option></select></label> : null}
          <label className={styles.selectControl}><ArrowDownUp size={15} /><select aria-label="排序方式" value={sort} onChange={event => setSort(event.target.value)}><option value="updated-desc">最近修改</option><option value="updated-asc">最早修改</option><option value="created-desc">最近创建</option><option value="created-asc">最早创建</option></select></label>
          <div className={styles.viewToggle} role="group" aria-label="展示方式"><button aria-label="卡片视图" aria-pressed={view === "grid"} onClick={() => changeView("grid")}><LayoutGrid size={17} /></button><button aria-label="列表视图" aria-pressed={view === "list"} onClick={() => changeView("list")}><List size={18} /></button></div>
          {!trash ? <>{!folderId ? <button className={styles.outlineButton} title="新建文件夹" aria-label="新建文件夹" disabled={busy} onClick={() => showModal({ kind: "create-folder" })}><FolderPlus size={19} /></button> : null}<button className={styles.primaryButton} disabled={busy || loading || !!error || (!!folderId && !currentFolder)} onClick={createProject}>{busy && !modal ? <Loader2 size={17} className={styles.spin} /> : <Plus size={18} />}新建项目</button></> : null}
        </div>
      </div>

      {folderId ? <div className={styles.breadcrumb}><button onClick={() => navigate("/workspace")}><ArrowLeft size={15} />所有项目</button><ChevronRight size={14} /><span>{currentFolder?.name || "文件夹不存在"}</span></div> : null}
      {query.trim() ? <p className={styles.searchHint}>在{trash ? "回收站" : "全部文件夹"}中搜索“{query.trim()}” · {entries.length} 个结果</p> : null}
      {selecting || selectedProjects.length ? <div className={styles.selectionBar}>
        <label><input className={styles.checkbox} type="checkbox" aria-label="选择全部项目" checked={allSelected} onChange={() => setSelection(allSelected ? new Set() : new Set(visibleProjects.map(project => project.id)))} />已选择 {selectedProjects.length} 个项目</label>
        <div>{trash ? <><button disabled={!selectedProjects.length || busy} onClick={() => showModal({ kind: "restore", projects: selectedProjects })}><RotateCcw size={16} />恢复</button><button className={styles.dangerText} disabled={!selectedProjects.length || busy} onClick={() => showModal({ kind: "purge", projects: selectedProjects })}>永久删除</button></> : <><button disabled={!selectedProjects.length || busy} onClick={() => showModal({ kind: "move", projects: selectedProjects })}><FolderOpen size={16} />移动至</button><button disabled={!selectedProjects.length || busy} onClick={() => showModal({ kind: "trash", projects: selectedProjects })}><Trash2 size={16} />移入回收站</button></>}<button aria-label="取消选择" onClick={() => { setSelection(new Set()); setSelecting(false); }}><X size={17} /></button></div>
      </div> : null}

      {loading ? <div className={styles.empty} role="status"><Loader2 size={28} className={styles.spin} /><p>正在加载项目…</p></div> : error ? <div className={styles.empty} role="alert"><p>{error}</p><button className={styles.outlineButton} onClick={() => void load()}>重新加载</button></div> : folderId && !currentFolder ? <div className={styles.empty}><Folder size={36} /><h2>这个文件夹已不存在</h2><button className={styles.outlineButton} onClick={() => navigate("/workspace")}>返回所有项目</button></div> : entries.length === 0 && (trash || query || filter !== "all") ? <div className={styles.empty}>{trash ? <Trash2 size={34} /> : <Search size={34} />}<h2>{trash && !query ? "回收站是空的" : "没有找到匹配的内容"}</h2><p>{trash ? "删除的项目会出现在这里。" : "试试其他名称，或调整筛选条件。"}</p></div> : view === "grid" ? <div className={styles.grid}>
        {!trash && !query && filter !== "folders" ? <button className={styles.createCard} disabled={busy} onClick={createProject}><span><Plus size={26} strokeWidth={1.5} /></span><strong>新建项目</strong><small>打开一张空白画布</small></button> : null}
        {entries.map(entry => <article key={entry.value.id} className={`${styles.card} ${entry.kind === "project" && selection.has(entry.value.id) ? styles.selected : ""}`} data-testid="workspace-item">
          <button className={styles.cardOpen} aria-label={`${trash ? "选择" : "打开"} ${entry.value.name}`} onClick={() => openEntry(entry)}><div className={`${styles.preview} ${entry.kind === "folder" ? styles.folderPreview : ""}`}>{entry.kind === "folder" ? <><Folder size={58} strokeWidth={1} /><span>{entry.value.projectCount} 个项目</span></> : <ProjectCover project={entry.value} />}</div><span className={styles.cardTitle}>{entry.value.name}</span><span className={styles.cardMeta}>{entry.kind === "folder" ? "文件夹" : trash ? `删除于 ${relativeDate(entry.value.deletedAt!)}` : `编辑于 ${relativeDate(entry.value.updatedAt)}`}{query && entry.kind === "project" ? ` · ${folderNames.get(entry.value.folderId ?? "") || "根目录"}` : ""}</span></button>
          {entry.kind === "project" ? <div className={`${styles.cardCheck} ${selecting ? styles.showCheck : ""}`}>{checkbox(entry.value)}</div> : null}
          <div className={styles.cardMenu}>{actions(entry)}</div>
        </article>)}
      </div> : <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th className={styles.checkCell}><input type="checkbox" className={styles.checkbox} aria-label="选择全部项目" checked={allSelected} onChange={() => { setSelecting(true); setSelection(allSelected ? new Set() : new Set(visibleProjects.map(project => project.id))); }} /></th><th>名称</th><th>类型</th><th>内容</th><th>创建时间</th><th>{trash ? "删除时间" : "最近更新"}</th><th><span className={styles.srOnly}>操作</span></th></tr></thead><tbody>
        {entries.map(entry => <tr key={entry.value.id} data-testid="workspace-item" className={entry.kind === "project" && selection.has(entry.value.id) ? styles.selectedRow : ""}><td>{entry.kind === "project" ? checkbox(entry.value) : null}</td><td><button className={styles.rowName} onClick={() => openEntry(entry)}><span className={styles.rowPreview}>{entry.kind === "folder" ? <Folder size={26} /> : <ProjectCover project={entry.value} />}</span><span>{entry.value.name}{query && entry.kind === "project" ? <small>{folderNames.get(entry.value.folderId ?? "") || "根目录"}</small> : null}</span></button></td><td>{entry.kind === "folder" ? "文件夹" : "项目"}</td><td>{entry.kind === "folder" ? `${entry.value.projectCount} 个项目` : `${entry.value.nodeCount} 个节点`}</td><td>{date(entry.value.createdAt)}</td><td>{date(trash && entry.kind === "project" ? entry.value.deletedAt! : entry.value.updatedAt)}</td><td>{actions(entry)}</td></tr>)}
        {!entries.length ? <tr><td colSpan={7} className={styles.emptyTable}>还没有项目，点击“新建项目”开始创作。</td></tr> : null}
      </tbody></table></div>}
      {!loading && !error ? <div className={styles.footer}><span>{entries.filter(entry => entry.kind === "folder").length ? `${entries.filter(entry => entry.kind === "folder").length} 个文件夹 · ` : ""}{visibleProjects.length} 个项目</span>{!trash ? <span><span className={styles.statusDot} />更改自动保存</span> : <span>回收站不会自动清空</span>}</div> : null}
    </main>

    {modal ? <WorkspaceActionDialog dialog={modal} folders={data.folders} busy={busy} onClose={() => setModal(null)} onSubmit={submit} /> : null}
  </div>;
}
