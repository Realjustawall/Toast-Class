/** MIT-licensed Excalidraw ships a public font fallback even with a local asset
 * path. Remove that fallback in production; missing local assets must fail locally.
 * Keep this small transform version-checked by tests when upgrading Excalidraw. */
export function localExcalidrawFonts(source: string, id: string) {
  if (!id.replaceAll('\\', '/').includes('/@excalidraw/excalidraw/dist/prod/')) return undefined;
  const fallback = /return (\w+)\.push\(new URL\((\w+),(\w+)\.ASSETS_FALLBACK_URL\)\),\1/g;
  if (!fallback.test(source)) return undefined;
  return source.replace(fallback, 'return $1');
}
