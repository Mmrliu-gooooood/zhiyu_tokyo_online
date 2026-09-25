import { generationRequestReadiness } from '@/lib/server/generation-jobs/runtime';
export const dynamic = 'force-dynamic';
export async function GET() {
  const status = await generationRequestReadiness();
  return Response.json(status, {
    status: status.database && status.schema ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
