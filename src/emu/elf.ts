/** Minimal ELF32 little-endian loader: loadable segments plus the symbol table. */

export interface ElfSegment {
  /** Load (physical) address: where the bytes live in flash. */
  paddr: number;
  vaddr: number;
  data: Uint8Array;
  memSize: number;
}

export interface ElfSymbol {
  name: string;
  addr: number;
  size: number;
  type: 'func' | 'object' | 'other';
}

export interface ElfImage {
  entry: number;
  segments: ElfSegment[];
  symbols: ElfSymbol[];
}

export function parseElf(bytes: Uint8Array): ElfImage {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 52 || dv.getUint32(0, false) !== 0x7f454c46) throw new Error('Not an ELF file');
  if (bytes[4] !== 1 || bytes[5] !== 1) throw new Error('Expected a 32-bit little-endian ELF file');
  if (dv.getUint16(18, true) !== 40) throw new Error('ELF file is not for ARM');

  const entry = dv.getUint32(24, true);
  const phoff = dv.getUint32(28, true);
  const shoff = dv.getUint32(32, true);
  const phentsize = dv.getUint16(42, true);
  const phnum = dv.getUint16(44, true);
  const shentsize = dv.getUint16(46, true);
  const shnum = dv.getUint16(48, true);

  const segments: ElfSegment[] = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (dv.getUint32(o, true) !== 1) continue; // PT_LOAD
    const offset = dv.getUint32(o + 4, true);
    const vaddr = dv.getUint32(o + 8, true);
    const paddr = dv.getUint32(o + 12, true);
    const filesz = dv.getUint32(o + 16, true);
    const memsz = dv.getUint32(o + 20, true);
    if (filesz === 0) continue;
    segments.push({ paddr, vaddr, data: bytes.subarray(offset, offset + filesz), memSize: memsz });
  }

  const symbols: ElfSymbol[] = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    if (dv.getUint32(o + 4, true) !== 2) continue; // SHT_SYMTAB
    const symOff = dv.getUint32(o + 16, true);
    const symSize = dv.getUint32(o + 20, true);
    const strSec = shoff + dv.getUint32(o + 24, true) * shentsize;
    const strOff = dv.getUint32(strSec + 16, true);
    const dec = new TextDecoder();
    for (let s = symOff; s + 16 <= symOff + symSize; s += 16) {
      const nameIdx = dv.getUint32(s, true);
      const info = bytes[s + 12];
      const t = info & 15;
      if (nameIdx === 0 || (t !== 1 && t !== 2 && t !== 0)) continue;
      if (dv.getUint16(s + 14, true) === 0) continue; // undefined section
      let e = strOff + nameIdx;
      while (bytes[e] !== 0) e++;
      const name = dec.decode(bytes.subarray(strOff + nameIdx, e));
      if (name.startsWith('$')) continue; // ARM mapping symbols
      symbols.push({
        name,
        addr: dv.getUint32(s + 4, true),
        size: dv.getUint32(s + 8, true),
        type: t === 2 ? 'func' : t === 1 ? 'object' : 'other',
      });
    }
  }
  return { entry, segments, symbols };
}

/** Find the function containing a code address. */
export function symbolAt(image: ElfImage, addr: number): ElfSymbol | null {
  const a = addr & ~1;
  let best: ElfSymbol | null = null;
  for (const s of image.symbols) {
    if (s.type !== 'func') continue;
    const start = s.addr & ~1;
    if (a >= start && a < start + Math.max(s.size, 2)) {
      if (!best || s.size < best.size) best = s;
    }
  }
  return best;
}

/** Copy the loadable segments of an image into flash (or RAM). Returns false if something does not fit. */
export function loadImage(
  image: ElfImage,
  flash: Uint8Array,
  flashBase: number,
  ram: Uint8Array,
  ramBase: number,
): boolean {
  let ok = true;
  flash.fill(0xff);
  for (const seg of image.segments) {
    const fo = seg.paddr - flashBase;
    const ro = seg.paddr - ramBase;
    if (fo >= 0 && fo + seg.data.length <= flash.length) flash.set(seg.data, fo);
    else if (ro >= 0 && ro + seg.data.length <= ram.length) ram.set(seg.data, ro);
    else ok = false;
  }
  return ok;
}
