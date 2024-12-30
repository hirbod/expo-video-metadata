// mp4-parser.ts
import { BinaryReaderImpl } from './binary-reader';
import { HdrDetector } from './hdr-detector';
import { FpsDetector } from './fps-detector';
import type { MP4Box, VideoTrackMetadata, ParsedVideoMetadata, VideoColorInfo } from '../ExpoVideoMetadata.types';

export class MP4Parser {
  protected reader: BinaryReaderImpl;
  protected boxes: MP4Box[] = [];

  constructor(data: Uint8Array) {
    this.reader = new BinaryReaderImpl(data);
  }

  public async parse(): Promise<ParsedVideoMetadata> {
    try {
      await this.readBoxes();

      const moov = this.boxes.find(box => box.type === 'moov');
      if (!moov) {
        throw new Error('No moov box found');
      }

      const moovBoxes = await this.parseBoxes(moov.data!);
      const trak = await this.findVideoTrack(moovBoxes);
      if (!trak) {
        throw new Error('No video track found');
      }

      const metadata = await this.parseVideoTrack(trak);
      return {
        ...metadata,
        container: 'mp4'
      };
    } catch (error) {
      console.error('Error parsing MP4:', error);
      throw error;
    }
  }

  protected async readBoxes(): Promise<void> {
    this.boxes = [];
    let offset = 0;
    const data = this.reader.data;

    while (offset < data.length) {
      if (data.length - offset < 8) break;

      const size =
        (data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3];

      const type = new TextDecoder().decode(data.slice(offset + 4, offset + 8));

      let boxSize = size;
      let headerSize = 8;

      if (size === 1) {
        if (data.length - offset < 16) break;

        const highBits =
          (data[offset + 8] << 24) |
          (data[offset + 9] << 16) |
          (data[offset + 10] << 8) |
          data[offset + 11];

        const lowBits =
          (data[offset + 12] << 24) |
          (data[offset + 13] << 16) |
          (data[offset + 14] << 8) |
          data[offset + 15];

        boxSize = (highBits * Math.pow(2, 32)) + lowBits;
        headerSize = 16;
      } else if (size === 0) {
        boxSize = data.length - offset;
      }

      if (boxSize < headerSize || offset + boxSize > data.length) {
        break;
      }

      this.boxes.push({
        type,
        size: boxSize,
        start: offset,
        end: offset + boxSize,
        data: data.subarray(offset + headerSize, offset + boxSize)
      });

      offset += boxSize;
    }
  }

protected async parseBoxes(data: Uint8Array): Promise<MP4Box[]> {
  const boxes: MP4Box[] = [];
  let offset = 0;

  while (offset < data.length) {
    if (data.length - offset < 8) break;

    const size =
      (data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3];

    if (size <= 0 || size > data.length - offset) break;

    const type = new TextDecoder().decode(data.slice(offset + 4, offset + 8));
    console.debug('Parsing box:', { type, size, offset });

    let boxSize = size;
    let headerSize = 8;

    if (type === 'stsd') {
      headerSize = 16;
    }
    else if (type === 'avc1') {
      headerSize = 86;
    }

    if (size === 1) {
      if (data.length - offset < 16) break;

      const highBits =
        (data[offset + 8] << 24) |
        (data[offset + 9] << 16) |
        (data[offset + 10] << 8) |
        data[offset + 11];

      const lowBits =
        (data[offset + 12] << 24) |
        (data[offset + 13] << 16) |
        (data[offset + 14] << 8) |
        data[offset + 15];

      boxSize = (highBits * Math.pow(2, 32)) + lowBits;
      headerSize = 16;
    }

    if (boxSize < headerSize || offset + boxSize > data.length) break;

    boxes.push({
      type,
      size: boxSize,
      start: offset,
      end: offset + boxSize,
      data: data.subarray(offset + headerSize, offset + boxSize)
    });

    offset += boxSize;
  }

  console.debug('Found boxes:', boxes.map(b => ({ type: b.type, size: b.size })));
  return boxes;
}

  protected findBox(boxes: MP4Box[], type: string): MP4Box | undefined {
    return boxes.find(box => box.type === type);
  }

  protected findBoxOffset(data: Uint8Array, type: string): number {
    let offset = 0;
    while (offset < data.length - 8) {
      const size =
        (data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3];

      const boxType = new TextDecoder().decode(data.slice(offset + 4, offset + 8));

      if (boxType === type) {
        return offset;
      }

      if (size === 0) break;
      if (size === 1) {
        if (data.length - offset < 16) break;
        const headerSize = 16;
        offset += headerSize;
      } else {
        offset += size;
      }
    }
    return -1;
  }

  protected async findVideoTrack(moovBoxes: MP4Box[]): Promise<MP4Box | undefined> {
    for (const trak of moovBoxes.filter(box => box.type === 'trak')) {
      const mdiaOffset = this.findBoxOffset(trak.data!, 'mdia');
      if (mdiaOffset === -1) continue;

      const mdiaData = trak.data!.subarray(mdiaOffset + 8);
      const hdlrOffset = this.findBoxOffset(mdiaData, 'hdlr');
      if (hdlrOffset === -1) continue;

      const handlerOffset = hdlrOffset + 16; // Skip box header (8) and version/flags (8)
      if (mdiaData.length < handlerOffset + 4) continue;

      const handlerType = new TextDecoder().decode(
        mdiaData.subarray(handlerOffset, handlerOffset + 4)
      );

      if (handlerType === 'vide') {
        return trak;
      }
    }

    return undefined;
  }

protected async parseVideoTrack(trak: MP4Box): Promise<VideoTrackMetadata> {
  const trakBoxes = await this.parseBoxes(trak.data!);

  const tkhd = this.findBox(trakBoxes, 'tkhd');
  if (!tkhd) {
    throw new Error('No tkhd box found');
  }

  const reader = new BinaryReaderImpl(tkhd.data!);

  reader.skip(4);  // Skip version and flags
  reader.skip(16); // Skip creation_time, modification_time, track_ID, reserved
  reader.skip(4);  // Skip duration
  reader.skip(8);  // Skip reserved
  reader.skip(4);  // Skip layer and alternate_group
  reader.skip(4);  // Skip volume and reserved

  const matrix: number[] = [];
  for (let i = 0; i < 9; i++) {
    matrix.push(reader.readUint32());
  }

  const width = Math.round(reader.readUint32() / 65536);
  const height = Math.round(reader.readUint32() / 65536);

  const mdia = this.findBox(trakBoxes, 'mdia');
  if (!mdia) {
    throw new Error('No mdia box found');
  }

  const mdiaBoxes = await this.parseBoxes(mdia.data!);
  const minf = this.findBox(mdiaBoxes, 'minf');
  if (!minf) {
    throw new Error('No minf box found');
  }

  const minfBoxes = await this.parseBoxes(minf.data!);
  const stbl = this.findBox(minfBoxes, 'stbl');
  if (!stbl) {
    throw new Error('No stbl box found');
  }

  const stblBoxes = await this.parseBoxes(stbl.data!);
  const stsd = this.findBox(stblBoxes, 'stsd');
  if (!stsd) {
    throw new Error('No stsd box found');
  }

  const stsdBoxes = await this.parseBoxes(stsd.data!);
  console.debug('STSD box content:', stsdBoxes.map(b => ({ type: b.type, size: b.size })));

  let displayWidth = width;
  let displayHeight = height;

  const videoTrack = this.findBox(stsdBoxes, 'avc1') ||
                     this.findBox(stsdBoxes, 'hev1') ||
                     this.findBox(stsdBoxes, 'mp4v');
  console.debug('Video track found:', videoTrack ? { type: videoTrack.type, size: videoTrack.size } : 'not found');

  if (videoTrack) {
    console.debug('Video track data length:', videoTrack.data?.length);
    console.debug('Video track first bytes:', Array.from(videoTrack.data?.slice(0, 16) || []).map(b => b.toString(16)));

    const videoBoxes = await this.parseBoxes(videoTrack.data!);
    console.debug('Video track boxes:', videoBoxes.map(b => ({ type: b.type, size: b.size })));

    const pasp = this.findBox(videoBoxes, 'pasp');
    if (pasp) {
      const paspReader = new BinaryReaderImpl(pasp.data!);
      const hSpacing = paspReader.readUint32();
      const vSpacing = paspReader.readUint32();
      if (hSpacing && vSpacing) {
        displayWidth = Math.round(width * (hSpacing / vSpacing));
        displayHeight = height;
      }
    }
  }

  let rotation = 0;
  if (matrix[0] === 0 && matrix[4] === 0) {
    if (matrix[1] === 0x10000 && matrix[3] === -0x10000) rotation = 90;
    if (matrix[1] === -0x10000 && matrix[3] === 0x10000) rotation = 270;
  } else if (matrix[0] === -0x10000 && matrix[4] === -0x10000) {
    rotation = 180;
  }

  let colorInfo: VideoColorInfo = this.getDefaultColorInfo();
  console.debug('Parsing color info');
  if (videoTrack) {
    const videoBoxes = await this.parseBoxes(videoTrack.data!);
    console.debug('Video track boxes:', videoBoxes.map(b => ({ type: b.type, size: b.size })));

    const colr = this.findBox(videoBoxes, 'colr');
    if (colr) {
      console.debug('Found colr box:', { size: colr.size, dataLength: colr.data?.length });
      colorInfo = HdrDetector.parseMP4ColorInfo(colr.data!);
    } else {
      console.debug('No colr box in video track');
    }
  }

  let fps;
  const mdhd = this.findBox(mdiaBoxes, 'mdhd');
  if (mdhd) {
    const mdhdReader = new BinaryReaderImpl(mdhd.data!);
    const version = mdhdReader.readUint8();
    mdhdReader.skip(3);

    if (version === 1) {
      mdhdReader.skip(16);
    } else {
      mdhdReader.skip(8);
    }

    const timescale = mdhdReader.readUint32();
    const duration = version === 1 ? mdhdReader.readUint64() : mdhdReader.readUint32();

    const stts = this.findBox(stblBoxes, 'stts');
    if (stts) {
      const timing = FpsDetector.parseMP4TimingInfo(stts.data!, timescale, Number(duration));
      if (timing) {
        fps = FpsDetector.calculateFps(timing);
      }
    }
  }

  return {
    width,
    height,
    rotation,
    displayAspectWidth: displayWidth,
    displayAspectHeight: displayHeight,
    colorInfo,
    fps
  };
}

  protected getDefaultColorInfo(): VideoColorInfo {
    return {
      matrixCoefficients: null,
      transferCharacteristics: null,
      primaries: null,
      fullRange: null
    };
  }
}