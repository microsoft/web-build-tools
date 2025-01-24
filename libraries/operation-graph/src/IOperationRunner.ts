// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { OperationStatus } from './OperationStatus';
import type { OperationError } from './OperationError';

import type { Stopwatch } from './Stopwatch';

/**
 * Information passed to the executing `IOperationRunner`
 *
 * @beta
 */
export interface IOperationRunnerContext {
  /**
   * An abort signal for the overarching execution. Runners should do their best to gracefully abort
   * as soon as possible if the signal is aborted.
   */
  abortSignal: AbortSignal;

  /**
   * If this is the first time this operation has been executed.
   */
  isFirstRun: boolean;

  /**
   * A callback to the overarching orchestrator to request that the operation be invoked again.
   * Used in watch mode to signal that inputs have changed.
   */
  requestRun?: () => void;
}

/**
 * Interface contract for a single state of an operation.
 *
 * @beta
 */
export interface IOperationState {
  /**
   * The status code for the operation.
   */
  status: OperationStatus;
  /**
   * Whether the operation has been run at least once.
   */
  hasBeenRun: boolean;
  /**
   * The error, if the status is `OperationStatus.Failure`.
   */
  error: OperationError | undefined;
  /**
   * Timing information for the operation.
   */
  stopwatch: Stopwatch;
}

/**
 * Interface contract for the current and past state of an operation.
 *
 * @beta
 */
export interface IOperationStates {
  /**
   * The current state of the operation.
   */
  readonly state: Readonly<IOperationState> | undefined;
  /**
   * The previous state of the operation.
   */
  readonly lastState: Readonly<IOperationState> | undefined;
}

/**
 * The `Operation` class is a node in the dependency graph of work that needs to be scheduled by the
 * `OperationExecutionManager`. Each `Operation` has a `runner` member of type `IOperationRunner`, whose
 * implementation manages the actual process for running a single operation.
 *
 * @beta
 */
export interface IOperationRunner {
  /**
   * Name of the operation, for logging.
   */
  readonly operationName: string;

  /**
   * Indicates that this runner is architectural and should not be reported on.
   */
  silent: boolean;

  /**
   * Method to be executed for the operation.
   */
  executeAsync(context: IOperationRunnerContext): Promise<OperationStatus>;
}
