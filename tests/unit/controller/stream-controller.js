import Hls from '../../../src/hls';
import Event from '../../../src/events';
import { FragmentTracker, FragmentState } from '../../../src/controller/fragment-tracker';
import StreamController from '../../../src/controller/stream-controller';
import { State } from '../../../src/controller/base-stream-controller';
import { mockFragments } from '../../mocks/data';
import Fragment from '../../../src/loader/fragment';
import M3U8Parser from '../../../src/loader/m3u8-parser';

import sinon from 'sinon';

describe('StreamController', function () {
  let hls;
  let fragmentTracker;
  let streamController;
  beforeEach(function () {
    hls = new Hls({});
    fragmentTracker = new FragmentTracker(hls);
    streamController = new StreamController(hls, fragmentTracker);
    streamController.startFragRequested = true;
  });

  /**
   * Assert: streamController should be started
   * @param {StreamController} streamController
   */
  const assertStreamControllerStarted = (streamController) => {
    expect(streamController.hasInterval()).to.be.true;
    expect(streamController.state).to.equal(State.IDLE, 'StreamController\'s state should not be STOPPED');
  };

  /**
   * Assert: streamController should be stopped
   * @param {StreamController} streamController
   */
  const assertStreamControllerStopped = (streamController) => {
    expect(streamController.hasInterval()).to.be.false;
    expect(streamController.state).to.equal(State.STOPPED, 'StreamController\'s state should be STOPPED');
  };

  describe('StreamController', function () {
    it('should be STOPPED when it is initialized', function () {
      assertStreamControllerStopped(streamController);
    });

    it('should not start when controller does not have level data', function () {
      streamController.startLoad(1);
      assertStreamControllerStopped(streamController);
    });

    it('should start without levels data', function () {
      const manifest = `#EXTM3U
  #EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=836280,RESOLUTION=848x360,NAME="480"
  http://proxy-62.dailymotion.com/sec(3ae40f708f79ca9471f52b86da76a3a8)/video/107/282/158282701_mp4_h264_aac_hq.m3u8#cell=core`;
      const levels = M3U8Parser.parseMasterPlaylist(manifest, 'http://www.dailymotion.com');
      // load levels data
      streamController.onManifestParsed({
        levels
      });
      streamController.startLoad(1);
      assertStreamControllerStarted(streamController);
      streamController.stopLoad();
      assertStreamControllerStopped(streamController);
    });
  });

  describe('SN Searching', function () {
    const fragPrevious = {
      programDateTime: 1505502671523,
      endProgramDateTime: 1505502676523,
      duration: 5.000,
      level: 1,
      start: 10.000,
      sn: 2, // Fragment with PDT 1505502671523 in level 1 does not have the same sn as in level 2 where cc is 1
      cc: 0
    };

    const levelDetails = {
      startSN: mockFragments[0].sn,
      endSN: mockFragments[mockFragments.length - 1].sn,
      fragments: mockFragments
    };
    const bufferEnd = fragPrevious.start + fragPrevious.duration;
    const end = mockFragments[mockFragments.length - 1].start + mockFragments[mockFragments.length - 1].duration;

    before(function () {
      levelDetails.hasProgramDateTime = false;
    });

    beforeEach(function () {
      streamController.fragPrevious = fragPrevious;
    });

    it('PTS search choosing wrong fragment (3 instead of 2) after level loaded', function () {
      const foundFragment = streamController.getNextFragment(bufferEnd, levelDetails);
      const resultSN = foundFragment ? foundFragment.sn : -1;
      expect(foundFragment).to.equal(mockFragments[3], 'Expected sn 3, found sn segment ' + resultSN);
    });

    // TODO: This test fails if using a real instance of Hls
    it('PTS search choosing the right segment if fragPrevious is not available', function () {
      const foundFragment = streamController.getNextFragment(bufferEnd, levelDetails);
      const resultSN = foundFragment ? foundFragment.sn : -1;
      expect(foundFragment).to.equal(mockFragments[3], 'Expected sn 3, found sn segment ' + resultSN);
    });

    it('returns the last fragment if the stream is fully buffered', function () {
      const actual = streamController.getNextFragment(end, levelDetails);
      expect(actual).to.equal(mockFragments[mockFragments.length - 1]);
    });

    describe('PDT Searching during a live stream', function () {
      before(function () {
        levelDetails.hasProgramDateTime = true;
      });

      it('PDT search choosing fragment after level loaded', function () {
        levelDetails.PTSKnown = false;
        levelDetails.live = true;

        const foundFragment = streamController.getInitialLiveFragment(levelDetails, mockFragments);
        const resultSN = foundFragment ? foundFragment.sn : -1;
        expect(foundFragment).to.equal(mockFragments[2], 'Expected sn 2, found sn segment ' + resultSN);
      });
    });
  });

  describe('fragment loading', function () {
    function fragStateStub (state) {
      return sinon.stub(fragmentTracker, 'getState').callsFake(() => state);
    }

    let triggerSpy;
    let frag;
    beforeEach(function () {
      triggerSpy = sinon.spy(hls, 'trigger');
      frag = new Fragment();
    });

    function assertLoadingState (frag) {
      expect(triggerSpy).to.have.been.calledWith(Event.FRAG_LOADING, { frag });
      expect(streamController.state).to.equal(State.FRAG_LOADING);
    }

    function assertNotLoadingState () {
      expect(triggerSpy).to.not.have.been.called;
      expect(hls.state).to.not.equal(State.FRAG_LOADING);
    }

    it('should load a complete fragment which has not been previously appended', function () {
      fragStateStub(FragmentState.NOT_LOADED);
      streamController._loadFragment(frag);
      assertLoadingState(frag);
    });

    it('should load a partial fragment', function () {
      fragStateStub(FragmentState.PARTIAL);
      streamController._loadFragment(frag);
      assertLoadingState(frag);
    });

    it('should load a frag which has backtracked', function () {
      fragStateStub(FragmentState.OK);
      frag.backtracked = true;
      streamController._loadFragment(frag);
      assertLoadingState(frag);
    });

    it('should not load a fragment which has completely & successfully loaded', function () {
      fragStateStub(FragmentState.OK);
      streamController._loadFragment(frag);
      assertNotLoadingState();
    });

    it('should not load a fragment while it is appending', function () {
      fragStateStub(FragmentState.APPENDING);
      streamController._loadFragment(frag);
      assertNotLoadingState();
    });
  });

  describe('checkBuffer', function () {
    const sandbox = sinon.createSandbox();

    beforeEach(function () {
      streamController.gapController = {
        poll: function () {}
      };
      streamController.media = {
        buffered: {
          length: 1
        },
        readyState: 4
      };
      streamController.mediaBuffer = null;
    });
    afterEach(function () {
      sandbox.restore();
    });

    it('should not throw when media is undefined', function () {
      streamController.media = null;
      streamController.checkBuffer();
    });

    it('should seek to start pos when metadata has not yet been loaded', function () {
      const seekStub = sandbox.stub(streamController, '_seekToStartPos');
      streamController.loadedmetadata = false;
      streamController.checkBuffer();
      expect(seekStub).to.have.been.calledOnce;
      expect(streamController.loadedmetadata).to.be.true;
    });

    it('should not seek to start pos when metadata has been loaded', function () {
      const seekStub = sandbox.stub(streamController, '_seekToStartPos');
      streamController.loadedmetadata = true;
      streamController.checkBuffer();
      expect(seekStub).to.have.not.been.called;
      expect(streamController.loadedmetadata).to.be.true;
    });

    it('should not seek to start pos when nothing has been buffered', function () {
      const seekStub = sandbox.stub(streamController, '_seekToStartPos');
      streamController.media.buffered.length = 0;
      streamController.checkBuffer();
      expect(seekStub).to.have.not.been.called;
      expect(streamController.loadedmetadata).to.be.false;
    });

    it('should complete the immediate switch if signalled', function () {
      const levelSwitchStub = sandbox.stub(streamController, 'immediateLevelSwitchEnd');
      streamController.loadedmetadata = true;
      streamController.immediateSwitch = true;
      streamController.checkBuffer();
      expect(levelSwitchStub).to.have.been.calledOnce;
    });

    describe('_seekToStartPos', function () {
      it('should seek to startPosition when startPosition is not buffered & the media is not seeking', function () {
        streamController.startPosition = 5;
        streamController._seekToStartPos();
        expect(streamController.media.currentTime).to.equal(5);
      });

      it('should not seek to startPosition when it is buffered', function () {
        streamController.startPosition = 5;
        streamController.media.currentTime = 5;
        streamController._seekToStartPos();
        expect(streamController.media.currentTime).to.equal(5);
      });
    });

    describe('startLoad', function () {
      beforeEach(function () {
        streamController.levels = [];
        streamController.media = null;
      });
      it('should not start when controller does not have level data', function () {
        streamController.levels = null;
        streamController.startLoad();
        assertStreamControllerStopped(streamController);
      });

      it('should start when controller has level data', function () {
        streamController.startLoad(5);
        assertStreamControllerStarted(streamController);
        expect(streamController.nextLoadPosition).to.equal(5);
        expect(streamController.startPosition).to.equal(5);
        expect(streamController.lastCurrentTime).to.equal(5);
      });

      it('should set startPosition to lastCurrentTime if unset', function () {
        streamController.lastCurrentTime = 5;
        streamController.startLoad(-1);
        assertStreamControllerStarted(streamController);
        expect(streamController.nextLoadPosition).to.equal(5);
        expect(streamController.startPosition).to.equal(5);
        expect(streamController.lastCurrentTime).to.equal(5);
      });

      it('sets up for a bandwidth test if starting at auto', function () {
        streamController.startFragRequested = false;
        hls.startLevel = -1;

        streamController.startLoad();
        expect(streamController.level).to.equal(0);
        expect(streamController.bitrateTest).to.be.true;
      });

      it('should not signal a bandwidth test if config.testBandwidth is false', function () {
        streamController.startFragRequested = false;
        hls.startLevel = -1;
        hls.nextAutoLevel = 3;
        hls.config.testBandwidth = false;

        streamController.startLoad();
        expect(streamController.level).to.equal(hls.nextAutoLevel);
        expect(streamController.bitrateTest).to.be.false;
      });
    });
  });
});
