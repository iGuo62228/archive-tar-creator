# archive-tar-creator

Bundles files and directories into a tar archive stream with USTAR header formatting.

```js
import { TarCreator } from 'archive-tar-creator';

const tar = new TarCreator({ mtime: 1700000000, uname: 'root', gname: 'root' });
tar.addFile('docs/readme.md', '# Tar Creator');
tar.addDirectory('logs');
tar.addFile('logs/run.txt', 'ok\n', { mtime: 1700000001 });

const archive = tar.finalize(); // Uint8Array
```

## Why

This library exists for the narrow case where you need to emit a USTAR archive
in a Node environment without pulling in a full tar implementation. It writes
exactly the POSIX.1-1988 header format — no PAX, no GNU long-name extensions.

The trade-off is simplicity over reach: any file path longer than 100 ASCII
bytes is rejected with a `RangeError`, and numeric fields use the classic octal
representation, so file sizes are capped at 8 GB and timestamps at the 33-bit
octal limit. If you need long names or huge files, use a full-featured tar
library; this one will not silently degrade.

## Edge cases

- `addDirectory` strips trailing slashes and stores the name without them; the
  `5` typeflag alone marks the entry as a directory.
- `mtime` may be a number or a function. Passing a function lets tests be fully
deterministic — the library never reads the wall clock.
- `addFile` accepts strings, `Uint8Array`, or `ArrayBuffer`. Strings are encoded
  as raw bytes (Latin-1 / code-unit-wise), not UTF-8, to keep header field
  arithmetic predictable.

## Exports

- `TarCreator` — class. Constructor accepts `{ mtime, uname, gname }`.
  - `addFile(name, content, opts?)` — opts: `{ mtime, mode, uname, gname }`.
  - `addDirectory(name, opts?)` — same opts shape, minus content.
  - `finalize()` — returns a `Uint8Array` containing the full archive.
