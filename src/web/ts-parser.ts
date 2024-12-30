// ts-parser.ts
import { BinaryReaderImpl } from './binary-reader';
import type { VideoTrackMetadata, ParsedVideoMetadata, VideoColorInfo } from '../ExpoVideoMetadata.types';

export class TSParser {
  private reader: BinaryReaderImpl;
  private static readonly PACKET_SIZE = 188;
  private static readonly SYNC_BYTE = 0x47;

  // Stream types
  private static readonly STREAM_TYPES = {
    VIDEO_MPEG1: 0x01,
    VIDEO_MPEG2: 0x02,
    VIDEO_MPEG4: 0x10,
    VIDEO_H264: 0x1B,
    VIDEO_HEVC: 0x24,
    PRIVATE_DATA: 0x06
  };

  // PSI (Program Specific Information) tables
  private static readonly PSI_TABLES = {
    PAT: 0x00, // Program Association Table
    PMT: 0x02, // Program Map Table
    SDT: 0x11  // Service Description Table
  };

  constructor(data: Uint8Array) {
    this.reader = new BinaryReaderImpl(data);
  }

  async parse(): Promise<ParsedVideoMetadata> {
    // Verify TS sync byte
    if (!this.verifyTSSync()) {
      throw new Error('Not a valid Transport Stream');
    }

    const programInfo = await this.parsePAT();
    if (!programInfo.pmtPid) {
      throw new Error('No PMT PID found');
    }

    const streamInfo = await this.parsePMT(programInfo.pmtPid);
    const metadata = await this.parseVideoStream(streamInfo);

    return {
      ...metadata,
      container: 'ts'
    };
  }

  private verifyTSSync(): boolean {
    // Check first few packets for sync byte
    for (let i = 0; i < 5; i++) {
      const pos = i * TSParser.PACKET_SIZE;
      if (pos >= this.reader.length) break;

      const syncByte = this.reader.data[pos];
      if (syncByte !== TSParser.SYNC_BYTE) {
        return false;
      }
    }
    return true;
  }

  private async parsePAT(): Promise<{ pmtPid: number | null }> {
    let pmtPid: number | null = null;
    const packets = this.findPSIPackets(TSParser.PSI_TABLES.PAT);

    for (const packet of packets) {
      // Parse PAT section
      const tableId = packet[0];
      if (tableId !== TSParser.PSI_TABLES.PAT) continue;

      const sectionLength = ((packet[1] & 0x0F) << 8) | packet[2];
      const programCount = Math.floor((sectionLength - 9) / 4);

      for (let i = 0; i < programCount; i++) {
        const offset = 8 + (i * 4);
        const programNumber = (packet[offset] << 8) | packet[offset + 1];
        const pid = ((packet[offset + 2] & 0x1F) << 8) | packet[offset + 3];

        if (programNumber !== 0) {
          pmtPid = pid;
          break;
        }
      }
    }

    return { pmtPid };
  }

  private async parsePMT(pmtPid: number): Promise<{
    videoPid: number;
    videoStreamType: number;
  } | null> {
    const packets = this.findPSIPackets(TSParser.PSI_TABLES.PMT, pmtPid);

    for (const packet of packets) {
      const tableId = packet[0];
      if (tableId !== TSParser.PSI_TABLES.PMT) continue;

      const sectionLength = ((packet[1] & 0x0F) << 8) | packet[2];
      const programInfoLength = ((packet[10] & 0x0F) << 8) | packet[11];
      let offset = 12 + programInfoLength;

      while (offset < sectionLength - 4) {
        const streamType = packet[offset];
        const elementaryPid = ((packet[offset + 1] & 0x1F) << 8) | packet[offset + 2];
        const esInfoLength = ((packet[offset + 3] & 0x0F) << 8) | packet[offset + 4];

        if (this.isVideoStream(streamType)) {
          return {
            videoPid: elementaryPid,
            videoStreamType: streamType
          };
        }

        offset += 5 + esInfoLength;
      }
    }

    return null;
  }

  private isVideoStream(streamType: number): boolean {
    return [
      TSParser.STREAM_TYPES.VIDEO_MPEG1,
      TSParser.STREAM_TYPES.VIDEO_MPEG2,
      TSParser.STREAM_TYPES.VIDEO_MPEG4,
      TSParser.STREAM_TYPES.VIDEO_H264,
      TSParser.STREAM_TYPES.VIDEO_HEVC
    ].includes(streamType);
  }

  private findPSIPackets(tableId: number, pid?: number): Uint8Array[] {
    const packets: Uint8Array[] = [];
    let offset = 0;

    while (offset + TSParser.PACKET_SIZE <= this.reader.length) {
      const packetStart = offset;
      const syncByte = this.reader.data[offset++];

      if (syncByte !== TSParser.SYNC_BYTE) {
        offset = packetStart + TSParser.PACKET_SIZE;
        continue;
      }

      const pidHigh = this.reader.data[offset++];
      const pidLow = this.reader.data[offset++];
      const packetPid = ((pidHigh & 0x1F) << 8) | pidLow;

      if (pid !== undefined && packetPid !== pid) {
        offset = packetStart + TSParser.PACKET_SIZE;
        continue;
      }

      const flags = this.reader.data[offset++];
      const hasPayload = (flags & 0x10) !== 0;
      const adaptationField = (flags & 0x20) !== 0;

      if (!hasPayload) {
        offset = packetStart + TSParser.PACKET_SIZE;
        continue;
      }

      let adaptationLength = 0;
      if (adaptationField) {
        adaptationLength = this.reader.data[offset++] + 1;
      }

      const payloadStart = offset + adaptationLength;
      const payloadLength = TSParser.PACKET_SIZE - (payloadStart - packetStart);

      if (payloadLength > 0) {
        const payload = this.reader.data.slice(payloadStart, payloadStart + payloadLength);
        if (payload[0] === tableId) {
          packets.push(payload);
        }
      }

      offset = packetStart + TSParser.PACKET_SIZE;
    }

    return packets;
  }

  private async parseVideoStream(streamInfo: { videoPid: number; videoStreamType: number } | null): Promise<VideoTrackMetadata> {
    if (!streamInfo) {
      throw new Error('No video stream found');
    }

    // Parse video elementary stream for H.264/HEVC specific data
    const videoPackets = this.findVideoPackets(streamInfo.videoPid);
    const nalUnits = this.parseNALUnits(videoPackets);
    const sps = this.findSPS(nalUnits, streamInfo.videoStreamType);

    if (!sps) {
      // Return basic metadata if can't parse SPS
      return {
        width: 0,
        height: 0,
        rotation: 0,
        displayAspectWidth: 0,
        displayAspectHeight: 0,
        codec: this.streamTypeToCodec(streamInfo.videoStreamType),
        colorInfo: this.getDefaultColorInfo()
      };
    }

    // Parse SPS for resolution and other metadata
    const metadata = await this.parseSPS(sps, streamInfo.videoStreamType);
    return {
      ...metadata,
      codec: this.streamTypeToCodec(streamInfo.videoStreamType)
    };
  }

  private findVideoPackets(videoPid: number): Uint8Array[] {
    return this.findPSIPackets(0xFF, videoPid); // 0xFF is not a real table ID
  }

  private parseNALUnits(packets: Uint8Array[]): Uint8Array[] {
    const nalUnits: Uint8Array[] = [];
    let currentNAL: number[] = [];

    for (const packet of packets) {
      for (let i = 0; i < packet.length - 3; i++) {
        if (packet[i] === 0 && packet[i + 1] === 0 && packet[i + 2] === 1) {
          if (currentNAL.length > 0) {
            nalUnits.push(new Uint8Array(currentNAL));
            currentNAL = [];
          }
          i += 2;
          continue;
        }
        currentNAL.push(packet[i]);
      }
    }

    if (currentNAL.length > 0) {
      nalUnits.push(new Uint8Array(currentNAL));
    }

    return nalUnits;
  }

  private findSPS(nalUnits: Uint8Array[], streamType: number): Uint8Array | null {
    const spsNalType = streamType === TSParser.STREAM_TYPES.VIDEO_HEVC ? 33 : 7;
    return nalUnits.find(nal => (nal[0] & 0x1F) === spsNalType) || null;
  }

  private parseSPS(sps: Uint8Array, streamType: number) {
    // Basic implementation - would need more complex parsing for full SPS
    return {
      width: 1920, // Default values
      height: 1080,
      rotation: 0,
      displayAspectWidth: 1920,
      displayAspectHeight: 1080,
      colorInfo: this.getDefaultColorInfo()
    };
  }

  private streamTypeToCodec(streamType: number): string {
    switch (streamType) {
      case TSParser.STREAM_TYPES.VIDEO_H264:
        return 'avc1';
      case TSParser.STREAM_TYPES.VIDEO_HEVC:
        return 'hev1';
      case TSParser.STREAM_TYPES.VIDEO_MPEG4:
        return 'mp4v';
      case TSParser.STREAM_TYPES.VIDEO_MPEG2:
        return 'mp2v';
      case TSParser.STREAM_TYPES.VIDEO_MPEG1:
        return 'mp1v';
      default:
        return 'unknown';
    }
  }

  private getDefaultColorInfo(): VideoColorInfo {
    return {
      matrixCoefficients: null,
      transferCharacteristics: null,
      primaries: null,
      fullRange: null
    };
  }
}