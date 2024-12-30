// binary-reader.ts
export class BinaryReaderImpl {
    offset = 0;
    data: Uint8Array;
    length: number;

    constructor(data: Uint8Array) {
        this.data = data;
        this.length = data.length;
    }

    read(length: number): Uint8Array {
        if (this.offset + length > this.length) {
            throw new Error('Read beyond bounds');
        }
        const result = this.data.slice(this.offset, this.offset + length);
        this.offset += length;
        return result;
    }

    readUint8(): number {
        if (this.offset + 1 > this.length) {
            throw new Error('Read beyond bounds');
        }
        const value = this.data[this.offset];
        this.offset += 1;
        return value;
    }

    readUint16(): number {
        if (this.offset + 2 > this.length) {
            throw new Error('Read beyond bounds');
        }
        const value = (this.data[this.offset] << 8) | this.data[this.offset + 1];
        this.offset += 2;
        return value;
    }

    readUint32(): number {
        if (this.offset + 4 > this.length) {
            throw new Error('Read beyond bounds');
        }
        const value = (this.data[this.offset] << 24) |
                     (this.data[this.offset + 1] << 16) |
                     (this.data[this.offset + 2] << 8) |
                      this.data[this.offset + 3];
        this.offset += 4;
        return value;
    }

    readUint64(): number {
        if (this.offset + 8 > this.length) {
            throw new Error('Read beyond bounds');
        }
        // Read high and low 32-bit parts
        const high = this.readUint32();
        const low = this.readUint32();

        // For duration values, we usually don't need the full 64-bit precision
        // We can safely handle it as a number since duration won't exceed Number.MAX_SAFE_INTEGER
        return high * Math.pow(2, 32) + low;
    }

    readString(length: number): string {
        const data = this.read(length);
        return new TextDecoder().decode(data);
    }

    seek(offset: number): void {
        if (offset < 0 || offset > this.length) {
            throw new Error('Seek beyond bounds');
        }
        this.offset = offset;
    }

    skip(length: number): void {
        const newOffset = this.offset + length;
        if (newOffset < 0 || newOffset > this.length) {
            throw new Error('Skip beyond bounds');
        }
        this.offset = newOffset;
    }

    remaining(): number {
        return this.length - this.offset;
    }

    canRead(length: number): boolean {
        return this.offset + length <= this.length;
    }

    readVint(): number {
        if (this.offset >= this.length) {
            throw new Error('Read beyond bounds');
        }

        const first = this.readUint8();
        let length = 1;

        // Count leading zeros to determine length
        for (let i = 7; i >= 0; i--) {
            if ((first & (1 << i)) !== 0) {
                length = 8 - i;
                break;
            }
        }

        let value = first & ((1 << (8 - length)) - 1);
        for (let i = 1; i < length; i++) {
            if (this.offset >= this.length) {
                throw new Error('Read beyond bounds');
            }
            value = (value << 8) | this.readUint8();
        }

        return value;
    }
}