// ============================================================
// WA-Bridge — WebP helpers
//
// WhatsApp renders an animated WebP sticker as a STATIC image
// unless the outgoing stickerMessage carries `isAnimated: true`.
// The Baileys fork only computes that flag for sticker *packs*,
// so regular sendMessage({ sticker }) sends are never marked
// animated. This helper detects animation from the buffer so the
// dispatcher can set the flag centrally for every sticker send.
// ============================================================

/**
 * Detect whether a WebP buffer is animated by scanning for the VP8X
 * animation flag (bit 1) or ANIM/ANMF chunks. Mirrors the Baileys
 * fork's isAnimatedWebP so detection stays consistent.
 */
export function isAnimatedWebP(buffer: Buffer): boolean {
  // WebP must start with RIFF....WEBP
  if (
    buffer.length < 12 ||
    buffer[0] !== 0x52 ||
    buffer[1] !== 0x49 ||
    buffer[2] !== 0x46 ||
    buffer[3] !== 0x46 ||
    buffer[8] !== 0x57 ||
    buffer[9] !== 0x45 ||
    buffer[10] !== 0x42 ||
    buffer[11] !== 0x50
  ) {
    return false;
  }

  // Parse chunks starting after the RIFF header (12 bytes)
  let offset = 12;
  while (offset < buffer.length - 8) {
    const chunkFourCC = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkFourCC === 'VP8X') {
      // VP8X extended header — animation flag is bit 1 at offset+8
      const flagsOffset = offset + 8;
      if (flagsOffset < buffer.length) {
        const flags = buffer[flagsOffset];
        if (flags & 0x02) return true;
      }
    } else if (chunkFourCC === 'ANIM' || chunkFourCC === 'ANMF') {
      // ANIM or ANMF chunks indicate animation
      return true;
    }
    // Move to next chunk (chunk size + 8 bytes header, padded to even)
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return false;
}
