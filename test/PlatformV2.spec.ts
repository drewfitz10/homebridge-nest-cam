import register from '../src/index';
import * as ffmpeg from '../src/ffmpeg';
import { HomebridgeAPI } from 'homebridge/lib/api';

describe('V2 standalone recording cameras', () => {
  it('publishes recording services separately and preserves the original identity', () => {
    jest.spyOn(ffmpeg, 'getCodecsOutput').mockResolvedValue('libx264 libfdk_aac libspeex');
    jest.spyOn(ffmpeg, 'isFfmpegInstalled').mockResolvedValue(true);
    const api = new HomebridgeAPI();
    const registered = jest.spyOn(api, 'registerPlatform').mockImplementation(() => undefined);
    const published = jest.spyOn(api, 'publishExternalAccessories').mockImplementation(() => undefined);
    const updated = jest.spyOn(api, 'updatePlatformAccessories').mockImplementation(() => undefined);
    register(api);
    const Platform = registered.mock.calls[0][2] as any;
    const log = { info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() };
    const platform = new Platform(
      log,
      { platform: 'Nest-cam', options: { secureVideo: true, standaloneSecureVideo: true, motionDetection: false } },
      api,
    );
    const original = new api.platformAccessory('Test Camera', api.hap.uuid.generate('test-camera'));
    original.context.cameraInfo = {
      uuid: 'test-camera',
      name: 'Test Camera',
      capabilities: [],
      properties: { 'streaming.enabled': true },
      nest_structure_id: 'structure.test',
      serial_number: 'test-camera',
    };
    platform.configureAccessory(original);
    platform.publishStandaloneCameras();
    platform.publishStandaloneCameras();
    expect(published).toHaveBeenCalledTimes(1);
    const standalone = published.mock.calls[0][1][0];
    expect(standalone.displayName).toBe('Test Camera V2');
    expect(standalone.UUID).not.toBe(original.UUID);
    expect(standalone.category).toBe(api.hap.Categories.IP_CAMERA);
    expect(standalone.getService(api.hap.Service.CameraRecordingManagement)).toBeDefined();
    expect(standalone.getService(api.hap.Service.DataStreamTransportManagement)).toBeDefined();
    expect(standalone.getService(api.hap.Service.CameraOperatingMode)).toBeDefined();
    expect(original.getService(api.hap.Service.CameraRecordingManagement)).toBeUndefined();
    expect(platform.nestObjects[0].camera).toBe(platform.nestObjects[1].camera);
    platform.isShuttingDown();
    expect(updated).toHaveBeenCalledWith([original]);
    jest.restoreAllMocks();
  });
});
