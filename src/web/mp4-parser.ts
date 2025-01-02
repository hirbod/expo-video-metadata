// mp4-parser.ts
import { BinaryReaderImpl } from './binary-reader';
import { HdrDetector } from './hdr-detector';
import { FpsDetector } from './fps-detector';
import type { MP4Box, VideoTrackMetadata, ParsedVideoMetadata, VideoColorInfo } from '../ExpoVideoMetadata.types';

interface FragmentInfo {
    defaultSampleDescriptionIndex: number;
    defaultSampleDuration: number;
    defaultSampleSize: number;
    defaultSampleFlags: number;
}

interface TrackFragment {
    trackId: number;
    fragmentInfo: FragmentInfo;
}

export class MP4Parser {
  protected reader: BinaryReaderImpl;
  protected boxes: MP4Box[] = [];
  protected fragments = new Map<number, TrackFragment>();


  constructor(data: Uint8Array) {
    this.reader = new BinaryReaderImpl(data);
  }

public async parse(): Promise<ParsedVideoMetadata> {
    try {
        await this.readBoxes();

        const moov = this.boxes.find(box => box.type === 'moov');
        if (!moov) throw new Error('No moov box found');

        const moovBoxes = await this.parseBoxes(moov.data!);
        const trak = await this.findVideoTrack(moovBoxes);
        if (!trak) throw new Error('File contains no video track, likely just audio');

        const metadata = await this.parseVideoTrack(trak, moovBoxes);  // Pass moovBoxes
        const duration = await this.getDuration(moovBoxes);

        const audioTrak = await this.findAudioTrack(moovBoxes);
        console.debug('Audio track found:', audioTrak ? { size: audioTrak.size } : 'not found');

        const audioInfo = audioTrak ?
            await this.parseAudioMetadata(audioTrak) :
            { hasAudio: false, audioChannels: 0, audioSampleRate: 0, audioCodec: '' };

        const bitrate = this.reader.length && duration ?
            Math.floor(this.reader.length * 8 / duration) :
            undefined;

        return {
            ...metadata,
            ...audioInfo,
            duration,
            fileSize: this.reader.length,
            bitrate,
            container: 'mp4'
        };
    } catch (error) {
        console.error('Error parsing MP4:', error);
        throw error;
    }
}

protected async readBoxes(): Promise<void> {
    this.boxes = [];
    this.fragments = new Map<number, TrackFragment>();
    let offset = 0;
    const data = this.reader.data;

    while (offset < data.length) {
        if (data.length - offset < 8) break;

        let size = (data[offset] << 24) |
                  (data[offset + 1] << 16) |
                  (data[offset + 2] << 8) |
                  data[offset + 3];

        const type = new TextDecoder().decode(data.slice(offset + 4, offset + 8));
        let headerSize = 8;

        // Handle 64-bit size
        if (size === 1 && data.length - offset >= 16) {
            const highBits = (data[offset + 8] << 24) |
                           (data[offset + 9] << 16) |
                           (data[offset + 10] << 8) |
                           data[offset + 11];
            const lowBits = (data[offset + 12] << 24) |
                          (data[offset + 13] << 16) |
                          (data[offset + 14] << 8) |
                          data[offset + 15];
            size = (highBits * 2 ** 32) + lowBits;
            headerSize = 16;
        }
        // Handle box that extends to EOF
        else if (size === 0) {
            size = data.length - offset;
        }

        if (offset + headerSize <= data.length) {
            const box: MP4Box = {
                type,
                size,
                start: offset,
                end: offset + size,
                data: data.subarray(offset + headerSize, offset + size)
            };

            this.boxes.push(box);

            if (type === 'moof') {
                await this.parseFragment(box);
            }
        }

        if (size < headerSize) size = headerSize;
        offset += size;
    }
}

private async parseFragment(moof: MP4Box): Promise<void> {
    const moofBoxes = await this.parseBoxes(moof.data!);
    const traf = moofBoxes.find(box => box.type === 'traf');

    if (traf) {
        const trafBoxes = await this.parseBoxes(traf.data!);
        const tfhd = trafBoxes.find(box => box.type === 'tfhd');

        if (tfhd?.data) {
            const trackId = (tfhd.data[4] << 24) |
                          (tfhd.data[5] << 16) |
                          (tfhd.data[6] << 8) |
                          tfhd.data[7];

            const flags = (tfhd.data[1] << 16) |
                        (tfhd.data[2] << 8) |
                        tfhd.data[3];

            let offset = 8;
            const fragmentInfo: FragmentInfo = {
                defaultSampleDescriptionIndex: 1,
                defaultSampleDuration: 0,
                defaultSampleSize: 0,
                defaultSampleFlags: 0
            };

            if (flags & 0x000001) offset += 8; // base-data-offset-present
            if (flags & 0x000002) {
                fragmentInfo.defaultSampleDescriptionIndex = (tfhd.data[offset] << 24) |
                                                          (tfhd.data[offset + 1] << 16) |
                                                          (tfhd.data[offset + 2] << 8) |
                                                          tfhd.data[offset + 3];
                offset += 4;
            }
            if (flags & 0x000008) {
                fragmentInfo.defaultSampleDuration = (tfhd.data[offset] << 24) |
                                                  (tfhd.data[offset + 1] << 16) |
                                                  (tfhd.data[offset + 2] << 8) |
                                                  tfhd.data[offset + 3];
                offset += 4;
            }
            if (flags & 0x000010) {
                fragmentInfo.defaultSampleSize = (tfhd.data[offset] << 24) |
                                              (tfhd.data[offset + 1] << 16) |
                                              (tfhd.data[offset + 2] << 8) |
                                              tfhd.data[offset + 3];
                offset += 4;
            }
            if (flags & 0x000020) {
                fragmentInfo.defaultSampleFlags = (tfhd.data[offset] << 24) |
                                               (tfhd.data[offset + 1] << 16) |
                                               (tfhd.data[offset + 2] << 8) |
                                               tfhd.data[offset + 3];
            }

            this.fragments.set(trackId, { trackId, fragmentInfo });
        }
    }
}

  protected async getDuration(moovBoxes: MP4Box[]): Promise<number> {
    try {
        for (const trak of moovBoxes.filter(box => box.type === 'trak')) {
            const mdia = this.findBox(await this.parseBoxes(trak.data!), 'mdia');
            if (!mdia) continue;

            const mdiaBoxes = await this.parseBoxes(mdia.data!);
            const mdhd = this.findBox(mdiaBoxes, 'mdhd');
            if (!mdhd) continue;

            const reader = new BinaryReaderImpl(mdhd.data!);
            const version = reader.readUint8();
            reader.skip(3); // flags

            if (version === 1) {
                reader.skip(16); // 64-bit creation and modification times
            } else {
                reader.skip(8);  // 32-bit creation and modification times
            }

            const timescale = reader.readUint32();
            const duration = version === 1 ? reader.readUint64() : reader.readUint32();

            return duration / timescale;
        }
    } catch (error) {
        console.debug('Error getting duration:', error);
    }
    return 0;
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
    else if (type === 'hev1' || type === 'hvc1') {
      headerSize = 86;  // Same as AVC1
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

      boxSize = (highBits * 2 ** 32) + lowBits;
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
    console.debug('Looking for video track in moov boxes:', moovBoxes.map(b => ({ type: b.type, size: b.size })));

    const tracks = moovBoxes.filter(box => box.type === 'trak');
    console.debug('Found tracks:', tracks.length);

    // First check normal tracks
    for (const trak of tracks) {
        const mdiaOffset = this.findBoxOffset(trak.data!, 'mdia');
        console.debug('Found mdia offset:', mdiaOffset);
        if (mdiaOffset === -1) continue;

        const mdiaData = trak.data!.subarray(mdiaOffset + 8);
        const hdlrOffset = this.findBoxOffset(mdiaData, 'hdlr');
        console.debug('Found hdlr offset:', hdlrOffset);
        if (hdlrOffset === -1) continue;

        const handlerOffset = hdlrOffset + 16;
        if (mdiaData.length < handlerOffset + 4) continue;

        const handlerType = new TextDecoder().decode(
            mdiaData.subarray(handlerOffset, handlerOffset + 4)
        );
        console.debug('Found track type:', handlerType);

        if (handlerType === 'vide') {
            return trak;
        }
    }

    // Check for fragmented MP4
    const mvex = moovBoxes.find(box => box.type === 'mvex');
    if (mvex) {
        console.debug('Found fragmented MP4');
        const mvexBoxes = await this.parseBoxes(mvex.data!);

        for (const trex of mvexBoxes.filter(box => box.type === 'trex')) {
            const trackId = (trex.data![4] << 24) |
                          (trex.data![5] << 16) |
                          (trex.data![6] << 8) |
                          trex.data![7];

            // Find corresponding trak
            for (const trak of tracks) {
                const tkhd = this.findBox(await this.parseBoxes(trak.data!), 'tkhd');
                if (tkhd) {
                    const trakId = (tkhd.data![12] << 24) |
                                 (tkhd.data![13] << 16) |
                                 (tkhd.data![14] << 8) |
                                 tkhd.data![15];

                    if (trakId === trackId) {
                        return trak;
                    }
                }
            }
        }
    }

    return undefined;
}

protected async parseVideoTrack(trak: MP4Box, moovBoxes: MP4Box[]): Promise<VideoTrackMetadata> {
   let videoBitrate: number | undefined;
   let codec = '';
   let timescale: number | undefined;
   let fps: number | undefined;

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

   const videoTrack = this.findBox(stsdBoxes, 'avc1') ||  // H.264/AVC
                     this.findBox(stsdBoxes, 'hev1') ||  // HEVC/H.265
                     this.findBox(stsdBoxes, 'hvc1') ||  // HEVC/H.265 alternate
                     this.findBox(stsdBoxes, 'mp4v') ||  // MPEG-4 Visual
                     this.findBox(stsdBoxes, 'vp08') ||  // VP8
                     this.findBox(stsdBoxes, 'vp09') ||  // VP9
                     this.findBox(stsdBoxes, 'av01');    // AV1

   console.debug('Video track found:', videoTrack ? { type: videoTrack.type, size: videoTrack.size } : 'not found');

   if (videoTrack) {
       console.debug('Video track data length:', videoTrack.data?.length);
       console.debug('Video track first bytes:', Array.from(videoTrack.data?.slice(0, 16) || []).map(b => b.toString(16)));

       const videoBoxes = await this.parseBoxes(videoTrack.data!);
       console.debug('Video track boxes:', videoBoxes.map(b => ({ type: b.type, size: b.size })));

       // Parse codec
       codec = videoTrack.type;
       if (codec === 'avc1') {
           const avcC = this.findBox(videoBoxes, 'avcC');
           if (avcC?.data) {
               const profile = avcC.data[1];
               const level = avcC.data[3];
               codec = `avc1.${profile.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
           }
       } else if (codec === 'hev1' || codec === 'hvc1') {
           const hvcC = this.findBox(videoBoxes, 'hvcC');
           if (hvcC?.data) {
               const profile = hvcC.data[1] & 0x1F;
               const level = hvcC.data[12];
               codec = `${codec}.${profile.toString(16)}${level.toString(16)}`;
           }
       }

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

       // Calculate video bitrate
       const btrt = this.findBox(videoBoxes, 'btrt');
       if (btrt?.data) {
           const btrtReader = new BinaryReaderImpl(btrt.data);
           const bufferSize = btrtReader.readUint32();
           const maxBitrate = btrtReader.readUint32();
           const avgBitrate = btrtReader.readUint32();
           videoBitrate = avgBitrate;
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

       // Check for HDR metadata boxes
       const colr = this.findBox(videoBoxes, 'colr');   // Standard color info
       const mdcv = this.findBox(videoBoxes, 'mdcv');   // Mastering display color volume
       const clli = this.findBox(videoBoxes, 'clli');   // Content light level info
       const dvcC = this.findBox(videoBoxes, 'dvcC');   // Dolby Vision
       const dvvC = this.findBox(videoBoxes, 'dvvC');   // Dolby Vision
       const st2086 = this.findBox(videoBoxes, 'st2086'); // HDR10 static metadata
       const hvcC = this.findBox(videoBoxes, 'hvcC');   // HEVC config
       const vpcC = this.findBox(videoBoxes, 'vpcC');   // VP9 config
       const av1C = this.findBox(videoBoxes, 'av1C');   // AV1 config
       const avcC = this.findBox(videoBoxes, 'avcC');   // AVC config

       // Try to get color info from available boxes in priority order
       if (colr) {
           console.debug('Found colr box:', { size: colr.size, dataLength: colr.data?.length });
           colorInfo = HdrDetector.parseMP4ColorInfo(colr.data!);
       } else if (mdcv) {
           console.debug('Found mdcv box:', { size: mdcv.size, dataLength: mdcv.data?.length });
           colorInfo = HdrDetector.parseMP4ColorInfo(mdcv.data!);
       } else if (dvcC || dvvC) {
           const dvBox = dvcC || dvvC;
           if (dvBox) {
               console.debug('Found Dolby Vision box:', { type: dvBox.type, size: dvBox.size, dataLength: dvBox.data?.length });
               colorInfo = HdrDetector.parseMP4ColorInfo(dvBox.data!);
           }
       } else if (st2086) {
           console.debug('Found HDR10 metadata box:', { size: st2086.size, dataLength: st2086.data?.length });
           colorInfo = HdrDetector.parseMP4ColorInfo(st2086.data!);
       } else if (hvcC) {
           console.debug('Found HEVC config box:', { size: hvcC.size, dataLength: hvcC.data?.length });
           colorInfo = HdrDetector.parseMP4ColorInfo(hvcC.data!);
       } else if (vpcC) {
           console.debug('Found VP9 config box:', { size: vpcC.size, dataLength: vpcC.data?.length });
           colorInfo = HdrDetector.parseMP4ColorInfo(vpcC.data!);
       } else if (av1C) {
           console.debug('Found AV1 config box:', { size: av1C.size, dataLength: av1C.data?.length });
           colorInfo = HdrDetector.parseMP4ColorInfo(av1C.data!);
       } else if (avcC) {
           console.debug('Found AVC config box:', { size: avcC.size, dataLength: avcC.data?.length });
           colorInfo = HdrDetector.parseMP4ColorInfo(avcC.data!);
       } else {
           console.debug('No color info boxes found in video track');
       }

       // Additional check for content light level
       if (clli && !HdrDetector.isHdr(colorInfo)) {
           console.debug('Found content light level box:', { size: clli.size, dataLength: clli.data?.length });
           const clliColorInfo = HdrDetector.parseMP4ColorInfo(clli.data!);
           if (HdrDetector.isHdr(clliColorInfo)) {
               colorInfo = clliColorInfo;
           }
       }
   }

   // Get fps from mdhd
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

       timescale = mdhdReader.readUint32();
       const duration = version === 1 ? mdhdReader.readUint64() : mdhdReader.readUint32();

       const stts = this.findBox(stblBoxes, 'stts');
       if (stts) {
           const timing = FpsDetector.parseMP4TimingInfo(stts.data!, timescale, Number(duration));
           if (timing) {
               fps = FpsDetector.calculateFps(timing);
           }
       }
   }

   // Handle fragmented MP4s
   if (!videoBitrate) {
       const mvex = moovBoxes.find(box => box.type === 'mvex');
       if (mvex) {
           const mvexBoxes = await this.parseBoxes(mvex.data!);
           const trex = mvexBoxes.find(box => box.type === 'trex');

           if (trex && this.fragments.size > 0) {
               const trackId = (trex.data![4] << 24) |
                             (trex.data![5] << 16) |
                             (trex.data![6] << 8) |
                             trex.data![7];

               const fragment = this.fragments.get(trackId);
               if (fragment) {
                   if (!fps && fragment.fragmentInfo.defaultSampleDuration && timescale) {
                       fps = 1 / (fragment.fragmentInfo.defaultSampleDuration / timescale);
                   }
                   if (fps && fragment.fragmentInfo.defaultSampleSize) {
                       videoBitrate = fragment.fragmentInfo.defaultSampleSize * 8 * fps;
                   }
               }
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
       fps,
       codec,
       videoBitrate
   };
}

protected async findAudioTrack(moovBoxes: MP4Box[]): Promise<MP4Box | undefined> {
    for (const trak of moovBoxes.filter(box => box.type === 'trak')) {
        const mdiaOffset = this.findBoxOffset(trak.data!, 'mdia');
        if (mdiaOffset === -1) continue;

        const mdiaData = trak.data!.subarray(mdiaOffset + 8);
        const hdlrOffset = this.findBoxOffset(mdiaData, 'hdlr');
        if (hdlrOffset === -1) continue;

        const handlerOffset = hdlrOffset + 16;
        if (mdiaData.length < handlerOffset + 4) continue;

        const handlerType = new TextDecoder().decode(
            mdiaData.subarray(handlerOffset, handlerOffset + 4)
        );

        if (handlerType === 'soun') {
            return trak;
        }
    }

    return undefined;
}

/**
* Parse audio metadata from an MP4 audio track
* Supports common formats: AAC, HE-AAC, MP3, AC3, E-AC3, DTS, TrueHD, FLAC, ALAC, Opus
*/
protected async parseAudioMetadata(trak: MP4Box) {
   try {
       // Parse track boxes hierarchy to find audio sample description
       const trakBoxes = await this.parseBoxes(trak.data!);
       const mdia = this.findBox(trakBoxes, 'mdia');
       if (!mdia) throw new Error('No mdia box');

       const mdiaBoxes = await this.parseBoxes(mdia.data!);
       const minf = this.findBox(mdiaBoxes, 'minf');
       if (!minf) throw new Error('No minf box');

       const minfBoxes = await this.parseBoxes(minf.data!);
       const stbl = this.findBox(minfBoxes, 'stbl');
       if (!stbl) throw new Error('No stbl box');

       const stblBoxes = await this.parseBoxes(stbl.data!);
       const stsd = this.findBox(stblBoxes, 'stsd');
       if (!stsd) throw new Error('No stsd box');

       const stsdBoxes = await this.parseBoxes(stsd.data!);
       const mp4a = this.findBox(stsdBoxes, 'mp4a');
       if (!mp4a || !mp4a.data) throw new Error('No mp4a box');

       // Parse fixed-position audio data from mp4a box
       // Channels at offset 16 (2 bytes)
       const audioChannels = (mp4a.data[16] << 8) | mp4a.data[17];
       // Sample rate at offset 24 (4 bytes, but actually 16.16 fixed point)
       const sampleRate = ((mp4a.data[24] << 24) |
                         (mp4a.data[25] << 16) |
                         (mp4a.data[26] << 8) |
                         mp4a.data[27]) >>> 16;

// Find ESDS box to determine codec
const esdsStart = mp4a.data.indexOf(0x65, 28);
let codec = 'aac';
if (esdsStart > 0 &&
   mp4a.data[esdsStart + 1] === 0x73 &&
   mp4a.data[esdsStart + 2] === 0x64 &&
   mp4a.data[esdsStart + 3] === 0x73) {

   const objectTypeID = mp4a.data[esdsStart + 21];
   console.debug('Audio Object Type ID:', objectTypeID.toString(16));

   switch (objectTypeID) {
       case 0x40:
       case 0x41:
       case 0x42: codec = 'aac'; break;
       case 0x45:
       case 0x46:
       case 0x47: codec = 'aac-he'; break;
       case 0x67:
       case 0x68:
       case 0xA5: codec = 'ac3'; break;
       case 0x6B: codec = 'mp3'; break;
       case 0xA6: codec = 'e-ac3'; break;
       case 0xA9: codec = 'dts'; break;
       case 0xAA: codec = 'dts-hd'; break;
       case 0xAB: codec = 'dts-hd-ma'; break;
       case 0xAC: codec = 'truehd'; break;
       case 0xAD: codec = 'flac'; break;
       case 0xAE: codec = 'alac'; break;
       case 0xAF: codec = 'opus'; break;
       case 0x6D: codec = 'aac-he-v2'; break;
       case 0xDD: codec = 'vorbis'; break;
       case 0xE1: codec = 'pcm'; break;
   }
}

       return {
           hasAudio: true,
           audioChannels,
           audioSampleRate: sampleRate,
           audioCodec: codec
       };
   } catch (error) {
       console.debug('Error parsing audio metadata:', error);
       return { hasAudio: false, audioChannels: 0, audioSampleRate: 0, audioCodec: '' };
   }
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