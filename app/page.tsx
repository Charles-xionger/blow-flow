import { redirect } from "next/navigation";

// The homepage will be designed separately. Keep historical canvas links usable.
export default async function Home({ searchParams }: { searchParams: Promise<{ project?: string | string[] }> }) {
  const { project } = await searchParams;
  const id = Array.isArray(project) ? project[0] : project;
  redirect(id ? `/canvas?project=${encodeURIComponent(id)}` : "/workspace");
}
