import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TarCreator } from '../src/index.js';

const BLOCK = 512;

function readOctal(buf, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = buf[off + i];
    if (c === 0 || c === 32) break;
    s += String.fromCharCode(c);
  }
  return parseInt(s, 8);
}

function readAscii(buf, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = buf[off + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function headerChecksum(buf) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    if (i >= 148 && i < 156) sum += 32;
    else sum += buf[i];
  }
  return sum;
}

test('writes a regular file header and content padded to 512', () => {
  const tar = new TarCreator({ mtime: 1700000000 });
  tar.addFile('hello.txt', 'hi');
  const out = tar.finalize();
  // header + padded content (510 bytes) + terminator (1024)
  assert.equal(out.length, BLOCK + BLOCK + BLOCK * 2);
  assert.equal(readAscii(out, 0, 100), 'hello.txt');
  assert.equal(readOctal(out, 124, 12), 2);
  assert.equal(out[156], '0'.charCodeAt(0));
  assert.equal(readAscii(out, 257, 6), 'ustar');
  assert.equal(headerChecksum(out.slice(0, BLOCK)), readOctal(out, 148, 8));
  assert.equal(out[BLOCK], 'h'.charCodeAt(0));
  assert.equal(out[BLOCK + 1], 'i'.charCodeAt(0));
});

test('finalized archive ends with two zero blocks', () => {
  const tar = new TarCreator({ mtime: 0 });
  const out = tar.finalize();
  const lastTwo = out.slice(out.length - BLOCK * 2);
  for (let i = 0; i < lastTwo.length; i++) assert.equal(lastTwo[i], 0);
});

test('directory entry has size 0 and typeflag 5', () => {
  const tar = new TarCreator({ mtime: 0 });
  tar.addDirectory('docs/');
  const out = tar.finalize();
  assert.equal(readAscii(out, 0, 100), 'docs');
  assert.equal(readOctal(out, 124, 12), 0);
  assert.equal(out[156], '5'.charCodeAt(0));
});

test('addDirectory rejects empty names', () => {
  const tar = new TarCreator();
  assert.throws(() => tar.addDirectory(''), TypeError);
  assert.throws(() => tar.addDirectory('/'), TypeError);
});

test('default file mode is 0o644 and directory mode is 0o755', () => {
  const tar = new TarCreator({ mtime: 0 });
  tar.addFile('a.txt', 'x');
  tar.addDirectory('d');
  const out = tar.finalize();
  assert.equal(readOctal(out, 100, 8), 0o644);
  assert.equal(readOctal(out, BLOCK * 2 + 100, 8), 0o755);
});

test('uname and gname are written when provided', () => {
  const tar = new TarCreator({ mtime: 0, uname: 'alice', gname: 'staff' });
  tar.addFile('f.txt', 'x');
  const out = tar.finalize();
  assert.equal(readAscii(out, 265, 32), 'alice');
  assert.equal(readAscii(out, 297, 32), 'staff');
});

test('mtime function is called for entries without explicit mtime', () => {
  let calls = 0;
  const tar = new TarCreator({ mtime: () => { calls++; return 1234567; } });
  tar.addFile('a.txt', 'x');
  tar.addFile('b.txt', 'y');
  const out = tar.finalize();
  assert.equal(calls, 2);
  assert.equal(readOctal(out, 136, 12), 1234567);
});

test('entry-level mtime overrides the default', () => {
  const tar = new TarCreator({ mtime: 1 });
  tar.addFile('a.txt', 'x', { mtime: 999 });
  const out = tar.finalize();
  assert.equal(readOctal(out, 136, 12), 999);
});

test('multiple entries are concatenated in order', () => {
  const tar = new TarCreator({ mtime: 0 });
  tar.addFile('first.txt', 'AAAA');
  tar.addDirectory('sub');
  tar.addFile('second.txt', 'BB');
  const out = tar.finalize();
  // first header @ 0, first data (512) @ 512, dir header @ 1024,
  // second header @ 1536, second data (512) @ 2048, terminator @ 2560
  assert.equal(readAscii(out, 0, 100), 'first.txt');
  assert.equal(out[156], '0'.charCodeAt(0));
  assert.equal(readAscii(out, 1024, 100), 'sub');
  assert.equal(out[1024 + 156], '5'.charCodeAt(0));
  assert.equal(readAscii(out, 1536, 100), 'second.txt');
  assert.equal(readOctal(out, 1536 + 124, 12), 2);
});

test('Uint8Array content is passed through verbatim', () => {
  const tar = new TarCreator({ mtime: 0 });
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  tar.addFile('bin.dat', bytes);
  const out = tar.finalize();
  assert.equal(readOctal(out, 124, 12), 6);
  for (let i = 0; i < bytes.length; i++) {
    assert.equal(out[BLOCK + i], bytes[i]);
  }
});

test('ArrayBuffer content is accepted', () => {
  const tar = new TarCreator({ mtime: 0 });
  const buf = new ArrayBuffer(3);
  new Uint8Array(buf).set([10, 20, 30]);
  tar.addFile('ab.dat', buf);
  const out = tar.finalize();
  assert.equal(readOctal(out, 124, 12), 3);
  assert.deepEqual(Array.from(out.slice(BLOCK, BLOCK + 3)), [10, 20, 30]);
});

test('names longer than 100 bytes are rejected', () => {
  const tar = new TarCreator({ mtime: 0 });
  const longName = 'x'.repeat(101);
  assert.throws(() => tar.addFile(longName, 'y'), RangeError);
});

test('header checksum is valid for a realistic file', () => {
  const tar = new TarCreator({ mtime: 1700000000, uname: 'root', gname: 'root' });
  tar.addFile('docs/readme.md', '# Tar Creator\n\nA small USTAR writer.\n', { mode: 0o600 });
  const out = tar.finalize();
  const block = out.slice(0, BLOCK);
  const stored = readOctal(block, 148, 8);
  assert.equal(headerChecksum(block), stored);
});

test('trailing slash is stripped from directory names', () => {
  const tar = new TarCreator({ mtime: 0 });
  tar.addDirectory('dir//');
  const out = tar.finalize();
  assert.equal(readAscii(out, 0, 100), 'dir');
});
