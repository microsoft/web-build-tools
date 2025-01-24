// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { InternalError } from '@rushstack/node-core-library';

import type { IOperationState } from './IOperationRunner';
import type { Operation } from './Operation';
import { OperationStatus } from './OperationStatus';
import { Stopwatch } from './Stopwatch';

/**
 * Meta-entity that tracks information about a group of related operations.
 *
 * @beta
 */
export class OperationGroupRecord {
  private readonly _operations: Set<Operation> = new Set();
  private _remainingOperations: Set<Operation> = new Set();

  private _groupStopwatch: Stopwatch = new Stopwatch();
  private _hasCancellations: boolean = false;
  private _hasFailures: boolean = false;

  public readonly name: string;

  public get duration(): number {
    return this._groupStopwatch ? this._groupStopwatch.duration : 0;
  }

  public get finished(): boolean {
    return this._remainingOperations.size === 0;
  }

  public get hasCancellations(): boolean {
    return this._hasCancellations;
  }

  public get hasFailures(): boolean {
    return this._hasFailures;
  }

  public constructor(name: string) {
    this.name = name;
  }

  public addOperation(operation: Operation): void {
    this._operations.add(operation);
  }

  public startTimer(): void {
    // Keep this undefined until needed, then start to avoid subsequent calls to startTimer()
    this._groupStopwatch.start();
  }

  public setOperationAsComplete(operation: Operation, state: IOperationState): void {
    if (!this._remainingOperations.has(operation)) {
      throw new InternalError(`Operation ${operation.operationName} is not in the group ${this.name}`);
    }

    if (state.status === OperationStatus.Aborted) {
      this._hasCancellations = true;
    } else if (state.status === OperationStatus.Failure) {
      this._hasFailures = true;
    }

    this._remainingOperations.delete(operation);
    if (this._remainingOperations.size === 0) {
      this._groupStopwatch.stop();
    }
  }

  public reset(): void {
    this._remainingOperations = new Set(this._operations);
    this._groupStopwatch.reset();
    this._hasCancellations = false;
    this._hasFailures = false;
  }
}
