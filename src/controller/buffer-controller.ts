/*
 * Buffer Controller
 */

import Events from '../events';
import EventHandler from '../event-handler';
import { logger } from '../utils/logger';
import { ErrorDetails, ErrorTypes } from '../errors';
import { getMediaSource } from '../utils/mediasource-helper';
import Fragment, { ElementaryStreamTypes } from '../loader/fragment';
import { TrackSet } from '../types/track';
import BufferOperationQueue from './buffer-operation-queue';
import {
  BufferOperation,
  SourceBuffers,
  SourceBufferName,
  SourceBufferListeners
} from '../types/buffer';
import { LevelUpdatedData, BufferAppendingEventPayload } from '../types/events';

const MediaSource = getMediaSource();
const DEFAULT_TARGET_DURATION = 10;

export default class BufferController extends EventHandler {
  // the value that we have set mediasource.duration to
  // (the actual duration may be tweaked slighly by the browser)
  private _msDuration: number | null = null;
  // the target duration of the current media playlist
  private _levelTargetDuration: number | null = null;
  // current stream state: true - for live broadcast, false - for VoD content
  private _live: boolean = false;
  // cache the self generated object url to detect hijack of video tag
  private _objectUrl: string | null = null;
  // A queue of buffer operations which require the SourceBuffer to not be updating upon execution
  private operationQueue!: BufferOperationQueue;
  // References to event listeners for each SourceBuffer, so that they can be referenced for event removal
  private listeners!: SourceBufferListeners;

  // The number of BUFFER_CODEC events received before any sourceBuffers are created
  public bufferCodecEventsExpected: number = 0;

  // A reference to the attached media element
  public media: HTMLMediaElement | null = null;

  // A reference to the active media source
  public mediaSource: MediaSource | null = null;

  // counters
  public appendError: number = 0;

  public tracks: TrackSet = {};
  public pendingTracks: TrackSet = {};
  public sourceBuffer!: SourceBuffers;

  constructor (hls: any) {
    super(hls,
      Events.MEDIA_ATTACHING,
      Events.MEDIA_DETACHING,
      Events.MANIFEST_PARSED,
      Events.BUFFER_RESET,
      Events.BUFFER_APPENDING,
      Events.BUFFER_CODECS,
      Events.BUFFER_EOS,
      Events.BUFFER_FLUSHING,
      Events.LEVEL_PTS_UPDATED,
      Events.LEVEL_UPDATED,
      Events.FRAG_PARSED
    );
    this.hls = hls;
    this._initSourceBuffer();
  }

  private _initSourceBuffer () {
    this.sourceBuffer = {};
    this.operationQueue = new BufferOperationQueue(this.sourceBuffer);
    this.listeners = {
      audio: [],
      video: [],
      audiovideo: []
    };
  }

  onManifestParsed (data: { altAudio: boolean }) {
    // in case of alt audio 2 BUFFER_CODECS events will be triggered, one per stream controller
    // sourcebuffers will be created all at once when the expected nb of tracks will be reached
    // in case alt audio is not used, only one BUFFER_CODEC event will be fired from main stream controller
    // it will contain the expected nb of source buffers, no need to compute it
    this.bufferCodecEventsExpected = data.altAudio ? 2 : 1;
    logger.log(`${this.bufferCodecEventsExpected} bufferCodec event(s) expected`);
  }

  onMediaAttaching (data: { media: HTMLMediaElement }) {
    const media = this.media = data.media;
    if (media && MediaSource) {
      const ms = this.mediaSource = new MediaSource();
      // MediaSource listeners are arrow functions with a lexical scope, and do not need to be bound
      ms.addEventListener('sourceopen', this._onMediaSourceOpen);
      ms.addEventListener('sourceended', this._onMediaSourceEnded);
      ms.addEventListener('sourceclose', this._onMediaSourceClose);
      // link video and media Source
      media.src = self.URL.createObjectURL(ms);
      // cache the locally generated object url
      this._objectUrl = media.src;
    }
  }

  onMediaDetaching () {
    logger.log('media source detaching');
    const { media, mediaSource, _objectUrl } = this;
    if (mediaSource) {
      if (mediaSource.readyState === 'open') {
        try {
          // endOfStream could trigger exception if any sourcebuffer is in updating state
          // we don't really care about checking sourcebuffer state here,
          // as we are anyway detaching the MediaSource
          // let's just avoid this exception to propagate
          mediaSource.endOfStream();
        } catch (err) {
          logger.warn(`onMediaDetaching:${err.message} while calling endOfStream`);
        }
      }
      // Clean up the SourceBuffers by invoking onBufferReset
      this.onBufferReset();
      mediaSource.removeEventListener('sourceopen', this._onMediaSourceOpen);
      mediaSource.removeEventListener('sourceended', this._onMediaSourceEnded);
      mediaSource.removeEventListener('sourceclose', this._onMediaSourceClose);

      // Detach properly the MediaSource from the HTMLMediaElement as
      // suggested in https://github.com/w3c/media-source/issues/53.
      if (media) {
        if (_objectUrl) {
          self.URL.revokeObjectURL(_objectUrl);
        }

        // clean up video tag src only if it's our own url. some external libraries might
        // hijack the video tag and change its 'src' without destroying the Hls instance first
        if (media.src === _objectUrl) {
          media.removeAttribute('src');
          media.load();
        } else {
          logger.warn('media.src was changed by a third party - skip cleanup');
        }
      }

      this.mediaSource = null;
      this.media = null;
      this._objectUrl = null;
      this.pendingTracks = {};
      this.tracks = {};
    }

    this.hls.trigger(Events.MEDIA_DETACHED);
  }

  onBufferReset () {
    const sourceBuffer = this.sourceBuffer;
    this.getSourceBufferTypes().forEach(type => {
      const sb = sourceBuffer[type];
      try {
        if (sb) {
          this.removeBufferListeners(type);
          if (this.mediaSource) {
            this.mediaSource.removeSourceBuffer(sb);
          }
          // Synchronously remove the SB from the map before the next call in order to prevent an async function from
          // accessing it
          sourceBuffer[type] = undefined;
        }
      } catch (err) {
        logger.warn(`Failed to reset the ${type} buffer`, err);
      }
    });
    this._initSourceBuffer();
  }

  onBufferCodecs (tracks: TrackSet) {
    // if source buffer(s) not created yet, appended buffer tracks in this.pendingTracks
    // if sourcebuffers already created, do nothing ...
    if (Object.keys(this.sourceBuffer).length) {
      return;
    }

    Object.keys(tracks).forEach(trackName => {
      this.pendingTracks[trackName] = tracks[trackName];
    });

    this.bufferCodecEventsExpected = Math.max(this.bufferCodecEventsExpected - 1, 0);
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      this.checkPendingTracks();
    }
  }

  onBufferAppending (eventData: BufferAppendingEventPayload) {
    const { hls, operationQueue } = this;
    const { data, type, frag, chunkMeta } = eventData;
    const chunkStats = chunkMeta.buffering[type];
    const fragStats = frag.stats.buffering;

    const start = performance.now();
    chunkStats.start = start;
    if (!fragStats.start) {
      fragStats.start = start;
    }

    const operation: BufferOperation = {
      execute: () => {
        chunkStats.executeStart = performance.now();
        this.appendExecutor(data, type);
      },
      onComplete: () => {
        const end = performance.now();
        chunkStats.executeEnd = chunkStats.end = end;
        if (!fragStats.first) {
          fragStats.first = end;
        }

        const { sourceBuffer } = this;
        const timeRanges = {};
        for (const type in sourceBuffer) {
          timeRanges[type] = sourceBuffer[type].buffered;
        }
        this.appendError = 0;
        this.hls.trigger(Events.BUFFER_APPENDED, { parent: frag.type, timeRanges, chunkMeta });
      },
      onError: (err) => {
        // in case any error occured while appending, put back segment in segments table
        logger.error(`[buffer-controller]: Error encountered while trying to append to the ${type} SourceBuffer`, err);
        const event = {
          type: ErrorTypes.MEDIA_ERROR,
          parent: frag.type,
          details: '',
          err,
          fatal: false
        };
        if (err.code === DOMException.QUOTA_EXCEEDED_ERR) {
          // TODO: enum MSE error codes
          // TODO: Should queues be cleared on this error?
          // QuotaExceededError: http://www.w3.org/TR/html5/infrastructure.html#quotaexceedederror
          // let's stop appending any segments, and report BUFFER_FULL_ERROR error
          event.details = ErrorDetails.BUFFER_FULL_ERROR;
        } else {
          this.appendError++;
          event.details = ErrorDetails.BUFFER_APPEND_ERROR;
          /* with UHD content, we could get loop of quota exceeded error until
            browser is able to evict some data from sourcebuffer. Retrying can help recover.
          */
          if (this.appendError > hls.config.appendErrorMaxRetry) {
            logger.log(`[buffer-controller]: Failed ${hls.config.appendErrorMaxRetry} times to append segment in sourceBuffer`);
            event.fatal = true;
          }
        }
        hls.trigger(Events.ERROR, event);
      }
    };
    operationQueue.append(operation, type as SourceBufferName);
  }

  onBufferFlushing (data: { startOffset: number, endOffset: number, type?: SourceBufferName }) {
    const { operationQueue } = this;
    const flushOperation = (type): BufferOperation => ({
      execute: this.removeExecutor.bind(this, type, data.startOffset, data.endOffset),
      onComplete: () => {
        this.hls.trigger(Events.BUFFER_FLUSHED);
      },
      onError: (e) => {
        logger.warn(`[buffer-controller]: Failed to remove from ${type} SourceBuffer`, e);
      }
    });

    if (data.type) {
      operationQueue.append(flushOperation(data.type), data.type);
    } else {
      operationQueue.append(flushOperation('audio'), 'audio');
      operationQueue.append(flushOperation('video'), 'video');
    }
  }

  onFragParsed (data: { frag: Fragment }) {
    const { frag } = data;
    const buffersAppendedTo: Array<SourceBufferName> = [];

    if (frag.elementaryStreams[ElementaryStreamTypes.AUDIO]) {
      buffersAppendedTo.push('audio');
    }
    if (frag.elementaryStreams[ElementaryStreamTypes.VIDEO]) {
      buffersAppendedTo.push('video');
    }
    console.assert(buffersAppendedTo.length, 'Fragments must have at least one ElementaryStreamType set', frag);

    logger.log('[buffer-controller]: All fragment chunks received, enqueueing operation to signal fragment buffered');
    const onUnblocked = () => {
      frag.stats.buffering.end = self.performance.now();
      this.hls.trigger(Events.FRAG_BUFFERED, { frag, stats: frag.stats, id: frag.type });
    };
    this.blockBuffers(onUnblocked, buffersAppendedTo);
    this.flushLiveBackBuffer();
  }

  // on BUFFER_EOS mark matching sourcebuffer(s) as ended and trigger checkEos()
  // an undefined data.type will mark all buffers as EOS.
  onBufferEos (data: { type?: SourceBufferName }) {
    for (const type in this.sourceBuffer) {
      if (!data.type || data.type === type) {
        const sb = this.sourceBuffer[type as SourceBufferName];
        if (sb && !sb.ended) {
          sb.ended = true;
          logger.log(`[buffer-controller]: ${type} sourceBuffer now EOS`);
        }
      }
    }

    const endStream = () => {
      const { mediaSource } = this;
      if (!mediaSource || mediaSource.readyState !== 'open') {
        return;
      }

      logger.log('[buffer-controller]: Signaling end of stream');
      // Allow this to throw and be caught by the enqueueing function
      mediaSource.endOfStream();
    };
    logger.log('[buffer-controller: End of stream signalled, enqueuing end of stream operation');
    this.blockBuffers(endStream);
  }

  onLevelUpdated ({ details }: LevelUpdatedData) {
    if (!details.fragments.length) {
      return;
    }
    this._levelTargetDuration = details.averagetargetduration || details.targetduration || DEFAULT_TARGET_DURATION;
    this._live = details.live;

    const levelDuration = details.totalduration + details.fragments[0].start;
    logger.log('[buffer-controller]: Duration update required; enqueueing duration change operation');
    if (this.getSourceBufferTypes().length) {
      this.blockBuffers(this.updateMediaElementDuration.bind(this, levelDuration));
    } else {
      this.updateMediaElementDuration(levelDuration);
    }
  }

  // Adjusting `SourceBuffer.timestampOffset` (desired point in the timeline where the next frames should be appended)
  // in Chrome browser when we detect MPEG audio container and time delta between level PTS and `SourceBuffer.timestampOffset`
  // is greater than 100ms (this is enough to handle seek for VOD or level change for LIVE videos). At the time of change we issue
  // `SourceBuffer.abort()` and adjusting `SourceBuffer.timestampOffset` if `SourceBuffer.updating` is false or awaiting `updateend`
  // event if SB is in updating state.
  // More info here: https://github.com/video-dev/hls.js/issues/332#issuecomment-257986486
  onLevelPtsUpdated (data: { type: SourceBufferName, start: number }) {
    const { operationQueue, sourceBuffer, tracks } = this;
    const type = data.type;
    const audioTrack = tracks.audio;

    if (type !== 'audio' || (audioTrack && audioTrack.container !== 'audio/mpeg')) {
      return;
    }
    const audioBuffer = sourceBuffer[type];
    if (!audioBuffer) {
      return;
    }
    const delta = Math.abs(audioBuffer.timestampOffset - data.start);
    if (delta < 0.1) {
      return;
    }

    const operation = {
      execute: this.abortExecutor.bind(this, type),
      onComplete () {
        if (audioBuffer) {
          logger.log(`[buffer-controller]: Updating audio SourceBuffer timestampOffset to ${data.start}`);
          audioBuffer.timestampOffset = data.start;
        }
      },
      onError (e) {
        logger.warn('[buffer-controller]: Failed to abort the audio SourceBuffer', e);
      }
    };
    operationQueue.append(operation, type);
  }

  flushLiveBackBuffer () {
    const { hls, _levelTargetDuration, _live, media, sourceBuffer } = this;
    if (!media || !_live || !_levelTargetDuration) {
      return;
    }

    const liveBackBufferLength = hls.config.liveBackBufferLength;
    if (!Number.isFinite(liveBackBufferLength) || liveBackBufferLength < 0) {
      return;
    }

    const targetBackBufferPosition = media.currentTime - Math.max(liveBackBufferLength, _levelTargetDuration);
    this.getSourceBufferTypes().forEach((type: SourceBufferName) => {
      const buffered = sourceBuffer[type]!.buffered;
      // when target buffer start exceeds actual buffer start
      if (buffered.length > 0 && targetBackBufferPosition > buffered.start(0)) {
        // remove buffer up until current time minus minimum back buffer length (removing buffer too close to current
        // time will lead to playback freezing)
        // credits for level target duration - https://github.com/videojs/http-streaming/blob/3132933b6aa99ddefab29c10447624efd6fd6e52/src/segment-loader.js#L91
        logger.log(`[buffer-controller]: Enqueueing operation to flush ${type} back buffer`);
        this.onBufferFlushing({
          startOffset: 0,
          endOffset: targetBackBufferPosition,
          type
        });
      }
    });
  }

  /**
   * Update Media Source duration to current level duration or override to Infinity if configuration parameter
   * 'liveDurationInfinity` is set to `true`
   * More details: https://github.com/video-dev/hls.js/issues/355
   */
  updateMediaElementDuration (levelDuration: number) {
    if (!this.media || !this.mediaSource || this.mediaSource.readyState !== 'open') {
      return;
    }
    const { hls, _live, media, mediaSource, _msDuration } = this;
    const mediaDuration = media.duration;

    // initialise to the value that the media source is reporting
    let msDuration = _msDuration;
    if (msDuration === null) {
      this._msDuration = msDuration = mediaSource.duration;
    }

    if (_live && hls.config.liveDurationInfinity) {
      // Override duration to Infinity
      logger.log('[buffer-controller]: Media Source duration is set to Infinity');
      this._msDuration = mediaSource.duration = Infinity;
    } else if ((levelDuration > msDuration && levelDuration > mediaDuration) || !Number.isFinite(mediaDuration)) {
      // levelDuration was the last value we set.
      // not using mediaSource.duration as the browser may tweak this value
      // only update Media Source duration if its value increase, this is to avoid
      // flushing already buffered portion when switching between quality level
      logger.log(`[buffer-controller]: Updating Media Source duration to ${levelDuration.toFixed(3)}`);
      this._msDuration = mediaSource.duration = levelDuration;
    }
  }

  private checkPendingTracks () {
    const { bufferCodecEventsExpected, operationQueue, pendingTracks } = this;

    // Check if we've received all of the expected bufferCodec events. When none remain, create all the sourceBuffers at once.
    // This is important because the MSE spec allows implementations to throw QuotaExceededErrors if creating new sourceBuffers after
    // data has been appended to existing ones.
    // 2 tracks is the max (one for audio, one for video). If we've reach this max go ahead and create the buffers.
    const pendingTracksCount = Object.keys(pendingTracks).length;
    if ((pendingTracksCount && !bufferCodecEventsExpected) || pendingTracksCount === 2) {
      // ok, let's create them now !
      this.createSourceBuffers(pendingTracks);
      this.pendingTracks = {};
      // append any pending segments now !
      Object.keys(this.sourceBuffer).forEach((type: SourceBufferName) => {
        operationQueue.executeNext(type);
      });
    }
  }

  private createSourceBuffers (tracks: TrackSet) {
    const { sourceBuffer, mediaSource } = this;
    if (!mediaSource) {
      throw Error('createSourceBuffers called when mediaSource was null');
    }

    for (const trackName in tracks) {
      if (!sourceBuffer[trackName]) {
        const track = tracks[trackName as keyof TrackSet];
        if (!track) {
          throw Error(`source buffer exists for track ${trackName}, however track does not`);
        }
        // use levelCodec as first priority
        const codec = track.levelCodec || track.codec;
        const mimeType = `${track.container};codecs=${codec}`;
        logger.log(`creating sourceBuffer(${mimeType})`);
        try {
          const sb = sourceBuffer[trackName] = mediaSource.addSourceBuffer(mimeType);
          const sbName = trackName as SourceBufferName;
          this.addBufferListener(sbName, 'updateend', this._onSBUpdateEnd);
          this.addBufferListener(sbName, 'error', this._onSBUpdateError);
          this.tracks[trackName] = {
            buffer: sb,
            codec: codec,
            container: track.container,
            levelCodec: track.levelCodec,
            id: track.id
          };
        } catch (err) {
          logger.error(`error while trying to add sourceBuffer:${err.message}`);
          this.hls.trigger(Events.ERROR, {
            type: ErrorTypes.MEDIA_ERROR,
            details: ErrorDetails.BUFFER_ADD_CODEC_ERROR,
            fatal: false,
            err,
            mimeType: mimeType
          });
        }
      }
    }
    this.hls.trigger(Events.BUFFER_CREATED, { tracks: this.tracks });
  }

  // Keep as arrow functions so that we can directly reference these functions directly as event listeners
  private _onMediaSourceOpen = () => {
    const { hls, media, mediaSource } = this;
    logger.log('media source opened');
    hls.trigger(Events.MEDIA_ATTACHED, { media });
    if (mediaSource) {
      // once received, don't listen anymore to sourceopen event
      mediaSource.removeEventListener('sourceopen', this._onMediaSourceOpen);
    }
    this.checkPendingTracks();
  };

  private _onMediaSourceClose = () => {
    logger.log('[buffer-controller]: Media source closed');
  };

  private _onMediaSourceEnded = () => {
    logger.log('[buffer-controller]: Media source ended');
  };

  private _onSBUpdateEnd (type: SourceBufferName) {
    const { operationQueue } = this;
    const operation = operationQueue.current(type);
    console.assert(operation, 'Operation should exist on update end');

    operation.onComplete();
    operationQueue.shiftAndExecuteNext(type);
  }

  private _onSBUpdateError (type: SourceBufferName, event: Event) {
    logger.error(`[buffer-controller]: ${type} SourceBuffer error`, event);
    // according to http://www.w3.org/TR/media-source/#sourcebuffer-append-error
    // SourceBuffer errors are not necessarily fatal; if so, the HTMLMediaElement will fire an error event
    this.hls.trigger(Events.ERROR, { type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_APPENDING_ERROR, fatal: false });
    // updateend is always fired after error, so we'll allow that to shift the current operation off of the queue
    const operation = this.operationQueue.current(type);
    if (operation) {
      operation.onError(event);
    }
  }

  // This method must result in an updateend event; if remove is not called, _onSBUpdateEnd must be called manually
  private removeExecutor (type: SourceBufferName, startOffset: number, endOffset: number) {
    const { media, operationQueue, sourceBuffer } = this;
    const sb = sourceBuffer[type];
    if (!media || !sb) {
      logger.warn(`[buffer-controller]: Attempting to remove from the ${type} SourceBuffer, but it does not exist`);
      operationQueue.shiftAndExecuteNext(type);
      return;
    }

    const removeStart = Math.max(0, startOffset);
    const removeEnd = Math.min(media.duration, endOffset);
    if (removeEnd > removeStart) {
      logger.log(`[buffer-controller]: Removing [${removeStart},${removeEnd}] from the ${type} SourceBuffer`);
      console.assert(!sb.updating, `${type} sourceBuffer must not be updating`);
      sb.remove(removeStart, removeEnd);
    } else {
      // Cycle the queue
      operationQueue.shiftAndExecuteNext(type);
    }
  }

  // This method must result in an updateend event; if append is not called, _onSBUpdateEnd must be called manually
  private appendExecutor (data: Uint8Array, type: SourceBufferName) {
    const { operationQueue, sourceBuffer } = this;
    const sb = sourceBuffer[type];
    if (!sb) {
      logger.warn(`[buffer-controller]: Attempting to append to the ${type} SourceBuffer, but it does not exist`);
      operationQueue.shiftAndExecuteNext(type);
      return;
    }

    sb.ended = false;
    console.assert(!sb.updating, `${type} sourceBuffer must not be updating`);
    sb.appendBuffer(data);
  }

  // SourceBuffers can be aborted while the updating flag is true, but only if it is because of an append operation -
  // aborting during a remove will throw an InvalidStateError. It's safer to enqueue aborts and execute them only if
  // updating is false
  private abortExecutor (type: SourceBufferName) {
    const { operationQueue, sourceBuffer } = this;
    const sb = sourceBuffer[type];
    if (!sb) {
      logger.warn(`[buffer-controller]: Attempting to abort to the ${type} SourceBuffer, but it does not exist`);
      operationQueue.shiftAndExecuteNext(type);
      return;
    }
    logger.log(`[buffer-controller]: Aborting the ${type} SourceBuffer`);
    console.assert(!sb.updating, `${type} sourceBuffer must not be updating`);
    sb.abort();
    // updateend is only triggered if aborting while updating is true
    this._onSBUpdateEnd(type);
  }

  // Enqueues an operation to each SourceBuffer queue which, upon execution, resolves a promise. When all promises
  // resolve, the onUnblocked function is executed. Functions calling this method do not need to unblock the queue
  // upon completion, since we already do it here
  private blockBuffers (onUnblocked: Function, buffers: Array<SourceBufferName> = this.getSourceBufferTypes()) {
    if (!buffers.length) {
      logger.log('[buffer-controller]: Blocking operation requested, but no SourceBuffers exist');
      onUnblocked();
      return;
    }
    const { operationQueue } = this;

    logger.log(`[buffer-controller]: Blocking ${buffers} SourceBuffer`);
    const blockingOperations = buffers.map(type => operationQueue.appendBlocker(type as SourceBufferName));
    Promise.all(blockingOperations).then(() => {
      logger.log(`[buffer-controller]: Blocking operation resolved; unblocking ${buffers} SourceBuffer`);
      onUnblocked();
      buffers.forEach(type => {
        const sb = this.sourceBuffer[type];
        // Only cycle the queue if the SB is not updating. There's a bug in Chrome which sets the SB updating flag to
        // true when changing the MediaSource duration (https://bugs.chromium.org/p/chromium/issues/detail?id=959359&can=2&q=mediasource%20duration)
        // While this is a workaround, it's probably useful to have around
        if (!sb || !sb.updating) {
          operationQueue.shiftAndExecuteNext(type);
        }
      });
    });
  }

  private getSourceBufferTypes () : Array<SourceBufferName> {
    return Object.keys(this.sourceBuffer) as Array<SourceBufferName>;
  }

  private addBufferListener (type: SourceBufferName, event: string, fn: Function) {
    const buffer = this.sourceBuffer[type];
    if (!buffer) {
      return;
    }
    const listener = fn.bind(this, type);
    this.listeners[type].push({ event, listener });
    buffer.addEventListener(event, listener);
  }

  private removeBufferListeners (type: SourceBufferName) {
    const buffer = this.sourceBuffer[type];
    if (!buffer) {
      return;
    }
    this.listeners[type].forEach(l => {
      buffer.removeEventListener(l.event, l.listener);
    });
  }
}
