// ExpoVideoMetadata.ts
import { VideoContainerParser } from './web/video-container-parser';
import type {
  VideoInfoOptions,
  VideoInfoResult,
  VideoSource,
  HTMLVideoElementWithTracks,
  Track,
  AudioTrack,
  VideoTrack,
  TrackList,
  ParsedVideoMetadata,
  VideoTrackMetadata
} from "./ExpoVideoMetadata.types";
import { HdrDetector } from './web/hdr-detector';


export default {
  name: "ExpoVideoMetadata",

  getVideoOrientation(video: HTMLVideoElementWithTracks) {
    // Get the video element's transform style
    const transform = window.getComputedStyle(video).transform;
    const matrix = new DOMMatrix(transform);

    // Calculate rotation angle from transform matrix
    const rotation = Math.round(Math.atan2(matrix.b, matrix.a) * (180 / Math.PI));

    // Get natural dimensions
    const { videoWidth: width, videoHeight: height } = video;
    const isNaturallyPortrait = height > width;

    // First check if there's rotation applied via CSS transform
    if (rotation !== 0) {
      switch ((rotation + 360) % 360) {
        case 90:
          return "Portrait";
        case 270:
          return "PortraitUpsideDown";
        case 0:
          return isNaturallyPortrait ? "Portrait" : "LandscapeRight";
        case 180:
          return isNaturallyPortrait ? "PortraitUpsideDown" : "LandscapeLeft";
      }
    }

    // If no rotation, use natural dimensions
    return isNaturallyPortrait ? "Portrait" : "LandscapeRight";
  },

  getVideoFrameRate(videoElement: HTMLVideoElementWithTracks): number {
    // Try captureStream() method first (works in Chrome/Firefox)
    if (videoElement.captureStream) {
      try {
        const stream = videoElement.captureStream();
        const [videoTrack] = stream.getVideoTracks();

        if (videoTrack) {
          const frameRate = videoTrack.getSettings().frameRate;
          if (frameRate) {
            console.log("frameRate", frameRate);
            return frameRate;
          }
        }
      } catch (error) {
        console.info("Error using captureStream:", error);
      }
    }

    // Fallback for Safari using webkitDecodedFrameCount
    if ('webkitDecodedFrameCount' in videoElement && videoElement.duration) {
      const totalFrames = (videoElement as any).webkitDecodedFrameCount;
      if (totalFrames > 0) {
        return Math.round((totalFrames / videoElement.duration) * 100) / 100;
      }
    }

    console.info("No supported method to detect frame rate");
    return 0;
  },

  async getAudioBuffer(
    audioUrl: string,
    options: RequestInit = {}
  ): Promise<{ sampleRate: number; numberOfChannels: number }> {
    try {
      const response = await fetch(audioUrl, options);
      const arrayBuffer = await response.arrayBuffer();

      const audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)();

      try {
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        return {
          sampleRate: audioBuffer.sampleRate,
          numberOfChannels: audioBuffer.numberOfChannels,
        };
      } catch (decodeError) {
        console.info("Error decoding audio data (no audio?):", decodeError);
        return { sampleRate: 0, numberOfChannels: 0 };
      } finally {
        await audioContext.close();
      }
    } catch (error) {
      console.info("Error decoding audio data (CORS?):", error);
      return { sampleRate: 0, numberOfChannels: 0 };
    }
  },

  getBase64FileSize(base64String: string): number {
    const base64Data = base64String.replace(/^data:.+;base64,/, "");
    return atob(base64Data).length;
  },

  async getFileSize(url: string, options: RequestInit = {}): Promise<number> {
    if (url.startsWith("data:")) {
      return this.getBase64FileSize(url);
    }

    try {
      const response = await fetch(url, { method: "HEAD", ...options });
      const contentLength = response.headers.get("Content-Length");
      return contentLength ? parseInt(contentLength, 10) : 0;
    } catch (error) {
      console.info("Error fetching file size for URL (CORS?):", url, error);
      return 0;
    }
  },

  async getVideoInfo(
    source: VideoSource,
    options: VideoInfoOptions = {}
  ): Promise<VideoInfoResult> {
    let file: File | Blob;
    let videoUrl: string;

    if (typeof source === "string") {
      try {
        const response = await fetch(source, options);
        file = await response.blob();
        videoUrl = source;
      } catch (error) {
        throw new Error(`Failed to fetch video: ${error.message}`);
      }
    } else {
      file = source;
      videoUrl = URL.createObjectURL(source);
    }

    const video = document.createElement("video") as HTMLVideoElementWithTracks;
    Object.assign(video, {
      crossOrigin: "anonymous",
      autoplay: true,
      muted: true,
      playsInline: true,
    });

    const resetVideo = () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
      if (source instanceof File || source instanceof Blob) {
        URL.revokeObjectURL(videoUrl);
      }
    };

    try {
      // Try container parsing first
      let containerMetadata : ParsedVideoMetadata | null = null;
      try {
        containerMetadata = await VideoContainerParser.parseContainer(file);
      } catch (error) {
        console.info("Container parsing failed, falling back to browser API:", error);
        containerMetadata = null;
      }

      // Load video element for additional metadata
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("Failed to load video metadata"));
        video.src = videoUrl;
        video.load();
        video.pause();
      });

      const videoTrack = video.videoTracks?.[0];
      const audioTrack = video.audioTracks?.[0];

      const hasAudio =
        Boolean(video.audioTracks?.length) ||
        video.mozHasAudio ||
        Boolean(video.webkitAudioDecodedByteCount);

      const { numberOfChannels: audioChannels, sampleRate: audioSampleRate } =
        await this.getAudioBuffer(videoUrl, options);

      const fileSize =
        source instanceof File || source instanceof Blob
          ? source.size
          : await this.getFileSize(videoUrl, options);

      console.log("containerMetadata", containerMetadata);

      // Use container metadata if available, fallback to video element
      return {
        duration: video.duration,
        width: containerMetadata?.width || video.videoWidth,
        height: containerMetadata?.height || video.videoHeight,
        bitRate: containerMetadata?.bitrate ||
          (fileSize && video.duration ? Math.floor(fileSize / video.duration) : 0),
        fileSize,
        hasAudio,
        audioSampleRate,
        isHDR: containerMetadata?.colorInfo ? HdrDetector.isHdr(containerMetadata.colorInfo) : null,
        audioCodec: audioTrack?.label ?? "",
        codec: containerMetadata?.codec || videoTrack?.label || "",
        audioChannels,
        fps: containerMetadata?.fps || this.getVideoFrameRate(video) || 0,
        orientation: this.getVideoOrientation(video),
        naturalOrientation: (video.videoWidth >= video.videoHeight ? "Landscape" : "Portrait"),
        aspectRatio: video.videoWidth / video.videoHeight,
        is16_9: Math.abs((video.videoWidth / video.videoHeight) - 16/9) < 0.01,
        location: null // not supported on web
      };
    } finally {
      resetVideo();
    }
  },
};