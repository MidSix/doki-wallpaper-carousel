import * as fs from "fs";
import * as path from "path";

/**
 * Formats Doki can show. Doki embeds the file in VS Code's CSS as `data:image/<ext>;base64,...`
 * and VS Code's Chromium recognizes the image by its content, so every format Chromium decodes
 * works. SVG doesn't (it needs the image/svg+xml type) and neither does TIFF.
 */
export const WALLPAPER_EXTENSIONS = [".gif", ".png", ".apng", ".jpg", ".jpeg", ".jfif", ".webp", ".avif", ".bmp", ".ico"];

export const isWallpaper = (file: string) => WALLPAPER_EXTENSIONS.includes(path.extname(file).toLowerCase());

function readHead(file: string, bytes: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, bytes, 0));
  } catch {
    return Buffer.alloc(0);
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether the file holds more than one frame, going by its header (no decoding). */
export function isAnimated(file: string): boolean {
  let head: Buffer;
  try {
    head = readHead(file, 4096);
  } catch {
    return false;
  }
  const ascii = head.toString("latin1");
  // GIF: always handled as an animation, a single frame is just a short one.
  if (ascii.startsWith("GIF8")) return true;
  // APNG: an acTL chunk before the first image data.
  if (ascii.startsWith("\x89PNG")) {
    const actl = ascii.indexOf("acTL");
    return actl !== -1 && (ascii.indexOf("IDAT") === -1 || actl < ascii.indexOf("IDAT"));
  }
  // WebP: the animation flag of the extended (VP8X) header.
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return ascii.slice(12, 16) === "VP8X" && (head[20] & 0x02) !== 0;
  // AVIF: image sequences use the "avis" brand.
  if (ascii.slice(4, 8) === "ftyp") {
    const size = Math.min(head.readUInt32BE(0), head.length);
    return ascii.slice(8, size).includes("avis");
  }
  return false;
}
