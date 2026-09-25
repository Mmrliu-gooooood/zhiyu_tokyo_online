import {
  deleteAccountKvEntry,
  listAccountKvKeys,
  readAccountKvEntry,
  writeAccountKvEntry,
} from '../handler';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  if (path.length === 2 && path[0] === 'entries') {
    return readAccountKvEntry(request, path[1] ?? '');
  }
  if (path.length === 1 && path[0] === 'keys') {
    return listAccountKvKeys(request);
  }
  return Response.json(
    { error: { code: 'ROUTE_NOT_FOUND', message: 'KV route not found' } },
    { status: 404, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  if (path.length === 2 && path[0] === 'entries') {
    return writeAccountKvEntry(request, path[1] ?? '');
  }
  return Response.json(
    { error: { code: 'ROUTE_NOT_FOUND', message: 'KV route not found' } },
    { status: 404, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  if (path.length === 2 && path[0] === 'entries') {
    return deleteAccountKvEntry(request, path[1] ?? '');
  }
  return Response.json(
    { error: { code: 'ROUTE_NOT_FOUND', message: 'KV route not found' } },
    { status: 404, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
