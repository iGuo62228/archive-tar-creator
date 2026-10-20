/**
 * TarCreator — a minimal, dependency-free USTAR tar archive stream builder.
 *
 * Design choices:
 *   • Synchronous, string-or-buffer assembly returning a Uint8Array. The Node
 *     `Buffer` type is deliberately avoided so the core logic is portable to
 *     any Uint8Array-compatible environment, which is why we use DataView and
 *     Array.prototype.fill for zeroing.
 *   • USTAR headers are written per POSIX-1.1988. PAX/GNU extensions are out of
 *     scope — if a name (file path) exceeds 100 bytes the header will be marked
 *     invalid by the size fields and the entry will be skipped. This keeps the
 *     output byte-identical regardless of host architecture.
 *   • Directory entries carry a size of 0 and a typeflag of '5'. The path is
 *     stored without a trailing slash; the typeflag alone determines directory
 *     status.
 *   • mtime is taken as a constructor argument (a number or a function returning
 *     a number) so tests can be fully deterministic.
 *   • Numeric fields use the USTAR-style 6/11-digit octal representation with a
 *     trailing NUL so the produced archives can be extracted by `tar`, busybox,
 *     and 7-Zip without extension negotiation.
 */

const USTAR_MAGIC = 'ustar';
const USTAR_VERSION = '00';
const BLOCK_SIZE = 512;
const MAX_NAME_LEN = 100;

/**
 * Encode an ASCII string into a Uint8Array.
 * @param {string} str
 * @returns {Uint8Array}
 */
function asciiToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Write a raw byte slice into the header buffer at the given offset, padding the
 * remaining region with NULs. Truncating is not performed — names that don't
 * fit must be rejected at the caller level.
 *
 * @param {Uint8Array} buf
 * @param {number} offset
 * @param {Uint8Array} data
 * @param {number} fieldSize
 */
function writeRaw(buf, offset, data, fieldSize) {
  if (data.length > fieldSize) {
    throw new RangeError(`field value (${data.length} bytes) exceeds field size (${fieldSize})`);
  }
  for (let i = 0; i < data.length; i++) {
    buf[offset + i] = data[i];
  }
  // Remaining bytes in the field are already zero from allocation.
}

/**
 * Write a numeric octal field. USTAR uses base-8 with a trailing NUL (or space).
 * We use a trailing NUL to match the historical POSIX convention so the numeric
 * length is fieldSize - 1.
 *
 * @param {Uint8Array} buf
 * @param {number} offset
 * @param {number} value
 * @param {number} fieldSize
 */
function writeOctal(buf, offset, value, fieldSize) {
  const s = value.toString(8);
  // fieldSize - 1 digits max, plus a trailing NUL.
  if (s.length > fieldSize - 1) {
    throw new RangeError(`octal value '${s}' does not fit in ${fieldSize} bytes`);
  }
  const sBytes = asciiToBytes(s);
  writeRaw(buf, offset, sBytes, fieldSize - 1);
  buf[offset + fieldSize - 1] = 0;
}

/**
 * Compute the unsigned 8-bit checksum of a 512-byte header block. The checksum
 * field itself (8 bytes at offset 148) is treated as ASCII spaces during the
 * computation, per the USTAR specification.
 *
 * @param {Uint8Array} block
 * @returns {number}
 */
function headerChecksum(block) {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (i >= 148 && i < 156) {
      sum += 32; // space
    } else {
      sum += block[i];
    }
  }
  return sum & 0xffffffff;
}

/**
 * Build one USTAR header block for a file entry.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {number} opts.size
 * @param {number} opts.mtime
 * @param {number} [opts.mode]
 * @param {string} [opts.typeflag]
 * @param {string} [opts.uname]
 * @param {string} [opts.gname]
 * @returns {Uint8Array}
 */
function buildHeader(opts) {
  const header = new Uint8Array(BLOCK_SIZE);
  const nameBytes = asciiToBytes(opts.name);
  if (nameBytes.length > MAX_NAME_LEN) {
    throw new RangeError(`name '${opts.name}' exceeds ${MAX_NAME_LEN} bytes`);
  }
  writeRaw(header, 0, nameBytes, 100);
  writeOctal(header, 100, opts.mode, 8);
  writeOctal(header, 108, 0, 8);  // uid
  writeOctal(header, 116, 0, 8);  // gid
  writeOctal(header, 124, opts.size, 12);
  writeOctal(header, 136, opts.mtime, 12);
  // Checksum placeholder: 8 ASCII spaces, computed below.
  for (let i = 148; i < 156; i++) header[i] = 32;
  header[156] = opts.typeflag ? opts.typeflag.charCodeAt(0) : 0;
  // Link name (unused for regular files/directories): leave as NULs.
  writeRaw(header, 257, asciiToBytes(USTAR_MAGIC), 6);
  writeRaw(header, 263, asciiToBytes(USTAR_VERSION), 2);
  if (opts.uname) writeRaw(header, 265, asciiToBytes(opts.uname), 32);
  if (opts.gname) writeRaw(header, 297, asciiToBytes(opts.gname), 32);
  // devmajor/devminor: zero octal, already zeroed.
  const checksum = headerChecksum(header);
  const csStr = asciiToBytes(checksum.toString(8));
  // 6 digits + NUL + space is the USTAR layout; we write 6 octal digits,
  // a NUL, and a space.
  writeRaw(header, 148, csStr, 6);
  header[154] = 0;   // NUL
  header[155] = 32;  // space
  return header;
}

/**
 * Pad `data` up to a multiple of BLOCK_SIZE with trailing NULs.
 *
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function padToBlock(data) {
  const remainder = data.length % BLOCK_SIZE;
  if (remainder === 0) return data;
  const padded = new Uint8Array(data.length + (BLOCK_SIZE - remainder));
  padded.set(data, 0);
  return padded;
}

/**
 * Concatenate a list of Uint8Array chunks into one buffer.
 *
 * @param {Uint8Array[]} chunks
 * @returns {Uint8Array}
 */
function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export class TarCreator {
  /**
   * @param {object} [opts]
   * @param {number | (() => number)} [opts.mtime] Default modification time
   *   (Unix seconds) for entries that don't specify one. May be a function so
   *   callers can supply a deterministic clock for tests.
   * @param {string} [opts.uname] Default owner name written into USTAR headers.
   * @param {string} [opts.gname] Default group name written into USTAR headers.
   */
  constructor(opts = {}) {
    this.mtime = opts.mtime ?? 0;
    this.uname = opts.uname ?? '';
    this.gname = opts.gname ?? '';
    this.entries = [];
  }

  /**
   * Resolve the mtime for an entry using the instance default.
   *
   * @param {number | undefined} entryMtime
   * @returns {number}
   */
  _resolveMtime(entryMtime) {
    if (entryMtime !== undefined) return entryMtime;
    return typeof this.mtime === 'function' ? this.mtime() : this.mtime;
  }

  /**
   * Add a regular file to the archive.
   *
   * @param {string} name Path stored in the header. Must be ≤ 100 ASCII bytes.
   * @param {string | Uint8Array | ArrayBuffer} content File body.
   * @param {object} [opts]
   * @param {number} [opts.mtime]
   * @param {number} [opts.mode] File mode bits (default 0o644).
   * @param {string} [opts.uname]
   * @param {string} [opts.gname]
   */
  addFile(name, content, opts = {}) {
    const data = content instanceof Uint8Array
      ? content
      : content instanceof ArrayBuffer
        ? new Uint8Array(content)
        : new Uint8Array(asciiToBytes(String(content)));
    if (data.length > 0o77777777777) {
      throw new RangeError('file size exceeds USTAR 11-octal-digit limit');
    }
    const mtime = this._resolveMtime(opts.mtime);
    const header = buildHeader({
      name,
      size: data.length,
      mtime,
      mode: opts.mode ?? 0o644,
      typeflag: '0',
      uname: opts.uname ?? this.uname,
      gname: opts.gname ?? this.gname,
    });
    this.entries.push(header, padToBlock(data));
  }

  /**
   * Add a directory entry. Directories have size 0 and typeflag '5'.
   *
   * @param {string} name Directory path without trailing slash.
   * @param {object} [opts]
   * @param {number} [opts.mtime]
   * @param {number} [opts.mode] Directory mode bits (default 0o755).
   * @param {string} [opts.uname]
   * @param {string} [opts.gname]
   */
  addDirectory(name, opts = {}) {
    const clean = name.replace(/\/+$/, '');
    if (clean.length === 0) {
      throw new TypeError('directory name must not be empty');
    }
    const mtime = this._resolveMtime(opts.mtime);
    const header = buildHeader({
      name: clean,
      size: 0,
      mtime,
      mode: opts.mode ?? 0o755,
      typeflag: '5',
      uname: opts.uname ?? this.uname,
      gname: opts.gname ?? this.gname,
    });
    this.entries.push(header);
  }

  /**
   * Assemble the archive as a Uint8Array. Two trailing zero blocks terminate
   * the archive per the USTAR specification.
   *
   * @returns {Uint8Array}
   */
  finalize() {
    const out = concat(this.entries);
    // Two empty blocks signal end-of-archive.
    const terminator = new Uint8Array(BLOCK_SIZE * 2);
    return concat([out, terminator]);
  }
}
