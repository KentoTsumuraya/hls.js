/*
*
* All objects in the event handling chain should inherit from this class
*
*/

import { logger } from './utils/logger';
import { ErrorTypes, ErrorDetails } from './errors';
import Event from './events';
import Hls from './hls';

const FORBIDDEN_EVENT_NAMES = {
  hlsEventGeneric: true,
  hlsHandlerDestroying: true,
  hlsHandlerDestroyed: true
};

class EventHandler {
  protected hls: Hls;
  private handledEvents: any[];
  private useGenericHandler: boolean;

  constructor (hls: Hls, ...events: any[]) {
    this.hls = hls;
    this.onEvent = this.onEvent.bind(this);
    this.handledEvents = events;
    this.useGenericHandler = true;

    this.registerListeners();
  }

  protected destroy () {
    this.onHandlerDestroying();
    this.unregisterListeners();
    this.onHandlerDestroyed();
  }

  protected onHandlerDestroying () {}
  protected onHandlerDestroyed () {}

  private isEventHandler () {
    return typeof this.handledEvents === 'object' && this.handledEvents.length && typeof this.onEvent === 'function';
  }

  private registerListeners () {
    if (this.isEventHandler()) {
      this.handledEvents.forEach(function (event) {
        if (FORBIDDEN_EVENT_NAMES[event]) {
          throw new Error('Forbidden event-name: ' + event);
        }

        this.hls.on(event, this.onEvent);
      }, this);
    }
  }

  private unregisterListeners () {
    if (this.isEventHandler()) {
      this.handledEvents.forEach(function (event) {
        this.hls.off(event, this.onEvent);
      }, this);
    }
  }

  /**
   * arguments: event (string), data (any)
   */
  private onEvent (event: string, data: any) {
    this.onEventGeneric(event, data);
  }

  private onEventGeneric (event: string, data: any) {
    const eventToFunction = function (event: string, data: any) {
      const funcName = 'on' + event.replace('hls', '');
      if (typeof this[funcName] !== 'function') {
        throw new Error(`Event ${event} has no generic handler in this ${this.constructor.name} class (tried ${funcName})`);
      }

      return this[funcName].bind(this, data);
    };
    try {
      eventToFunction.call(this, event, data).call();
    } catch (err) {
      logger.error(`An internal error happened while handling event ${event}. Error message: "${err.message}". Here is a stacktrace:`, err);
      this.hls.trigger(Event.ERROR, { type: ErrorTypes.OTHER_ERROR, details: ErrorDetails.INTERNAL_EXCEPTION, fatal: false, event: event, err: err });
    }
  }
}

export default EventHandler;
