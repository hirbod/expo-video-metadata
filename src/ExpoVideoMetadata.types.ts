export type PacketStatsInfo = {
  packetCount: number;
  averagePacketRate: number;
  averageBitrate: number;
};

export type RationalInfo = {
  num: number;
  den: number;
};

export type ColorSpaceInfo = {
  primaries: string | null;
  transfer: string | null;
  matrix: string | null;
  fullRange: boolean | null;
  hdr: boolean | null;
};

export type MetadataImageInfo = {
  mimeType: string;
  data: Uint8Array;
  size: number;
};

export type MetadataTagsInfo = {
  title?: string;
  description?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  trackNumber?: number;
  tracksTotal?: number;
  discNumber?: number;
  discsTotal?: number;
  genre?: string;
  date?: string;
  lyrics?: string;
  comment?: string;
  images?: MetadataImageInfo[];
  rawTagCount?: number;
  raw?: Record<string, unknown>;
};

export type BaseTrackInfo = {
  type: string;
  codec: string | null;
  codecParameterString: string | null;
  start: number;
  end: number;
  languageCode: string;
  packetStats: PacketStatsInfo | null;
};

export type VideoTrackInfo = BaseTrackInfo & {
  type: "video";
  codedWidth: number;
  codedHeight: number;
  rotation: number;
  pixelAspectRatio: RationalInfo;
  displayWidth: number;
  displayHeight: number;
  transparency: boolean;
  colorSpace: ColorSpaceInfo;
};

export type AudioTrackInfo = BaseTrackInfo & {
  type: "audio";
  numberOfChannels: number;
  sampleRate: number;
};

export type MediaTrackInfo = BaseTrackInfo | VideoTrackInfo | AudioTrackInfo;

export type VideoInfoResult = {
  format: string;
  mimeType: string | null;
  start: number;
  end: number;
  tracks: MediaTrackInfo[];
  metadataTags?: MetadataTagsInfo | null;
  fileSize: number;

  /**
   * Legacy convenience fields derived from the primary video and audio tracks.
   */
  duration: number;
  hasAudio: boolean;
  isHDR: boolean | null;
  width: number;
  height: number;
  fps: number;
  bitRate: number;
  codec: string;
  orientation:
    | "Portrait"
    | "PortraitUpsideDown"
    | "Landscape"
    | "LandscapeRight"
    | "LandscapeLeft";
  naturalOrientation:
    | "Portrait"
    | "Landscape";
  aspectRatio: number;
  is16_9: boolean;
  audioSampleRate: number;
  audioChannels: number;
  audioCodec: string;
  location: {
    latitude: number;
    longitude: number;
    altitude?: number;
  } | null;
};

export type VideoSource = string | File | Blob;

export type VideoInfoOptions = {
  /**
   * In case `source` is a remote URI, `headers` object is passed in network requests.
   */
  headers?: Record<string, string>;
  /**
   * Set to `true` to compute exact durations by scanning packet timing when
   * metadata duration is unavailable or approximate.
   *
   * Defaults to `false` for faster metadata resolution.
   */
  exactDuration?: boolean;
  /**
   * Number of packets to inspect for packet statistics. Use `null` to scan the
   * full track, matching Mediabunny's metadata extraction demo exactly.
   *
   * Defaults to `30`.
   */
  packetStatsSampleCount?: number | null;
  /**
   * Include container metadata tags such as title, artist, comments, embedded
   * images, raw tags, and GPS location.
   *
   * Defaults to `false` because tag parsing can require extra reads and is not
   * needed for basic technical video metadata.
   */
  includeMetadataTags?: boolean;
  /**
   * Include video tracks in the returned `tracks` array and derived video
   * convenience fields.
   *
   * Defaults to `true`.
   */
  includeVideoTracks?: boolean;
  /**
   * Include audio tracks in the returned `tracks` array and derived audio
   * convenience fields.
   *
   * Defaults to `true`.
   */
  includeAudioTracks?: boolean;
};
