export type VideoInfoResult = {
  /**
   * Duration of the video in seconds (float).
   */
  duration: number;
  /**
   * Tells if the video has a audio track. If the video has no audio track, its considered a mute video.
   */
  hasAudio: boolean;
  /**
   * Available only on iOS >= 14 and Android. Tells if the video is a HDR video.
   * Will return null if it could not be determined. (e.g. on Web or on older iOS/Android versions)
   */
  isHDR: boolean | null;
  /**
   * Width of the video in pixels.
   */
  width: number;
  /**
   * Height of the video in pixels.
   */
  height: number;
  /**
   * Frame rate of the video in frames per second.
   * Works on iOS, Android and Web (except Safari).
   */
  fps: number;
  /**
   * Bit rate of the video in bits per second.
   * Supported on all platforms.
   */
  bitRate: number;
  /**
   * File size of the video in bytes. Works only for local files, returns 0 for remote files.
   * Supported on all platforms.
   */
  fileSize: number;
  /**
   * Video codec.
   * Supported on all platforms, but on Web it may return an empty string.
   */
  codec: string;
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
  orientation:
    | "Portrait"
    | "PortraitUpsideDown"
    | "Landscape"
    | "LandscapeRight"
    | "LandscapeLeft";
  /**
   * Natural orientation of the video.
   * This is the orientation of the video as it was recorded, without any rotation/transform applied.
   */
  naturalOrientation:
    | "Portrait"
    | "Landscape";
  /**
   * Aspect ratio of the video.
   */
  aspectRatio: number;
  /**
   * Tells if the video is 16:9.
   */
  is16_9: boolean;
  /**
   * Audio sample rate of the video in samples per second.
   */
  audioSampleRate: number;
  /**
   * Audio channel count of the video.
   */
  audioChannels: number;
  /**
   * Audio codec of the video.
   */
  audioCodec: string;
  /**
   * Location where the video was recorded.
   * Supported on iOS and Android (if the video contains location metadata)
   */
  location: {
    latitude: number;
    longitude: number;
    altitude?: number;
  } | null;
};

export type VideoSource = string | File | Blob;

export type VideoInfoOptions = {
  /**
   * In case `sourceFilename` is a remote URI, `headers` object is passed in a network request.
   */
  headers?: Record<string, string>;
};
