// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import {
  type ITerminal,
  type ITerminalProvider,
  DiscardStdoutTransform,
  SplitterTransform,
  StderrLineTransform,
  StdioSummarizer,
  TextRewriterTransform,
  Terminal,
  type TerminalWritable
} from '@rushstack/terminal';
import { InternalError, NewlineKind } from '@rushstack/node-core-library';
import { CollatedTerminal, type CollatedWriter, type StreamCollator } from '@rushstack/stream-collator';

import { OperationStatus, TERMINAL_STATUSES } from './OperationStatus';
import type { IOperationRunner, IOperationRunnerContext } from './IOperationRunner';
import type { Operation } from './Operation';
import { Stopwatch } from '../../utilities/Stopwatch';
import { OperationMetadataManager } from './OperationMetadataManager';
import type { IPhase } from '../../api/CommandLineConfiguration';
import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import { CollatedTerminalProvider } from '../../utilities/CollatedTerminalProvider';
import {
  getProjectLogFilePaths,
  type ILogFilePaths,
  initializeProjectLogFilesAsync
} from './ProjectLogWritable';
import type { IOperationExecutionResult } from './IOperationExecutionResult';

export interface IOperationExecutionRecordContext {
  streamCollator: StreamCollator;
  onOperationStatusChanged?: (record: OperationExecutionRecord) => void;

  debugMode: boolean;
  quietMode: boolean;
}

/**
 * Internal class representing everything about executing an operation
 *
 * @internal
 */
export class OperationExecutionRecord implements IOperationRunnerContext, IOperationExecutionResult {
  /**
   * The associated operation.
   */
  public readonly operation: Operation;

  /**
   * The error which occurred while executing this operation, this is stored in case we need
   * it later (for example to re-print errors at end of execution).
   */
  public error: Error | undefined = undefined;

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
   * ```
   *        (0) A
   *             \
   *          (1) B     C (0)         (applications)
   *               \   /|\
   *                \ / | \
   *             (2) D  |  X (1)      (utilities)
   *                    | / \
   *                    |/   \
   *                (2) Y     Z (2)   (other utilities)
   *
   * All roots (A & C) have a criticalPathLength of 0.
   * B has a score of 1, since A depends on it.
   * D has a score of 2, since we look at the longest chain (e.g D->B->A is longer than D->C)
   * X has a score of 1, since the only package which depends on it is A
   * Z has a score of 2, since only X depends on it, and X has a score of 1
   * Y has a score of 2, since the chain Y->X->C is longer than Y->C
   * ```
   *
   * The algorithm is implemented in AsyncOperationQueue.ts as calculateCriticalPathLength()
   */
  public criticalPathLength: number | undefined = undefined;

  /**
   * The set of operations that must complete before this operation executes.
   */
  public readonly dependencies: Set<OperationExecutionRecord> = new Set();
  /**
   * The set of operations that depend on this operation.
   */
  public readonly consumers: Set<OperationExecutionRecord> = new Set();

  public readonly stopwatch: Stopwatch = new Stopwatch();
  public readonly stdioSummarizer: StdioSummarizer = new StdioSummarizer({
    // Allow writing to this object after transforms have been closed. We clean it up manually in a finally block.
    preventAutoclose: true
  });

  public readonly runner: IOperationRunner;
  public readonly associatedPhase: IPhase | undefined;
  public readonly associatedProject: RushConfigurationProject | undefined;
  public readonly _operationMetadataManager: OperationMetadataManager | undefined;

  public logFilePaths: ILogFilePaths | undefined;

  private readonly _context: IOperationExecutionRecordContext;

  private _collatedWriter: CollatedWriter | undefined = undefined;
  private _status: OperationStatus;

  public constructor(operation: Operation, context: IOperationExecutionRecordContext) {
    const { runner, associatedPhase, associatedProject } = operation;

    if (!runner) {
      throw new InternalError(
        `Operation for phase '${associatedPhase?.name}' and project '${associatedProject?.packageName}' has no runner.`
      );
    }

    this.operation = operation;
    this.runner = runner;
    this.associatedPhase = associatedPhase;
    this.associatedProject = associatedProject;
    this.logFilePaths = undefined;

    this._operationMetadataManager =
      associatedPhase && associatedProject
        ? new OperationMetadataManager({
            phase: associatedPhase,
            rushProject: associatedProject,
            operation
          })
        : undefined;

    this._context = context;
    this._status = operation.dependencies.size > 0 ? OperationStatus.Waiting : OperationStatus.Ready;
  }

  public get name(): string {
    return this.runner.name;
  }

  public get weight(): number {
    return this.operation.weight;
  }

  public get debugMode(): boolean {
    return this._context.debugMode;
  }

  public get quietMode(): boolean {
    return this._context.quietMode;
  }

  public get collatedWriter(): CollatedWriter {
    // Lazy instantiate because the registerTask() call affects display ordering
    if (!this._collatedWriter) {
      this._collatedWriter = this._context.streamCollator.registerTask(this.name);
    }
    return this._collatedWriter;
  }

  public get nonCachedDurationMs(): number | undefined {
    // Lazy calculated because the state file is created/restored later on
    return this._operationMetadataManager?.stateFile.state?.nonCachedDurationMs;
  }

  public get cobuildRunnerId(): string | undefined {
    // Lazy calculated because the state file is created/restored later on
    return this._operationMetadataManager?.stateFile.state?.cobuildRunnerId;
  }

  public get metadataFolderPath(): string | undefined {
    return this._operationMetadataManager?.metadataFolderPath;
  }

  public get isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.status);
  }

  /**
   * The current execution status of an operation. Operations start in the 'ready' state,
   * but can be 'blocked' if an upstream operation failed. It is 'executing' when
   * the operation is executing. Once execution is complete, it is either 'success' or
   * 'failure'.
   */
  public get status(): OperationStatus {
    return this._status;
  }
  public set status(newStatus: OperationStatus) {
    if (newStatus === this._status) {
      return;
    }
    this._status = newStatus;
    this._context.onOperationStatusChanged?.(this);
  }

  public get silent(): boolean {
    return !this.operation.enabled || this.runner.silent;
  }

  /**
   * {@inheritdoc IOperationRunnerContext.runWithTerminalAsync}
   */
  public async runWithTerminalAsync<T>(
    callback: (terminal: ITerminal, terminalProvider: ITerminalProvider) => Promise<T>,
    options: {
      createLogFile: boolean;
      logFileSuffix: string;
    }
  ): Promise<T> {
    const { associatedPhase, associatedProject, stdioSummarizer } = this;
    const { createLogFile, logFileSuffix = '' } = options;

    const logFilePaths: ILogFilePaths | undefined =
      createLogFile && associatedProject && associatedPhase && this._operationMetadataManager
        ? getProjectLogFilePaths({
            project: associatedProject,
            logFilenameIdentifier: `${this._operationMetadataManager.logFilenameIdentifier}${logFileSuffix}`
          })
        : undefined;
    this.logFilePaths = logFilePaths;

    const projectLogWritable: TerminalWritable | undefined = logFilePaths
      ? await initializeProjectLogFilesAsync({
          logFilePaths,
          enableChunkedOutput: true
        })
      : undefined;

    try {
      //#region OPERATION LOGGING
      // TERMINAL PIPELINE:
      //
      //                             +--> quietModeTransform? --> collatedWriter
      //                             |
      // normalizeNewlineTransform --1--> stderrLineTransform --2--> projectLogWritable
      //                                                        |
      //                                                        +--> stdioSummarizer
      const destination: TerminalWritable = projectLogWritable
        ? new SplitterTransform({
            destinations: [projectLogWritable, stdioSummarizer]
          })
        : stdioSummarizer;

      const stderrLineTransform: StderrLineTransform = new StderrLineTransform({
        destination,
        newlineKind: NewlineKind.Lf // for StdioSummarizer
      });

      const splitterTransform1: SplitterTransform = new SplitterTransform({
        destinations: [
          this.quietMode
            ? new DiscardStdoutTransform({ destination: this.collatedWriter })
            : this.collatedWriter,
          stderrLineTransform
        ]
      });

      const normalizeNewlineTransform: TextRewriterTransform = new TextRewriterTransform({
        destination: splitterTransform1,
        normalizeNewlines: NewlineKind.Lf,
        ensureNewlineAtEnd: true
      });

      const collatedTerminal: CollatedTerminal = new CollatedTerminal(normalizeNewlineTransform);
      const terminalProvider: CollatedTerminalProvider = new CollatedTerminalProvider(collatedTerminal, {
        debugEnabled: this.debugMode
      });
      const terminal: Terminal = new Terminal(terminalProvider);
      //#endregion

      const result: T = await callback(terminal, terminalProvider);

      normalizeNewlineTransform.close();

      // If the pipeline is wired up correctly, then closing normalizeNewlineTransform should
      // have closed projectLogWritable.
      if (projectLogWritable?.isOpen) {
        throw new InternalError('The output file handle was not closed');
      }

      return result;
    } finally {
      projectLogWritable?.close();
    }
  }

  public async executeAsync({
    onStart,
    onResult
  }: {
    onStart: (record: OperationExecutionRecord) => Promise<OperationStatus | undefined>;
    onResult: (record: OperationExecutionRecord) => Promise<void>;
  }): Promise<void> {
    if (!this.isTerminal) {
      this.stopwatch.reset();
    }
    this.stopwatch.start();
    this.status = OperationStatus.Executing;

    try {
      const earlyReturnStatus: OperationStatus | undefined = await onStart(this);
      // When the operation status returns by the hook, bypass the runner execution.
      if (earlyReturnStatus) {
        this.status = earlyReturnStatus;
      } else {
        // If the operation is disabled, skip the runner and directly mark as Skipped.
        // However, if the operation is a NoOp, return NoOp so that cache entries can still be written.
        this.status = this.operation.enabled
          ? await this.runner.executeAsync(this)
          : this.runner.isNoOp
            ? OperationStatus.NoOp
            : OperationStatus.Skipped;
      }
      // Delegate global state reporting
      await onResult(this);
    } catch (error) {
      this.status = OperationStatus.Failure;
      this.error = error;
      // Delegate global state reporting
      await onResult(this);
    } finally {
      if (this.isTerminal) {
        this._collatedWriter?.close();
        this.stdioSummarizer.close();
        this.stopwatch.stop();
      }
    }
  }
}
