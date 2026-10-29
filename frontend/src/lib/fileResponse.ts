// Server-only. Streams a file from disk as an HTTP response, honoring a
// single-range "Range" header (audio/video seeking, resumable downloads).
// Both /api/serve-audio and /api/video/download used to readFileSync the
// WHOLE file for every request -- including every small range request a
// <video> makes while playing -- blocking the server on each one.
import fs from "fs";
import { Readable } from "stream";

export function fileResponse(
  filePath: string,
  size: number,
  contentType: string,
  rangeHeader: string | null,
  extraHeaders: Record<string, string> = {}
): Response {
  const baseHeaders = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
    ...extraHeaders,
  };

  if (!rangeHeader) {
    return new Response(toWebStream(fs.createReadStream(filePath)), {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(size) },
    });
  }

  const range = parseRange(rangeHeader, size);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    });
  }

  const { start, end } = range;
  return new Response(toWebStream(fs.createReadStream(filePath, { start, end })), {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    },
  });
}

// "bytes=START-END", "bytes=START-" or "bytes=-SUFFIX_LENGTH"; null when
// unsatisfiable. Multi-range requests are answered with their first range.
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)/.exec(header.trim());
  if (!match || size === 0) return null;
  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;
  if (rawStart === "") {
    if (rawEnd === "") return null;
    start = Math.max(0, size - Number(rawEnd));
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

function toWebStream(stream: fs.ReadStream): ReadableStream {
  return Readable.toWeb(stream) as unknown as ReadableStream;
}
