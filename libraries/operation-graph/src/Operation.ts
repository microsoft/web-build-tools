// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { InternalError } from '@rushstack/node-core-library';
import type { ITerminal } from '@rushstack/terminal';

import { Stopwatch } from './Stopwatch';
import type {
  IOperationRunner,
  IOperationRunnerContext,
  IOperationState,
  IOperationStates
} from './IOperationRunner';
import type { OperationError } from './OperationError';
import { OperationStatus } from './OperationStatus';

/**
 * Options for constructing a new Operation.
 * @beta
 */
export interface IOperationOptions {
  /**
   * The name of this operation, for logging.
   */
  operationName: string;

  /**
   * The group that this operation belongs to. Will be used for logging and duration tracking.
   */
  groupName?: string | undefined;

  /**
   * When the scheduler is ready to process this `Operation`, the `runner` implements the actual work of
   * running the operation.
   */
  runner?: IOperationRunner | undefined;

  /**
   * The weight used by the scheduler to determine order of execution.
   */
  weight?: number | undefined;
}

/**
 * Information provided to `executeAsync` by the `OperationExecutionManager`.
 *
 * @beta
 */
export interface IExecuteOperationContext extends Omit<IOperationRunnerContext, 'isFirstRun' | 'requestRun'> {
  /**
   * Function to invoke before execution of an operation, for logging.
   */
  beforeExecute(operation: Operation, state: IOperationState): void;

  /**
   * Function to invoke after execution of an operation, for logging.
   */
  afterExecute(operation: Operation, state: IOperationState): void;

  /**
   * Function used to schedule the concurrency-limited execution of an operation.
   *
   * Will return OperationStatus.Aborted if execution is aborted before the task executes.
   */
  queueWork(workFn: () => Promise<OperationStatus>, priority: number): Promise<OperationStatus>;

  /**
   * A callback to the overarching orchestrator to request that the operation be invoked again.
   * Used in watch mode to signal that inputs have changed.
   */
  requestRun?: (requestor: string) => void;

  /**
   * Terminal to write output to.
   */
  terminal: ITerminal;
}

/**
 * The `Operation` class is a node in the dependency graph of work that needs to be scheduled by the
 * `OperationExecutionManager`. Each `Operation` has a `runner` member of type `IOperationRunner`, whose
 * implementation manages the actual process of running a single operation.
 *
 * The graph of `Operation` instances will be cloned into a separate execution graph after processing.
 *
 * @beta
 */
export class Operation implements IOperationStates {
  /**
   * A set of all dependencies which must be executed before this operation is complete.
   */
  public readonly dependencies: Set<Operation> = new Set<Operation>();
  /**
   * A set of all operations that wait for this operation.
   */
  public readonly consumers: Set<Operation> = new Set<Operation>();
  /**
   * If specified, the name of a grouping to which this Operation belongs, for logging start and end times.
   */
  public readonly groupName: string | undefined;
  /**
   * The name of this operation, for logging.
   */
  public readonly operationName: string;

  /**
   * When the scheduler is ready to process this `Operation`, the `runner` implements the actual work of
   * running the operation.
   */
  public runner: IOperationRunner | undefined = undefined;

  /**
   * This number represents how far away this Operation is from the furthest "root" operation (i.e.
   * an operation with no consumers). This helps us to calculate the critical path (i.e. the
   * longest chain of projects which must be executed in order, thereby limiting execution speed
   * of the entire operation tree.
   *
   * This number is calculated via a memoized depth-first search, and when choosing the next
   * operation to execute, the operation with the highest criticalPathLength is chosen.
   *
   * Example:
   *        (0) A
   *             \\
   *          (1) B     C (0)         (applications)
   *               \\   /|\\
   *                \\ / | \\
   *             (2) D  |  X (1)      (utilities)
   *                    | / \\
   *                    |/   \\
   *                (2) Y     Z (2)   (other utilities)
   *
   * All roots (A & C) have a criticalPathLength of 0.
   * B has a score of 1, since A depends on it.
   * D has a score of 2, since we look at the longest chain (e.g D-\>B-\>A is longer than D-\>C)
   * X has a score of 1, since the only package which depends on it is A
   * Z has a score of 2, since only X depends on it, and X has a score of 1
   * Y has a score of 2, since the chain Y-\>X-\>C is longer than Y-\>C
   *
   * The algorithm is implemented in AsyncOperationQueue.ts as calculateCriticalPathLength()
   */
  public criticalPathLength: number | undefined = undefined;

  /**
   * The weight for this operation. This scalar is the contribution of this operation to the
   * `criticalPathLength` calculation above. Modify to indicate the following:
   * - `weight` === 1: indicates that this operation has an average duration
   * - `weight` &gt; 1: indicates that this operation takes longer than average and so the scheduler
   *     should try to favor starting it over other, shorter operations. An example might be an operation that
   *     bundles an entire application and runs whole-program optimization.
   * - `weight` &lt; 1: indicates that this operation takes less time than average and so the scheduler
   *     should favor other, longer operations over it. An example might be an operation to unpack a cached
   *     output, or an operation using NullOperationRunner, which might use a value of 0.
   */
  public weight: number;

  /**
   * The state of this operation the previous time a manager was invoked.
   */
  public lastState: IOperationState | undefined = undefined;

  /**
   * The current state of this operation
   */
  public state: IOperationState | undefined = undefined;

  /**
   * A cached execution promise for the current OperationExecutionManager invocation of this operation.
   */
  private _promise: Promise<OperationStatus> | undefined = undefined;

  /**
   * If true, then a run of this operation is currently wanted.
   * This is used to track state from the `requestRun` callback passed to the runner.
   */
  private _runPending: boolean = true;

  public constructor(options: IOperationOptions) {
    this.groupName = options?.groupName;
    this.runner = options?.runner;
    this.weight = options?.weight || 1;
    this.operationName = options.operationName;
  }

  public addDependency(dependency: Operation): void {
    this.dependencies.add(dependency);
    dependency.consumers.add(this);
  }

  public deleteDependency(dependency: Operation): void {
    this.dependencies.delete(dependency);
    dependency.consumers.delete(this);
  }

  public reset(): void {
    // Reset operation state
    this.lastState = this.state;

    this.state = {
      status: this.dependencies.size > 0 ? OperationStatus.Waiting : OperationStatus.Ready,
      hasBeenRun: this.lastState?.hasBeenRun ?? false,
      error: undefined,
      stopwatch: new Stopwatch()
    };

    this._promise = undefined;
    this._runPending = true;
  }

  /**
   * @internal
   */
  public async _executeAsync(context: IExecuteOperationContext): Promise<OperationStatus> {
    const { state } = this;
    if (!state) {
      throw new Error(`Operation state has not been initialized.`);
    }

    if (!this._promise) {
      this._promise = this._executeInnerAsync(context, state);
    }

    return this._promise;
  }

  private async _executeInnerAsync(
    context: IExecuteOperationContext,
    rawState: IOperationState
  ): Promise<OperationStatus> {
    const state: IOperationState = rawState;
    const { runner } = this;

    const dependencyResults: PromiseSettledResult<OperationStatus>[] = await Promise.allSettled(
      Array.from(this.dependencies, (dependency: Operation) => dependency._executeAsync(context))
    );

    const { abortSignal, requestRun, queueWork } = context;

    if (abortSignal.aborted) {
      state.status = OperationStatus.Aborted;
      return state.status;
    }

    for (const result of dependencyResults) {
      if (
        result.status === 'rejected' ||
        result.value === OperationStatus.Blocked ||
        result.value === OperationStatus.Failure
      ) {
        state.status = OperationStatus.Blocked;
        return state.status;
      }
    }

    state.status = OperationStatus.Ready;

    const innerContext: IOperationRunnerContext = {
      abortSignal,
      isFirstRun: !state.hasBeenRun,
      requestRun: requestRun
        ? () => {
            switch (this.state?.status) {
              case OperationStatus.Waiting:
              case OperationStatus.Ready:
              case OperationStatus.Executing:
                // If current status has not yet resolved to a fixed value,
                // re-executing this operation does not require a full rerun
                // of the operation graph. Simply mark that a run is requested.

                // This variable is on the Operation instead of the
                // containing closure to deal with scenarios in which
                // the runner hangs on to an old copy of the callback.
                this._runPending = true;
                return;

              case OperationStatus.Blocked:
              case OperationStatus.Aborted:
              case OperationStatus.Failure:
              case OperationStatus.NoOp:
              case OperationStatus.Success:
                // The requestRun callback is assumed to remain constant
                // throughout the lifetime of the process, so it is safe
                // to capture here.
                return requestRun(this.operationName);
              case undefined:
                throw new InternalError(`The operation state is undefined`);
              default:
                // This line is here to enforce exhaustiveness
                const currentStatus: undefined = this.state?.status;
                throw new InternalError(`Unexpected status: ${currentStatus}`);
            }
          }
        : undefined
    };

    // eslint-disable-next-line require-atomic-updates
    state.status = await queueWork(async (): Promise<OperationStatus> => {
      // Redundant variable to satisfy require-atomic-updates
      const innerState: IOperationState = state;

      if (abortSignal.aborted) {
        innerState.status = OperationStatus.Aborted;
        return innerState.status;
      }

      context.beforeExecute(this, innerState);

      innerState.stopwatch.start();
      innerState.status = OperationStatus.Executing;
      // Mark that the operation has been started at least once.
      innerState.hasBeenRun = true;

      while (this._runPending) {
        this._runPending = false;
        try {
          // We don't support aborting in the middle of a runner's execution.
          innerState.status = runner ? await runner.executeAsync(innerContext) : OperationStatus.NoOp;
        } catch (error) {
          innerState.status = OperationStatus.Failure;
          innerState.error = error as OperationError;
        }

        // Since runner.executeAsync is async, a change could have occurred that requires re-execution
        // This operation is still active, so can re-execute immediately, rather than forcing a whole
        // new execution pass.

        // As currently written, this does mean that if a job is scheduled with higher priority while
        // this operation is still executing, it will still wait for this retry. This may not be desired
        // and if it becomes a problem, the retry loop will need to be moved outside of the `queueWork` call.
        // This introduces complexity regarding tracking of timing and start/end logging, however.

        if (this._runPending) {
          if (abortSignal.aborted) {
            innerState.status = OperationStatus.Aborted;
            break;
          } else {
            context.terminal.writeLine(`Immediate rerun requested. Executing.`);
          }
        }
      }

      state.stopwatch.stop();
      context.afterExecute(this, state);

      return state.status;
    }, /* priority */ this.criticalPathLength ?? 0);

    return state.status;
  }
}
