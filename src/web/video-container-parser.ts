// video-container-parser.ts
import { MP4Parser } from './mp4-parser';
import { MOVParser } from './mov-parser';
import { WebMParser } from './webm-parser';
import { MKVParser } from './mkv-parser';
import { AVIParser } from './avi-parser';
import { TSParser } from './ts-parser';
import type { ParsedVideoMetadata, VideoContainer, VideoTrackMetadata } from '../ExpoVideoMetadata.types';

export class VideoContainerParser {
  // Signature patterns for different container formats
  private static readonly SIGNATURES = {
    MP4: [0x66, 0x74, 0x79, 0x70], // ftyp
    WEBM: [0x1A, 0x45, 0xDF, 0xA3], // EBML
    MOV: [0x6D, 0x6F, 0x6F, 0x76], // moov
    AVI: [0x52, 0x49, 0x46, 0x46], // RIFF
    MKV: [0x1A, 0x45, 0xDF, 0xA3], // Same as WEBM, differentiated by DocType
    TS: [0x47, 0x40, 0x00] // TS sync byte pattern
  };

  /**
   * Parse video container and extract metadata
   */
  static async parseContainer(file: File | Blob) : Promise<ParsedVideoMetadata> {
    // Read first 32 bytes for signature detection
    const headerBuffer = await file.slice(0, 32).arrayBuffer();
    const headerBytes = new Uint8Array(headerBuffer);
    const container = this.detectContainer(headerBytes);

    // Read the entire file
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    try {
      switch (container) {
        case 'mp4':
          return await new MP4Parser(bytes).parse();
        case 'mov':
          return await new MOVParser(bytes).parse();
        case 'webm':
          return await new WebMParser(bytes).parse();
        case 'mkv':
          return await new MKVParser(bytes).parse();
        case 'ts':
          return await new TSParser(bytes).parse();
        default:
          throw new Error('Unsupported container format');
      }
    } catch (error) {
      console.error(`Error parsing ${container} container:`, error);
      throw new Error(`Failed to parse ${container} container: ${error.message}`);
    }
  }

  /**
   * Detect container format from file signature
   */
  private static detectContainer(bytes: Uint8Array): VideoContainer {
    // Check for TS first as it has a different pattern
    if (this.isTransportStream(bytes)) {
      return 'ts';
    }

    // Check for other containers
    for (let offset = 0; offset < bytes.length - 8; offset++) {
      if (this.matchSignature(bytes, offset, this.SIGNATURES.MP4)) {
        return 'mp4';
      }
      if (this.matchSignature(bytes, offset, this.SIGNATURES.MOV)) {
        return 'mov';
      }
      if (this.matchSignature(bytes, offset, this.SIGNATURES.AVI)) {
        return 'avi';
      }
    }

    // Check for WEBM/MKV (they share the same signature)
    if (this.matchSignature(bytes, 0, this.SIGNATURES.WEBM)) {
      return this.isMatroska(bytes) ? 'mkv' : 'webm';
    }

    return 'unknown';
  }

  /**
   * Check if file is a Transport Stream
   */
  private static isTransportStream(bytes: Uint8Array): boolean {
    // Check for TS sync byte pattern
    return bytes[0] === 0x47 &&
           (bytes[188] === 0x47) &&
           (bytes[376] === 0x47);
  }

  /**
   * Check if EBML container is Matroska
   */
  private static isMatroska(bytes: Uint8Array): boolean {
    // Skip EBML header and look for DocType
    let offset = 4;
    while (offset < bytes.length - 8) {
      if (bytes[offset] === 0x42 && bytes[offset + 1] === 0x82) {
        // Found DocType element, check if it's 'matroska'
        const docType = new TextDecoder().decode(
          bytes.slice(offset + 2, offset + 10)
        );
        return docType.includes('matroska');
      }
      offset++;
    }
    return false;
  }

  /**
   * Match signature pattern at offset
   */
  private static matchSignature(bytes: Uint8Array, offset: number, signature: number[]): boolean {
    return signature.every((byte, i) => bytes[offset + i] === byte);
  }

  /**
   * Utility method to check if format is supported
   */
  static isFormatSupported(file: File): boolean {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return ['mp4', 'webm', 'mov', 'mkv', 'avi', 'ts'].includes(extension || '');
  }

  /**
   * Get metadata from file
   */
  static async getMetadataFromFile(file: File) {
    return this.parseContainer(file);
  }

  /**
   * Get metadata from URL
   */
  static async getMetadataFromUrl(url: string) {
    const response = await fetch(url);
    const blob = await response.blob();
    return this.parseContainer(blob);
  }
}