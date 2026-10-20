import { Suspense } from 'react';

import { ReviewPage } from '@/components/study/review/ReviewPage';

export default async function Page({ params }: { params: Promise<{ spaceId: string }> }) {
  const { spaceId } = await params;
  return (
    <Suspense>
      <ReviewPage spaceId={spaceId} />
    </Suspense>
  );
}
