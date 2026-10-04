import { StudySpaceDetailPage } from '@/components/study/spaces/StudySpaceDetailPage';

export default async function Page({ params }: { params: Promise<{ spaceId: string }> }) {
  const { spaceId } = await params;
  return <StudySpaceDetailPage spaceId={spaceId} />;
}
