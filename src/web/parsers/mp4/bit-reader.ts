/**
 * Bit-level reader for parsing H.264 NAL units.
 * Implements Exp-Golomb (UEV/SEV) decoding as per H.264 spec.
 * Uses DataView and 32-bit buffer for efficient bit operations.
 */
export class BitReader {
  private view: DataView
  private byteOffset = 0
  //private bitOffset = 0
  private bitBuffer = 0
  private bitsInBuffer = 0
  private readonly length: number

  constructor(data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    this.length = data.length
    this.fillBitBuffer()
  }

  /**
   * Fills the internal 32-bit buffer with next available bytes.
   * This reduces the number of individual byte reads needed.
   */
  private fillBitBuffer(): void {
    while (this.bitsInBuffer <= 24 && this.byteOffset < this.length) {
      this.bitBuffer = (this.bitBuffer << 8) | this.view.getUint8(this.byteOffset++)
      this.bitsInBuffer += 8
    }
  }

  /**
   * Reads specified number of bits from the stream.
   * Uses the internal 32-bit buffer for faster access.
   *
   * @param count - Number of bits to read (max 32)
   * @returns Bit value as number
   */
  readBits(count: number): number {
    if (count === 0) return 0
    if (count > 32) {
      console.debug('Attempting to read more than 32 bits')
      return 0
    }

    // Ensure we have enough bits
    if (this.bitsInBuffer < count) {
      this.fillBitBuffer()
      if (this.bitsInBuffer < count) {
        console.debug('End of buffer reached while reading bits')
        return 0
      }
    }

    // Extract bits from the buffer
    const value = (this.bitBuffer >> (this.bitsInBuffer - count)) & ((1 << count) - 1)
    this.bitsInBuffer -= count
    return value
  }

  /**
   * Reads a single bit from the stream.
   * Optimized special case of readBits(1).
   *
   * @returns Bit value (0 or 1)
   */
  readBit(): number {
    if (this.bitsInBuffer === 0) {
      this.fillBitBuffer()
      if (this.bitsInBuffer === 0) {
        console.debug('End of buffer reached while reading bit')
        return 0
      }
    }

    const bit = (this.bitBuffer >> (this.bitsInBuffer - 1)) & 1
    this.bitsInBuffer--
    return bit
  }

  /**
   * Reads an unsigned Exp-Golomb code (UEV).
   * Optimized to use readBits for the suffix.
   *
   * @returns Decoded UEV value
   */
  readUEV(): number {
    let leadingZeroBits = -1
    let bit = 0
    do {
      bit = this.readBit()
      leadingZeroBits++
    } while (bit === 0 && leadingZeroBits < 32)

    if (leadingZeroBits >= 32) {
      console.debug('Invalid UEV code - too many leading zeros')
      return 0
    }

    const suffixBits = this.readBits(leadingZeroBits)
    return (1 << leadingZeroBits) + suffixBits - 1
  }

  /**
   * Reads a signed Exp-Golomb code (SEV).
   * Uses UEV encoding with sign bit in LSB.
   *
   * @returns Decoded SEV value
   */
  readSEV(): number {
    const codeNum = this.readUEV()
    if (codeNum === 0) return 0
    const signFlag = codeNum & 1
    const magnitude = (codeNum + 1) >> 1
    return signFlag ? magnitude : -magnitude
  }

  /**
   * Skips scaling list data in SPS.
   * Used for custom quantization matrices.
   *
   * @param size - Size of scaling list (16 or 64)
   */
  skipScalingList(size: number): void {
    let lastScale = 8
    let nextScale = 8
    for (let j = 0; j < size; j++) {
      if (nextScale !== 0) {
        const deltaScale = this.readSEV()
        nextScale = (lastScale + deltaScale + 256) % 256
      }
      lastScale = nextScale === 0 ? lastScale : nextScale
    }
  }

  /**
   * Outputs debug information about reader state.
   * Includes byte/bit offsets and buffer contents.
   */
  debugState(): void {
    const nextBytes = new Array(4)
    for (let i = 0; i < 4 && this.byteOffset + i < this.length; i++) {
      nextBytes[i] = `0x${this.view.getUint8(this.byteOffset + i).toString(16)}`
    }

    console.debug('BitReader state:', {
      byteOffset: this.byteOffset,
      bitsInBuffer: this.bitsInBuffer,
      bitBuffer: `0x${this.bitBuffer.toString(16)}`,
      nextBytes,
      binaryView: nextBytes
        .map((hex) => Number.parseInt(hex.slice(2), 16).toString(2).padStart(8, '0'))
        .join(' '),
    })
  }

  /**
   * Checks if more data is available in the stream.
   *
   * @returns true if more data available, false otherwise
   */
  hasMoreData(): boolean {
    return this.bitsInBuffer > 0 || this.byteOffset < this.length
  }
}
