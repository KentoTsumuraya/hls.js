import { BufferHelper } from '../utils/buffer-helper';
import TransmuxerInterface from '../demux/transmuxer-interface';
import Event from '../events';
import TimeRanges from '../utils/time-ranges';
import { ErrorDetails } from '../errors';
import { logger } from '../utils/logger';
import { FragmentState } from './fragment-tracker';
import Fragment, { ElementaryStreamTypes } from '../loader/fragment';
import BaseStreamController, { State } from './base-stream-controller';
import FragmentLoader from '../loader/fragment-loader';
import { ChunkMetadata, TransmuxerResult } from '../types/transmuxer';
import { BufferAppendingEventPayload, TrackLoadedData, AudioTracksUpdated } from '../types/events';
import { TrackSet } from '../types/track';
import { Level } from '../types/level';
import LevelDetails from '../loader/level-details';

const { performance } = self;

const TICK_INTERVAL = 100; // how often to tick in ms

class AudioStreamController extends BaseStreamController {
  private retryDate: number = 0;
  private onvseeking: Function | null = null;
  private onvseeked: Function | null = null;
  private onvended: Function | null = null;
  private videoBuffer: any | null = null;
  private initPTS: any = [];
  private videoTrackCC: number = -1;
  private audioSwitch: boolean = false;
  private trackId: number = -1;

  protected readonly logPrefix = '[audio-stream-controller]';

  constructor (hls, fragmentTracker) {
    super(hls,
      Event.MEDIA_ATTACHED,
      Event.MEDIA_DETACHING,
      Event.AUDIO_TRACKS_UPDATED,
      Event.AUDIO_TRACK_SWITCHING,
      Event.AUDIO_TRACK_LOADED,
      Event.KEY_LOADED,
      Event.ERROR,
      Event.BUFFER_RESET,
      Event.BUFFER_CREATED,
      Event.BUFFER_FLUSHED,
      Event.INIT_PTS_FOUND,
      Event.FRAG_BUFFERED
    );

    this.config = hls.config;
    this.fragmentTracker = fragmentTracker;
    this.fragmentLoader = new FragmentLoader(hls.config);
  }

  // INIT_PTS_FOUND is triggered when the video track parsed in the stream-controller has a new PTS value
  onInitPtsFound ({ frag, initPTS }) {
    // Always update the new INIT PTS
    // Can change due level switch
    const cc = frag.cc;
    this.initPTS[cc] = initPTS;
    this.videoTrackCC = cc;
    this.log(`InitPTS for cc: ${cc} found from video track: ${initPTS}`);
    // If we are waiting, tick immediately to unblock audio fragment transmuxing
    if (this.state === State.WAITING_INIT_PTS) {
      this.tick();
    }
  }

  startLoad (startPosition) {
    if (!this.levels) {
      this.startPosition = startPosition;
      this.state = State.STOPPED;
      return;
    }
    const lastCurrentTime = this.lastCurrentTime;
    this.stopLoad();
    this.setInterval(TICK_INTERVAL);
    this.fragLoadError = 0;
    if (lastCurrentTime > 0 && startPosition === -1) {
      this.log(`Override startPosition with lastCurrentTime @${lastCurrentTime.toFixed(3)}`);
      this.state = State.IDLE;
    } else {
      this.lastCurrentTime = this.startPosition ? this.startPosition : startPosition;
      this.state = State.STARTING;
    }
    this.nextLoadPosition = this.startPosition = this.lastCurrentTime = startPosition;
    this.tick();
  }

  doTick () {
    const { media } = this;

    switch (this.state) {
    case State.ERROR:
      // don't do anything in error state to avoid breaking further ...
      break;
    case State.PAUSED:
      // TODO: Remove useless PAUSED state
      // don't do anything in paused state either ...
      break;
    case State.STARTING:
      this.state = State.WAITING_TRACK;
      this.loadedmetadata = false;
      break;
    case State.IDLE:
      this.doTickIdle();
      break;
    case State.WAITING_TRACK: {
      const { levels, trackId } = this;
      if (levels && levels[trackId] && levels[trackId].details) {
        // check if playlist is already loaded
        this.state = State.WAITING_INIT_PTS;
      }
      break;
    }
    case State.FRAG_LOADING_WAITING_RETRY:
      const now = performance.now();
      const retryDate = this.retryDate;
      const isSeeking = media && media.seeking;
      // if current time is gt than retryDate, or if media seeking let's switch to IDLE state to retry loading
      if (!retryDate || (now >= retryDate) || isSeeking) {
        this.log('RetryDate reached, switch back to IDLE state');
        this.state = State.IDLE;
      }
      break;
    case State.WAITING_INIT_PTS:
      const videoTrackCC = this.videoTrackCC;
      if (Number.isFinite(this.initPTS[videoTrackCC])) {
        this.state = State.IDLE;
      }
      break;
    case State.STOPPED:
    case State.FRAG_LOADING:
    case State.PARSING:
    case State.PARSED:
    case State.ENDED:
      break;
    default:
      break;
    }

    this.onTickEnd();
  }

  protected onTickEnd () {
    const { media } = this;
    if (!media || !media.readyState) {
      // Exit early if we don't have media or if the media hasn't buffered anything yet (readyState 0)
      return;
    }
    const mediaBuffer = this.mediaBuffer ? this.mediaBuffer : media;
    const buffered = mediaBuffer.buffered;

    if (!this.loadedmetadata && buffered.length) {
      this.loadedmetadata = true;
    }

    this.lastCurrentTime = media.currentTime;
  }

  private doTickIdle () {
    const { hls, levels, media, trackId } = this;

    const config = hls.config;
    if (!levels) {
      return;
    }

    // if video not attached AND
    // start fragment already requested OR start frag prefetch disable
    // exit loop
    // => if media not attached but start frag prefetch is enabled and start frag not requested yet, we will not exit loop
    if (!media && (this.startFragRequested || !config.startFragPrefetch)) {
      return;
    }

    const pos = this.getLoadPosition();
    if (!Number.isFinite(pos)) {
      return;
    }

    if (!levels || !levels[trackId]) {
      return;
    }
    const levelInfo = levels[trackId];

    const mediaBuffer = this.mediaBuffer ? this.mediaBuffer : this.media;
    const videoBuffer = this.videoBuffer ? this.videoBuffer : this.media;
    const bufferInfo = BufferHelper.bufferInfo(mediaBuffer, pos, config.maxBufferHole);
    const mainBufferInfo = BufferHelper.bufferInfo(videoBuffer, pos, config.maxBufferHole);
    const bufferLen = bufferInfo.len;
    const maxConfigBuffer = Math.min(config.maxBufferLength, config.maxMaxBufferLength);
    const maxBufLen = Math.max(maxConfigBuffer, mainBufferInfo.len);
    const audioSwitch = this.audioSwitch;

    // if buffer length is less than maxBufLen try to load a new fragment
    if (bufferLen >= maxBufLen && !audioSwitch) {
      return;
    }

    const trackDetails = levelInfo.details;
    if (!trackDetails) {
      this.state = State.WAITING_TRACK;
      return;
    }

    if (!audioSwitch && this._streamEnded(bufferInfo, trackDetails)) {
      hls.trigger(Event.BUFFER_EOS, { type: 'audio' });
      this.state = State.ENDED;
      return;
    }

    const fragments = trackDetails.fragments;
    const start = fragments[0].start;
    let loadPos = bufferInfo.end;

    if (audioSwitch) {
      loadPos = pos;
      // if currentTime (pos) is less than alt audio playlist start time, it means that alt audio is ahead of currentTime
      if (trackDetails.PTSKnown && pos < start) {
        // if everything is buffered from pos to start or if audio buffer upfront, let's seek to start
        if (bufferInfo.end > start || bufferInfo.nextStart) {
          this.log('Alt audio track ahead of main track, seek to start of alt audio track');
          media.currentTime = start + 0.05;
        }
      }
    }

    const frag = this.getNextFragment(loadPos, trackDetails);
    if (!frag) {
      return;
    }

    if (frag.encrypted) {
      this.log(`Loading key for ${frag.sn} of [${trackDetails.startSN} ,${trackDetails.endSN}],track ${trackId}`);
      this.state = State.KEY_LOADING;
      hls.trigger(Event.KEY_LOADING, { frag: frag });
    } else {
      this.log(`Loading ${frag.sn}, cc: ${frag.cc} of [${trackDetails.startSN} ,${trackDetails.endSN}],track ${trackId}, currentTime:${pos},bufferEnd:${bufferInfo.end.toFixed(3)}`);
      this.loadFragment(frag);
    }
  }

  onMediaAttached (data) {
    const media = this.media = this.mediaBuffer = data.media;
    this.onvseeking = this.onMediaSeeking.bind(this);
    this.onvended = this.onMediaEnded.bind(this);
    media.addEventListener('seeking', this.onvseeking);
    media.addEventListener('ended', this.onvended);
    const config = this.config;
    if (this.levels && config.autoStartLoad) {
      this.startLoad(config.startPosition);
    }
  }

  onMediaDetaching () {
    const media = this.media;
    if (media && media.ended) {
      this.log('MSE detaching and video ended, reset startPosition');
      this.startPosition = this.lastCurrentTime = 0;
    }

    // remove video listeners
    if (media) {
      media.removeEventListener('seeking', this.onvseeking);
      media.removeEventListener('ended', this.onvended);
      this.onvseeking = this.onvseeked = this.onvended = null;
    }
    this.media = this.mediaBuffer = this.videoBuffer = null;
    this.loadedmetadata = false;
    this.stopLoad();
  }

  onAudioTracksUpdated ({ audioTracks }: AudioTracksUpdated) {
    this.log('Audio tracks updated');
    this.levels = audioTracks.map(mediaPlaylist => new Level(mediaPlaylist));
  }

  onAudioTrackSwitching (data) {
    // if any URL found on new audio track, it is an alternate audio track
    const altAudio = !!data.url;
    this.trackId = data.id;
    const { fragCurrent, transmuxer } = this;

    if (fragCurrent && fragCurrent.loader) {
      fragCurrent.loader.abort();
    }
    this.fragCurrent = null;
    // destroy useless transmuxer when switching audio to main
    if (!altAudio) {
      if (transmuxer) {
        transmuxer.destroy();
        this.transmuxer = null;
      }
    } else {
      // switching to audio track, start timer if not already started
      this.setInterval(TICK_INTERVAL);
    }

    // should we switch tracks ?
    if (altAudio) {
      this.audioSwitch = true;
      // main audio track are handled by stream-controller, just do something if switching to alt audio track
      this.state = State.IDLE;
    } else {
      this.state = State.PAUSED;
    }
    this.tick();
  }

  onAudioTrackLoaded (data: TrackLoadedData) {
    const { levels } = this;
    const { details: newDetails, id: trackId } = data;
    if (!levels) {
      this.warn(`Audio tracks were reset while loading level ${trackId}`);
      return;
    }
    this.log(`Track ${trackId} loaded [${newDetails.startSN},${newDetails.endSN}],duration:${newDetails.totalduration}`);

    const track = levels[trackId];
    let sliding = 0;
    if (newDetails.live) {
      sliding = this.mergeLivePlaylists(track.details, newDetails);
    } else {
      newDetails.PTSKnown = false;
    }
    track.details = newDetails;

    // compute start position
    if (!this.startFragRequested) {
      this.setStartPosition(track.details, sliding);
    }
    // only switch batck to IDLE state if we were waiting for track to start downloading a new fragment
    if (this.state === State.WAITING_TRACK) {
      this.state = State.IDLE;
    }

    // trigger handler right now
    this.tick();
  }

  onKeyLoaded () {
    if (this.state === State.KEY_LOADING) {
      this.state = State.IDLE;
      this.tick();
    }
  }

  _handleFragmentLoadProgress (frag: Fragment, payload: Uint8Array) {
    const { config, trackId, levels } = this;
    if (!levels) {
      this.warn(`Audio tracks were reset while fragment load was in progress. Fragment ${frag.sn} of level ${frag.level} will not be buffered`);
      return;
    }

    const track = levels[trackId] as Level;
    console.assert(track, 'Audio track is defined on fragment load progress');
    const details = track.details as LevelDetails;
    console.assert(details, 'Audio track details are defined on fragment load progress');
    const audioCodec = config.defaultAudioCodec || track.audioCodec || 'mp4a.40.2';

    let transmuxer = this.transmuxer;
    if (!transmuxer) {
      transmuxer = this.transmuxer =
          new TransmuxerInterface(this.hls, 'audio', this._handleTransmuxComplete.bind(this), this._handleTransmuxerFlush.bind(this));
    }

    // initPTS from the video track is required for transmuxing. It should exist before loading a fragment.
    const initPTS = this.initPTS[frag.cc];

    const initSegmentData = details.initSegment ? details.initSegment.data : [];
    // this.log(`Transmuxing ${sn} of [${details.startSN} ,${details.endSN}],track ${trackId}`);
    // time Offset is accurate if level PTS is known, or if playlist is not sliding (not live)
    const accurateTimeOffset = false; // details.PTSKnown || !details.live;
    const chunkMeta = new ChunkMetadata(frag.level, frag.sn, frag.stats.chunkCount, payload.byteLength);
    transmuxer.push(payload, initSegmentData, audioCodec, '', frag, details.totalduration, accurateTimeOffset, chunkMeta, initPTS);
  }

  onBufferReset () {
    // reset reference to sourcebuffers
    this.mediaBuffer = this.videoBuffer = null;
    this.loadedmetadata = false;
  }

  onBufferCreated (data) {
    const audioTrack = data.tracks.audio;
    if (audioTrack) {
      this.mediaBuffer = audioTrack.buffer;
    }
    if (data.tracks.video) {
      this.videoBuffer = data.tracks.video.buffer;
    }
  }

  onFragBuffered (data: { frag: Fragment }) {
    const { frag } = data;
    if (frag && frag.type !== 'audio') {
      return;
    }
    if (this._fragLoadAborted(frag)) {
      // If a level switch was requested while a fragment was buffering, it will emit the FRAG_BUFFERED event upon completion
      // Avoid setting state back to IDLE or concluding the audio switch; otherwise, the switched-to track will not buffer
      this.warn(`Fragment ${frag.sn} of level ${frag.level} finished buffering, but was aborted. state: ${this.state}, audioSwitch: ${this.audioSwitch}`);
      return;
    }
    this.fragPrevious = frag;
    const media = this.mediaBuffer ? this.mediaBuffer : this.media;
    this.log(`Buffered fragment ${frag.sn} of level ${frag.level}. PTS:[${frag.startPTS},${frag.endPTS}],DTS:[${frag.startDTS}/${frag.endDTS}], Buffered: ${TimeRanges.toString(media.buffered)}`);
    if (this.audioSwitch && frag.sn !== 'initSegment') {
      this.audioSwitch = false;
      this.hls.trigger(Event.AUDIO_TRACK_SWITCHED, { id: this.trackId });
    }
    this.state = State.IDLE;
    this.tick();
  }

  onError (data) {
    const frag = data.frag;
    // don't handle frag error not related to audio fragment
    if (frag && frag.type !== 'audio') {
      return;
    }

    switch (data.details) {
    case ErrorDetails.FRAG_LOAD_ERROR:
    case ErrorDetails.FRAG_LOAD_TIMEOUT:
      const frag = data.frag;
      // don't handle frag error not related to audio fragment
      if (frag && frag.type !== 'audio') {
        break;
      }

      if (!data.fatal) {
        let loadError = this.fragLoadError;
        if (loadError) {
          loadError++;
        } else {
          loadError = 1;
        }

        const config = this.config;
        if (loadError <= config.fragLoadingMaxRetry) {
          this.fragLoadError = loadError;
          // exponential backoff capped to config.fragLoadingMaxRetryTimeout
          const delay = Math.min(Math.pow(2, loadError - 1) * config.fragLoadingRetryDelay, config.fragLoadingMaxRetryTimeout);
          this.warn(`Frag loading failed, retry in ${delay} ms`);
          this.retryDate = performance.now() + delay;
          // retry loading state
          this.state = State.FRAG_LOADING_WAITING_RETRY;
        } else {
          logger.error(`${data.details} reaches max retry, redispatch as fatal ...`);
          // switch error to fatal
          data.fatal = true;
          this.state = State.ERROR;
        }
      }
      break;
    case ErrorDetails.AUDIO_TRACK_LOAD_ERROR:
    case ErrorDetails.AUDIO_TRACK_LOAD_TIMEOUT:
    case ErrorDetails.KEY_LOAD_ERROR:
    case ErrorDetails.KEY_LOAD_TIMEOUT:
      //  when in ERROR state, don't switch back to IDLE state in case a non-fatal error is received
      if (this.state !== State.ERROR) {
        // if fatal error, stop processing, otherwise move to IDLE to retry loading
        this.state = data.fatal ? State.ERROR : State.IDLE;
        this.warn(`${data.details} while loading frag, now switching to ${this.state} state ...`);
      }
      break;
    case ErrorDetails.BUFFER_FULL_ERROR:
      // if in appending state
      if (data.parent === 'audio' && (this.state === State.PARSING || this.state === State.PARSED)) {
        const media = this.mediaBuffer;
        const currentTime = this.media.currentTime;
        const mediaBuffered = media && BufferHelper.isBuffered(media, currentTime) && BufferHelper.isBuffered(media, currentTime + 0.5);
        // reduce max buf len if current position is buffered
        if (mediaBuffered) {
          const config = this.config;
          if (config.maxMaxBufferLength >= config.maxBufferLength) {
            // reduce max buffer length as it might be too high. we do this to avoid loop flushing ...
            config.maxMaxBufferLength /= 2;
            this.warn(`Reduce max buffer length to ${config.maxMaxBufferLength}s`);
          }
          this.state = State.IDLE;
        } else {
          // current position is not buffered, but browser is still complaining about buffer full error
          // this happens on IE/Edge, refer to https://github.com/video-dev/hls.js/pull/708
          // in that case flush the whole audio buffer to recover
          this.warn('Buffer full error also media.currentTime is not buffered, flush audio buffer');
          this.fragCurrent = null;
          // flush everything
          this.hls.trigger(Event.BUFFER_FLUSHING, { startOffset: 0, endOffset: Number.POSITIVE_INFINITY, type: 'audio' });
        }
      }
      break;
    default:
      break;
    }
  }

  onBufferFlushed () {
    /* after successful buffer flushing, filter flushed fragments from bufferedFrags
      use mediaBuffered instead of media (so that we will check against video.buffered ranges in case of alt audio track)
    */
    const media = this.mediaBuffer ? this.mediaBuffer : this.media;
    if (media) {
      // filter fragments potentially evicted from buffer. this is to avoid memleak on live streams
      this.fragmentTracker.detectEvictedFragments(ElementaryStreamTypes.AUDIO, media.buffered);
    }
    // move to IDLE once flush complete. this should trigger new fragment loading
    this.state = State.IDLE;
    // reset reference to frag
    this.fragPrevious = null;
  }

  private _handleTransmuxComplete (transmuxResult: TransmuxerResult) {
    const id = 'audio';
    const { hls } = this;
    const { remuxResult, chunkMeta } = transmuxResult;

    const context = this.getCurrentContext(chunkMeta);
    if (!context) {
      this.warn(`The loading context changed while buffering fragment ${chunkMeta.sn} of level ${chunkMeta.level}. This chunk will not be buffered.`);
      return;
    }
    const { frag } = context;
    const { audio, text, id3, initSegment } = remuxResult;

    this.state = State.PARSING;
    if (this.audioSwitch && audio) {
      this.completeAudioSwitch();
    }

    if (initSegment && initSegment.tracks) {
      this._bufferInitSegment(initSegment.tracks, frag, chunkMeta);
      hls.trigger(Event.FRAG_PARSING_INIT_SEGMENT, { frag, id, tracks: initSegment.tracks });
      // Only flush audio from old audio tracks when PTS is known on new audio track
    }
    if (audio) {
      frag.setElementaryStreamInfo(ElementaryStreamTypes.AUDIO, audio.startPTS, audio.endPTS, audio.startDTS, audio.endDTS);
      this.bufferFragmentData(audio, frag, chunkMeta);
    }

    if (id3) {
      const emittedID3: any = id3;
      emittedID3.frag = frag;
      emittedID3.id = id;
      hls.trigger(Event.FRAG_PARSING_METADATA, emittedID3);
    }
    if (text) {
      const emittedText: any = text;
      emittedText.frag = frag;
      emittedText.id = id;
      hls.trigger(Event.FRAG_PARSING_USERDATA, emittedText);
    }
  }

  private _bufferInitSegment (tracks: TrackSet, frag: Fragment, chunkMeta: ChunkMetadata) {
    if (this.state !== State.PARSING) {
      return;
    }
    // delete any video track found on audio transmuxer
    if (tracks.video) {
      delete tracks.video;
    }

    // include levelCodec in audio and video tracks
    const track = tracks.audio;
    if (!track) {
      return;
    }

    track.levelCodec = track.codec;
    track.id = 'audio';
    this.hls.trigger(Event.BUFFER_CODECS, tracks);
    this.log(`Audio, container:${track.container}, codecs[level/parsed]=[${track.levelCodec}/${track.codec}]`);
    const initSegment = track.initSegment;
    if (initSegment) {
      const segment: BufferAppendingEventPayload = { type: 'audio', data: initSegment, frag, chunkMeta };
      this.hls.trigger(Event.BUFFER_APPENDING, segment);
    }
    // trigger handler right now
    this.tick();
  }

  private loadFragment (frag: Fragment) {
    // only load if fragment is not loaded or if in audio switch
    // we force a frag loading in audio switch as fragment tracker might not have evicted previous frags in case of quick audio switch
    const fragState = this.fragmentTracker.getState(frag);
    this.fragCurrent = frag;
    const prevPos = this.nextLoadPosition;

    if (!this.audioSwitch && fragState !== FragmentState.NOT_LOADED) {
      return;
    }

    if (frag.sn === 'initSegment') {
      this._loadInitSegment(frag);
    } else if (Number.isFinite(this.initPTS[frag.cc])) {
      this.startFragRequested = true;
      this.nextLoadPosition = frag.start + frag.duration;
      this._loadFragForPlayback(frag);
    } else {
      this.log(`Unknown video PTS for continuity counter ${frag.cc}, waiting for video PTS before loading audio fragment ${frag.sn} of level ${this.trackId}`);
      this.state = State.WAITING_INIT_PTS;
      this.nextLoadPosition = prevPos;
    }
  }

  private completeAudioSwitch () {
    const { hls, media, trackId } = this;
    if (media) {
      this.warn('Switching audio track : flushing all audio');
      hls.trigger(Event.BUFFER_FLUSHING, {
        startOffset: 0,
        endOffset: Number.POSITIVE_INFINITY,
        type: 'audio'
      });
    }
    this.audioSwitch = false;
    hls.trigger(Event.AUDIO_TRACK_SWITCHED, { id: trackId });
  }
}
export default AudioStreamController;
