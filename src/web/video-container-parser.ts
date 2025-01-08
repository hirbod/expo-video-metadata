// video-container-parser.ts
import type { ParsedVideoMetadata, VideoContainer } from '../ExpoVideoMetadata.types'
import { AVIParser } from './avi-parser'
import { MOVParser } from './mov-parser'
import { MP4Parser } from './mp4-parser'
import { TSParser } from './ts/ts-parser'
import { WebMParser } from './webm-parser'

/**
 * Main parser class that detects and handles different video container formats
 * Supports MP4, MOV, WebM, MKV, AVI, and TS containers
 */
export class VideoContainerParser {
  /**
   * Magic bytes/signatures used to identify container formats
   * Each format starts with specific byte sequences:
   * - MP4: 'ftyp' marker indicates ISO base media file
   * - WEBM/MKV: EBML header marker (both use same signature)
   * - MOV: 'moov' atom marker for QuickTime format
   * - AVI: 'RIFF' marker for Audio Video Interleave
   * - TS: Transport Stream sync byte (0x47) followed by specific bits
   */
  private static readonly SIGNATURES = {
    MP4: [0x66, 0x74, 0x79, 0x70], // ftyp
    WEBM: [0x1a, 0x45, 0xdf, 0xa3], // EBML
    MKV: [0x1a, 0x45, 0xdf, 0xa3], // Same as WEBM, differentiated by DocType
    MOV: [0x6d, 0x6f, 0x6f, 0x76], // moov
    AVI: [0x52, 0x49, 0x46, 0x46], // RIFF
    TS: [0x47], // TS sync byte
  }

  /**
   * Parse video container and extract metadata
   * Process:
   * 1. Read first 32 bytes to detect container type
   * 2. Read entire file into memory
   * 3. Route to appropriate parser based on container
   * 4. Extract and return standardized metadata
   *
   * Note: WebM and MKV share the same signature but are differentiated
   * by their DocType in the EBML header. The WebM parser handles both.
   */
  static async parseContainer(file: File | Blob): Promise<ParsedVideoMetadata> {
    // For TS files we need at least 188 * 3 bytes to check multiple sync packets
    // For other formats 32 bytes is enough
    const headerSize = 188 * 3
    const headerBuffer = await file.slice(0, headerSize).arrayBuffer()
    const headerBytes = new Uint8Array(headerBuffer)
    const container = VideoContainerParser.detectContainer(headerBytes)

    // If we don't support this container type, fail fast before reading the whole file
    if (container === 'unknown') {
      throw new Error('Unsupported container format')
    }

    // Read the entire file
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)

    try {
      console.debug('Parsing container:', container)
      switch (container) {
        case 'mp4':
          return await new MP4Parser(bytes).parse()
        case 'mov':
          return await new MOVParser(bytes).parse()
        // WebM/MKV share same signature, differentiated by DocType
        case 'webm':
          return await new WebMParser(bytes).parse()
        case 'ts':
          return await new TSParser(bytes).parse()
        case 'avi':
          return await new AVIParser(bytes).parse()
        default:
          throw new Error('Unsupported container format')
      }
    } catch (error) {
      console.error(`Error parsing ${container} container:`, error)
      throw new Error(`Failed to parse ${container} container: ${error.message}`)
    }
  }

  /**
   * Detect container format from file signature
   */
  private static detectContainer(bytes: Uint8Array): VideoContainer {
    // Check for TS first as it has a different pattern
    if (VideoContainerParser.isTransportStream(bytes)) {
      console.debug('Detected TS container')
      return 'ts'
    }

    // First check for QuickTime specific atoms in the first 32 bytes
    for (let offset = 0; offset < bytes.length - 8; offset++) {
      const atomType = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8))

      // QuickTime specific atoms that indicate a MOV file
      // 'qt  ' and 'QT  ' use spaces (0x20) as padding
      if (['mvhd', 'moov', 'qt  '].includes(atomType)) {
        console.debug('Found QuickTime atom:', atomType)
        return 'mov'
      }

      // Check for ftyp
      if (atomType === 'ftyp') {
        // Look at major brand and compatible brands
        const brandOffset = offset + 8
        if (brandOffset + 4 <= bytes.length) {
          const majorBrand = new TextDecoder().decode(bytes.slice(brandOffset, brandOffset + 4))
          console.debug('Found major brand:', majorBrand)

          // QuickTime major brands - must be exactly 4 bytes
          // 'qt  ' and 'QT  ' use spaces (0x20) as padding
          if (['qt  ', 'moov', 'QT  '].includes(majorBrand)) {
            return 'mov'
          }

          // Check compatible brands if we have enough bytes
          if (brandOffset + 16 <= bytes.length) {
            const compatibleBrand = new TextDecoder().decode(
              bytes.slice(brandOffset + 4, brandOffset + 8)
            )
            console.debug('Found compatible brand:', compatibleBrand)
            if (['qt  ', 'moov', 'QT  '].includes(compatibleBrand)) {
              return 'mov'
            }
          }

          return 'mp4'
        }
      }

      if (VideoContainerParser.matchSignature(bytes, offset, VideoContainerParser.SIGNATURES.AVI)) {
        return 'avi'
      }
    }

    // Check for WEBM/MKV (they share the same signature)
    if (VideoContainerParser.matchSignature(bytes, 0, VideoContainerParser.SIGNATURES.WEBM)) {
      return VideoContainerParser.isMatroska(bytes) ? 'mkv' : 'webm'
    }

    return 'unknown'
  }

  /**
   * Check if file is a Transport Stream
   */
  private static isTransportStream(bytes: Uint8Array): boolean {
    // Check for TS sync byte (0x47) at regular 188-byte intervals
    // Check first few packets to increase confidence
    const packetSize = 188

    // First check if we have enough data
    if (bytes.length < packetSize) {
      console.debug('Not enough data for TS detection, length:', bytes.length)
      return false
    }

    // Log first few bytes for debugging
    console.debug(
      'First bytes:',
      Array.from(bytes.slice(0, 5)).map((b) => '0x' + b.toString(16))
    )

    for (let i = 0; i < 5; i++) {
      const offset = i * packetSize
      if (offset >= bytes.length) {
        console.debug('Reached end of buffer at offset:', offset)
        break
      }
      const syncByte = bytes[offset]
      console.debug(`Checking sync byte at offset ${offset}:`, '0x' + syncByte.toString(16))
      if (syncByte !== 0x47) {
        console.debug('Invalid sync byte at offset:', offset)
        return false
      }
    }
    return true
  }

  /**
   * Check if EBML container is Matroska
   */
  private static isMatroska(bytes: Uint8Array): boolean {
    // Skip EBML header and look for DocType
    let offset = 4
    while (offset < bytes.length - 8) {
      if (bytes[offset] === 0x42 && bytes[offset + 1] === 0x82) {
        // Found DocType element, check if it's 'matroska'
        const docType = new TextDecoder().decode(bytes.slice(offset + 2, offset + 10))
        return docType.includes('matroska')
      }
      offset++
    }
    return false
  }

  /**
   * Match signature pattern at offset
   */
  private static matchSignature(bytes: Uint8Array, offset: number, signature: number[]): boolean {
    return signature.every((byte, i) => bytes[offset + i] === byte)
  }

  /**
   * Utility method to check if format is supported
   */
  static isFormatSupported(file: File): boolean {
    const extension = file.name.split('.').pop()?.toLowerCase()
    return ['mp4', 'webm', 'mov', 'mkv', 'avi', 'ts'].includes(extension || '')
  }

  /**
   * Get metadata from file
   */
  static async getMetadataFromFile(file: File) {
    return VideoContainerParser.parseContainer(file)
  }

  /**
   * Get metadata from URL
   */
  static async getMetadataFromUrl(url: string) {
    const response = await fetch(url)
    const blob = await response.blob()
    return VideoContainerParser.parseContainer(blob)
  }
}
