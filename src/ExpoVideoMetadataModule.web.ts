import { VideoContainerParser } from './web/video-container-parser';
import { getQuickFileSize } from './web/utils/file-utils';
import type { VideoInfoOptions, VideoInfoResult, VideoSource, ParsedVideoMetadata } from "./ExpoVideoMetadata.types";
import { HdrDetector } from './web/hdr-detector';

export default {
  name: "ExpoVideoMetadata",

  async getVideoInfo(
    source: VideoSource,
    options: VideoInfoOptions = {}
  ): Promise<VideoInfoResult> {
    let file: File | Blob;
    let fileSize: number;

    if (typeof source === "string") {
      fileSize = await getQuickFileSize(source);
      const response = await fetch(source, options);
      file = await response.blob();
    } else {
      file = source;
      fileSize = file.size;
    }

    try {
      console.debug("Attempting to parse container metadata");
      const metadata = await VideoContainerParser.parseContainer(file);
      console.debug("Container metadata parsed:", metadata);

      const aspectRatio = metadata.width / metadata.height;

      return {
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        bitRate: metadata.bitrate || (fileSize && metadata.duration ? Math.floor(fileSize * 8 / metadata.duration) : 0),
        fileSize,
        hasAudio: metadata.hasAudio,
        audioSampleRate: metadata.audioSampleRate,
        audioChannels: metadata.audioChannels,
        audioCodec: metadata.audioCodec,
        isHDR: metadata.colorInfo ? HdrDetector.isHdr(metadata.colorInfo) : null,
        codec: metadata.codec || "",
        fps: metadata.fps || 0,
        orientation: this.getOrientationFromMatrix(metadata.rotation, metadata.width, metadata.height),
        naturalOrientation: metadata.height > metadata.width ? "Portrait" : "Landscape",
        aspectRatio,
        is16_9: Math.abs(aspectRatio - 16/9) < 0.01,
        location: null
      };
    } catch (error) {
      console.error('Error parsing video:', error);
      throw new Error(`Failed to parse video: ${error.message}`);
    }
  },

  getOrientationFromMatrix(rotation: number, width: number, height: number) {
    const isNaturallyPortrait = height > width;

    switch (rotation) {
      case 90: return "Portrait";
      case 270: return "PortraitUpsideDown";
      case 180: return isNaturallyPortrait ? "PortraitUpsideDown" : "LandscapeLeft";
      default: return isNaturallyPortrait ? "Portrait" : "LandscapeRight";
    }
  }
};