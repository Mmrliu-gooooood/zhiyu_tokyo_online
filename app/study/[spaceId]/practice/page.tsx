import { Suspense } from 'react';

import { PracticePage } from '@/components/study/exams/PracticePage';

export default async function Page({ params }: { params: Promise<{ spaceId: string }> }) {
  const { spaceId } = await params;
  return (
    <Suspense>
      <PracticePage spaceId={spaceId} />
    </Suspense>
  );
}
