import {
  ALL_FORMATS,
  Input,
  type InputAudioTrack,
  type InputTrack,
  type InputVideoTrack,
  type MetadataTags,
} from "mediabunny";

import type {
  AudioTrackInfo,
  BaseTrackInfo,
  MediaTrackInfo,
  MetadataTagsInfo,
  PacketStatsInfo,
  VideoInfoOptions,
  VideoInfoResult,
  VideoSource,
  VideoTrackInfo,
} from "./ExpoVideoMetadata.types";
import {
  createSourceInfo,
  isBlobLikeSource,
  isLocalFileSource,
} from "./createSourceInfo";

type Location = VideoInfoResult["location"];

const ISO_6709_PATTERN =
  /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\/?$/;
const DEFAULT_PACKET_STATS_SAMPLE_COUNT = 30;

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

async function getDuration(
  input: Input,
  tracks: InputTrack[],
  options: VideoInfoOptions
) {
  if (options.exactDuration) {
    return await input.computeDuration(tracks, { skipLiveWait: true });
  }

  return (
    (await input.getDurationFromMetadata(tracks, { skipLiveWait: true })) ??
    (await input.computeDuration(tracks, { skipLiveWait: true }))
  );
}

async function getTrackEnd(track: InputTrack, options: VideoInfoOptions) {
  if (options.exactDuration) {
    return await track.computeDuration({ skipLiveWait: true });
  }

  return (
    (await track.getDurationFromMetadata({ skipLiveWait: true })) ??
    (await track.computeDuration({ skipLiveWait: true }))
  );
}

function getPacketStatsSampleCount(options: VideoInfoOptions) {
  return options.packetStatsSampleCount === undefined
    ? DEFAULT_PACKET_STATS_SAMPLE_COUNT
    : options.packetStatsSampleCount;
}

function shouldIncludeTrack(track: InputTrack, options: VideoInfoOptions) {
  if (track.isVideoTrack()) {
    return options.includeVideoTracks !== false;
  }

  if (track.isAudioTrack()) {
    return options.includeAudioTracks !== false;
  }

  return true;
}

async function getPacketStats(
  track: InputTrack,
  options: VideoInfoOptions
): Promise<PacketStatsInfo | null> {
  const sampleCount = getPacketStatsSampleCount(options);

  return await safeRead(
    () =>
      sampleCount === null
        ? track.computePacketStats(undefined, { skipLiveWait: true })
        : track.computePacketStats(sampleCount, { skipLiveWait: true }),
    null
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

function normalizeMetadataTags(metadata: MetadataTags): MetadataTagsInfo | null {
  const result: MetadataTagsInfo = {
    title: metadata.title,
    description: metadata.description,
    artist: metadata.artist,
    album: metadata.album,
    albumArtist: metadata.albumArtist,
    trackNumber: metadata.trackNumber,
    tracksTotal: metadata.tracksTotal,
    discNumber: metadata.discNumber,
    discsTotal: metadata.discsTotal,
    genre: metadata.genre,
    date: metadata.date?.toISOString().slice(0, 10),
    lyrics: metadata.lyrics,
    comment: metadata.comment,
    images: metadata.images?.map((image) => ({
      mimeType: image.mimeType,
      data: image.data,
      size: image.data.byteLength,
    })),
    rawTagCount: metadata.raw && Object.keys(metadata.raw).length,
    raw: metadata.raw,
  };

  const hasValue = Object.values(result).some((value) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }

    return value !== undefined && value !== null;
  });

  return hasValue ? result : null;
}

async function getBaseTrackInfo(
  track: InputTrack,
  options: VideoInfoOptions
): Promise<BaseTrackInfo> {
  const [codec, codecParameterString, start, end, languageCode, packetStats] =
    await Promise.all([
      safeRead(() => track.getCodec(), null),
      safeRead(() => track.getCodecParameterString(), null),
      safeRead(() => track.getFirstTimestamp(), 0),
      safeRead(() => getTrackEnd(track, options), 0),
      safeRead(() => track.getLanguageCode(), "und"),
      getPacketStats(track, options),
    ]);

  return {
    type: track.type,
    codec,
    codecParameterString,
    start,
    end,
    languageCode,
    packetStats,
  };
}

async function getVideoTrackInfo(
  track: InputVideoTrack,
  options: VideoInfoOptions
): Promise<VideoTrackInfo> {
  const [
    base,
    codedWidth,
    codedHeight,
    rotation,
    pixelAspectRatio,
    displayWidth,
    displayHeight,
    transparency,
    colorSpace,
    hdr,
  ] = await Promise.all([
    getBaseTrackInfo(track, options),
    safeRead(() => track.getCodedWidth(), 0),
    safeRead(() => track.getCodedHeight(), 0),
    safeRead(() => track.getRotation(), 0),
    safeRead(() => track.getPixelAspectRatio(), { num: 1, den: 1 }),
    safeRead(() => track.getDisplayWidth(), 0),
    safeRead(() => track.getDisplayHeight(), 0),
    safeRead(() => track.canBeTransparent(), false),
    safeRead(() => track.getColorSpace(), {}),
    safeRead(() => track.hasHighDynamicRange(), null),
  ]);

  return {
    ...base,
    type: "video",
    codedWidth,
    codedHeight,
    rotation,
    pixelAspectRatio,
    displayWidth,
    displayHeight,
    transparency,
    colorSpace: {
      primaries: colorSpace.primaries ?? null,
      transfer: colorSpace.transfer ?? null,
      matrix: colorSpace.matrix ?? null,
      fullRange: colorSpace.fullRange ?? null,
      hdr,
    },
  };
}

async function getAudioTrackInfo(
  track: InputAudioTrack,
  options: VideoInfoOptions
): Promise<AudioTrackInfo> {
  const [base, numberOfChannels, sampleRate] = await Promise.all([
    getBaseTrackInfo(track, options),
    safeRead(() => track.getNumberOfChannels(), 0),
    safeRead(() => track.getSampleRate(), 0),
  ]);

  return {
    ...base,
    type: "audio",
    numberOfChannels,
    sampleRate,
  };
}

async function getTrackInfo(
  track: InputTrack,
  options: VideoInfoOptions
): Promise<MediaTrackInfo> {
  if (track.isVideoTrack()) {
    return await getVideoTrackInfo(track, options);
  }

  if (track.isAudioTrack()) {
    return await getAudioTrackInfo(track, options);
  }

  return await getBaseTrackInfo(track, options);
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
    const mediaInput = new Input({
      formats: ALL_FORMATS,
      source: sourceInfo.source,
    });
    input = mediaInput;

    const tracks = await mediaInput.getTracks();
    const includedTracks = tracks.filter((track) => shouldIncludeTrack(track, options));
    const [format, mimeType, start, end, trackInfo] = await Promise.all([
      mediaInput.getFormat().then((format) => format.name),
      mediaInput.getMimeType(),
      includedTracks.length
        ? safeRead(() => mediaInput.getFirstTimestamp(includedTracks), 0)
        : 0,
      includedTracks.length ? getDuration(mediaInput, includedTracks, options) : 0,
      Promise.all(includedTracks.map((track) => getTrackInfo(track, options))),
    ]);

    const videoTrack = trackInfo.find(
      (track): track is VideoTrackInfo => track.type === "video"
    );
    const audioTrack = trackInfo.find(
      (track): track is AudioTrackInfo => track.type === "audio"
    );
    const metadata = options.includeMetadataTags
      ? await safeRead(() => mediaInput.getMetadataTags(), null)
      : null;
    const metadataTags = metadata ? normalizeMetadataTags(metadata) : undefined;
    const duration = Math.max(0, end - start);
    const width = videoTrack?.codedWidth ?? 0;
    const height = videoTrack?.codedHeight ?? 0;
    const aspectRatio = width > 0 && height > 0 ? width / height : 0;
    const bitRate =
      videoTrack?.packetStats?.averageBitrate ??
      (sourceInfo.fileSize && duration
        ? Math.floor((sourceInfo.fileSize * 8) / duration)
        : 0);

    return {
      format,
      mimeType,
      start,
      end,
      tracks: trackInfo,
      ...(options.includeMetadataTags ? { metadataTags: metadataTags ?? null } : {}),
      fileSize: sourceInfo.fileSize,
      duration,
      width,
      height,
      bitRate,
      hasAudio: Boolean(audioTrack),
      audioSampleRate: audioTrack?.sampleRate ?? 0,
      isHDR: videoTrack?.colorSpace.hdr ?? null,
      audioCodec: audioTrack
        ? normalizeAudioCodec(audioTrack.codec, audioTrack.codecParameterString)
        : "",
      codec: videoTrack
        ? normalizeVideoCodec(videoTrack.codec, videoTrack.codecParameterString)
        : "",
      audioChannels: audioTrack?.numberOfChannels ?? 0,
      fps: videoTrack?.packetStats?.averagePacketRate ?? 0,
      orientation: videoTrack
        ? getOrientation(videoTrack.rotation, width, height)
        : "LandscapeRight",
      aspectRatio,
      is16_9: Math.abs(aspectRatio - 16 / 9) < 0.01,
      naturalOrientation: height > width ? "Portrait" : "Landscape",
      location: metadata ? findLocationInMetadata(metadata) : null,
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
