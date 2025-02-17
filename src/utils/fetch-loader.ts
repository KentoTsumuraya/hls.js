import {
  LoaderCallbacks,
  LoaderContext,
  Loader,
  LoaderStats,
  LoaderConfiguration,
  LoaderOnProgress
} from '../types/loader';
import LoadStats from '../loader/load-stats';
import ChunkCache from '../demux/chunk-cache';

const { fetch, AbortController, ReadableStream, Request, Headers, performance } = self;

export function fetchSupported () {
  if (fetch && AbortController && ReadableStream && Request) {
    try {
      new ReadableStream({}); // eslint-disable-line no-new
      return true;
    } catch (e) { /* noop */ }
  }
  return false;
}

class
FetchLoader implements Loader<LoaderContext> {
  private fetchSetup: Function;
  private requestTimeout?: number;
  private request!: Request;
  private response!: Response;
  private controller: AbortController;
  public context!: LoaderContext;
  private config!: LoaderConfiguration;
  private callbacks!: LoaderCallbacks<LoaderContext>;
  public stats: LoaderStats;

  constructor (config /* HlsConfig */) {
    this.fetchSetup = config.fetchSetup || getRequest;
    this.controller = new AbortController();
    this.stats = new LoadStats();
  }

  destroy (): void {
    this.abortInternal();
  }

  abortInternal (): void {
    this.stats.aborted = true;
    this.controller.abort();
  }

  abort (): void {
    this.abortInternal();
    if (this.callbacks.onAbort) {
      this.callbacks.onAbort(this.stats, this.context, this.response);
    }
  }

  load (context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
    const stats = this.stats;
    stats.loading.start = performance.now();

    const initParams = getRequestParameters(context, this.controller.signal);
    const onProgress: LoaderOnProgress<LoaderContext> | undefined = callbacks.onProgress;
    const isArrayBuffer = context.responseType === 'arraybuffer';
    const LENGTH = isArrayBuffer ? 'byteLength' : 'length';

    this.context = context;
    this.config = config;
    this.callbacks = callbacks;
    this.request = this.fetchSetup(context, initParams);
    this.requestTimeout = self.setTimeout(() => {
      this.abortInternal();
      callbacks.onTimeout(stats, context, this.response);
    }, config.timeout);

    fetch(this.request).then((response: Response): Promise<string | ArrayBuffer> => {
      this.response = response;

      if (!response.ok) {
        const { status, statusText } = response;
        throw new FetchError(statusText || 'fetch, bad network response', status, response);
      }
      stats.loading.first = Math.max(performance.now(), stats.loading.start);
      stats.total = parseInt(response.headers.get('Content-Length') || '0');

      if (onProgress) {
        this.loadProgressively(response, stats, context, config.highWaterMark, onProgress);
      }

      if (isArrayBuffer) {
        return response.arrayBuffer();
      }
      return response.text();
    }).then((responseData: string | ArrayBuffer) => {
      const { response } = this;
      clearTimeout(this.requestTimeout);
      stats.loading.end = Math.max(performance.now(), stats.loading.first);
      stats.loaded = stats.total = responseData[LENGTH];

      const loaderResponse = {
        url: response.url,
        data: responseData
      };

      callbacks.onSuccess(loaderResponse, stats, context, response);
    }).catch((error) => {
      clearTimeout(this.requestTimeout);
      if (stats.aborted) {
        return;
      }
      // CORS errors result in an undefined code. Set it to 0 here to align with XHR's behavior
      const code = error.code || 0;
      callbacks.onError({ code, text: error.message }, context, error.details);
    });
  }

  getResponseHeader (name: string): string | null {
    if (this.response) {
      try {
        return this.response.headers.get(name);
      } catch (error) { /* Could not get header */ }
    }
    return null;
  }

  private loadProgressively (response: Response, stats: LoaderStats, context: LoaderContext, highWaterMark: number = 0, onProgress: LoaderOnProgress<LoaderContext>) {
    const chunkCache = new ChunkCache();
    const reader = (response.clone().body as ReadableStream).getReader();

    const pump = () => {
      reader.read().then((data: { done: boolean, value: Uint8Array }) => {
        const { done, value: chunk } = data;
        if (done) {
          if (chunkCache.dataLength) {
            onProgress(stats, context, chunkCache.flush(), response);
          }
          return;
        }
        const len = chunk.length;
        stats.loaded += len;
        if (len >= highWaterMark) {
          // The cache already has data, and the current chunk is large enough to be emitted. Push it to the cache
          // and flush in order to join the typed arrays
          if (chunkCache.dataLength) {
            chunkCache.push(chunk);
            onProgress(stats, context, chunkCache.flush(), response);
          } else {
            // If there's nothing cached already, just emit the progress event
            onProgress(stats, context, chunk, response);
          }
        } else {
          chunkCache.push(chunk);
          if (chunkCache.dataLength >= highWaterMark) {
            onProgress(stats, context, chunkCache.flush(), response);
          }
        }
        pump();
      }).catch(() => { /* aborted */ });
    };

    pump();
  }
}

function getRequestParameters (context: LoaderContext, signal): any {
  const initParams: any = {
    method: 'GET',
    mode: 'cors',
    credentials: 'same-origin',
    signal
  };

  if (context.rangeEnd) {
    initParams.headers = new Headers({
      Range: 'bytes=' + context.rangeStart + '-' + String(context.rangeEnd - 1)
    });
  }

  return initParams;
}

function getRequest (context: LoaderContext, initParams: any): Request {
  return new Request(context.url, initParams);
}

class FetchError extends Error {
  public code: number;
  public details: any;
  constructor (message: string, code: number, details: any) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export default FetchLoader;
