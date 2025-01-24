// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { once } from 'node:events';

import { AlreadyReportedError } from '@rushstack/node-core-library';

import { OperationStatus } from './OperationStatus';
import type {
  IAfterExecuteEventMessage,
  IPCHost,
  CommandMessageFromHost,
  ISyncEventMessage,
  IRequestRunEventMessage
} from './protocol.types';

/**
 * Callbacks for the watch loop.
 *
 * @beta
 */
export interface IWatchLoopOptions {
  /**
   * Callback that performs the core work of a single iteration.
   */
  executeAsync: (state: IWatchLoopState) => Promise<OperationStatus>;
  /**
   * Logging callback immediately before execution occurs.
   */
  onBeforeExecute: () => void;
  /**
   * Logging callback when a run is requested (and hasn't already been).
   */
  onRequestRun: (requestor: string) => void;
  /**
   * Logging callback when a run is aborted.
   */
  onAbort: () => void;
}

/**
 * The public API surface of the watch loop, for use in the `executeAsync` callback.
 *
 * @beta
 */
export interface IWatchLoopState {
  get abortSignal(): AbortSignal;
  requestRun: (requestor: string) => void;
}

/**
 * This class implements a watch loop.
 *
 * @beta
 */
export class WatchLoop implements IWatchLoopState {
  private readonly _options: Readonly<IWatchLoopOptions>;

  private _abortController: AbortController;
  private _isRunning: boolean;
  private _runRequested: boolean;
  private _requestRunPromise: Promise<string | undefined>;
  private _resolveRequestRun!: (requestor: string) => void;

  public constructor(options: IWatchLoopOptions) {
    this._options = options;

    this._abortController = new AbortController();
    this._isRunning = false;
    // Always start as true, so that any requests prior to first run are silenced.
    this._runRequested = true;
    this._requestRunPromise = new Promise<string | undefined>((resolve) => {
      this._resolveRequestRun = resolve;
    });
  }

  /**
   * Runs the inner loop until the abort signal is cancelled or a run completes without a new run being requested.
   */
  public async runUntilStableAsync(abortSignal: AbortSignal): Promise<OperationStatus> {
    if (abortSignal.aborted) {
      return OperationStatus.Aborted;
    }

    abortSignal.addEventListener('abort', this._abortCurrent, { once: true });

    try {
      let result: OperationStatus = OperationStatus.Ready;

      do {
        // Always check the abort signal first, in case it was aborted in the async tick since the last executeAsync() call.
        if (abortSignal.aborted) {
          return OperationStatus.Aborted;
        }

        result = await this._runIterationAsync();
      } while (this._runRequested);

      // Even if the run has finished, if the abort signal was aborted, we should return `Aborted` just in case.
      return abortSignal.aborted ? OperationStatus.Aborted : result;
    } finally {
      abortSignal.removeEventListener('abort', this._abortCurrent);
    }
  }

  /**
   * Runs the inner loop until the abort signal is aborted. Will otherwise wait indefinitely for a new run to be requested.
   */
  public async runUntilAbortedAsync(abortSignal: AbortSignal, onWaiting: () => void): Promise<void> {
    if (abortSignal.aborted) {
      return;
    }

    const abortPromise: Promise<unknown> = once(abortSignal, 'abort');

    // eslint-disable-next-line no-constant-condition
    while (!abortSignal.aborted) {
      await this.runUntilStableAsync(abortSignal);

      onWaiting();
      await Promise.race([this._requestRunPromise, abortPromise]);
    }
  }

  /**
   * Sets up an IPC handler that will run the inner loop when it receives a "run" message from the host.
   * Runs until receiving an "exit" message from the host, or aborts early if an unhandled error is thrown.
   */
  public async runIPCAsync(host: IPCHost = process): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let abortController: AbortController = new AbortController();

      let runRequestedFromHost: boolean = true;
      let status: OperationStatus = OperationStatus.Ready;

      function tryMessageHost(
        message: ISyncEventMessage | IRequestRunEventMessage | IAfterExecuteEventMessage
      ): void {
        if (!host.send) {
          return reject(new Error('Host does not support IPC'));
        }

        try {
          host.send(message);
        } catch (err) {
          reject(new Error(`Unable to communicate with host: ${err}`));
        }
      }

      function requestRunFromHost(requestor: string): void {
        if (runRequestedFromHost) {
          return;
        }

        runRequestedFromHost = true;

        const requestRunMessage: IRequestRunEventMessage = {
          event: 'requestRun',
          requestor
        };

        tryMessageHost(requestRunMessage);
      }

      function sendSync(): void {
        const syncMessage: ISyncEventMessage = {
          event: 'sync',
          status
        };
        tryMessageHost(syncMessage);
      }

      host.on('message', async (message: CommandMessageFromHost) => {
        switch (message.command) {
          case 'exit': {
            return resolve();
          }

          case 'cancel': {
            if (this._isRunning) {
              abortController.abort();
              abortController = new AbortController();
              // This will terminate the currently executing `runUntilStableAsync` call.
            }
            return;
          }

          case 'run': {
            runRequestedFromHost = false;

            status = OperationStatus.Executing;

            try {
              status = await this.runUntilStableAsync(abortController.signal);
              this._requestRunPromise
                // the reject callback in the promise is discarded so we ignore errors
                .catch(() => {})
                .finally(() => {
                  requestRunFromHost('runIPCAsync');
                });
            } catch (err) {
              status = OperationStatus.Failure;
              return reject(err);
            } finally {
              const afterExecuteMessage: IAfterExecuteEventMessage = {
                event: 'after-execute',
                status
              };
              tryMessageHost(afterExecuteMessage);
            }
            return;
          }

          case 'sync': {
            return sendSync();
          }

          default: {
            return reject(new Error(`Unexpected command from host: ${message}`));
          }
        }
      });

      sendSync();
    });
  }

  /**
   * Requests that a new run occur.
   */
  public requestRun: (requestor: string) => void = (requestor: string) => {
    if (!this._runRequested) {
      this._options.onRequestRun(requestor);
      this._runRequested = true;
      if (this._isRunning) {
        this._options.onAbort();
        this._abortCurrent();
      }
    }
    this._resolveRequestRun(requestor);
  };

  /**
   * The abort signal for the current iteration.
   */
  public get abortSignal(): AbortSignal {
    return this._abortController.signal;
  }

  /**
   * Cancels the current iteration (if possible).
   */
  private _abortCurrent = (): void => {
    this._abortController.abort();
  };

  /**
   * Resets the abort signal and run request state.
   */
  private _reset(): void {
    if (this._abortController.signal.aborted) {
      this._abortController = new AbortController();
    }

    if (this._runRequested) {
      this._runRequested = false;
      this._requestRunPromise = new Promise<string | undefined>((resolve) => {
        this._resolveRequestRun = resolve;
      });
    }
  }

  /**
   * Runs a single iteration of the loop.
   * @returns The status of the iteration.
   */
  private async _runIterationAsync(): Promise<OperationStatus> {
    this._reset();

    this._options.onBeforeExecute();
    try {
      this._isRunning = true;
      return await this._options.executeAsync(this);
    } catch (err) {
      if (!(err instanceof AlreadyReportedError)) {
        throw err;
      } else {
        return OperationStatus.Failure;
      }
    } finally {
      this._isRunning = false;
    }
  }
}
