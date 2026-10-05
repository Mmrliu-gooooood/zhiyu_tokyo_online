import { MaterialDetailPage } from '@/components/study/materials/MaterialDetailPage';

export default async function Page({ params }: { params: Promise<{ materialId: string }> }) {
  const { materialId } = await params;
  return <MaterialDetailPage materialId={materialId} />;
}
