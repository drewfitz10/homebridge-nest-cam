import { FragmentBuffer } from '../src/recording-delegate';
const box = (type: string, data = ''): Buffer => {
  const b = Buffer.alloc(8 + data.length);
  b.writeUInt32BE(b.length);
  b.write(type, 4);
  b.write(data, 8);
  return b;
};
describe('fragmented MP4 prebuffer', () => {
  it('reassembles split headers and payloads into init and complete fragments', () => {
    const b = new FragmentBuffer();
    const init = Buffer.concat([box('ftyp'), box('moov', 'init')]);
    const fragment = Buffer.concat([box('moof'), box('mdat', 'video')]);
    const all = Buffer.concat([init, fragment]);
    for (let i = 0; i < all.length; i += 3) b.push(all.subarray(i, i + 3));
    expect(b.init).toEqual(init);
    expect(b.fragments.map((f) => f.data)).toEqual([fragment]);
  });
  it('rejects malformed box lengths', () => {
    expect(() => new FragmentBuffer().push(Buffer.alloc(8))).toThrow('Invalid MP4');
  });
  it('evicts old fragments while retaining at least four seconds of context', () => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
    const b = new FragmentBuffer();
    b.push(Buffer.concat([box('ftyp'), box('moov')]));
    for (let i = 0; i < 10; i++) {
      b.push(Buffer.concat([box('moof'), box('mdat')]));
      jest.advanceTimersByTime(4000);
    }
    expect(b.fragments.length).toBe(3);
    jest.useRealTimers();
  });
});
