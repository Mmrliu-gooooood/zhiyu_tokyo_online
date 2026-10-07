import { Suspense } from 'react';

import { CompanionChatPage } from '@/components/study/companion/CompanionChatPage';

export default async function Page({ params }: { params: Promise<{ classmateId: string }> }) {
  const { classmateId } = await params;
  return (
    <Suspense>
      <CompanionChatPage classmateId={classmateId} />
    </Suspense>
  );
}
