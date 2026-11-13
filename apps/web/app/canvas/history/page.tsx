import RemoteHistory from '@/components/canvas/RemoteHistory';

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const { project } = await searchParams;
  return project ? <RemoteHistory key={project} project={project} /> : <p className="p-8">请选择要查看历史的项目。</p>;
}
