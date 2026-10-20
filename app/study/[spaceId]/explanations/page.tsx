import { Suspense } from 'react';

import { ExplanationsPage } from '@/components/study/explanations/ExplanationsPage';

export default async function Page({ params }: { params: Promise<{ spaceId: string }> }) {
  const { spaceId } = await params;
  return (
    <Suspense>
      <ExplanationsPage spaceId={spaceId} />
    </Suspense>
  );
}
