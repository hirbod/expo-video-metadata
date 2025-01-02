// types.ts

export type VideoSource = string | File | Blob

export type VideoInfoOptions = {
  /**
   * In case `sourceFilename` is a remote URI, `headers` object is passed in a network request.
   */
  headers?: Record<string, string>
}

export type VideoInfoResult = {
  /**
   * Duration of the video in seconds (float).
   */
  duration: number
  /**
   * Tells if the video has a audio track. If the video has no audio track, its considered a mute video.
   */
  hasAudio: boolean
  /**
   * Available only on iOS >= 14 and Android. Tells if the video is a HDR video.
   * Will return null if it could not be determined. (e.g. on Web or on older iOS/Android versions)
   */
  isHDR: boolean | null
  /**
   * Width of the video in pixels.
   */
  width: number
  /**
   * Height of the video in pixels.
   */
  height: number
  /**
   * Frame rate of the video in frames per second.
   * Works on iOS, Android and Web (except Safari).
   */
  fps: number
  /**
   * Bit rate of the video in bits per second.
   * Supported on all platforms.
   */
  bitRate: number
  /**
   * File size of the video in bytes. Works only for local files, returns 0 for remote files.
   * Supported on all platforms.
   */
  fileSize: number
  /**
   * Video codec.
   * Supported on all platforms, but on Web it may return an empty string.
   */
  codec: string
  /**
   * Video orientation.
   * Supported on all platforms, but on Web it may return an empty string.
   * Orientation takes into account both the natural dimensions AND any rotation/transform applied to the video:
   * - Portrait: The video is in portrait mode.
   * - PortraitUpsideDown: The video is in portrait mode, but upside down.
   * - Landscape: The video is in landscape mode.
   * - LandscapeRight: The video is in landscape mode, but rotated 90 degrees clockwise.
   * - LandscapeLeft: The video is in landscape mode, but rotated 90 degrees counter-clockwise.
   */
  orientation: 'Portrait' | 'PortraitUpsideDown' | 'Landscape' | 'LandscapeRight' | 'LandscapeLeft'
  /**
   * Natural orientation of the video.
   * This is the orientation of the video as it was recorded, without any rotation/transform applied.
   */
  naturalOrientation: 'Portrait' | 'Landscape'
  /**
   * Aspect ratio of the video.
   */
  aspectRatio: number
  /**
   * Tells if the video is 16:9.
   */
  is16_9: boolean
  /**
   * Audio sample rate of the video in samples per second.
   */
  audioSampleRate: number
  /**
   * Audio channel count of the video.
   */
  audioChannels: number
  /**
   * Audio codec of the video.
   */
  audioCodec: string
  /**
   * Location where the video was recorded.
   * Supported on iOS and Android (if the video contains location metadata)
   */
  location: {
    latitude: number
    longitude: number
    altitude?: number
  } | null
}

// Internal types for video container parsing
export type VideoContainer = 'mp4' | 'webm' | 'mov' | 'avi' | 'mkv' | 'ts' | 'unknown'

export type ColorMatrix = 'bt601' | 'bt709' | 'bt2020' | null
export type TransferCharacteristics = 'bt709' | 'arib-std-b67' | 'pq' | null
export type ColorPrimaries = 'bt601' | 'bt709' | 'bt2020' | null

export interface VideoColorInfo {
  matrixCoefficients: string | null // 'bt709', 'bt2020nc', 'bt2020c', etc.
  transferCharacteristics: string | null // 'bt709', 'arib-std-b67', 'smpte2084', etc.
  primaries: string | null // 'bt709', 'bt2020', etc.
  fullRange: boolean | null
}

export interface SampleEntry {
  count: number
  duration: number
}

export interface TimingInfo {
  timescale: number
  sampleTable: SampleEntry[]
  duration: number
  totalSamples?: number
}

export interface VideoTrackMetadata {
  width: number
  height: number
  rotation: number
  displayAspectWidth: number
  displayAspectHeight: number
  codec: string
  fps?: number
  colorInfo: VideoColorInfo
  timing?: TimingInfo
  videoBitrate?: number
  audioBitrate?: number
}

export interface ParsedVideoMetadata extends VideoTrackMetadata {
  container: VideoContainer
  hasAudio: boolean
  audioChannels: number
  audioSampleRate: number
  audioCodec: string
  duration: number
  fileSize: number
  bitrate?: number
}

// Add common codec strings
export type AudioCodec =
  | 'aac'
  | 'mp3'
  | 'opus'
  | 'vorbis'
  | 'ac3'
  | 'eac3'
  | 'alac'
  | 'flac'
  | 'pcm'
  | ''

export type VideoCodec =
  | 'avc1' // H.264
  | 'hev1' // HEVC/H.265
  | 'hvc1' // HEVC/H.265 alternate
  | 'mp4v' // MPEG-4 Visual
  | 'vp08' // VP8
  | 'vp09' // VP9
  | 'av01' // AV1
  | ''

export interface BoxHeader {
  type: string
  size: number
  start: number
  end: number
}

export interface MP4Box extends BoxHeader {
  data?: Uint8Array
}

export interface WebMElement {
  id: number
  size: number
  data: Uint8Array
  offset: number
}

export interface BinaryReader {
  offset: number
  length: number
  data: Uint8Array
  read(length: number): Uint8Array
  readUint8(): number
  readUint16(): number
  readUint32(): number
  readString(length: number): string
  seek(offset: number): void
  skip(length: number): void
}

export interface HTMLVideoElementWithTracks extends HTMLVideoElement {
  videoTracks?: TrackList<VideoTrack>
  audioTracks?: TrackList<AudioTrack>
  mozHasAudio?: boolean
  webkitAudioDecodedByteCount?: number
  captureStream?(): MediaStream
}

export interface Track {
  id: string
  kind: string
  label: string
  language: string
}

export interface AudioTrack extends Track {
  enabled: boolean
}

export interface VideoTrack extends Track {
  selected: boolean
}

export type TrackList<T> = T[]
