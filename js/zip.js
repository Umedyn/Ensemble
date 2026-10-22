// A store-only zip (no compression, no dependencies) for exporting a world
// from the creator (task 3-5), and a reader for the same format. Entries are
// { name, data: Uint8Array }; names are UTF-8. DOM-free, so Node tests can
// check it.
(function (root) {
  const E = root.Ensemble;
  const Z = (E.Zip = {});

  const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  Z.crc32 = function (bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  // UTF-8 without TextEncoder (the Node test VM has none).
  Z.utf8 = function (str) {
    const out = [];
    for (const ch of String(str)) {
      let c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  };
  Z.text = function (bytes) {
    let s = '';
    for (let i = 0; i < bytes.length;) {
      const b = bytes[i++];
      let c;
      if (b < 0x80) c = b;
      else if (b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
      else if (b < 0xf0) c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      else c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      s += String.fromCodePoint(c);
    }
    return s;
  };

  // Fixed date (1 Jan 2020), so the same files make the same zip.
  const DOS_TIME = 0, DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
  Z.build = function (entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    entries.forEach((e) => {
      const name = Z.utf8(e.name);
      const data = e.data;
      const crc = Z.crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true); // version needed
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, 0, true); // stored
      local.setUint16(10, DOS_TIME, true);
      local.setUint16(12, DOS_DATE, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true); // made by
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, DOS_TIME, true);
      cd.setUint16(14, DOS_DATE, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    });
    const cdSize = central.reduce((t, p) => t + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((t, p) => t + p.length, 0));
    let at = 0;
    all.forEach((p) => { out.set(p, at); at += p.length; });
    return out;
  };

  // Reads a store-only zip (as built above) → [{ name, data }]. Throws on a
  // compressed entry or a bad checksum.
  Z.read = function (bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let endAt = -1;
    for (let i = bytes.length - 22; i >= 0; i--) if (v.getUint32(i, true) === 0x06054b50) { endAt = i; break; }
    if (endAt < 0) throw new Error('not a zip file');
    const count = v.getUint16(endAt + 10, true);
    let p = v.getUint32(endAt + 16, true);
    const out = [];
    for (let n = 0; n < count; n++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
      const method = v.getUint16(p + 10, true);
      const crc = v.getUint32(p + 16, true);
      const size = v.getUint32(p + 20, true);
      const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
      const localAt = v.getUint32(p + 42, true);
      const name = Z.text(bytes.subarray(p + 46, p + 46 + nameLen));
      if (method !== 0) throw new Error(`${name} is compressed; only stored zips can be read`);
      const dataAt = localAt + 30 + v.getUint16(localAt + 26, true) + v.getUint16(localAt + 28, true);
      const data = bytes.slice(dataAt, dataAt + size);
      if (Z.crc32(data) !== crc) throw new Error(`${name} is damaged (checksum)`);
      out.push({ name, data });
      p += 46 + nameLen + extra + comment;
    }
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
