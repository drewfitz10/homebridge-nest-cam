import { RecordingTimeline } from '../src/recording-timeline';
const box = (type: string, payload: Buffer): Buffer => {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(b.length);
  b.write(type, 4);
  payload.copy(b, 8);
  return b;
};
const track = (id: number, scale: number): Buffer => {
  const tkhd = Buffer.alloc(20);
  tkhd.writeUInt32BE(id, 12);
  const mdhd = Buffer.alloc(20);
  mdhd.writeUInt32BE(scale, 12);
  return box('trak', Buffer.concat([box('tkhd', tkhd), box('mdia', box('mdhd', mdhd))]));
};
const traf = (id: number, time: bigint): Buffer => {
  const tfhd = Buffer.alloc(8);
  tfhd.writeUInt32BE(id, 4);
  const tfdt = Buffer.alloc(12);
  tfdt[0] = 1;
  tfdt.writeBigUInt64BE(time, 4);
  return box('traf', Buffer.concat([box('tfhd', tfhd), box('tfdt', tfdt)]));
};
const fragment = (video: bigint, audio: bigint): Buffer =>
  box('moof', Buffer.concat([box('mfhd', Buffer.alloc(8)), traf(1, video), traf(2, audio)]));
test('rebases each event to zero, preserves A/V offset and does not modify the shared prebuffer', () => {
  const timeline = new RecordingTimeline(box('moov', Buffer.concat([track(1, 1000), track(2, 48000)])));
  const input = fragment(BigInt(100000), BigInt(4801000));
  const original = Buffer.from(input);
  const first = timeline.normalize(input);
  expect(first.readUInt32BE(20)).toBe(1);
  expect(first.readBigUInt64BE(60)).toBe(BigInt(0));
  expect(first.readBigUInt64BE(104)).toBe(BigInt(1000));
  expect(input).toEqual(original);
  const next = timeline.normalize(fragment(BigInt(104000), BigInt(4993000)));
  expect(next.readUInt32BE(20)).toBe(2);
  expect(next.readBigUInt64BE(60)).toBe(BigInt(4000));
  expect(next.readBigUInt64BE(104)).toBe(BigInt(193000));
});
