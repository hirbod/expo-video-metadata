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
   * Tells if the video is HDR.
   * Will return null if it could not be determined.
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
   * Works when the container exposes enough packet timing information.
   */
  fps: number;
  /**
   * Bit rate of the video in bits per second.
   * Supported on all platforms.
   */
  bitRate: number;
  /**
   * File size of the video in bytes.
   * Remote files return 0 when the server does not expose a readable content length.
   */
  fileSize: number;
  /**
   * Video codec.
   * Returns an empty string when the codec cannot be determined.
   */
  codec: string;
  /**
   * Video orientation.
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
   * Returned when the video contains readable location metadata.
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
   * In case `source` is a remote URI, `headers` object is passed in a network request.
   */
  headers?: Record<string, string>;
};
