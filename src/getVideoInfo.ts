import {
  HLS_FORMATS,
  Input,
  MATROSKA,
  OGG,
  QTFF,
  WEBM,
  type MetadataTags,
} from "mediabunny";

import type {
  VideoInfoOptions,
  VideoInfoResult,
  VideoSource,
} from "./ExpoVideoMetadata.types";
import {
  createSourceInfo,
  isBlobLikeSource,
  isLocalFileSource,
} from "./createSourceInfo";

type Location = VideoInfoResult["location"];

const ISO_6709_PATTERN =
  /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\/?$/;

const VIDEO_INPUT_FORMATS = [
  ...HLS_FORMATS,
  QTFF,
  MATROSKA,
  WEBM,
  OGG,
];

// Raw location metadata keys vary by container and writer. QuickTime/iOS files
// commonly use ISO 6709 GPS strings under one of these atom/tag names.
const LOCATION_METADATA_KEYS = [
  "com.apple.quicktime.location.ISO6709",
  "location.ISO6709",
  "©xyz",
  "xyz",
];

async function safeRead<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

async function getDuration(input: Input, tracks: Awaited<ReturnType<Input["getTracks"]>>) {
  return (
    (await input.getDurationFromMetadata(tracks, { skipLiveWait: true })) ??
    (await input.computeDuration(tracks, { skipLiveWait: true }))
  );
}

function normalizeRotation(rotation: number) {
  return ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
}

function getOrientation(
  rotation: number,
  width: number,
  height: number
): VideoInfoResult["orientation"] {
  const isNaturallyPortrait = height > width;

  switch (normalizeRotation(rotation)) {
    case 0:
      return isNaturallyPortrait ? "Portrait" : "LandscapeRight";
    case 90:
      return "Portrait";
    case 180:
      return isNaturallyPortrait ? "PortraitUpsideDown" : "LandscapeLeft";
    case 270:
      return "PortraitUpsideDown";
    default:
      return isNaturallyPortrait ? "Portrait" : "LandscapeRight";
  }
}

function parseISO6709Location(value: string): Location {
  const match = value.trim().match(ISO_6709_PATTERN);

  if (!match) {
    return null;
  }

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  const altitude = match[3] == null ? undefined : Number(match[3]);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    latitude,
    longitude,
    ...(Number.isFinite(altitude) ? { altitude } : {}),
  };
}

function decodeMetadataValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }

  return null;
}

function findLocationInMetadata(metadata: MetadataTags): Location {
  const raw = metadata.raw ?? {};

  for (const key of LOCATION_METADATA_KEYS) {
    const value = decodeMetadataValue(raw[key]);
    const location = value ? parseISO6709Location(value) : null;

    if (location) {
      return location;
    }
  }

  for (const value of Object.values(raw)) {
    const decodedValue = decodeMetadataValue(value);
    const location = decodedValue ? parseISO6709Location(decodedValue) : null;

    if (location) {
      return location;
    }

    if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
      for (const nestedValue of Object.values(value)) {
        if (typeof nestedValue !== "string") {
          continue;
        }

        const nestedLocation = parseISO6709Location(nestedValue);
        if (nestedLocation) {
          return nestedLocation;
        }
      }
    }
  }

  return null;
}

function normalizeVideoCodec(codec: string | null, codecParameterString: string | null) {
  switch (codec) {
    case "avc":
      return "avc1";
    case "hevc":
      return "hev1";
    default:
      return codec ?? codecParameterString?.split(".")[0] ?? "";
  }
}

function normalizeAudioCodec(codec: string | null, codecParameterString: string | null) {
  if (codec) {
    return codec;
  }

  if (codecParameterString?.startsWith("mp4a")) {
    return "aac";
  }

  return codecParameterString?.split(".")[0] ?? "";
}

function createRemoteReadError(source: string, cause: unknown) {
  const error = new Error(
    `Failed to read remote video metadata from '${source}'. On web, remote videos must allow CORS and byte-range requests.`
  );
  (error as Error & { cause?: unknown }).cause = cause;

  return error;
}

function createLocalReadError(source: string, cause: unknown) {
  const error = new Error(`Failed to read local video metadata from '${source}'.`);
  (error as Error & { cause?: unknown }).cause = cause;

  return error;
}

export async function getVideoInfo(
  source: VideoSource,
  options: VideoInfoOptions = {}
): Promise<VideoInfoResult> {
  let input: Input | null = null;

  try {
    const sourceInfo = await createSourceInfo(source, options);
    input = new Input({
      formats: VIDEO_INPUT_FORMATS,
      source: sourceInfo.source,
    });

    const [tracks, videoTrack, audioTracks, audioTrack, metadata] =
      await Promise.all([
        input.getTracks(),
        input.getPrimaryVideoTrack(),
        input.getAudioTracks(),
        input.getPrimaryAudioTrack(),
        input.getMetadataTags(),
      ]);

    const duration = await getDuration(input, tracks);
    const hasAudio = audioTracks.length > 0;

    let width = 0;
    let height = 0;
    let fps = 0;
    let bitRate = 0;
    let codec = "";
    let isHDR: boolean | null = null;
    let orientation: VideoInfoResult["orientation"] = "LandscapeRight";

    if (videoTrack) {
      const [codedWidth, codedHeight, rotation] = await Promise.all([
        videoTrack.getCodedWidth(),
        videoTrack.getCodedHeight(),
        videoTrack.getRotation(),
      ]);
      const [
        videoBitRate,
        averageVideoBitRate,
        videoCodecParameterString,
        videoCodec,
        videoIsHDR,
        packetStats,
      ] = await Promise.all([
        safeRead(() => videoTrack.getBitrate(), null),
        safeRead(() => videoTrack.getAverageBitrate(), null),
        safeRead(() => videoTrack.getCodecParameterString(), null),
        safeRead(() => videoTrack.getCodec(), null),
        safeRead(() => videoTrack.hasHighDynamicRange(), null),
        safeRead(() => videoTrack.computePacketStats(100, { skipLiveWait: true }), null),
      ]);

      width = codedWidth;
      height = codedHeight;
      fps = packetStats?.averagePacketRate ?? 0;
      bitRate =
        videoBitRate ??
        averageVideoBitRate ??
        packetStats?.averageBitrate ??
        (sourceInfo.fileSize && duration
          ? Math.floor((sourceInfo.fileSize * 8) / duration)
          : 0);
      codec = normalizeVideoCodec(videoCodec, videoCodecParameterString);
      isHDR = videoIsHDR;
      orientation = getOrientation(rotation, width, height);
    }

    let audioSampleRate = 0;
    let audioChannels = 0;
    let audioCodec = "";

    if (audioTrack) {
      const [sampleRate, numberOfChannels, audioCodecParameterString, codec] =
        await Promise.all([
          safeRead(() => audioTrack.getSampleRate(), 0),
          safeRead(() => audioTrack.getNumberOfChannels(), 0),
          safeRead(() => audioTrack.getCodecParameterString(), null),
          safeRead(() => audioTrack.getCodec(), null),
        ]);

      audioSampleRate = sampleRate;
      audioChannels = numberOfChannels;
      audioCodec = normalizeAudioCodec(codec, audioCodecParameterString);
    }

    const aspectRatio = width > 0 && height > 0 ? width / height : 0;

    return {
      duration,
      width,
      height,
      bitRate,
      fileSize: sourceInfo.fileSize,
      hasAudio,
      audioSampleRate,
      isHDR,
      audioCodec,
      codec,
      audioChannels,
      fps,
      orientation,
      aspectRatio,
      is16_9: Math.abs(aspectRatio - 16 / 9) < 0.01,
      naturalOrientation: height > width ? "Portrait" : "Landscape",
      location: findLocationInMetadata(metadata),
    };
  } catch (error) {
    if (typeof source === "string" && isLocalFileSource(source)) {
      throw createLocalReadError(source, error);
    }

    if (typeof source === "string" && !isBlobLikeSource(source)) {
      throw createRemoteReadError(source, error);
    }

    throw error;
  } finally {
    input?.dispose();
  }
}
