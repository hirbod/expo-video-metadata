// binary-reader.ts

/**
 * Reusable TextDecoder instance for string conversions.
 * Using a single instance is more efficient than creating a new one for each conversion.
 */
const textDecoder = new TextDecoder()

/**
 * Implementation of a binary reader for parsing video container formats.
 * Provides methods to read various integer types and strings from binary data.
 * Handles both big-endian and little-endian formats as needed.
 */
export class BinaryReaderImpl {
  private _offset = 0
  private readonly _data: Uint8Array
  private readonly _length: number

  constructor(data: Uint8Array) {
    this._data = data
    this._length = data.length
  }

  // Public getters for read-only access to internal state
  public get offset(): number {
    return this._offset
  }

  public get data(): Uint8Array {
    return this._data
  }

  public get length(): number {
    return this._length
  }

  /**
   * Ensures that the requested number of bytes can be read from the current position.
   * Throws an error if reading would exceed the buffer bounds.
   * @param length - Number of bytes to check
   * @throws Error if reading would exceed buffer bounds
   */
  private assertCanRead(length: number): void {
    if (this._offset + length > this._length) {
      throw new Error(`Cannot read ${length} bytes at offset ${this._offset}`)
    }
  }

  /**
   * Reads a specified number of bytes from the current position.
   * @param length - Number of bytes to read
   * @returns Uint8Array containing the read bytes
   */
  read(length: number): Uint8Array {
    this.assertCanRead(length)
    const result = this._data.slice(this._offset, this._offset + length)
    this._offset += length
    return result
  }

  /**
   * Reads an unsigned 8-bit integer (1 byte).
   * Range: 0 to 255
   * Common uses: flags, small counts, ASCII characters
   * @returns number The read uint8 value
   */
  readUint8(): number {
    this.assertCanRead(1)
    const value = this._data[this._offset]
    this._offset += 1
    return value
  }

  /**
   * Reads an unsigned 16-bit integer (2 bytes) in big-endian format.
   * Range: 0 to 65,535
   * Common uses: pixel dimensions, port numbers, Unicode characters
   * @returns number The read uint16 value
   */
  readUint16(): number {
    this.assertCanRead(2)
    // Combine two bytes: first byte shifted left 8 bits | second byte
    // Example: 0x1234 = (0x12 << 8) | 0x34
    const value = (this._data[this._offset] << 8) | this._data[this._offset + 1]
    this._offset += 2
    return value
  }

  /**
   * Reads an unsigned 32-bit integer (4 bytes) in big-endian format.
   * Range: 0 to 4,294,967,295
   * Common uses: file sizes, timestamps, color values
   * @returns number The read uint32 value
   */
  readUint32(): number {
    this.assertCanRead(4)
    // Combine four bytes with shifts and bitwise OR
    // Example: 0x12345678 = (0x12 << 24) | (0x34 << 16) | (0x56 << 8) | 0x78
    const value =
      (this._data[this._offset] << 24) |
      (this._data[this._offset + 1] << 16) |
      (this._data[this._offset + 2] << 8) |
      this._data[this._offset + 3]
    this._offset += 4
    return value
  }

  /**
   * Reads an unsigned 64-bit integer (8 bytes) in big-endian format.
   * Returns as BigInt to handle values beyond JavaScript's Number.MAX_SAFE_INTEGER
   * Common uses: file sizes > 4GB, high-precision timestamps
   * @returns number The read uint64 value converted to number
   */
  readUint64(): number {
    this.assertCanRead(8)
    // Split into high and low 32-bit values
    const high = BigInt(this.readUint32())
    const low = BigInt(this.readUint32())
    const value = (high << 32n) + low // Combine using BigInt arithmetic
    // Convert back to number, but check for safe integer range
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      console.warn('Uint64 value exceeds safe integer range, precision may be lost')
    }
    return Number(value)
  }

  /**
   * Reads a string of specified length using UTF-8 encoding.
   * @param length - Number of bytes to read
   * @returns string The decoded UTF-8 string
   */
  readString(length: number): string {
    const data = this.read(length)
    return textDecoder.decode(data)
  }

  /**
   * Sets the read position to a specific offset.
   * @param offset - The offset to seek to
   * @throws Error if offset is invalid
   */
  seek(offset: number): void {
    if (offset < 0 || offset > this._length) {
      throw new Error(`Invalid seek position: ${offset}`)
    }
    this._offset = offset
  }

  /**
   * Skips a specified number of bytes.
   * @param length - Number of bytes to skip
   * @throws Error if skip would exceed buffer bounds
   */
  skip(length: number): void {
    const newOffset = this._offset + length
    if (newOffset < 0 || newOffset > this._length) {
      throw new Error(`Invalid skip length: ${length}`)
    }
    this._offset = newOffset
  }

  /**
   * Returns the number of remaining bytes that can be read.
   * @returns number Number of remaining bytes
   */
  remaining(): number {
    return this._length - this._offset
  }

  /**
   * Checks if a specified number of bytes can be read from current position.
   * @param length - Number of bytes to check
   * @returns boolean True if bytes can be read, false otherwise
   */
  canRead(length: number): boolean {
    return this._offset + length <= this._length
  }

  /**
   * Reads a variable-length integer (VINT) as used in EBML format.
   * EBML VINT format:
   * - First byte determines length by position of first set bit
   * - Remaining bytes contain the value
   * Example:
   * 1xxx xxxx                   - 1 byte  (value 0 to 2^7-1)
   * 01xx xxxx  xxxx xxxx       - 2 bytes (value 0 to 2^14-1)
   * 001x xxxx  xxxx xxxx  xxxx xxxx    - 3 bytes (value 0 to 2^21-1)
   * ...and so on
   * @returns number The read VINT value
   */
  readVint(): number {
    this.assertCanRead(1)
    const firstByte = this._data[this._offset]

    // Special handling for known 4-byte IDs in EBML
    // 0x1a = EBML element
    // 0x18 = Segment element
    // 0x16 = Tracks element
    if (this.canRead(4)) {
      if (firstByte === 0x1a || firstByte === 0x18 || firstByte === 0x16) {
        this._offset++
        return (
          (firstByte << 24) | (this.readUint8() << 16) | (this.readUint8() << 8) | this.readUint8()
        )
      }
    }

    this._offset++

    // Count leading zeros to determine length
    let length = 1
    for (let mask = 0x80; mask !== 0; mask >>= 1) {
      if ((firstByte & mask) !== 0) break
      length++
    }

    // Extract value bits from first byte
    // Example: for 2-byte VINT (0b01xx xxxx), mask is 0b0011 1111
    let value = firstByte & (0xff >> length)

    // Read remaining bytes
    for (let i = 1; i < length; i++) {
      if (!this.canRead(1)) break
      value = (value << 8) | this.readUint8()
    }

    return value
  }

  /**
   * Reads an EBML size field.
   * Similar to VINT but used specifically for element sizes.
   * The number of size octets is encoded in the first byte:
   * - All bits 1: size unknown
   * - First bit 0: that position indicates size octets
   * Example:
   * 1xxx xxxx                   - 1 byte
   * 01xx xxxx  xxxx xxxx       - 2 bytes
   * 001x xxxx  xxxx xxxx  xxxx xxxx    - 3 bytes
   * @returns number The read size value
   */
  readEbmlSize(): number {
    const firstByte = this.readUint8()
    let length = 1

    // Count leading zeros to determine length
    for (let i = 7; i >= 0; i--) {
      if ((firstByte & (1 << i)) !== 0) break
      length++
    }

    // Extract size value
    let size = firstByte & ((1 << (8 - length)) - 1)
    for (let i = 1; i < length; i++) {
      size = (size << 8) | this.readUint8()
    }

    // Size cannot exceed remaining bytes
    return Math.min(size, this.remaining())
  }
}
