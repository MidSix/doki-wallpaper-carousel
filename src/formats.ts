import * as fs from "fs";
import * as path from "path";

/**
 * Formats Doki can show. Doki embeds the file in VS Code's CSS as `data:image/<ext>;base64,...`
 * and VS Code's Chromium recognizes the image by its content, so every format Chromium decodes
 * works. SVG doesn't (it needs the image/svg+xml type) and neither does TIFF.
 */
export const WALLPAPER_EXTENSIONS = [".gif", ".png", ".apng", ".jpg", ".jpeg", ".jfif", ".webp", ".avif", ".bmp", ".ico"];

/** For file dialog filters: extensions without the dot. */
export const WALLPAPER_FILTER = WALLPAPER_EXTENSIONS.map((e) => e.slice(1));

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

export type OpacityPlan =
  /** Two passes (palette, then GIF), each taking the filter graph with a palette input. */
  | { kind: "gif" }
  /** One pass: output options after `-i file -vf <filter>`. */
  | { kind: "single"; output: string[] }
  | { kind: "unsupported"; reason: string };

/**
 * How ffmpeg rewrites a wallpaper with a color filter while keeping its format, size, frame
 * timing and transparency. `sequenceStream` is the stream index of an animated AVIF's frames.
 */
export function opacityPlan(file: string, sequenceStream?: number): OpacityPlan {
  const ext = path.extname(file).toLowerCase();
  const animated = isAnimated(file);
  const still = ["-frames:v", "1", "-update", "1"];
  switch (ext) {
    case ".gif":
      return { kind: "gif" };
    case ".png":
    case ".apng":
      return animated
        ? { kind: "single", output: ["-c:v", "apng", "-plays", "0", "-f", "apng"] }
        : { kind: "single", output: [...still, "-c:v", "png", "-f", "image2"] };
    case ".jpg":
    case ".jpeg":
    case ".jfif":
      return { kind: "single", output: [...still, "-c:v", "mjpeg", "-q:v", "2", "-f", "image2"] };
    case ".webp":
      // ffmpeg reads the first frame of an animated WebP only, or nothing at all.
      if (animated) return { kind: "unsupported", reason: "ffmpeg can't read animated WebP files" };
      return { kind: "single", output: [...still, "-c:v", "libwebp", "-quality", "92", "-f", "webp"] };
    case ".avif": {
      const av1 = ["-c:v", "libaom-av1", "-crf", "20", "-cpu-used", "6", "-pix_fmt", "yuv420p", "-f", "avif"];
      if (!animated) return { kind: "single", output: [...still, "-still-picture", "1", ...av1] };
      // An animated AVIF also has a still cover image; the frames are in their own stream.
      return { kind: "single", output: [...(sequenceStream !== undefined ? ["-map", `0:${sequenceStream}`] : []), ...av1] };
    }
    case ".bmp":
      return { kind: "single", output: [...still, "-c:v", "bmp", "-f", "image2"] };
    case ".ico":
      return { kind: "single", output: [...still, "-f", "ico"] };
    default:
      return { kind: "unsupported", reason: `${ext || "this file type"} is not a wallpaper format` };
  }
}
