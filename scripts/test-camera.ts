import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Deterministic Chromium test-only camera input, never part of the app build. */
export async function prepareTestCamera() {
  const directory = resolve('.local');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, 'camera-320x180-10fps.y4m');
  const width = 320,
    height = 180;
  const frames = [Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`)];
  for (let frame = 0; frame < 10; frame++) {
    const pixels = Buffer.alloc((width * height * 3) / 2);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        pixels[y * width + x] = 32 + ((Math.floor(x / 32) + frame) % 6) * 30;
    pixels.fill(110, width * height, (width * height * 5) / 4);
    pixels.fill(160, (width * height * 5) / 4);
    frames.push(Buffer.from('FRAME\n'), pixels);
  }
  const content = Buffer.concat(frames);
  try {
    await writeFile(path, content, { flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    if (!(await readFile(path)).equals(content))
      throw new Error(
        'Existing test camera differs; stop its browsers before replacing the fixture.',
      );
  }
  return path;
}
