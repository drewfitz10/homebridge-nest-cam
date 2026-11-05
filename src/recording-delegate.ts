import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { Writable } from 'stream';
import {
  CameraController,
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  HAP,
  Logging,
  RecordingPacket,
} from 'homebridge';
import pathToFfmpeg from 'ffmpeg-for-homebridge';
import { NestCam, NestCamEvents } from './nest/cam';
import { NestConfig } from './nest/types/config';
import { NexusStreamer } from './nest/streamer';

/** Parses MP4 boxes across arbitrary stdout chunks and retains a bounded prebuffer. */
export class FragmentBuffer extends EventEmitter {
  private pending = Buffer.alloc(0);
  private initialization: Array<Buffer> = [];
  private fragment: Array<Buffer> = [];
  init?: Buffer;
  fragments: Array<{ data: Buffer; time: number }> = [];
  push(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 8) {
      let size = this.pending.readUInt32BE(0);
      let header = 8;
      if (size === 1) {
        if (this.pending.length < 16) {
          return;
        }
        size = Number(this.pending.readBigUInt64BE(8));
        header = 16;
      }
      if (size < header || size > 32 * 1024 * 1024) {
        throw new Error('Invalid MP4 box size');
      }
      if (this.pending.length < size) {
        return;
      }
      const box = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(size);
      const type = box.toString('ascii', 4, 8);
      if (!this.init) {
        this.initialization.push(box);
        if (type === 'moov') {
          this.init = Buffer.concat(this.initialization);
        }
      } else {
        this.fragment.push(box);
        if (type === 'mdat') {
          const data = Buffer.concat(this.fragment);
          this.fragment = [];
          this.fragments.push({ data, time: Date.now() });
          while (this.fragments.length > 3 && this.fragments[0].time < Date.now() - 8000) {
            this.fragments.shift();
          }
          if (this.fragments.reduce((n, f) => n + f.data.length, 0) > 32 * 1024 * 1024) {
            throw new Error('Prebuffer exceeded 32 MiB');
          }
          this.emit('fragment', data);
        }
      }
    }
  }
}

export class RecordingDelegate implements CameraRecordingDelegate {
  controller?: CameraController;
  private active = false;
  private credentialsReady = false;
  private configuration?: CameraRecordingConfiguration;
  private process?: ChildProcess;
  private streamer?: NexusStreamer;
  private buffer = new FragmentBuffer();
  private stopped = new EventEmitter();
  private retry?: NodeJS.Timeout;
  private session?: { id: number; close: () => void };
  constructor(private hap: HAP, private camera: NestCam, private config: NestConfig, private log: Logging) {
    camera.on(NestCamEvents.CAMERA_STATE_CHANGED, () => this.restart());
    camera.on(NestCamEvents.AUDIO_STATE_CHANGED, () => this.restart());
  }

  updateRecordingActive(active: boolean): void {
    this.active = active;
    this.restart();
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.configuration = configuration;
    this.restart();
  }

  credentialsUpdated(): void {
    this.credentialsReady = true;
    if (!this.process) this.restart();
  }

  restart(): void {
    this.stop();
    const c = this.configuration;
    const management = this.controller?.recordingManagement;
    const cameraActive = management?.operatingModeService.getCharacteristic(
      this.hap.Characteristic.HomeKitCameraActive,
    ).value;
    if (
      !this.credentialsReady ||
      !this.config.access_token ||
      !this.active ||
      !c ||
      !management ||
      cameraActive === false ||
      cameraActive === 0 ||
      !this.camera.info.properties['streaming.enabled']
    ) {
      return;
    }
    const audio =
      !!management.recordingManagementService.getCharacteristic(this.hap.Characteristic.RecordingAudioActive).value &&
      !!this.camera.info.properties['audio.enabled'];
    const [width, height, fps] = c.videoCodec.resolution;
    const p = c.videoCodec.parameters;
    const seconds = c.mediaContainerConfiguration.fragmentLength / 1000;
    const args = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-f', 'h264', '-r', '15', '-i', 'pipe:0'];
    if (audio) {
      args.push('-c:a', 'aac', '-f', 'aac', '-i', 'pipe:3');
    }
    args.push(
      '-map',
      '0:v:0',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-profile:v',
      ['baseline', 'main', 'high'][p.profile],
      '-level:v',
      ['3.1', '3.2', '4.0'][p.level],
      '-vf',
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(fps),
      '-b:v',
      `${p.bitRate}k`,
      '-maxrate',
      `${p.bitRate}k`,
      '-bufsize',
      `${p.bitRate * 2}k`,
      '-g',
      String(Math.max(1, Math.floor(fps * Math.min(seconds, p.iFrameInterval / 1000)))),
      '-keyint_min',
      '1',
      '-sc_threshold',
      '0',
      '-force_key_frames',
      `expr:gte(t,n_forced*${seconds})`,
    );
    if (audio) {
      args.push(
        '-map',
        '1:a:0',
        '-c:a',
        'aac',
        '-profile:a',
        'aac_low',
        '-ar',
        '32000',
        '-ac',
        '1',
        '-b:a',
        `${c.audioCodec.bitrate}k`,
      );
    } else {
      args.push('-an');
    }
    args.push(
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration',
      String(c.mediaContainerConfiguration.fragmentLength * 1000),
      '-f',
      'mp4',
      'pipe:1',
    );
    const buffer = (this.buffer = new FragmentBuffer());
    const process = (this.process = spawn(this.config.options?.pathToFfmpeg || pathToFfmpeg || 'ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    }));
    let lastError = '';
    process.stderr?.on('data', (data: Buffer) => {
      lastError = data.toString().slice(-1000);
    });
    let bufferReady = false;
    process.stdout?.on('data', (data: Buffer) => {
      try {
        buffer.push(data);
        if (!bufferReady && buffer.fragments.length) {
          bufferReady = true;
          this.log.info(`HKSV prebuffer ready for ${this.camera.info.name}`);
        }
      } catch (error) {
        this.log.error(String(error));
        this.failed(process);
      }
    });
    process.on('error', (error) => {
      this.log.error(`HKSV encoder: ${error.message}`);
      this.failed(process);
    });
    process.on('exit', () => {
      if (this.process === process) {
        this.log.error(`HKSV encoder stopped: ${lastError}`);
        this.failed(process);
      }
    });
    for (const pipe of [process.stdin, process.stdio[3]]) {
      pipe?.on('error', () => undefined);
    }
    this.streamer = new NexusStreamer(
      this.camera.info,
      () => this.config.access_token,
      this.config.options?.streamQuality || 3,
      { getStdin: () => process.stdin },
      audio ? { getStdin: () => process.stdio[3] as Writable } : undefined,
      undefined,
      this.log,
      this.config.nest_token !== undefined,
    );
    this.streamer.startPlayback();
    this.log.info(`HKSV prebuffer started for ${this.camera.info.name}`);
  }

  private failed(process: ChildProcess): void {
    if (this.process !== process) {
      return;
    }
    this.stop();
    this.retry = setTimeout(() => this.restart(), 10000);
    this.retry.unref();
  }

  stop(): void {
    clearTimeout(this.retry);
    this.session?.close();
    this.stopped.emit('stop');
    const process = this.process;
    this.process = undefined;
    this.streamer?.stopPlayback();
    this.streamer = undefined;
    process?.kill('SIGKILL');
    this.buffer = new FragmentBuffer();
  }

  async *handleRecordingStreamRequest(streamId: number): AsyncGenerator<RecordingPacket> {
    this.log.info(`HKSV recording requested for ${this.camera.info.name} (stream ${streamId})`);
    if (!this.process || this.session) {
      throw new Error('HKSV prebuffer unavailable or already in use');
    }
    const buffer = this.buffer;
    const queue = buffer.fragments.map((f) => f.data);
    let queuedBytes = queue.reduce((n, b) => n + b.length, 0);
    let closed = false;
    let wake: (() => void) | undefined;
    const close = (): void => {
      closed = true;
      wake?.();
    };
    const onFragment = (data: Buffer): void => {
      if (closed) {
        return;
      }
      queuedBytes += data.length;
      if (queuedBytes > 32 * 1024 * 1024) {
        close();
        return;
      }
      queue.push(data);
      wake?.();
    };
    const session = (this.session = { id: streamId, close });
    buffer.on('fragment', onFragment);
    this.stopped.on('stop', close);
    let watchdog: NodeJS.Timeout | undefined;
    try {
      while (!closed && (!buffer.init || !queue.length)) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          watchdog = setTimeout(close, 20000);
        });
        clearTimeout(watchdog);
      }
      if (closed) {
        throw new Error('Nest recording source timed out');
      }
      this.log.info(`HKSV sending recording for ${this.camera.info.name}; ${queue.length} buffered fragments`);
      yield { data: buffer.init!, isLast: false };
      while (!closed) {
        const data = queue.shift();
        if (data) {
          queuedBytes -= data.length;
          yield { data, isLast: false };
        } else {
          await new Promise<void>((resolve) => {
            wake = resolve;
            watchdog = setTimeout(close, 20000);
          });
          clearTimeout(watchdog);
        }
      }
    } finally {
      clearTimeout(watchdog);
      buffer.removeListener('fragment', onFragment);
      this.stopped.removeListener('stop', close);
      if (this.session === session) {
        this.session = undefined;
      }
    }
  }

  closeRecordingStream(streamId: number, reason?: number): void {
    this.log.info(
      `HKSV recording closed for ${this.camera.info.name} (stream ${streamId}, reason ${
        reason ?? 'connection closed'
      })`,
    );
    if (this.session?.id === streamId) {
      this.session.close();
    }
  }

  acknowledgeStream(streamId: number): void {
    this.closeRecordingStream(streamId);
  }
}
