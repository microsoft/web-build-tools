// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import {
  type TerminalWritable,
  StdioWritable,
  TextRewriterTransform,
  Colorize,
  ConsoleTerminalProvider,
  TerminalChunkKind
} from '@rushstack/terminal';
import { StreamCollator, type CollatedTerminal, type CollatedWriter } from '@rushstack/stream-collator';
import { NewlineKind, Async, InternalError, AlreadyReportedError } from '@rushstack/node-core-library';

import { AsyncOperationQueue, type IOperationSortFunction } from './AsyncOperationQueue';
import type { Operation } from './Operation';
import { OperationStatus } from './OperationStatus';
import { type IOperationExecutionRecordContext, OperationExecutionRecord } from './OperationExecutionRecord';
import type { IExecutionResult } from './IOperationExecutionResult';
import type { CobuildConfiguration } from '../../api/CobuildConfiguration';

export interface IOperationExecutionManagerOptions {
  quietMode: boolean;
  debugMode: boolean;
  parallelism: number;
  changedProjectsOnly: boolean;
  destination?: TerminalWritable;
  cobuildConfiguration?: CobuildConfiguration;

  beforeExecuteOperationAsync?: (operation: OperationExecutionRecord) => Promise<OperationStatus | undefined>;
  afterExecuteOperationAsync?: (operation: OperationExecutionRecord) => Promise<void>;
  onOperationStatusChangedAsync?: (record: OperationExecutionRecord) => void;
  beforeExecuteOperationsAsync?: (records: Map<Operation, OperationExecutionRecord>) => Promise<void>;
}

/**
 * Format "======" lines for a shell window with classic 80 columns
 */
const ASCII_HEADER_WIDTH: number = 79;

const prioritySort: IOperationSortFunction = (
  a: OperationExecutionRecord,
  b: OperationExecutionRecord
): number => {
  return a.criticalPathLength! - b.criticalPathLength!;
};

/**
 * A class which manages the execution of a set of tasks with interdependencies.
 * Initially, and at the end of each task execution, all unblocked tasks
 * are added to a ready queue which is then executed. This is done continually until all
 * tasks are complete, or prematurely fails if any of the tasks fail.
 */
export class OperationExecutionManager {
  private readonly _changedProjectsOnly: boolean;
  private readonly _executionRecords: Map<Operation, OperationExecutionRecord>;
  private readonly _quietMode: boolean;
  private readonly _parallelism: number;
  private readonly _totalOperations: number;

  private readonly _outputWritable: TerminalWritable;
  private readonly _colorsNewlinesTransform: TextRewriterTransform;
  private readonly _streamCollator: StreamCollator;

  private readonly _terminal: CollatedTerminal;

  private readonly _beforeExecuteOperation?: (
    operation: OperationExecutionRecord
  ) => Promise<OperationStatus | undefined>;
  private readonly _afterExecuteOperation?: (operation: OperationExecutionRecord) => Promise<void>;
  private readonly _onOperationStatusChanged?: (record: OperationExecutionRecord) => void;
  private readonly _beforeExecuteOperations?: (
    records: Map<Operation, OperationExecutionRecord>
  ) => Promise<void>;
  private readonly _cobuildConfiguration: CobuildConfiguration | undefined;

  // Variables for current status
  private _hasAnyFailures: boolean;
  private _hasAnyNonAllowedWarnings: boolean;
  private _completedOperations: number;
  private _executionQueue: AsyncOperationQueue;

  public constructor(operations: Set<Operation>, options: IOperationExecutionManagerOptions) {
    const {
      quietMode,
      debugMode,
      parallelism,
      changedProjectsOnly,
      beforeExecuteOperationAsync: beforeExecuteOperation,
      afterExecuteOperationAsync: afterExecuteOperation,
      onOperationStatusChangedAsync: onOperationStatusChanged,
      beforeExecuteOperationsAsync: beforeExecuteOperations,
      cobuildConfiguration
    } = options;
    this._completedOperations = 0;
    this._quietMode = quietMode;
    this._hasAnyFailures = false;
    this._hasAnyNonAllowedWarnings = false;
    this._changedProjectsOnly = changedProjectsOnly;
    this._parallelism = parallelism;
    this._cobuildConfiguration = cobuildConfiguration;

    this._beforeExecuteOperation = beforeExecuteOperation;
    this._afterExecuteOperation = afterExecuteOperation;
    this._beforeExecuteOperations = beforeExecuteOperations;
    this._onOperationStatusChanged = (record: OperationExecutionRecord) => {
      if (record.status === OperationStatus.Ready) {
        this._executionQueue.assignOperations();
      }
      onOperationStatusChanged?.(record);
    };

    // TERMINAL PIPELINE:
    //
    // streamCollator --> colorsNewlinesTransform --> StdioWritable
    //
    this._outputWritable = options.destination || StdioWritable.instance;
    this._colorsNewlinesTransform = new TextRewriterTransform({
      destination: this._outputWritable,
      normalizeNewlines: NewlineKind.OsDefault,
      removeColors: !ConsoleTerminalProvider.supportsColor
    });
    this._streamCollator = new StreamCollator({
      destination: this._colorsNewlinesTransform,
      onWriterActive: this._streamCollator_onWriterActive
    });
    this._terminal = this._streamCollator.terminal;

    // Convert the developer graph to the mutable execution graph
    const executionRecordContext: IOperationExecutionRecordContext = {
      streamCollator: this._streamCollator,
      onOperationStatusChanged: this._onOperationStatusChanged,
      debugMode,
      quietMode,
      cobuildConfiguration: this._cobuildConfiguration
    };

    let totalOperations: number = 0;
    const executionRecords: Map<Operation, OperationExecutionRecord> = (this._executionRecords = new Map());
    for (const operation of operations) {
      const executionRecord: OperationExecutionRecord = new OperationExecutionRecord(
        operation,
        executionRecordContext
      );

      executionRecords.set(operation, executionRecord);
      if (!executionRecord.silent) {
        // Only count non-silent operations
        totalOperations++;
      }
    }
    this._totalOperations = totalOperations;

    for (const [operation, consumer] of executionRecords) {
      for (const dependency of operation.dependencies) {
        const dependencyRecord: OperationExecutionRecord | undefined = executionRecords.get(dependency);
        if (!dependencyRecord) {
          throw new Error(
            `Operation "${consumer.name}" declares a dependency on operation "${dependency.name}" that is not in the set of operations to execute.`
          );
        }
        consumer.dependencies.add(dependencyRecord);
        dependencyRecord.consumers.add(consumer);
      }
    }

    const executionQueue: AsyncOperationQueue = new AsyncOperationQueue(
      this._executionRecords.values(),
      prioritySort
    );
    this._executionQueue = executionQueue;
  }

  private _streamCollator_onWriterActive = (writer: CollatedWriter | undefined): void => {
    if (writer) {
      this._completedOperations++;

      // Format a header like this
      //
      // ==[ @rushstack/the-long-thing ]=================[ 1 of 1000 ]==

      // leftPart: "==[ @rushstack/the-long-thing "
      const leftPart: string = Colorize.gray('==[') + ' ' + Colorize.cyan(writer.taskName) + ' ';
      const leftPartLength: number = 4 + writer.taskName.length + 1;

      // rightPart: " 1 of 1000 ]=="
      const completedOfTotal: string = `${this._completedOperations} of ${this._totalOperations}`;
      const rightPart: string = ' ' + Colorize.white(completedOfTotal) + ' ' + Colorize.gray(']==');
      const rightPartLength: number = 1 + completedOfTotal.length + 4;

      // middlePart: "]=================["
      const twoBracketsLength: number = 2;
      const middlePartLengthMinusTwoBrackets: number = Math.max(
        ASCII_HEADER_WIDTH - (leftPartLength + rightPartLength + twoBracketsLength),
        0
      );

      const middlePart: string = Colorize.gray(']' + '='.repeat(middlePartLengthMinusTwoBrackets) + '[');

      this._terminal.writeStdoutLine('\n' + leftPart + middlePart + rightPart);

      if (!this._quietMode) {
        this._terminal.writeStdoutLine('');
      }
    }
  };

  /**
   * Executes all operations which have been registered, returning a promise which is resolved when all the
   * operations are completed successfully, or rejects when any operation fails.
   */
  public async executeAsync(): Promise<IExecutionResult> {
    this._completedOperations = 0;
    const totalOperations: number = this._totalOperations;

    if (!this._quietMode) {
      const plural: string = totalOperations === 1 ? '' : 's';
      this._terminal.writeStdoutLine(`Selected ${totalOperations} operation${plural}:`);
      const nonSilentOperations: string[] = [];
      for (const record of this._executionRecords.values()) {
        if (!record.silent) {
          nonSilentOperations.push(record.name);
        }
      }
      nonSilentOperations.sort();
      for (const name of nonSilentOperations) {
        this._terminal.writeStdoutLine(`  ${name}`);
      }
      this._terminal.writeStdoutLine('');
    }

    this._terminal.writeStdoutLine(`Executing a maximum of ${this._parallelism} simultaneous processes...`);

    const maxParallelism: number = Math.min(totalOperations, this._parallelism);

    await this._beforeExecuteOperations?.(this._executionRecords);

    const beforeOperationResult: (record: OperationExecutionRecord) => Promise<void> = async (
      record: OperationExecutionRecord
    ) => {
      try {
        await this._afterExecuteOperation?.(record);
      } catch (e) {
        this._reportOperationErrorIfAny(record);
        record.error = e;
        record.status = OperationStatus.Failure;
      }
    };

    const onOperationStartAsync: (
      record: OperationExecutionRecord
    ) => Promise<OperationStatus | undefined> = async (record: OperationExecutionRecord) => {
      return await this._beforeExecuteOperation?.(record);
    };

    await Async.forEachAsync(
      this._executionQueue,
      async (record: OperationExecutionRecord) => {
        await record.executeAsync({
          onStart: onOperationStartAsync,
          onResult: onOperationCompleteAsync
        });
      },
      {
        concurrency: maxParallelism,
        weighted: true
      }
    );

    const status: OperationStatus = this._hasAnyFailures
      ? OperationStatus.Failure
      : this._hasAnyNonAllowedWarnings
      ? OperationStatus.SuccessWithWarning
      : OperationStatus.Success;

    return {
      operationResults: this._executionRecords,
      status
    };
  }

  private _reportOperationErrorIfAny(record: OperationExecutionRecord): void {
    // Failed operations get reported, even if silent.
    // Generally speaking, silent operations shouldn't be able to fail, so this is a safety measure.
    let message: string | undefined = undefined;
    if (record.error) {
      if (!(record.error instanceof AlreadyReportedError)) {
        message = record.error.message;
      }
    }

    if (message) {
      // This creates the writer, so don't do this until needed
      record.collatedWriter.terminal.writeStderrLine(message);
      // Ensure that the summary isn't blank if we have an error message
      // If the summary already contains max lines of stderr, this will get dropped, so we hope those lines
      // are more useful than the final exit code.
      record.stdioSummarizer.writeChunk({
        text: `${message}\n`,
        kind: TerminalChunkKind.Stdout
      });
    }
  }

  /**
   * Handles the result of the operation and propagates any relevant effects.
   */
  private _onOperationComplete(record: OperationExecutionRecord): void {
    const { runner, name, status, silent } = record;

    switch (status) {
      /**
       * This operation failed. Mark it as such and all reachable dependents as blocked.
       */
      case OperationStatus.Failure: {
        // Failed operations get reported, even if silent.
        // Generally speaking, silent operations shouldn't be able to fail, so this is a safety measure.
        this._reportOperationErrorIfAny(record);

        // This creates the writer, so don't do this globally
        const { terminal } = record.collatedWriter;
        terminal.writeStderrLine(Colorize.red(`"${name}" failed to build.`));
        const blockedQueue: Set<OperationExecutionRecord> = new Set(record.consumers);

        for (const blockedRecord of blockedQueue) {
          if (blockedRecord.status === OperationStatus.Waiting) {
            // Now that we have the concept of architectural no-ops, we could implement this by replacing
            // {blockedRecord.runner} with a no-op that sets status to Blocked and logs the blocking
            // operations. However, the existing behavior is a bit simpler, so keeping that for now.
            if (!blockedRecord.silent) {
              terminal.writeStdoutLine(`"${blockedRecord.name}" is blocked by "${name}".`);
            }
            blockedRecord.status = OperationStatus.Blocked;

            this._executionQueue.complete(blockedRecord);
            if (!blockedRecord.silent) {
              // Only increment the count if the operation is not silent to avoid confusing the user.
              // The displayed total is the count of non-silent operations.
              this._completedOperations++;
            }

            for (const dependent of blockedRecord.consumers) {
              blockedQueue.add(dependent);
            }
          } else if (blockedRecord.status !== OperationStatus.Blocked) {
            // It shouldn't be possible for operations to be in any state other than Waiting or Blocked
            throw new InternalError(
              `Blocked operation ${blockedRecord.name} is in an unexpected state: ${blockedRecord.status}`
            );
          }
        }
        this._hasAnyFailures = true;
        break;
      }

      /**
       * This operation was restored from the build cache.
       */
      case OperationStatus.FromCache: {
        if (!silent) {
          record.collatedWriter.terminal.writeStdoutLine(
            Colorize.green(`"${name}" was restored from the build cache.`)
          );
        }
        break;
      }

      /**
       * This operation was skipped via legacy change detection.
       */
      case OperationStatus.Skipped: {
        if (!silent) {
          record.collatedWriter.terminal.writeStdoutLine(Colorize.green(`"${name}" was skipped.`));
        }
        break;
      }

      /**
       * This operation intentionally didn't do anything.
       */
      case OperationStatus.NoOp: {
        if (!silent) {
          record.collatedWriter.terminal.writeStdoutLine(Colorize.gray(`"${name}" did not define any work.`));
        }
        break;
      }

      case OperationStatus.Success: {
        if (!silent) {
          record.collatedWriter.terminal.writeStdoutLine(
            Colorize.green(`"${name}" completed successfully in ${record.stopwatch.toString()}.`)
          );
        }
        break;
      }

      case OperationStatus.SuccessWithWarning: {
        if (!silent) {
          record.collatedWriter.terminal.writeStderrLine(
            Colorize.yellow(`"${name}" completed with warnings in ${record.stopwatch.toString()}.`)
          );
        }
        this._hasAnyNonAllowedWarnings = this._hasAnyNonAllowedWarnings || !runner.warningsAreAllowed;
        break;
      }
    }

    if (record.isTerminal) {
      // If the operation was not remote, then we can notify queue that it is complete
      this._executionQueue.complete(record);
    } else {
      this._executionQueue.assignOperations();
    }
  }
}
