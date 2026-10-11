import { AttemptPage } from '@/components/study/exams/AttemptPage';

export default async function Page({
  params,
}: {
  params: Promise<{ spaceId: string; attemptId: string }>;
}) {
  const { spaceId, attemptId } = await params;
  return <AttemptPage spaceId={spaceId} attemptId={attemptId} />;
}
