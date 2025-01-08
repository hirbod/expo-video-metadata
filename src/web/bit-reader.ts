/**
 * Bit-level reader for parsing H.264 NAL units.
 * Implements Exp-Golomb (UEV/SEV) decoding as per H.264 spec.
 * Uses DataView and 32-bit buffer for efficient bit operations.
 */
export class BitReader {
  private data: Uint8Array
  private offset = 0
  private bitOffset = 0

  constructor(data: Uint8Array) {
    this.data = data
  }

  public readBit(): number {
    if (this.offset >= this.data.length) {
      console.debug('End of buffer reached while reading bits')
      return 0
    }

    const bit = (this.data[this.offset] >> (7 - this.bitOffset)) & 0x01
    this.bitOffset++
    if (this.bitOffset === 8) {
      this.bitOffset = 0
      this.offset++
    }
    return bit
  }

  public readBits(count: number): number {
    let result = 0
    for (let i = 0; i < count; i++) {
      result = (result << 1) | this.readBit()
    }
    return result
  }

  public readUEV(): number {
    let leadingZeros = 0
    while (leadingZeros < 32 && this.readBit() === 0) {
      leadingZeros++
    }

    if (leadingZeros >= 32) {
      throw new Error('Invalid UEV value - too many leading zeros')
    }

    let result = 1
    for (let i = 0; i < leadingZeros; i++) {
      result = (result << 1) | this.readBit()
    }

    return result - 1
  }

  public readSEV(): number {
    const value = this.readUEV()
    if (value === 0) return 0
    const sign = value & 1 ? 1 : -1
    return sign * ((value + 1) >> 1)
  }

  public skipBits(count: number): void {
    this.bitOffset += count
    while (this.bitOffset >= 8) {
      this.offset++
      this.bitOffset -= 8
    }
  }

  public skipScalingList(size: number): void {
    let lastScale = 8
    let nextScale = 8
    for (let i = 0; i < size; i++) {
      if (nextScale !== 0) {
        const deltaScale = this.readSEV()
        nextScale = (lastScale + deltaScale + 256) % 256
      }
      lastScale = nextScale === 0 ? lastScale : nextScale
    }
  }

  public remainingBits(): number {
    return (this.data.length - this.offset) * 8 - this.bitOffset
  }

  public currentByte(): number {
    return this.offset < this.data.length ? this.data[this.offset] : 0
  }

  public currentPosition(): number {
    return this.offset
  }

  public peekBits(count: number): number {
    const savedOffset = this.offset
    const savedBitOffset = this.bitOffset
    const value = this.readBits(count)
    this.offset = savedOffset
    this.bitOffset = savedBitOffset
    return value
  }
}
