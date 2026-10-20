import { Suspense } from 'react';

import { ExplanationPage } from '@/components/study/explanations/ExplanationPage';

export default async function Page({
  params,
}: {
  params: Promise<{ spaceId: string; explanationId: string }>;
}) {
  const { spaceId, explanationId } = await params;
  return (
    <Suspense>
      <ExplanationPage spaceId={spaceId} explanationId={explanationId} />
    </Suspense>
  );
}
