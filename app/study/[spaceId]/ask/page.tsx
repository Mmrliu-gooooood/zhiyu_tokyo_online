import { StudyAskPage } from '@/components/study/knowledge/StudyAskPage';

export default async function Page({ params }: { params: Promise<{ spaceId: string }> }) {
  const { spaceId } = await params;
  return <StudyAskPage spaceId={spaceId} />;
}
