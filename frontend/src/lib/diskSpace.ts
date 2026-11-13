// A floor of free disk space the app never writes below. Projects, export
// copies and caches are all small or capped, but the disk is the laptop's
// own: if something else ever fills it, an export (Chromium, ffmpeg, the
// copy in "مشاريعي") must stop with a clear message instead of pushing the
// system to a full disk.
import fs from "fs/promises";
import path from "path";

const MIN_FREE_BYTES = 5 * 1024 ** 3;

// The volume holding the projects sits on the laptop's root disk.
const DISK_PROBE_DIR = path.join(process.cwd(), "public", "render-assets");

// null when there is room (or the free space can't be read).
export async function lowDiskError(): Promise<string | null> {
  const stats = await fs.statfs(DISK_PROBE_DIR).catch(() => null);
  if (!stats) return null;
  const free = stats.bavail * stats.bsize;
  if (free >= MIN_FREE_BYTES) return null;
  const gb = (free / 1024 ** 3).toFixed(1);
  return (
    `القرص شبه ممتلئ (بقي ${gb} GB فقط)، فأوقفنا الحفظ حمايةً للجهاز. احذف بعض الملفات أو المشاريع القديمة ثم حاول مجدداً. ` +
    `/ Disk almost full (${gb} GB left): free some space and try again.`
  );
}
