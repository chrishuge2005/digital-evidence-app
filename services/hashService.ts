import * as FileSystem from 'expo-file-system/legacy';
import { sha256 } from 'js-sha256';

// Optimized Base64 lookup table for rapid binary decoding
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const lookup = new Uint8Array(256);
for (let i = 0; i < chars.length; i++) {
  lookup[chars.charCodeAt(i)] = i;
}

/**
 * Decodes a base64 string directly into a Uint8Array.
 * This prevents memory bloat compared to standard JS string mapping.
 */
function decodeBase64Chunk(base64: string): Uint8Array {
  let bufferLength = base64.length * 0.75;
  if (base64[base64.length - 1] === '=') bufferLength--;
  if (base64[base64.length - 2] === '=') bufferLength--;

  const bytes = new Uint8Array(bufferLength);
  let p = 0;
  for (let i = 0; i < base64.length; i += 4) {
    const encoded1 = lookup[base64.charCodeAt(i)];
    const encoded2 = lookup[base64.charCodeAt(i + 1)];
    const encoded3 = lookup[base64.charCodeAt(i + 2)];
    const encoded4 = lookup[base64.charCodeAt(i + 3)];

    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    if (encoded3 !== undefined && encoded3 !== 64) {
      bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    }
    if (encoded4 !== undefined && encoded4 !== 64) {
      bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
    }
  }
  return bytes;
}

export const hashService = {
  /**
   * Calculates the SHA-256 hash of a local file.
   * Reads the file in 1MB chunks to prevent Out-Of-Memory (OOM) crashes on large videos.
   */
  async calculateSha256(fileUri: string): Promise<string> {
    const info = await FileSystem.getInfoAsync(fileUri);
    if (!info.exists) {
      throw new Error("File does not exist at the specified URI.");
    }
    if (info.isDirectory) {
      throw new Error("URI points to a directory, not a file.");
    }

    const fileSize = info.size || 0;
    const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
    const hash = sha256.create();

    let position = 0;
    while (position < fileSize) {
      const length = Math.min(CHUNK_SIZE, fileSize - position);
      
      const base64Chunk = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
        position,
        length
      });

      const bytes = decodeBase64Chunk(base64Chunk);
      hash.update(bytes);
      
      position += length;
    }

    const finalHash = hash.hex().toLowerCase();
    
    // Strict verification of the output
    if (finalHash.length !== 64 || !/^[a-f0-9]+$/.test(finalHash)) {
      throw new Error("Hash generation yielded an invalid format.");
    }

    return finalHash;
  }
};