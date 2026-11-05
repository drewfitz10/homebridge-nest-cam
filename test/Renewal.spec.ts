import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import Pbf from 'pbf';
import { Logging, HAP } from 'homebridge';
import { NexusStreamer } from '../src/nest/streamer';
import { RecordingDelegate } from '../src/recording-delegate';
import { NestCam } from '../src/nest/cam';
import { NestConfig } from '../src/nest/types/config';
jest.mock('child_process', () => ({ spawn: jest.fn() }));
const decodeToken = (data: Uint8Array): string =>
  new Pbf(data).readFields(
    (tag, value, pbf) => {
      if (tag === 4 && value && pbf) value.token = pbf.readString();
    },
    { token: '' },
  ).token;
const log = { info: jest.fn(), debug: jest.fn(), error: jest.fn() } as unknown as Logging;
describe('renewable camera authentication', () => {
  afterEach(() => jest.restoreAllMocks());
  it('uses the latest token when an existing Nexus session reauthorizes', () => {
    jest.spyOn(NexusStreamer.prototype as any, 'setupConnection').mockImplementation(() => undefined);
    const send = jest.spyOn(NexusStreamer.prototype as any, 'sendMessage').mockImplementation(() => undefined);
    let token = 'first';
    const streamer = new NexusStreamer({} as any, () => token, 3, { getStdin: () => undefined });
    (streamer as any).updateAuthentication();
    expect(decodeToken(send.mock.calls[0][1] as Uint8Array)).toBe('first');
    token = 'renewed';
    (streamer as any).updateAuthentication();
    expect(decodeToken(send.mock.calls[1][1] as Uint8Array)).toBe('renewed');
  });
  it('waits for credentials before starting a restored recording and keeps it running during renewal', () => {
    jest.spyOn(NexusStreamer.prototype as any, 'setupConnection').mockImplementation(() => undefined);
    jest.spyOn(NexusStreamer.prototype, 'startPlayback').mockImplementation(() => undefined);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdio: [null, null, null, new PassThrough()],
      kill: jest.fn(),
    });
    (spawn as unknown as jest.Mock).mockReturnValue(child);
    const config: NestConfig = { platform: 'Nest-cam', access_token: 'cached-before-discovery' };
    const camera = Object.assign(new EventEmitter(), {
      info: { properties: { 'streaming.enabled': true, 'audio.enabled': false }, name: 'Test' },
    }) as unknown as NestCam;
    const delegate = new RecordingDelegate(
      { Characteristic: { HomeKitCameraActive: 'active', RecordingAudioActive: 'audio' } } as unknown as HAP,
      camera,
      config,
      log,
    );
    delegate.controller = {
      recordingManagement: {
        operatingModeService: { getCharacteristic: () => ({ value: true }) },
        recordingManagementService: { getCharacteristic: () => ({ value: false }) },
      },
    } as any;
    delegate.updateRecordingConfiguration({
      prebufferLength: 4000,
      eventTriggerTypes: [1],
      mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
      videoCodec: {
        type: 0,
        parameters: { profile: 1, level: 2, bitRate: 500, iFrameInterval: 4000 },
        resolution: [1280, 720, 15],
      },
      audioCodec: { type: 0, samplerate: 3, bitrate: 32 },
    });
    delegate.updateRecordingActive(true);
    expect(spawn).not.toHaveBeenCalled();
    config.access_token = 'first';
    delegate.credentialsUpdated();
    expect(spawn).toHaveBeenCalledTimes(1);
    config.access_token = 'renewed';
    delegate.credentialsUpdated();
    expect(spawn).toHaveBeenCalledTimes(1);
    delegate.stop();
  });
});
