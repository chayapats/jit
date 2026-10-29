/**
 * Removes PNG/JPEG metadata and trailing bytes without decoding pixels. This download-only fallback is never
 * eligible for preview, model delivery or box copying. Malformed framing and oversized dimensions are refused.
 */
export function stripAttachmentMetadata(bytes: Uint8Array, mediaType: string, pixels: number): Uint8Array {
  const b = Buffer.from(bytes), kept: Buffer[] = [];
  const fail = (): never => { throw new Error("image_decode_failed"); };
  if (mediaType === "image/png") {
    if (!b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) fail();
    kept.push(b.subarray(0, 8)); let at = 8, header = false, data = false;
    while (at + 12 <= b.length) {
      const size = b.readUInt32BE(at), end = at + 12 + size, type = b.toString("ascii", at + 4, at + 8);
      if (end > b.length || !/^[A-Za-z]{4}$/.test(type)) fail();
      if (!header) {
        if (type !== "IHDR" || size !== 13) fail();
        const w = b.readUInt32BE(at + 8), h = b.readUInt32BE(at + 12);
        if (!w || !h || w * h > pixels) throw new Error("image_too_many_pixels");
        header = true;
      } else if (type === "IHDR") fail();
      if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(type)) kept.push(b.subarray(at, end));
      else if (type[0] === type[0]!.toUpperCase()) fail();
      if (type === "IDAT") data = true;
      if (type === "IEND") { if (size !== 0 || !data) fail(); return Buffer.concat(kept); }
      at = end;
    }
    return fail();
  }
  if (mediaType !== "image/jpeg" || b[0] !== 0xff || b[1] !== 0xd8) return fail();
  kept.push(b.subarray(0, 2)); let at = 2, frame = false, scan = false;
  while (at < b.length) {
    const start = at;
    if (b[at++] !== 0xff) fail();
    while (b[at] === 0xff) at++;
    const marker = b[at++]; if (marker === undefined) fail();
    if (marker === 0xd9) { if (!frame || !scan) fail(); kept.push(b.subarray(start, at)); return Buffer.concat(kept); }
    if (at + 2 > b.length) fail();
    const size = b.readUInt16BE(at), end = at + size;
    if (size < 2 || end > b.length) fail();
    const sof = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker!);
    if (sof) {
      if (size < 8) fail();
      const h = b.readUInt16BE(at + 3), w = b.readUInt16BE(at + 5);
      if (!w || !h || w * h > pixels) throw new Error("image_too_many_pixels");
      frame = true;
    }
    const app0 = marker === 0xe0 && b.subarray(at + 2, at + 7).equals(Buffer.from("JFIF\0"));
    const app14 = marker === 0xee && b.toString("ascii", at + 2, at + 7) === "Adobe";
    if (sof || [0xdb, 0xc4, 0xdd, 0xda].includes(marker!) || app0 || app14) kept.push(b.subarray(start, end));
    else if (!(marker! >= 0xe0 && marker! <= 0xef) && marker !== 0xfe) fail();
    at = end;
    if (marker === 0xda) {
      scan = true; const entropy = at;
      while (at < b.length) {
        if (b[at] !== 0xff) { at++; continue; }
        let next = at + 1; while (b[next] === 0xff) next++;
        if (b[next] === 0 || (b[next]! >= 0xd0 && b[next]! <= 0xd7)) { at = next + 1; continue; }
        break;
      }
      kept.push(b.subarray(entropy, at));
    }
  }
  return fail();
}
