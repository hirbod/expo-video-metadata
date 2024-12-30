// fps-detector.ts
import { TimingInfo, SampleEntry } from "../ExpoVideoMetadata.types";
import { BinaryReaderImpl } from "./binary-reader";

export class FpsDetector {
  static parseMP4TimingInfo(data: Uint8Array, timescale: number, duration: number): TimingInfo | null {
    if (!data || data.length < 8) {
      return null;
    }

    try {
      const reader = new BinaryReaderImpl(data);

      // Skip version and flags
      reader.skip(4);

      // Read entry count
      const entryCount = reader.readUint32();
      if (entryCount <= 0 || entryCount > 10000) {
        return null;
      }

      // Read all entries to get a better picture
      const sampleTable: SampleEntry[] = [];
      let totalSamples = 0;

      for (let i = 0; i < entryCount && reader.remaining() >= 8; i++) {
        const count = reader.readUint32();
        const delta = reader.readUint32();

        if (count === 0 || delta === 0) continue;

        sampleTable.push({ count, duration: delta });
        totalSamples += count;
      }

      if (sampleTable.length === 0) {
        return null;
      }

      return {
        timescale,
        sampleTable,
        duration,
        totalSamples
      };
    } catch (error) {
      return null;
    }
  }

  static calculateFps(timing: TimingInfo | null): number | undefined {
    if (!timing || !timing.sampleTable.length || timing.timescale === 0) {
      return undefined;
    }

    try {
      // Calculate weighted average frame duration
      let totalDuration = 0;
      let totalFrames = 0;

      for (const entry of timing.sampleTable) {
        totalDuration += entry.duration * entry.count;
        totalFrames += entry.count;
      }

      if (totalDuration === 0 || totalFrames === 0) {
        return undefined;
      }

      // Calculate average frame duration
      const averageDuration = totalDuration / totalFrames;
      const calculatedFps = timing.timescale / averageDuration;

      // Common FPS values and their multipliers/dividers
      const commonFps = [
        { value: 23.976, tolerance: 0.01 },
        { value: 24, tolerance: 0.01 },
        { value: 25, tolerance: 0.01 },
        { value: 29.97, tolerance: 0.01 },
        { value: 30, tolerance: 0.01 },
        { value: 48, tolerance: 0.01 },
        { value: 50, tolerance: 0.01 },
        { value: 59.94, tolerance: 0.01 },
        { value: 60, tolerance: 0.01 },
        { value: 90, tolerance: 0.01 },
        { value: 120, tolerance: 0.01 },
        { value: 144, tolerance: 0.01 },
        { value: 165, tolerance: 0.01 },
        { value: 240, tolerance: 0.01 }
      ];

      // First try exact matches
      for (const { value, tolerance } of commonFps) {
        if (Math.abs(calculatedFps - value) <= tolerance) {
          return value;
        }
      }

      // Then check for multipliers/dividers
      for (const { value } of commonFps) {
        // Check if it's a multiple of a common FPS
        if (Math.abs(calculatedFps / 2 - value) <= 0.01) {
          return value;
        }
        // Check if it's a fraction of a common FPS
        if (Math.abs(calculatedFps * 2 - value) <= 0.01) {
          return value;
        }
      }

      // If no standard FPS is found, round to 3 decimal places
      if (calculatedFps >= 10 && calculatedFps <= 240) {
        return Math.round(calculatedFps * 1000) / 1000;
      }

      return undefined;
    } catch (error) {
      return undefined;
    }
  }
}