// fps-detector.ts
import type { SampleEntry, TimingInfo } from '../ExpoVideoMetadata.types'
import { BinaryReaderImpl } from './binary-reader'

/**
 * Utility class for detecting frame rates from video container timing data.
 * Supports both fixed and variable frame rate videos.
 */
export class FpsDetector {
  /**
   * Parses MP4 timing information from the 'stts' box (time-to-sample).
   * Each entry in the box represents a run of samples with the same duration.
   *
   * @param data - Binary data from the 'stts' box
   * @param timescale - Time units per second (e.g., 1000000 for microseconds)
   * @param duration - Total duration in timescale units
   * @returns Parsed timing information or null if invalid
   */
  static parseMP4TimingInfo(
    data: Uint8Array,
    timescale: number,
    duration: number
  ): TimingInfo | null {
    if (!data || data.length < 8) {
      console.debug('FPS Detection: Invalid data length', { dataLength: data?.length })
      return null
    }

    try {
      const reader = new BinaryReaderImpl(data)
      reader.skip(4) // Skip version and flags

      const entryCount = reader.readUint32()
      console.debug('FPS Detection: Entry count', { entryCount })

      // Validate entry count and ensure we have enough data
      const entrySizeBytes = 8 // 4 bytes for count + 4 bytes for delta
      const requiredBytes = entryCount * entrySizeBytes
      if (
        entryCount <= 0 ||
        entryCount > 1000000 || // Cap at 1M entries to prevent memory issues with corrupted files
        requiredBytes > reader.remaining()
      ) {
        console.debug('FPS Detection: Invalid entry count', {
          entryCount,
          remaining: reader.remaining(),
          requiredBytes,
        })
        return null
      }

      // Calculate totals on the fly instead of storing all entries
      let totalDuration = 0
      let totalSamples = 0
      const firstThreeSamples: SampleEntry[] = []

      for (let i = 0; i < entryCount && reader.remaining() >= 8; i++) {
        const count = reader.readUint32()
        const delta = reader.readUint32()

        if (count === 0 || delta === 0) {
          console.debug('FPS Detection: Invalid sample entry', { count, delta })
          continue
        }

        // Only store first three samples for debugging
        if (firstThreeSamples.length < 3) {
          firstThreeSamples.push({ count, duration: delta })
        }

        totalDuration += count * delta
        totalSamples += count
      }

      if (totalSamples === 0) {
        console.debug('FPS Detection: No valid samples')
        return null
      }

      // Calculate FPS directly
      const averageDuration = totalDuration / totalSamples
      const calculatedFps = timescale / averageDuration

      console.debug('FPS Detection: Direct calculation', {
        totalSamples,
        timescale,
        duration,
        calculatedFps,
        firstThreeSamples,
      })

      // Return minimal data needed for FPS calculation
      return {
        timescale,
        calculatedFps,
        duration,
        totalSamples,
        // Keep a small sample for debugging
        sampleTable: firstThreeSamples,
      }
    } catch (error) {
      console.debug('FPS Detection: Error parsing timing info', error)
      return null
    }
  }

  /**
   * Calculates the frame rate from timing information.
   * Attempts to match the calculated FPS to common video frame rates.
   * Uses proportional tolerances to handle rounding errors and timing variations.
   *
   * @param timing - Parsed timing information
   * @returns Standard frame rate if matched, calculated FPS if not, or undefined if invalid
   */
  static calculateFps(timing: TimingInfo | null): number | undefined {
    if (!timing || timing.totalSamples === 0 || timing.timescale === 0) {
      console.debug('FPS Detection: Invalid timing info', { timing })
      return undefined
    }

    try {
      const calculatedFps = timing.calculatedFps

      // Use a Map for O(1) lookups of common FPS values
      // Format: [fps, tolerance]
      // Higher frame rates get proportionally larger tolerances
      // because timing variations have bigger impact at higher rates
      const commonFpsMap = new Map([
        [23.976, 0.01], // NTSC film rate (24 * 1000/1001)
        [24, 0.01], // Standard film rate
        [25, 0.01], // PAL video rate
        [29.97, 0.015], // NTSC video rate (30 * 1000/1001)
        [30, 0.015], // Standard video rate
        [48, 0.024], // HFR film rate
        [50, 0.025], // HFR PAL rate
        [59.94, 0.03], // HFR NTSC rate
        [60, 0.03], // HFR video rate
        [90, 0.045], // VR common rate
        [120, 0.06], // High refresh gaming
        [144, 0.072], // Gaming monitor rate
        [165, 0.083], // Gaming monitor rate
        [240, 0.12], // Ultra high refresh gaming
      ])

      // Try exact matches first
      for (const [value, tolerance] of commonFpsMap) {
        // Adjust tolerance to be at least 0.05% of the frame rate
        // This ensures proportional accuracy at higher frame rates
        // Example: at 60fps, minimum tolerance is 0.03 (60 * 0.0005)
        const adjustedTolerance = Math.max(tolerance, value * 0.0005)
        if (Math.abs(calculatedFps - value) <= adjustedTolerance) {
          return value
        }
      }

      // Check for common frame rate multiples (e.g., 120fps could be 2x60)
      for (const [value] of commonFpsMap) {
        const adjustedTolerance = Math.max(0.01, value * 0.0005)
        if (
          Math.abs(calculatedFps / 2 - value) <= adjustedTolerance || // Check if it's double a standard rate
          Math.abs(calculatedFps * 2 - value) <= adjustedTolerance // Check if it's half a standard rate
        ) {
          return value
        }
      }

      // Return calculated value if within reasonable range (10-240 fps)
      // Round to 3 decimal places for consistent precision
      return calculatedFps >= 10 && calculatedFps <= 240
        ? Math.round(calculatedFps * 1000) / 1000
        : undefined
    } catch (error) {
      return undefined
    }
  }
}
