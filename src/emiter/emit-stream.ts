import { EmitObserver } from "./emit-observer";
import { EmitObserveStream } from "./emit-observer.types";
import { EmitMiddlewareOption } from "./emit-stream.types";

/**
 * Stream that emits values, errors, and completion events
 */
export class EmitStream<T = any> {
  private sourceObserver = new EmitObserver<T>();
  private outputObserver = new EmitObserver<any>();
  private cleanup: () => void = () => { };
  private isPaused: boolean = false;
  private buffer: any[] = [];
  private maxBufferSize: number;

  /**
   * @param producer - A function that takes an EmitObserver and returns a cleanup function
   */
  constructor(
    private producer: (observer: EmitObserver<T>) => () => void | void,
    options: { maxBufferSize?: number, continueOnError?: boolean } = {}
  ) {
    this.sourceObserver = new EmitObserver<T>({ continueOnError: options.continueOnError });
    this.outputObserver = new EmitObserver<any>({ continueOnError: options.continueOnError });
    this.maxBufferSize = options.maxBufferSize ?? Infinity;
    const cleanupFn = this.producer(this.sourceObserver);
    this.cleanup = cleanupFn ?? (() => { });
  }

  /**
   * Pauses the stream, buffering values if resumed
   * @returns The EmitStream instance for chaining
   */
  pause(): this {
    this.isPaused = true;
    return this;
  }

  /**
   * Resumes the stream, flushing buffered values
   * @returns The EmitStream instance for chaining
   */
  resume(): this {
    this.isPaused = false;
    while (this.buffer.length > 0 && !this.isPaused) {
      this.outputObserver.next(this.buffer.shift()!);
    }
    return this;
  }

  /**
   * Subscribes an observer to the stream
   * @param observer - Partial observer implementation with event handlers
   * @returns - The EmitStream instance for chaining
   */
  listen(observer: EmitObserveStream<T>): this {
    if (observer.next) {
      this.outputObserver.on('next', (value: T) => {
        if (this.isPaused && this.maxBufferSize > 0) {
          if (this.buffer.length < this.maxBufferSize) {
            this.buffer.push(value);
          }
          return;
        }
        observer.next!(value);
      });
    }
    if (observer.error) this.outputObserver.on('error', observer.error);
    if (observer.complete) this.outputObserver.on('complete', observer.complete);
    return this;
  }

  use(
    ...args: ((value: any) => any | Promise<any>)[]
      | [((value: any) => any | Promise<any>)[], EmitMiddlewareOption]
  ): EmitStream<T> {
    let middlewares: ((value: any) => any | Promise<any>)[] = [];
    let options: EmitMiddlewareOption = {};

    if (Array.isArray(args[0])) {
      middlewares = args[0];
      options = (args[1] && typeof args[1] === 'object') ? args[1] as EmitMiddlewareOption : {};
    } else {
      middlewares = args as ((value: any) => any | Promise<any>)[];
    }

    const {
      errorHandler,
      retries = 0,
      retryDelay = 0,
      maxRetryDelay = Infinity,
      jitter = 0,
      delayFn = (attempt, baseDelay) => baseDelay * Math.pow(2, attempt),
      continueOnError = false,
    } = options;

    const withRetry = async (value: T): Promise<any> => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          let result = value;
          for (const middleware of middlewares) {
            result = await Promise.resolve(middleware(result));
          }
          return result;
        } catch (error) {
          lastError = error;
          if (attempt < retries) {
            let delay = delayFn(attempt, retryDelay);
            if (jitter > 0) {
              const jitterFactor = 1 + jitter * (Math.random() * 2 - 1);
              delay *= jitterFactor;
            }
            delay = Math.min(delay, maxRetryDelay);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
      throw lastError;
    };

    this.sourceObserver.on('next', async (value: T) => {
      try {
        const result = retries > 0
          ? await withRetry(value)
          : await Promise.all(middlewares.map(mw => mw(value)))
            .then(results => results[results.length - 1]);
        if (result instanceof Promise) {
          this.outputObserver.next(await result);
        } else {
          this.outputObserver.next(result);
        }
      } catch (err) {
        if (errorHandler) errorHandler(err);
        if (!continueOnError) this.outputObserver.error(err);
      }
    });

    return this;
  }

  /**
   * Get the stream's observer instance
   * @returns The EmitObserver instance
   */
  getObserver(): EmitObserver<T> {
    return this.sourceObserver;
  }

  /**
   * Unsubscribes from the stream and emits specified event
   * @param option - Specific event to emit when unsubscribing
   * @returns {this} - The EmitStream instance for chaining
   */
  unlisten(option?: Exclude<keyof EmitObserveStream<T>, 'next'>): this {
    switch (option) {
      case 'error': {
        this.outputObserver.error(new Error('Stream unlistened'));
        break;
      }
      case 'complete':
      default: {
        this.outputObserver.complete();
        break;
      }
    }
    this.cleanup();
    return this;
  }
}
