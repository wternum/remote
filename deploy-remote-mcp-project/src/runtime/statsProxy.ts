/** Keep aborts and server error responses intact. Rubik is not a browser-CORS API. */
export async function fetchStatsProxy(request: Request, nativeFetch: typeof fetch): Promise<Response> {
  if (request.signal.aborted) throw request.signal.reason ?? new DOMException('Request aborted', 'AbortError');
  try {
    const response = await nativeFetch(request);
    if (request.signal.aborted) throw request.signal.reason ?? new DOMException('Request aborted', 'AbortError');
    if (response.headers.get('content-type')?.includes('application/json')) return response;
    // Vite's SPA fallback may be a successful HTML page, not a statistics endpoint.
    return Response.json({ code: '503', msg: 'OKX statistics require the server-side proxy; live trades remain available', data: [] }, { status: 503 });
  } catch (error) {
    if (request.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    return Response.json({ code: '502', msg: 'Statistics proxy unavailable; no browser upstream fallback', data: [] }, { status: 502 });
  }
}
