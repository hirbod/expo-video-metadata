import type { BinaryReaderImpl } from '../../binary-reader'

/**
 * Information about an audio stream including codec, sample rate, channels, and bitrate
 */
export interface AudioStreamInfo {
  hasAudio: boolean
  audioChannels: number
  audioSampleRate: number
  audioCodec: string
  audioBitrate: number // in kbps
}

/**
 * Standard audio stream type identifiers in MPEG-TS
 * Values are defined by ISO/IEC 13818-1
 */
export const AUDIO_STREAM_TYPES = {
  MPEG1_AUDIO: 0x03,
  MPEG2_AUDIO: 0x04,
  AAC: 0x0f, // AAC ADTS
  AAC_LATM: 0x11, // AAC with LATM transport syntax
} as const

// Export the type for use in other files
export type AudioStreamType = (typeof AUDIO_STREAM_TYPES)[keyof typeof AUDIO_STREAM_TYPES]

/**
 * Finds and extracts audio PES packets from a transport stream
 * @param reader - Binary reader containing the transport stream data
 * @param audioPid - PID of the audio stream to extract
 * @param streamType - Type of audio stream (MPEG1, MPEG2, AAC, etc.)
 * @returns Array of extracted PES packet payloads
 */
export function findAudioPackets(
  reader: BinaryReaderImpl,
  audioPid: number,
  streamType: number
): Uint8Array[] {
  const packets: Uint8Array[] = []
  let offset = 0
  let currentPESLength = 0
  const maxPacketsToSearch = 100 // Limit search to avoid processing entire file
  let packetCount = 0

  // Pre-allocate buffer for efficiency (16KB is typically enough for audio PES)
  const maxPESSize = 16384
  const pesBuffer = new Uint8Array(maxPESSize)

  while (offset + 188 <= reader.length && packetCount < maxPacketsToSearch) {
    const packetStart = offset
    // 0x47 is the MPEG-TS sync byte
    const syncByte = reader.data[offset]

    if (syncByte !== 0x47) {
      offset += 188 // Standard TS packet size
      continue
    }

    // Extract 13-bit PID from header
    const pidHigh = reader.data[offset + 1]
    const pidLow = reader.data[offset + 2]
    const packetPid = ((pidHigh & 0x1f) << 8) | pidLow

    if (packetPid !== audioPid) {
      offset += 188
      continue
    }

    // Parse transport stream header flags
    const flags = reader.data[offset + 3]
    const hasPayload = (flags & 0x10) !== 0 // Payload present flag
    const adaptationField = (flags & 0x20) !== 0 // Adaptation field present
    const payloadUnitStart = (flags & 0x40) !== 0 // Payload unit start indicator

    if (!hasPayload) {
      offset += 188
      continue
    }

    // Calculate payload start position
    let payloadOffset = offset + 4 // Skip TS header
    if (adaptationField) {
      const adaptationLength = reader.data[payloadOffset]
      payloadOffset += adaptationLength > 0 ? adaptationLength + 1 : 1
    }

    if (payloadUnitStart) {
      // Save previous PES packet if we have one
      if (currentPESLength > 0) {
        packets.push(pesBuffer.slice(0, currentPESLength))
        packetCount++
      }

      // Reset for new PES packet
      currentPESLength = 0

      // Skip PES header (9 bytes + optional header length)
      const pesHeaderLength = reader.data[payloadOffset + 8]
      payloadOffset += 9 + pesHeaderLength
    }

    // Copy payload to buffer
    const payloadEnd = packetStart + 188
    const payloadLength = payloadEnd - payloadOffset
    if (payloadLength > 0 && currentPESLength + payloadLength <= maxPESSize) {
      pesBuffer.set(reader.data.subarray(payloadOffset, payloadEnd), currentPESLength)
      currentPESLength += payloadLength
    }

    offset += 188
  }

  // Add the last PES packet if we have one
  if (currentPESLength > 0) {
    packets.push(pesBuffer.slice(0, currentPESLength))
  }

  return packets
}

/**
 * Parses MPEG-1/2 Audio (MP3) header to extract audio properties
 * Header format is defined in ISO/IEC 11172-3 and ISO/IEC 13818-3
 * @param data - Buffer containing MPEG audio frames
 */
export function parseMPEGAudioHeader(data: Uint8Array): AudioStreamInfo | null {
  // Look for MPEG sync word (11 bits set to 1)
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] === 0xff && (data[i + 1] & 0xe0) === 0xe0) {
      const header = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]

      // Extract header fields
      const version = (header >> 19) & 3 // 00=V2.5, 01=reserved, 10=V2, 11=V1
      const layer = (header >> 17) & 3 // 00=reserved, 01=III, 10=II, 11=I
      const bitrateIndex = (header >> 12) & 0xf
      const samplingIndex = (header >> 10) & 3
      const channelMode = (header >> 6) & 3 // 00=Stereo, 01=Joint, 10=Dual, 11=Mono

      // Sample rates table [MPEG2.5, reserved, MPEG2, MPEG1]
      const sampleRates = [
        [11025, 12000, 8000], // MPEG 2.5
        [0, 0, 0], // Reserved
        [22050, 24000, 16000], // MPEG 2
        [44100, 48000, 32000], // MPEG 1
      ]

      // Bitrate table (kbps)
      // [version][layer][bitrate_index]
      const bitrates = [
        // MPEG Version 2.5
        [
          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // Reserved
          [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // Layer 3
          [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // Layer 2
          [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], // Layer 1
        ],
        // Reserved
        [
          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ],
        // MPEG Version 2
        [
          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // Reserved
          [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // Layer 3
          [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // Layer 2
          [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], // Layer 1
        ],
        // MPEG Version 1
        [
          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // Reserved
          [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // Layer 3
          [0, 32, 48, 56, 64, 96, 112, 128, 160, 192, 224, 256, 320, 384, 384], // Layer 2
          [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // Layer 1
        ],
      ]

      const sampleRate = sampleRates[version][samplingIndex] || 44100
      const channels = channelMode === 3 ? 1 : 2

      // Layer is stored as 0=Reserved, 1=Layer3, 2=Layer2, 3=Layer1
      // But our table is indexed as 0=Reserved, 1=Layer3, 2=Layer2, 3=Layer1
      // So we can use layer directly
      const bitrate =
        layer > 0 && bitrateIndex < 15 ? bitrates[version][layer][bitrateIndex] * 1000 : 0

      console.debug('Found MPEG audio header:', {
        version,
        layer,
        bitrateIndex,
        samplingIndex,
        channelMode,
        sampleRate,
        channels,
        bitrate,
      })

      return {
        hasAudio: true,
        audioChannels: channels,
        audioSampleRate: sampleRate,
        audioCodec: layer === 2 ? 'mp2' : 'mp3',
        audioBitrate: bitrate,
      }
    }
  }
  console.debug('No MPEG audio header found in data')
  return null
}

/**
 * Parses AAC ADTS header to extract audio properties
 * Header format is defined in ISO/IEC 13818-7 (MPEG-2 AAC) and ISO/IEC 14496-3 (MPEG-4 AAC)
 * @param data - Buffer containing AAC ADTS frames
 */
export function parseAACHeader(data: Uint8Array): AudioStreamInfo | null {
  // Look for ADTS sync word (12 bits: all 1s)
  for (let i = 0; i < data.length - 7; i++) {
    if (data[i] === 0xff && (data[i + 1] & 0xf0) === 0xf0) {
      // Parse header fields according to ADTS specification
      const id = (data[i + 1] & 0x08) >> 3 // 0=MPEG-4, 1=MPEG-2
      const profile = ((data[i + 2] & 0xc0) >> 6) + 1 // Add 1 as spec defines 0=Main, 1=LC
      const sampleRateIndex = (data[i + 2] & 0x3c) >> 2 // Sample rate lookup index
      const channelConfig =
        ((data[i + 2] & 0x1) << 2) | // Channel configuration
        ((data[i + 3] & 0xc0) >> 6) // (3=stereo, 1=mono, etc.)

      // Frame length is 13 bits, spread across 3 bytes
      const frameLength =
        ((data[i + 3] & 0x03) << 11) | (data[i + 4] << 3) | ((data[i + 5] & 0xe0) >> 5)

      // Standard AAC sample rates (in Hz)
      const sampleRates = [
        96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000,
      ]

      if (sampleRateIndex >= sampleRates.length) {
        console.debug('Invalid sample rate index:', sampleRateIndex)
        continue
      }

      // HE-AAC detection logic:
      // 1. Must be AAC-LC (profile=2)
      // 2. Base sample rate should be half of target rate
      // Example: 22050 Hz base rate indicates 44100 Hz with SBR
      let sampleRate = sampleRates[sampleRateIndex]
      const isHEAAC = profile === 2 && sampleRate <= 24000

      if (isHEAAC) {
        sampleRate *= 2 // SBR doubles the sample rate
      }

      // Calculate bitrate by analyzing multiple frames
      let totalLength = 0
      let frameCount = 0
      let pos = i
      const maxFrames = 5 // Use up to 5 frames for average bitrate

      while (frameCount < maxFrames && pos < data.length - 7) {
        if (data[pos] === 0xff && (data[pos + 1] & 0xf0) === 0xf0) {
          // Verify frame consistency
          const nextProfile = ((data[pos + 2] & 0xc0) >> 6) + 1
          const nextSRIndex = (data[pos + 2] & 0x3c) >> 2
          if (nextProfile !== profile || nextSRIndex !== sampleRateIndex) {
            break
          }

          const len =
            ((data[pos + 3] & 0x03) << 11) | (data[pos + 4] << 3) | ((data[pos + 5] & 0xe0) >> 5)
          if (len <= 0) break

          totalLength += len
          frameCount++
          pos += len
        } else {
          break
        }
      }

      // AAC uses 1024 samples per frame (2048 for HE-AAC, but bitrate calculation remains the same)
      const samplesPerFrame = 1024
      const bitrate = Math.round((totalLength * 8 * sampleRate) / (frameCount * samplesPerFrame))

      // Standard AAC bitrates (in bits/second)
      const commonBitrates = [
        32000, 48000, 56000, 64000, 96000, 128000, 160000, 192000, 224000, 256000, 320000,
      ]

      // Find closest standard bitrate
      let roundedBitrate = commonBitrates[0]
      let minDiff = Math.abs(bitrate - commonBitrates[0])

      for (const commonBitrate of commonBitrates) {
        const diff = Math.abs(bitrate - commonBitrate)
        if (diff < minDiff || (diff === minDiff && commonBitrate < roundedBitrate)) {
          minDiff = diff
          roundedBitrate = commonBitrate
        }
      }

      console.debug('Found AAC ADTS header:', {
        id,
        profile,
        sampleRateIndex,
        channelConfig,
        frameLength,
        sampleRate,
        isHEAAC,
        calculatedBitrate: bitrate,
        roundedBitrate,
        frameCount,
        totalLength,
      })

      return {
        hasAudio: true,
        audioChannels: channelConfig,
        audioSampleRate: sampleRate,
        audioCodec: isHEAAC ? 'aac_he' : 'aac',
        audioBitrate: roundedBitrate,
      }
    }
  }
  console.debug('No AAC ADTS header found in data')
  return null
}

/**
 * Main audio stream parser that handles different audio formats
 * Supports MPEG-1/2 Audio, AAC ADTS, and AAC LATM
 * @param reader - Binary reader containing the transport stream data
 * @param elementaryPid - PID of the audio elementary stream
 * @param streamType - Type of audio stream (from AUDIO_STREAM_TYPES)
 * @returns Audio stream information including codec, sample rate, channels, and bitrate
 */
export function parseAudioStream(
  reader: BinaryReaderImpl,
  elementaryPid: number,
  streamType: number
): AudioStreamInfo {
  try {
    console.debug('Attempting to parse audio stream:', {
      pid: `0x${elementaryPid.toString(16)}`,
      streamType: `0x${streamType.toString(16)}`,
    })

    const packets = findAudioPackets(reader, elementaryPid, streamType)
    console.debug('Found audio packets:', {
      count: packets.length,
      firstPacketSize: packets[0]?.length,
      totalSize: packets.reduce((sum, p) => sum + p.length, 0),
    })

    if (packets.length === 0) {
      console.debug('No audio packets found')
      throw new Error('No audio packets found')
    }

    // Concatenate packets to ensure we have enough data for header parsing
    const data = new Uint8Array(packets.reduce((sum, p) => sum + p.length, 0))
    let offset = 0
    for (const packet of packets) {
      data.set(packet, offset)
      offset += packet.length
    }

    let info: AudioStreamInfo | null = null

    // Parse based on stream type defined in AUDIO_STREAM_TYPES
    switch (streamType) {
      case AUDIO_STREAM_TYPES.MPEG1_AUDIO:
      case AUDIO_STREAM_TYPES.MPEG2_AUDIO:
        console.debug('Attempting to parse MPEG audio header')
        info = parseMPEGAudioHeader(data)
        break
      case AUDIO_STREAM_TYPES.AAC:
        console.debug('Attempting to parse AAC ADTS header')
        info = parseAACHeader(data)
        break
      case AUDIO_STREAM_TYPES.AAC_LATM:
        console.debug('Using default values for AAC LATM')
        // LATM/LOAS parsing would require additional implementation
        // Default to common values for now
        info = {
          hasAudio: true,
          audioChannels: 2,
          audioSampleRate: 48000,
          audioCodec: 'aac',
          audioBitrate: 128000,
        }
        break
    }

    if (info) {
      console.debug('Successfully parsed audio info:', info)
      return info
    }
    console.debug('Failed to parse audio header')
  } catch (error) {
    console.debug('Error parsing audio stream:', error)
  }

  // Return default values if parsing fails
  return {
    hasAudio: false,
    audioChannels: 0,
    audioSampleRate: 0,
    audioCodec: '',
    audioBitrate: 0,
  }
}
