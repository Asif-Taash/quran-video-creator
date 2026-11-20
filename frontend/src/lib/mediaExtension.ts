import path from "path";

// An uploaded file keeps its own extension only when it is a media one
// (2026-11-20 security fix). Uploads are saved under public/, which the site
// serves: a ".html" or ".svg" kept as-is could be opened as a page on our own
// address, and an extension like ".$(cmd)" could reach a command line. The
// content itself is read by ffmpeg/the browser, which don't need the name.
const MEDIA_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif",
  ".mp4", ".webm", ".mov", ".mkv", ".m4v",
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac",
  ".ttf", ".otf", ".woff", ".woff2",
]);

export function mediaExtension(fileName: string, fallback: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return MEDIA_EXTENSIONS.has(extension) ? extension : fallback;
}
