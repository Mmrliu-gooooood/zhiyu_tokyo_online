import { Suspense } from 'react';

import { StudySpacesPage } from '@/components/study/spaces/StudySpacesPage';

export default function Page() {
  // StudySpacesPage reads `?create=1` (the sidebar's "new space" link).
  return (
    <Suspense>
      <StudySpacesPage />
    </Suspense>
  );
}
