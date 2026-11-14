/**
 * Reads a request body up to `limit` bytes. null means the body is larger. Public endpoints read
 * the whole body before they can authenticate it, so the size has to be bounded first.
 */
export async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function status(code: number, headers?: HeadersInit): Response {
  return new Response(null, headers === undefined ? { status: code } : { status: code, headers });
}
