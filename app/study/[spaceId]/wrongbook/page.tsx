import { Suspense } from 'react';

import { WrongbookPage } from '@/components/study/wrongbook/WrongbookPage';

export default async function Page({ params }: { params: Promise<{ spaceId: string }> }) {
  const { spaceId } = await params;
  return (
    <Suspense>
      <WrongbookPage spaceId={spaceId} />
    </Suspense>
  );
}
