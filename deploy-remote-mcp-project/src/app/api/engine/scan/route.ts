import { GET as getHandler } from '@/api/engine';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return getHandler(request);
}
