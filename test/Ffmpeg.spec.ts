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
