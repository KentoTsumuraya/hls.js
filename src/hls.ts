import * as URLToolkit from 'url-toolkit';

import {
  ErrorTypes,
  ErrorDetails
} from './errors';

import PlaylistLoader from './loader/playlist-loader';
import KeyLoader from './loader/key-loader';

import { FragmentTracker } from './controller/fragment-tracker';
import StreamController from './controller/stream-controller';
import LevelController from './controller/level-controller';

import PerformanceMonitor from './performance/performance-monitor';

import { isSupported } from './is-supported';
import { logger, enableLogs } from './utils/logger';
import { HlsConfig, hlsDefaultConfig, mergeConfig, setStreamingMode } from './config';

import HlsEvents from './events';

import { Observer } from './observer';
import { Level } from './types/level';
import { MediaPlaylist } from './types/media-playlist';

/**
 * @module Hls
 * @class
 * @constructor
 */
export default class Hls extends Observer {
  public static defaultConfig?: HlsConfig;
  public config: HlsConfig;

  private _autoLevelCapping: number;
  private abrController: any;
  private capLevelController: any;
  private levelController: any;
  private streamController: any;
  private networkControllers: any[];
  private audioTrackController: any;
  private subtitleTrackController: any;
  private emeController: any;
  private coreComponents: any[];
  private media: HTMLMediaElement | null = null;
  private url: string | null = null;

  static get version (): string {
    return __VERSION__;
  }

  static isSupported (): boolean {
    return isSupported();
  }

  static get Events () {
    return HlsEvents;
  }

  static get ErrorTypes () {
    return ErrorTypes;
  }

  static get ErrorDetails () {
    return ErrorDetails;
  }

  static get DefaultConfig (): HlsConfig {
    if (!Hls.defaultConfig) {
      return hlsDefaultConfig;
    }

    return Hls.defaultConfig;
  }

  /**
   * @type {HlsConfig}
   */
  static set DefaultConfig (defaultConfig: HlsConfig) {
    Hls.defaultConfig = defaultConfig;
  }

  /**
   * Creates an instance of an HLS client that can attach to exactly one `HTMLMediaElement`.
   *
   * @constructs Hls
   * @param {HlsConfig} config
   */
  constructor (userConfig: Partial<HlsConfig> = {}) {
    super();

    const defaultConfig = Hls.DefaultConfig;
    mergeConfig(defaultConfig, userConfig);
    const config = this.config = userConfig as HlsConfig;
    enableLogs(config.debug);

    this._autoLevelCapping = -1;
    // Try to enable progressive streaming by default. Whether it will be enabled depends on API support
    this.progressive = config.progressive;

    // core controllers and network loaders
    const abrController = this.abrController = new config.abrController(this); // eslint-disable-line new-cap
    const bufferController = new config.bufferController(this); // eslint-disable-line new-cap
    const capLevelController = this.capLevelController = new config.capLevelController(this); // eslint-disable-line new-cap
    const fpsController = new config.fpsController(this); // eslint-disable-line new-cap
    const playListLoader = new PlaylistLoader(this);
    const keyLoader = new KeyLoader(this);

    // network controllers
    const levelController = this.levelController = new LevelController(this);
    // FIXME: FragmentTracker must be defined before StreamController because the order of event handling is important
    const fragmentTracker = new FragmentTracker(this);
    const streamController = this.streamController = new StreamController(this, fragmentTracker);

    // Cap level controller uses streamController to flush the buffer
    capLevelController.setStreamController(streamController);

    const networkControllers = [
      levelController,
      streamController
    ];

    this.networkControllers = networkControllers;
    const coreComponents = [
      playListLoader,
      keyLoader,
      abrController,
      bufferController,
      capLevelController,
      fpsController,
      fragmentTracker
    ];

    this.audioTrackController = this.createController(config.audioTrackController, null, networkControllers);
    this.createController(config.audioStreamController, fragmentTracker, networkControllers);
    // subtitleTrackController must be defined before  because the order of event handling is important
    this.subtitleTrackController = this.createController(config.subtitleTrackController, null, networkControllers);
    this.createController(config.subtitleStreamController, fragmentTracker, networkControllers);
    this.createController(config.timelineController, null, coreComponents);
    this.emeController = this.createController(config.emeController, null, coreComponents);

    // Push the performance monitor last so that it is the last class to handle events
    coreComponents.push(new PerformanceMonitor(this));

    this.coreComponents = coreComponents;
  }

  createController (ControllerClass, fragmentTracker, components) {
    if (ControllerClass) {
      const controllerInstance = fragmentTracker ? new ControllerClass(this, fragmentTracker) : new ControllerClass(this);
      if (components) {
        components.push(controllerInstance);
      }
      return controllerInstance;
    }
    return null;
  }

  /**
   * Dispose of the instance
   */
  destroy () {
    logger.log('destroy');
    this.trigger(HlsEvents.DESTROYING);
    this.detachMedia();
    this.coreComponents.concat(this.networkControllers).forEach(component => {
      component.destroy();
    });
    this.url = null;
    this.removeAllListeners();
    this._autoLevelCapping = -1;
  }

  /**
   * Attaches Hls.js to a media element
   * @param {HTMLMediaElement} media
   */
  attachMedia (media: HTMLMediaElement) {
    logger.log('attachMedia');
    this.media = media;
    this.trigger(HlsEvents.MEDIA_ATTACHING, { media: media });
  }

  /**
   * Detach Hls.js from the media
   */
  detachMedia () {
    logger.log('detachMedia');
    this.trigger(HlsEvents.MEDIA_DETACHING);
    this.media = null;
  }

  /**
   * Set the source URL. Can be relative or absolute.
   * @param {string} url
   */
  loadSource (url: string) {
    url = URLToolkit.buildAbsoluteURL(self.location.href, url, { alwaysNormalize: true });
    logger.log(`loadSource:${url}`);
    this.url = url;
    // when attaching to a source URL, trigger a playlist load
    this.trigger(HlsEvents.MANIFEST_LOADING, { url: url });
  }

  /**
   * Start loading data from the stream source.
   * Depending on default config, client starts loading automatically when a source is set.
   *
   * @param {number} startPosition Set the start position to stream from
   * @default -1 None (from earliest point)
   */
  startLoad (startPosition: number = -1) {
    logger.log(`startLoad(${startPosition})`);
    this.networkControllers.forEach(controller => {
      controller.startLoad(startPosition);
    });
  }

  /**
   * Stop loading of any stream data.
   */
  stopLoad () {
    logger.log('stopLoad');
    this.networkControllers.forEach(controller => {
      controller.stopLoad();
    });
  }

  /**
   * Swap through possible audio codecs in the stream (for example to switch from stereo to 5.1)
   */
  swapAudioCodec () {
    logger.log('swapAudioCodec');
    this.streamController.swapAudioCodec();
  }

  /**
   * When the media-element fails, this allows to detach and then re-attach it
   * as one call (convenience method).
   *
   * Automatic recovery of media-errors by this process is configurable.
   */
  recoverMediaError () {
    logger.log('recoverMediaError');
    const media = this.media;
    this.detachMedia();
    if (media) {
      this.attachMedia(media);
    }
  }

  removeLevel (levelIndex, urlId = 0) {
    this.levelController.removeLevel(levelIndex, urlId);
  }

  /**
   * @type {Level[]}
   */
  get levels (): Array<Level> {
    return this.levelController.levels;
  }

  /**
   * Index of quality level currently played
   * @type {number}
   */
  get currentLevel (): number {
    return this.streamController.currentLevel;
  }

  /**
   * Set quality level index immediately .
   * This will flush the current buffer to replace the quality asap.
   * That means playback will interrupt at least shortly to re-buffer and re-sync eventually.
   * @type {number} -1 for automatic level selection
   */
  set currentLevel (newLevel: number) {
    logger.log(`set currentLevel:${newLevel}`);
    this.loadLevel = newLevel;
    this.streamController.immediateLevelSwitch();
  }

  /**
   * Index of next quality level loaded as scheduled by stream controller.
   * @type {number}
   */
  get nextLevel (): number {
    return this.streamController.nextLevel;
  }

  /**
   * Set quality level index for next loaded data.
   * This will switch the video quality asap, without interrupting playback.
   * May abort current loading of data, and flush parts of buffer (outside currently played fragment region).
   * @type {number} -1 for automatic level selection
   */
  set nextLevel (newLevel: number) {
    logger.log(`set nextLevel:${newLevel}`);
    this.levelController.manualLevel = newLevel;
    this.streamController.nextLevelSwitch();
  }

  /**
   * Return the quality level of the currently or last (of none is loaded currently) segment
   * @type {number}
   */
  get loadLevel (): number {
    return this.levelController.level;
  }

  /**
   * Set quality level index for next loaded data in a conservative way.
   * This will switch the quality without flushing, but interrupt current loading.
   * Thus the moment when the quality switch will appear in effect will only be after the already existing buffer.
   * @type {number} newLevel -1 for automatic level selection
   */
  set loadLevel (newLevel: number) {
    logger.log(`set loadLevel:${newLevel}`);
    this.levelController.manualLevel = newLevel;
  }

  /**
   * get next quality level loaded
   * @type {number}
   */
  get nextLoadLevel (): number {
    return this.levelController.nextLoadLevel;
  }

  /**
   * Set quality level of next loaded segment in a fully "non-destructive" way.
   * Same as `loadLevel` but will wait for next switch (until current loading is done).
   * @type {number} level
   */
  set nextLoadLevel (level: number) {
    this.levelController.nextLoadLevel = level;
  }

  /**
   * Return "first level": like a default level, if not set,
   * falls back to index of first level referenced in manifest
   * @type {number}
   */
  get firstLevel (): number {
    return Math.max(this.levelController.firstLevel, this.minAutoLevel);
  }

  /**
   * Sets "first-level", see getter.
   * @type {number}
   */
  set firstLevel (newLevel: number) {
    logger.log(`set firstLevel:${newLevel}`);
    this.levelController.firstLevel = newLevel;
  }

  /**
   * Return start level (level of first fragment that will be played back)
   * if not overrided by user, first level appearing in manifest will be used as start level
   * if -1 : automatic start level selection, playback will start from level matching download bandwidth
   * (determined from download of first segment)
   * @type {number}
   */
  get startLevel (): number {
    return this.levelController.startLevel;
  }

  /**
   * set  start level (level of first fragment that will be played back)
   * if not overrided by user, first level appearing in manifest will be used as start level
   * if -1 : automatic start level selection, playback will start from level matching download bandwidth
   * (determined from download of first segment)
   * @type {number} newLevel
   */
  set startLevel (newLevel: number) {
    logger.log(`set startLevel:${newLevel}`);
    // if not in automatic start level detection, ensure startLevel is greater than minAutoLevel
    if (newLevel !== -1) {
      newLevel = Math.max(newLevel, this.minAutoLevel);
    }

    this.levelController.startLevel = newLevel;
  }

  /**
   * set  dynamically set capLevelToPlayerSize against (`CapLevelController`)
   *
   * @type {boolean}
   */
  set capLevelToPlayerSize (shouldStartCapping: boolean) {
    const newCapLevelToPlayerSize = !!shouldStartCapping;

    if (newCapLevelToPlayerSize !== this.config.capLevelToPlayerSize) {
      if (newCapLevelToPlayerSize) {
        this.capLevelController.startCapping(); // If capping occurs, nextLevelSwitch will happen based on size.
      } else {
        this.capLevelController.stopCapping();
        this.autoLevelCapping = -1;
        this.streamController.nextLevelSwitch(); // Now we're uncapped, get the next level asap.
      }

      this.config.capLevelToPlayerSize = newCapLevelToPlayerSize;
    }
  }

  /**
   * Capping/max level value that should be used by automatic level selection algorithm (`ABRController`)
   * @type {number}
   */
  get autoLevelCapping (): number {
    return this._autoLevelCapping;
  }

  /**
   * get bandwidth estimate
   * @type {number}
   */
  get bandwidthEstimate (): number {
    const bwEstimator = this.abrController._bwEstimator;
    return bwEstimator ? bwEstimator.getEstimate() : NaN;
  }

  /**
   * Capping/max level value that should be used by automatic level selection algorithm (`ABRController`)
   * @type {number}
   */
  set autoLevelCapping (newLevel: number) {
    logger.log(`set autoLevelCapping:${newLevel}`);
    this._autoLevelCapping = newLevel;
  }

  /**
   * True when automatic level selection enabled
   * @type {boolean}
   */
  get autoLevelEnabled (): boolean {
    return (this.levelController.manualLevel === -1);
  }

  /**
   * Level set manually (if any)
   * @type {number}
   */
  get manualLevel (): number {
    return this.levelController.manualLevel;
  }

  /**
   * min level selectable in auto mode according to config.minAutoBitrate
   * @type {number}
   */
  get minAutoLevel (): number {
    const { levels, config: { minAutoBitrate } } = this;
    const len = levels ? levels.length : 0;

    for (let i = 0; i < len; i++) {
      const levelNextBitrate = levels[i].realBitrate
        ? Math.max(levels[i].realBitrate, levels[i].bitrate)
        : levels[i].bitrate;

      if (levelNextBitrate > minAutoBitrate) {
        return i;
      }
    }

    return 0;
  }

  /**
   * max level selectable in auto mode according to autoLevelCapping
   * @type {number}
   */
  get maxAutoLevel (): number {
    const { levels, autoLevelCapping } = this;

    let maxAutoLevel;
    if (autoLevelCapping === -1 && levels && levels.length) {
      maxAutoLevel = levels.length - 1;
    } else {
      maxAutoLevel = autoLevelCapping;
    }

    return maxAutoLevel;
  }

  /**
   * next automatically selected quality level
   * @type {number}
   */
  get nextAutoLevel (): number {
    // ensure next auto level is between  min and max auto level
    return Math.min(Math.max(this.abrController.nextAutoLevel, this.minAutoLevel), this.maxAutoLevel);
  }

  /**
   * this setter is used to force next auto level.
   * this is useful to force a switch down in auto mode:
   * in case of load error on level N, hls.js can set nextAutoLevel to N-1 for example)
   * forced value is valid for one fragment. upon succesful frag loading at forced level,
   * this value will be resetted to -1 by ABR controller.
   * @type {number}
   */
  set nextAutoLevel (nextLevel: number) {
    this.abrController.nextAutoLevel = Math.max(this.minAutoLevel, nextLevel);
  }

  /**
   * @type {AudioTrack[]}
   */
  get audioTracks (): Array<MediaPlaylist> {
    const audioTrackController = this.audioTrackController;
    return audioTrackController ? audioTrackController.audioTracks : [];
  }

  /**
   * index of the selected audio track (index in audio track lists)
   * @type {number}
   */
  get audioTrack (): number {
    const audioTrackController = this.audioTrackController;
    return audioTrackController ? audioTrackController.audioTrack : -1;
  }

  /**
   * selects an audio track, based on its index in audio track lists
   * @type {number}
   */
  set audioTrack (audioTrackId: number) {
    const audioTrackController = this.audioTrackController;
    if (audioTrackController) {
      audioTrackController.audioTrack = audioTrackId;
    }
  }

  /**
   * @type {Seconds}
   */
  get liveSyncPosition (): number {
    return this.streamController.liveSyncPosition;
  }

  /**
   * get alternate subtitle tracks list from playlist
   * @type {MediaPlaylist[]}
   */
  get subtitleTracks (): Array<MediaPlaylist> {
    const subtitleTrackController = this.subtitleTrackController;
    return subtitleTrackController ? subtitleTrackController.subtitleTracks : [];
  }

  /**
   * index of the selected subtitle track (index in subtitle track lists)
   * @type {number}
   */
  get subtitleTrack (): number {
    const subtitleTrackController = this.subtitleTrackController;
    return subtitleTrackController ? subtitleTrackController.subtitleTrack : -1;
  }

  get progressive () {
    return this.config.progressive;
  }

  /**
   * select an subtitle track, based on its index in subtitle track lists
   * @type {number}
   */
  set subtitleTrack (subtitleTrackId: number) {
    const subtitleTrackController = this.subtitleTrackController;
    if (subtitleTrackController) {
      subtitleTrackController.subtitleTrack = subtitleTrackId;
    }
  }

  /**
   * @type {boolean}
   */
  get subtitleDisplay (): boolean {
    const subtitleTrackController = this.subtitleTrackController;
    return subtitleTrackController ? subtitleTrackController.subtitleDisplay : false;
  }

  /**
   * Enable/disable subtitle display rendering
   * @type {boolean}
   */
  set subtitleDisplay (value: boolean) {
    const subtitleTrackController = this.subtitleTrackController;
    if (subtitleTrackController) {
      subtitleTrackController.subtitleDisplay = value;
    }
  }

  set progressive (value) {
    setStreamingMode(this.config, value);
  }
}
