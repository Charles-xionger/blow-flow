import { BrandMark } from "@/components/ui/brand-mark";

/** Quiet, non-modal state while a project is read from local and remote storage. */
export function CanvasOpeningState({ error, children }: { error?: string | null; children?: React.ReactNode }) {
  return (
    <div className="relative flex h-full min-h-64 items-center justify-center bg-background px-6 text-foreground" role="status" aria-live="polite">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="relative mb-6 grid size-16 place-items-center rounded-2xl bg-muted text-foreground">
          <div className="absolute inset-0 rounded-2xl border border-border motion-safe:animate-pulse" aria-hidden="true" />
          <BrandMark size={36} />
        </div>
        <p className="text-base font-semibold">{error ? "画布暂时无法打开" : "正在打开项目"}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {error ? error : "正在读取画布内容，请稍候…"}
        </p>
      </div>
      {children}
    </div>
  );
}
