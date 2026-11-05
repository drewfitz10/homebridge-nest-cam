interface Box {
  type: string;
  start: number;
  end: number;
  data: number;
}
const boxes = (buffer: Buffer, start = 0, end = buffer.length): Box[] => {
  const result: Box[] = [];
  while (start < end) {
    if (end - start < 8) throw new Error('Truncated MP4 box');
    let size = buffer.readUInt32BE(start);
    let header = 8;
    if (size === 1) {
      if (end - start < 16) throw new Error('Truncated extended MP4 box');
      size = Number(buffer.readBigUInt64BE(start + 8));
      header = 16;
    }
    if (size < header || start + size > end) throw new Error('Invalid MP4 box length');
    result.push({
      type: buffer.toString('ascii', start + 4, start + 8),
      start,
      end: start + size,
      data: start + header,
    });
    start += size;
  }
  return result;
};
const children = (buffer: Buffer, box: Box): Box[] => boxes(buffer, box.data, box.end);

/** Give each HKSV event its own media timeline while preserving A/V offsets. */
export class RecordingTimeline {
  private readonly timescales = new Map<number, number>();
  private origin?: number;
  private sequence = 0;
  constructor(initialization: Buffer) {
    for (const movie of boxes(initialization).filter((b) => b.type === 'moov')) {
      for (const track of children(initialization, movie).filter((b) => b.type === 'trak')) {
        const parts = children(initialization, track);
        const tkhd = parts.find((b) => b.type === 'tkhd');
        const mdia = parts.find((b) => b.type === 'mdia');
        const mdhd = mdia && children(initialization, mdia).find((b) => b.type === 'mdhd');
        if (!tkhd || !mdhd) continue;
        const id = initialization.readUInt32BE(tkhd.data + (initialization[tkhd.data] === 1 ? 20 : 12));
        const scale = initialization.readUInt32BE(mdhd.data + (initialization[mdhd.data] === 1 ? 20 : 12));
        if (!scale) throw new Error('Invalid MP4 timescale');
        this.timescales.set(id, scale);
      }
    }
  }
  normalize(fragment: Buffer): Buffer {
    const data = Buffer.from(fragment);
    const timestamps: Array<{ offset: number; wide: boolean; time: number; scale: number }> = [];
    const sequences: Box[] = [];
    for (const moof of boxes(data).filter((b) => b.type === 'moof')) {
      const parts = children(data, moof);
      const mfhd = parts.find((b) => b.type === 'mfhd');
      if (mfhd) sequences.push(mfhd);
      for (const traf of parts.filter((b) => b.type === 'traf')) {
        const fields = children(data, traf);
        const tfhd = fields.find((b) => b.type === 'tfhd');
        const tfdt = fields.find((b) => b.type === 'tfdt');
        if (!tfhd || !tfdt) continue;
        const scale = this.timescales.get(data.readUInt32BE(tfhd.data + 4));
        if (!scale) throw new Error('Unknown MP4 recording track');
        const offset = tfdt.data + 4;
        const wide = data[tfdt.data] === 1;
        const time = wide ? Number(data.readBigUInt64BE(offset)) : data.readUInt32BE(offset);
        timestamps.push({ offset, wide, time, scale });
      }
    }
    if (this.origin === undefined && timestamps.length)
      this.origin = Math.min(...timestamps.map((t) => t.time / t.scale));
    for (const t of timestamps) {
      const value = Math.max(0, t.time - Math.round((this.origin || 0) * t.scale));
      if (t.wide) data.writeBigUInt64BE(BigInt(value), t.offset);
      else data.writeUInt32BE(value, t.offset);
    }
    for (const mfhd of sequences) data.writeUInt32BE(++this.sequence, mfhd.data + 4);
    return data;
  }
}
