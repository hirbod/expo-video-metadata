// binary-reader.ts
export class BinaryReaderImpl {
  offset = 0
  data: Uint8Array
  length: number

  constructor(data: Uint8Array) {
    this.data = data
    this.length = data.length
  }

  read(length: number): Uint8Array {
    if (this.offset + length > this.length) {
      throw new Error('Read beyond bounds')
    }
    const result = this.data.slice(this.offset, this.offset + length)
    this.offset += length
    return result
  }

  readUint8(): number {
    if (this.offset + 1 > this.length) {
      throw new Error('Read beyond bounds')
    }
    const value = this.data[this.offset]
    this.offset += 1
    return value
  }

  readUint16(): number {
    if (this.offset + 2 > this.length) {
      throw new Error('Read beyond bounds')
    }
    const value = (this.data[this.offset] << 8) | this.data[this.offset + 1]
    this.offset += 2
    return value
  }

  readUint32(): number {
    if (this.offset + 4 > this.length) {
      throw new Error('Read beyond bounds')
    }
    const value =
      (this.data[this.offset] << 24) |
      (this.data[this.offset + 1] << 16) |
      (this.data[this.offset + 2] << 8) |
      this.data[this.offset + 3]
    this.offset += 4
    return value
  }

  readUint64(): number {
    if (this.offset + 8 > this.length) {
      throw new Error('Read beyond bounds')
    }
    // Read high and low 32-bit parts
    const high = this.readUint32()
    const low = this.readUint32()

    // For duration values, we usually don't need the full 64-bit precision
    // We can safely handle it as a number since duration won't exceed Number.MAX_SAFE_INTEGER
    return high * 2 ** 32 + low
  }

  readString(length: number): string {
    const data = this.read(length)
    return new TextDecoder().decode(data)
  }

  seek(offset: number): void {
    if (offset < 0 || offset > this.length) {
      throw new Error('Seek beyond bounds')
    }
    this.offset = offset
  }

  skip(length: number): void {
    const newOffset = this.offset + length
    if (newOffset < 0 || newOffset > this.length) {
      throw new Error('Skip beyond bounds')
    }
    this.offset = newOffset
  }

  remaining(): number {
    return this.length - this.offset
  }

  canRead(length: number): boolean {
    return this.offset + length <= this.length
  }

  readVint(): number {
    if (!this.canRead(1)) {
      throw new Error('Cannot read VINT')
    }

    const firstByte = this.data[this.offset]
    //console.log('VINT first byte:', firstByte.toString(16))

    // Special handling for known 4-byte IDs
    if (this.canRead(4)) {
      if (firstByte === 0x1a) {
        this.offset++
        const id =
          (0x1a << 24) | (this.readUint8() << 16) | (this.readUint8() << 8) | this.readUint8()
        console.log('Found EBML ID:', id.toString(16))
        return id
      }

      if (firstByte === 0x18) {
        this.offset++
        const id =
          (0x18 << 24) | (this.readUint8() << 16) | (this.readUint8() << 8) | this.readUint8()
        //console.log('Found Segment ID:', id.toString(16))
        return id
      }

      if (firstByte === 0x16) {
        this.offset++
        const id =
          (0x16 << 24) | (this.readUint8() << 16) | (this.readUint8() << 8) | this.readUint8()
        //console.log('Found Tracks ID:', id.toString(16))
        return id
      }
    }

    this.offset++

    // Count leading zeros
    let length = 1
    for (let mask = 0x80; mask !== 0; mask >>= 1) {
      if ((firstByte & mask) !== 0) break
      length++
    }

    //console.log('VINT length:', length)
    let value = firstByte & (0xff >> length)

    // Read remaining bytes
    for (let i = 1; i < length; i++) {
      if (!this.canRead(1)) break
      value = (value << 8) | this.readUint8()
    }

    //console.log('VINT final value:', value.toString(16))
    return value
  }

  readEbmlSize(): number {
    const firstByte = this.readUint8()
    let length = 1

    for (let i = 7; i >= 0; i--) {
      if ((firstByte & (1 << i)) !== 0) break
      length++
    }

    let size = firstByte & ((1 << (8 - length)) - 1)
    for (let i = 1; i < length; i++) {
      size = (size << 8) | this.readUint8()
    }

    // Validate size
    if (size > this.remaining()) {
      return this.remaining()
    }

    return size
  }
}
