// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { Utilities } from './Utilities';

/**
 * Used with the Stopwatch class.
 */
export enum StopwatchState {
  Stopped = 1,
  Started = 2
}

/**
 * Represents a readonly view of a `Stopwatch`.
 * @beta
 */
export interface IStopwatchResult {
  /**
   * Displays how long the stopwatch has been executing in a human readable format.
   */
  toString(): string;
  /**
   * Get the duration in seconds.
   */
  get duration(): number;
  /**
   * Return the start time of the most recent stopwatch run.
   */
  get startTime(): number | undefined;
  /**
   * Return the end time of the most recent stopwatch run.
   */
  get endTime(): number | undefined;
}

/**
 * Represents a typical timer/stopwatch which keeps track
 * of elapsed time in between two events.
 */
export class Stopwatch implements IStopwatchResult {
  private _startTime: number | undefined;
  private _endTime: number | undefined;
  private _state: StopwatchState;

  private _getTime: () => number;

  public constructor(getTime: () => number = Utilities.getTimeInMs) {
    this._startTime = undefined;
    this._endTime = undefined;
    this._getTime = getTime;
    this._state = StopwatchState.Stopped;
  }

  public static fromState({ startTime, endTime }: { startTime: number; endTime: number }): Stopwatch {
    const stopwatch: Stopwatch = new Stopwatch();
    stopwatch._startTime = startTime;
    stopwatch._endTime = endTime;
    stopwatch._state = StopwatchState.Stopped;
    return stopwatch;
  }

  /**
   * Static helper function which creates a stopwatch which is immediately started
   */
  public static start(): Stopwatch {
    return new Stopwatch().start();
  }

  public get state(): StopwatchState {
    return this._state;
  }

  /**
   * Starts the stopwatch. Note that if end() has been called,
   * reset() should be called before calling start() again.
   */
  public start(): Stopwatch {
    if (this._startTime !== undefined) {
      throw new Error('Call reset() before starting the Stopwatch');
    }
    this._startTime = this._getTime();
    this._endTime = undefined;
    this._state = StopwatchState.Started;
    return this;
  }

  /**
   * Stops executing the stopwatch and saves the current timestamp
   */
  public stop(): Stopwatch {
    this._endTime = this._startTime !== undefined ? this._getTime() : undefined;
    this._state = StopwatchState.Stopped;
    return this;
  }

  /**
   * Resets all values of the stopwatch back to the original
   */
  public reset(): Stopwatch {
    this._endTime = this._startTime = undefined;
    this._state = StopwatchState.Stopped;
    return this;
  }

  /**
   * Displays how long the stopwatch has been executing in a human readable format.
   */
  public toString(): string {
    if (this._state === StopwatchState.Stopped && this._startTime === undefined) {
      return '0.00 seconds (stopped)';
    }
    const totalSeconds: number = this.duration;

    if (totalSeconds > 60) {
      const minutes: number = Math.floor(totalSeconds / 60);
      const seconds: number = totalSeconds % 60.0;

      return `${minutes.toFixed(0)} minute${minutes === 1 ? '' : 's'} ${seconds.toFixed(1)} seconds`;
    } else {
      return `${totalSeconds.toFixed(2)} seconds`;
    }
  }

  /**
   * Get the duration in seconds.
   */
  public get duration(): number {
    if (this._startTime === undefined) {
      return 0;
    }
    const curTime: number = this._endTime !== undefined ? this._endTime : this._getTime();

    return (curTime - this._startTime) / 1000.0;
  }

  /**
   * Return the start time of the most recent stopwatch run.
   */
  public get startTime(): number | undefined {
    return this._startTime;
  }

  /**
   * Return the end time of the most recent stopwatch run.
   */
  public get endTime(): number | undefined {
    return this._endTime;
  }
}
