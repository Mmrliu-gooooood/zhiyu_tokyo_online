import { ExtractionReviewPage } from '@/components/study/extraction/ExtractionReviewPage';

export default async function Page({
  params,
}: {
  params: Promise<{ spaceId: string; extractionId: string }>;
}) {
  const { spaceId, extractionId } = await params;
  return <ExtractionReviewPage spaceId={spaceId} extractionId={extractionId} />;
}
