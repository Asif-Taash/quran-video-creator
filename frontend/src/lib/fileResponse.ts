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
  rangeHeader: string | null
): Response {
  const baseHeaders = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
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

// A Node stream as a web stream. Not Readable.toWeb: when the browser drops a
// request midway (seeking in audio does it all the time), Node's adapter kept
// pushing data into the closed stream and threw an uncaught "Controller is
// already closed" (seen 2026-11-26 in the frontend log). Here the file read
// stops the moment the response is cancelled.
export function toWebStream(stream: Readable): ReadableStream<Uint8Array> {
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer) => {
        if (done) return;
        try {
          controller.enqueue(chunk);
        } catch {
          done = true;
          stream.destroy();
          return;
        }
        if ((controller.desiredSize ?? 1) <= 0) stream.pause();
      });
      stream.on("end", () => {
        if (done) return;
        done = true;
        try {
          controller.close();
        } catch {}
      });
      stream.on("error", (err) => {
        if (done) return;
        done = true;
        try {
          controller.error(err);
        } catch {}
      });
    },
    pull() {
      stream.resume();
    },
    cancel() {
      done = true;
      stream.destroy();
    },
  });
}
