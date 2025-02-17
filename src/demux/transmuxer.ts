import Event from '../events';
import { ErrorTypes, ErrorDetails } from '../errors';
import Decrypter from '../crypt/decrypter';
import AACDemuxer from '../demux/aacdemuxer';
import MP4Demuxer from '../demux/mp4demuxer';
import TSDemuxer from '../demux/tsdemuxer';
import MP3Demuxer from '../demux/mp3demuxer';
import MP4Remuxer from '../remux/mp4-remuxer';
import PassThroughRemuxer from '../remux/passthrough-remuxer';
import { Demuxer } from '../types/demuxer';
import { Remuxer } from '../types/remuxer';
import { TransmuxerResult, ChunkMetadata } from '../types/transmuxer';
import ChunkCache from './chunk-cache';
import { appendUint8Array } from '../utils/mp4-tools';

import { logger } from '../utils/logger';

let now;
// performance.now() not available on WebWorker, at least on Safari Desktop
try {
  now = self.performance.now.bind(self.performance);
} catch (err) {
  logger.debug('Unable to use Performance API on this environment');
  now = self.Date.now;
}

const muxConfig = [
  { demux: TSDemuxer, remux: MP4Remuxer },
  { demux: MP4Demuxer, remux: PassThroughRemuxer },
  { demux: AACDemuxer, remux: MP4Remuxer },
  { demux: MP3Demuxer, remux: MP4Remuxer }
];

let minProbeByteLength = 1024;
muxConfig.forEach(({ demux }) => {
  minProbeByteLength = Math.max(minProbeByteLength, demux.minProbeByteLength);
});

export default class Transmuxer {
  private observer: any;
  private typeSupported: any;
  private config: any;
  private vendor: any;
  private demuxer?: Demuxer;
  private remuxer?: Remuxer;
  private decrypter: any;
  private probe!: Function;
  private decryptionPromise: Promise<TransmuxerResult> | null = null;
  private transmuxConfig!: TransmuxConfig;
  private currentTransmuxState!: TransmuxState;
  private cache: ChunkCache = new ChunkCache();

  constructor (observer, typeSupported, config, vendor) {
    this.observer = observer;
    this.typeSupported = typeSupported;
    this.config = config;
    this.vendor = vendor;
  }

  configure (transmuxConfig: TransmuxConfig, state: TransmuxState) {
    this.transmuxConfig = transmuxConfig;
    this.currentTransmuxState = state;
    if (this.decrypter) {
      this.decrypter.reset();
    }
  }

  push (data: ArrayBuffer,
    decryptdata: any | null,
    chunkMeta: ChunkMetadata
  ): TransmuxerResult | Promise<TransmuxerResult> {
    const stats = chunkMeta.transmuxing;
    stats.executeStart = now();

    let uintData = new Uint8Array(data);
    const { cache, config, currentTransmuxState: state, transmuxConfig } = this;

    const encryptionType = getEncryptionType(uintData, decryptdata);
    if (encryptionType === 'AES-128') {
      const decrypter = this.getDecrypter();
      // Software decryption is synchronous; webCrypto is not
      if (config.enableSoftwareAES) {
        // Software decryption is progressive. Progressive decryption may not return a result on each call. Any cached
        // data is handled in the flush() call
        const decryptedData = decrypter.softwareDecrypt(uintData, decryptdata.key.buffer, decryptdata.iv.buffer);
        if (!decryptedData) {
          stats.executeEnd = now();
          return emptyResult(chunkMeta);
        }
        uintData = decryptedData;
      } else {
        this.decryptionPromise = decrypter.webCryptoDecrypt(uintData, decryptdata.key.buffer, decryptdata.iv.buffer)
          .then((decryptedData) : TransmuxerResult => {
            // Calling push here is important; if flush() is called while this is still resolving, this ensures that
            // the decrypted data has been transmuxed
            const result = this.push(decryptedData, null, chunkMeta) as TransmuxerResult;
            this.decryptionPromise = null;
            return result;
          });
        return this.decryptionPromise!;
      }
    }

    const { contiguous, discontinuity, trackSwitch, accurateTimeOffset, timeOffset } = state;
    const { audioCodec, videoCodec, defaultInitPts, duration, initSegmentData } = transmuxConfig;

    // Reset muxers before probing to ensure that their state is clean, even if flushing occurs before a successful probe
    if (discontinuity || trackSwitch) {
      this.resetInitSegment(initSegmentData, audioCodec, videoCodec, duration);
    }

    if (discontinuity) {
      this.resetInitialTimestamp(defaultInitPts);
    }

    if (!contiguous) {
      this.resetContiguity();
    }

    let { demuxer, remuxer } = this;
    if (this.needsProbing(uintData, discontinuity, trackSwitch)) {
      if (cache.dataLength) {
        const cachedData = cache.flush();
        uintData = appendUint8Array(cachedData, uintData);
      }
      ({ demuxer, remuxer } = this.configureTransmuxer(uintData, transmuxConfig));
    }

    if (!demuxer || !remuxer) {
      cache.push(uintData);
      stats.executeEnd = now();
      return emptyResult(chunkMeta);
    }

    const result = this.transmux(uintData, decryptdata, encryptionType, timeOffset, accurateTimeOffset, chunkMeta);

    state.contiguous = true;
    state.discontinuity = false;
    state.trackSwitch = false;

    stats.executeEnd = now();
    return result;
  }

  // Due to data caching, flush calls can produce more than one TransmuxerResult (hence the Array type)
  flush (chunkMeta: ChunkMetadata) : TransmuxerResult[] | Promise<TransmuxerResult[]> {
    const stats = chunkMeta.transmuxing;
    stats.executeStart = now();

    const { decrypter, cache, currentTransmuxState, decryptionPromise, observer } = this;
    const transmuxResults: Array<TransmuxerResult> = [];

    if (decryptionPromise) {
      // Upon resolution, the decryption promise calls push() and returns its TransmuxerResult up the stack. Therefore
      // only flushing is required for async decryption
      return decryptionPromise.then(() => {
        return this.flush(chunkMeta);
      });
    }

    const { accurateTimeOffset, timeOffset } = currentTransmuxState;
    if (decrypter) {
      // The decrypter may have data cached, which needs to be demuxed. In this case we'll have two TransmuxResults
      // This happens in the case that we receive only 1 push call for a segment (either for non-progressive downloads,
      // or for progressive downloads with small segments)
      const decryptedData = decrypter.flush();
      if (decryptedData) {
        // Push always returns a TransmuxerResult if decryptdata is null
        transmuxResults.push(this.push(decryptedData, null, chunkMeta) as TransmuxerResult);
      }
    }

    const bytesSeen = cache.dataLength;
    cache.reset();
    const { demuxer, remuxer } = this;
    if (!demuxer || !remuxer) {
      // If probing failed, and each demuxer saw enough bytes to be able to probe, then Hls.js has been given content its not able to handle
      if (bytesSeen >= minProbeByteLength) {
        observer.trigger(Event.ERROR, { type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.FRAG_PARSING_ERROR, fatal: true, reason: 'no demux matching with content found' });
      }
      stats.executeEnd = now();
      return [emptyResult(chunkMeta)];
    }

    const { audioTrack, avcTrack, id3Track, textTrack } = demuxer.flush(timeOffset);
    logger.log(`[transmuxer.ts]: Flushed fragment ${chunkMeta.sn} of level ${chunkMeta.level}`);
    transmuxResults.push({
      remuxResult: remuxer.remux(audioTrack, avcTrack, id3Track, textTrack, timeOffset, accurateTimeOffset),
      chunkMeta
    });

    stats.executeEnd = now();
    return transmuxResults;
  }

  resetInitialTimestamp (defaultInitPts: number | undefined) {
    const { demuxer, remuxer } = this;
    if (!demuxer || !remuxer) {
      return;
    }
    demuxer.resetTimeStamp(defaultInitPts);
    remuxer.resetTimeStamp(defaultInitPts);
  }

  resetContiguity () {
    const { demuxer, remuxer } = this;
    if (!demuxer || !remuxer) {
      return;
    }
    demuxer.resetContiguity();
    remuxer.resetNextTimestamp();
  }

  resetInitSegment (initSegmentData: Uint8Array, audioCodec: string | undefined, videoCodec: string | undefined, duration: number) {
    const { demuxer, remuxer } = this;
    if (!demuxer || !remuxer) {
      return;
    }
    demuxer.resetInitSegment(audioCodec, videoCodec, duration);
    remuxer.resetInitSegment(initSegmentData, audioCodec, videoCodec);
  }

  destroy (): void {
    if (this.demuxer) {
      this.demuxer.destroy();
      this.demuxer = undefined;
    }
    if (this.remuxer) {
      this.remuxer.destroy();
      this.remuxer = undefined;
    }
  }

  private transmux (data: Uint8Array, decryptData: Uint8Array, encryptionType: string | null, timeOffset: number, accurateTimeOffset: boolean, chunkMeta: ChunkMetadata): TransmuxerResult | Promise<TransmuxerResult> {
    let result: TransmuxerResult | Promise<TransmuxerResult>;
    if (encryptionType === 'SAMPLE-AES') {
      result = this.transmuxSampleAes(data, decryptData, timeOffset, accurateTimeOffset, chunkMeta);
    } else {
      result = this.transmuxUnencrypted(data, timeOffset, accurateTimeOffset, chunkMeta);
    }
    return result;
  }

  private transmuxUnencrypted (data: Uint8Array, timeOffset: number, accurateTimeOffset: boolean, chunkMeta: ChunkMetadata) {
    const { audioTrack, avcTrack, id3Track, textTrack } = this.demuxer!.demux(data, timeOffset, false);
    return {
      remuxResult: this.remuxer!.remux(audioTrack, avcTrack, id3Track, textTrack, timeOffset, accurateTimeOffset),
      chunkMeta
    };
  }

  // TODO: Handle flush with Sample-AES
  private transmuxSampleAes (data: Uint8Array, decryptData: any, timeOffset: number, accurateTimeOffset: boolean, chunkMeta: ChunkMetadata) : Promise<TransmuxerResult> {
    return this.demuxer!.demuxSampleAes(data, decryptData, timeOffset)
      .then(demuxResult => ({
        remuxResult: this.remuxer!.remux(demuxResult.audioTrack, demuxResult.avcTrack, demuxResult.id3Track, demuxResult.textTrack, timeOffset, accurateTimeOffset),
        chunkMeta
      })
      );
  }

  private configureTransmuxer (data: Uint8Array, transmuxConfig: TransmuxConfig) {
    const { config, observer, typeSupported, vendor } = this;
    const { audioCodec, defaultInitPts, duration, initSegmentData, videoCodec } = transmuxConfig;
    let demuxer, remuxer;
    // probe for content type
    for (let i = 0, len = muxConfig.length; i < len; i++) {
      const mux = muxConfig[i];
      const probe = mux.demux.probe;
      if (probe(data)) {
        remuxer = this.remuxer = new mux.remux(observer, config, typeSupported, vendor);
        demuxer = this.demuxer = new mux.demux(observer, config, typeSupported);

        // Ensure that muxers are always initialized with an initSegment
        this.resetInitSegment(initSegmentData, audioCodec, videoCodec, duration);
        this.resetInitialTimestamp(defaultInitPts);
        logger.log(`[transmuxer.ts]: Probe succeeded with a data length of ${data.length}.`);
        this.probe = probe;
        break;
      }
    }

    return { demuxer, remuxer };
  }

  private needsProbing (data: Uint8Array, discontinuity: boolean, trackSwitch: boolean) : boolean {
    // in case of continuity change, or track switch
    // we might switch from content type (AAC container to TS container, or TS to fmp4 for example)
    // so let's check that current demuxer is still valid
    return !this.demuxer || ((discontinuity || trackSwitch) && !this.probe(data));
  }

  private getDecrypter () {
    let decrypter = this.decrypter;
    if (!decrypter) {
      decrypter = this.decrypter = new Decrypter(this.observer, this.config);
    }
    return decrypter;
  }
}

function getEncryptionType (data: Uint8Array, decryptData: any): string | null {
  let encryptionType = null;
  if ((data.byteLength > 0) && (decryptData != null) && (decryptData.key != null)) {
    encryptionType = decryptData.method;
  }
  return encryptionType;
}

const emptyResult = (chunkMeta) : TransmuxerResult => ({
  remuxResult: {},
  chunkMeta
});

export function isPromise<T> (p: Promise<T> | any): p is Promise<T> {
  return 'then' in p && p.then instanceof Function;
}

export class TransmuxConfig {
  public audioCodec?: string;
  public videoCodec?: string;
  public initSegmentData: Uint8Array;
  public duration: number;
  public defaultInitPts?: number;

  constructor (audioCodec: string | undefined, videoCodec: string | undefined, initSegmentData: Uint8Array, duration: number, defaultInitPts?: number) {
    this.audioCodec = audioCodec;
    this.videoCodec = videoCodec;
    this.initSegmentData = initSegmentData;
    this.duration = duration;
    this.defaultInitPts = defaultInitPts;
  }
}

export class TransmuxState {
  public discontinuity: boolean;
  public contiguous: boolean;
  public accurateTimeOffset: boolean;
  public trackSwitch: boolean;
  public timeOffset: number;

  constructor (discontinuity: boolean, contiguous: boolean, accurateTimeOffset: boolean, trackSwitch: boolean, timeOffset: number) {
    this.discontinuity = discontinuity;
    this.contiguous = contiguous;
    this.accurateTimeOffset = accurateTimeOffset;
    this.trackSwitch = trackSwitch;
    this.timeOffset = timeOffset;
  }
}
