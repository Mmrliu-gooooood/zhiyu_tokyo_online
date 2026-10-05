import { Suspense } from 'react';

import { MaterialReaderPage } from '@/components/study/materials/MaterialReaderPage';

export default async function Page({ params }: { params: Promise<{ materialId: string }> }) {
  const { materialId } = await params;
  return (
    <Suspense>
      <MaterialReaderPage materialId={materialId} />
    </Suspense>
  );
}
