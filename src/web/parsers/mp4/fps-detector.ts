// fps-detector.ts
import type { SampleEntry, TimingInfo } from '../../../ExpoVideoMetadata.types'
import { BinaryReaderImpl } from '../../binary-reader'

/**
 * Utility class for detecting frame rates from video container timing data.
 * Supports both fixed and variable frame rate videos.
 */
export class FpsDetector {
  // Pre-defined map of common FPS values and their tolerances
  private static readonly COMMON_FPS_MAP = new Map([
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

  /**
   * Parses MP4 timing information from the 'stts' box (time-to-sample).
   * Each entry in the box represents a run of samples with the same duration.
   */
  static parseMP4TimingInfo(
    data: Uint8Array,
    timescale: number,
    duration: number
  ): TimingInfo | null {
    if (!data || data.length < 8) return null

    try {
      const reader = new BinaryReaderImpl(data)
      reader.skip(4) // Skip version and flags

      const entryCount = reader.readUint32()

      // Validate entry count and ensure we have enough data
      const entrySizeBytes = 8 // 4 bytes for count + 4 bytes for delta
      const requiredBytes = entryCount * entrySizeBytes
      if (
        entryCount <= 0 ||
        entryCount > 1000000 || // Cap at 1M entries
        requiredBytes > reader.remaining()
      ) {
        return null
      }

      // Pre-allocate array for first three samples
      const firstThreeSamples = new Array<SampleEntry>(3)
      let sampleIndex = 0
      let totalDuration = 0
      let totalSamples = 0

      for (let i = 0; i < entryCount && reader.remaining() >= 8; i++) {
        const count = reader.readUint32()
        const delta = reader.readUint32()

        if (count === 0 || delta === 0) continue

        // Store only first three samples
        if (sampleIndex < 3) {
          firstThreeSamples[sampleIndex++] = { count, duration: delta }
        }

        totalDuration = (totalDuration + count * delta) >>> 0
        totalSamples = (totalSamples + count) >>> 0
      }

      if (totalSamples === 0) return null

      // Calculate FPS directly
      const averageDuration = totalDuration / totalSamples
      const calculatedFps = timescale / averageDuration

      /*
      console.debug('FPS Detection: Direct calculation', {
        totalSamples,
        timescale,
        duration,
        calculatedFps,
        firstThreeSamples,
      })
      */

      // Return minimal data needed for FPS calculation
      return {
        timescale,
        calculatedFps,
        duration,
        totalSamples,
        sampleTable: firstThreeSamples.slice(0, sampleIndex),
      }
    } catch (error) {
      console.debug('FPS Detection: Error parsing timing info', error)
      return null
    }
  }

  /**
   * Calculates the frame rate from timing information.
   * Attempts to match the calculated FPS to common video frame rates.
   */
  static calculateFps(timing: TimingInfo | null): number | undefined {
    if (!timing?.calculatedFps || timing.totalSamples === 0 || timing.timescale === 0) {
      return undefined
    }

    try {
      const calculatedFps = timing.calculatedFps

      // Early return for out-of-range values
      if (calculatedFps < 10 || calculatedFps > 240) {
        return undefined
      }

      // Cache the base tolerance calculation
      const toleranceBase = calculatedFps * 0.0005

      // Try exact matches first
      for (const [value, tolerance] of FpsDetector.COMMON_FPS_MAP) {
        const adjustedTolerance = Math.max(tolerance, toleranceBase)
        if (Math.abs(calculatedFps - value) <= adjustedTolerance) {
          return value
        }
      }

      // Check for common frame rate multiples
      for (const [value] of FpsDetector.COMMON_FPS_MAP) {
        const adjustedTolerance = Math.max(0.01, toleranceBase)
        const halfDiff = Math.abs(calculatedFps / 2 - value)
        const doubleDiff = Math.abs(calculatedFps * 2 - value)

        if (halfDiff <= adjustedTolerance || doubleDiff <= adjustedTolerance) {
          return value
        }
      }

      // Return calculated value rounded to 3 decimal places
      return Math.round(calculatedFps * 1000) / 1000
    } catch (error) {
      return undefined
    }
  }
}
