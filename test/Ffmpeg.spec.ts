import { EventEmitter } from 'events';
import execa from 'execa';
import { FfmpegProcess } from '../src/ffmpeg';
import { StreamingDelegate } from '../src/streaming-delegate';
import { Logging } from 'homebridge';
jest.mock('execa');
describe('FFmpeg startup callbacks', () => {
  let child: any;
  const log = { info: jest.fn(), debug: jest.fn(), error: jest.fn() } as unknown as Logging;
  const delegate = {
    stopStream: jest.fn(),
    controller: { forceStopStreamingSession: jest.fn() },
  } as unknown as StreamingDelegate;
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
    child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.catch = jest.fn();
    (execa as unknown as jest.Mock).mockReturnValue(child);
  });
  afterEach(() => jest.useRealTimers());
  it('acknowledges spawn without waiting for media and calls back only once', () => {
    const cb = jest.fn();
    new FfmpegProcess('VIDEO', [], log, delegate, 'test', false, '/ffmpeg', cb);
    child.emit('spawn');
    child.stderr.emit('data', Buffer.from('frame=1'));
    child.emit('exit', 1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(undefined);
  });
  it('fails a stalled startup before Homebridge warns', () => {
    const cb = jest.fn();
    new FfmpegProcess('VIDEO', [], log, delegate, 'test', false, '/ffmpeg', cb);
    jest.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe('live passthrough compatibility', () => {
  const command = (online: boolean): string[] => {
    const delegate = Object.create(StreamingDelegate.prototype) as any;
    delegate.ffmpegCodec = 'copy';
    delegate.camera = { info: { properties: { 'streaming.enabled': online } } };
    delegate.pendingSessions = {
      test: {
        videoPort: 50000,
        returnVideoPort: 50001,
        videoSSRC: 1,
        videoSRTP: Buffer.alloc(30),
        address: '127.0.0.1',
      },
    };
    return delegate.getVideoCommand(
      { width: 1280, height: 720, fps: 15, max_bit_rate: 300, pt: 99, mtu: 1316 },
      'test',
    );
  };
  it('keeps scaling and encoder controls out of a copied live stream', () => {
    const args = command(true);
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
    expect(args).not.toContain('-vf');
    expect(args).not.toContain('-b:v');
    expect(args).not.toContain('-bf');
  });
  it('encodes the offline JPEG as H.264 even when live passthrough is selected', () => {
    const args = command(false);
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
    expect(args).toContain('-loop');
  });
});
