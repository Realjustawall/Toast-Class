/** Recover from an empty binary response observed in browser PDF requests.
 * The fallback keeps authentication and streams base64 on the server. */
export async function readPdfSource(
  roomId: string,
  fileId: string,
  documentId: string,
  signal: AbortSignal,
) {
  const path =
    '/api/v1/classrooms/' + roomId + '/files/' + fileId + '/content?documentId=' + documentId;
  const options = {
    credentials: 'same-origin' as const,
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  };
  let bytes: Uint8Array | undefined;
  try {
    const response = await fetch(path + '&raw=1', options);
    if (response.status !== 204) {
      if (!response.ok) throw Error('Original PDF is unavailable');
      bytes = new Uint8Array(await response.arrayBuffer());
    }
  } catch (error) {
    if (signal.aborted) throw error;
  }
  if (!bytes?.length) {
    const response = await fetch(path + '&encoding=base64', {
      credentials: 'same-origin',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) throw Error('Original PDF is unavailable');
    const data = await response.text();
    if (
      data.length > Math.ceil((20 * 1024 * 1024) / 3) * 4 ||
      !data.length ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    )
      throw Error('Invalid original PDF response');
    const decoded = atob(data);
    bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  }
  if (bytes.length > 20 * 1024 * 1024 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
    throw Error('Invalid original PDF');
  return bytes;
}
