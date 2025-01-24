// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { createHash, type Hash } from 'node:crypto';

import {
  type IOperationRunner,
  type IOperationRunnerContext,
  OperationStatus
} from '@rushstack/operation-graph';

import { AlreadyReportedError, InternalError } from '@rushstack/node-core-library';

import type { HeftTask } from '../../pluginFramework/HeftTask';
import {
  copyFilesAsync,
  type ICopyOperation,
  asAbsoluteCopyOperation,
  asRelativeCopyOperation
} from '../../plugins/CopyFilesPlugin';
import { deleteFilesAsync } from '../../plugins/DeleteFilesPlugin';
import type {
  HeftTaskSession,
  IHeftTaskFileOperations,
  IHeftTaskRunHookOptions,
  IHeftTaskRunIncrementalHookOptions
} from '../../pluginFramework/HeftTaskSession';
import type { HeftPhaseSession } from '../../pluginFramework/HeftPhaseSession';
import type { InternalHeftSession } from '../../pluginFramework/InternalHeftSession';
import { watchGlobAsync, type IGlobOptions } from '../../plugins/FileGlobSpecifier';
import { type IWatchedFileState, WatchFileSystemAdapter } from '../../utilities/WatchFileSystemAdapter';

export interface ITaskOperationRunnerOptions {
  internalHeftSession: InternalHeftSession;
  task: HeftTask;
}

/**
 * Log out a start message, run a provided function, and log out an end message
 */
export async function runAndMeasureAsync<T = void>(
  fn: () => Promise<T>,
  startMessageFn: () => string,
  endMessageFn: () => string,
  logFn: (message: string) => void
): Promise<T> {
  logFn(startMessageFn());
  const startTime: number = performance.now();
  try {
    return await fn();
  } finally {
    const endTime: number = performance.now();
    logFn(`${endMessageFn()} (${endTime - startTime}ms)`);
  }
}

export class TaskOperationRunner implements IOperationRunner {
  private readonly _options: ITaskOperationRunnerOptions;

  private _fileOperations: IHeftTaskFileOperations | undefined = undefined;
  private _copyConfigHash: string | undefined;
  private _watchFileSystemAdapter: WatchFileSystemAdapter | undefined = undefined;

  public readonly silent: boolean = false;

  public get operationName(): string {
    const { taskName, parentPhase } = this._options.task;
    return `Task ${JSON.stringify(taskName)} of phase ${JSON.stringify(parentPhase.phaseName)}`;
  }

  public constructor(options: ITaskOperationRunnerOptions) {
    this._options = options;
  }

  public async executeAsync(context: IOperationRunnerContext): Promise<OperationStatus> {
    const { internalHeftSession, task } = this._options;
    const { parentPhase } = task;
    const phaseSession: HeftPhaseSession = internalHeftSession.getSessionForPhase(parentPhase);
    const taskSession: HeftTaskSession = phaseSession.getSessionForTask(task);
    return await this._executeTaskAsync(context, taskSession);
  }

  private async _executeTaskAsync(
    context: IOperationRunnerContext,
    taskSession: HeftTaskSession
  ): Promise<OperationStatus> {
    const { abortSignal, requestRun } = context;
    const { hooks, logger } = taskSession;

    // Need to clear any errors or warnings from the previous invocation, particularly
    // if this is an immediate rerun
    logger.resetErrorsAndWarnings();

    const rootFolderPath: string = this._options.internalHeftSession.heftConfiguration.buildFolderPath;
    const isWatchMode: boolean = taskSession.parameters.watch && !!requestRun;

    const { terminal } = logger;

    // Exit the task early if cancellation is requested
    if (abortSignal.aborted) {
      return OperationStatus.Aborted;
    }

    if (!this._fileOperations && hooks.registerFileOperations.isUsed()) {
      const fileOperations: IHeftTaskFileOperations = await hooks.registerFileOperations.promise({
        copyOperations: new Set(),
        deleteOperations: new Set()
      });

      let copyConfigHash: string | undefined;
      const { copyOperations } = fileOperations;
      if (copyOperations.size > 0) {
        // Do this here so that we only need to do it once for each Heft invocation
        const hasher: Hash | undefined = createHash('sha256');
        const absolutePathCopyOperations: Set<ICopyOperation> = new Set();
        for (const copyOperation of fileOperations.copyOperations) {
          // The paths in the `fileOperations` object may be either absolute or relative
          // For execution we need absolute paths.
          const absoluteOperation: ICopyOperation = asAbsoluteCopyOperation(rootFolderPath, copyOperation);
          absolutePathCopyOperations.add(absoluteOperation);

          // For portability of the hash we need relative paths.
          const portableCopyOperation: ICopyOperation = asRelativeCopyOperation(
            rootFolderPath,
            absoluteOperation
          );
          hasher.update(JSON.stringify(portableCopyOperation));
        }
        fileOperations.copyOperations = absolutePathCopyOperations;
        copyConfigHash = hasher.digest('base64');
      }

      this._fileOperations = fileOperations;
      this._copyConfigHash = copyConfigHash;
    }

    const shouldRunIncremental: boolean = isWatchMode && hooks.runIncremental.isUsed();
    let watchFileSystemAdapter: WatchFileSystemAdapter | undefined;
    const getWatchFileSystemAdapter = (): WatchFileSystemAdapter => {
      if (!watchFileSystemAdapter) {
        watchFileSystemAdapter = this._watchFileSystemAdapter ||= new WatchFileSystemAdapter();
        watchFileSystemAdapter.setBaseline();
      }
      return watchFileSystemAdapter;
    };

    const shouldRun: boolean = hooks.run.isUsed() || shouldRunIncremental;
    if (!shouldRun && !this._fileOperations) {
      terminal.writeVerboseLine('Task execution skipped, no implementation provided');
      return OperationStatus.NoOp;
    }

    const runResult: OperationStatus = shouldRun
      ? await runAndMeasureAsync(
          async (): Promise<OperationStatus> => {
            // Create the options and provide a utility method to obtain paths to copy
            const runHookOptions: IHeftTaskRunHookOptions = {
              abortSignal
            };

            // Run the plugin run hook
            try {
              if (shouldRunIncremental) {
                const runIncrementalHookOptions: IHeftTaskRunIncrementalHookOptions = {
                  ...runHookOptions,
                  watchGlobAsync: (
                    pattern: string | string[],
                    options: IGlobOptions = {}
                  ): Promise<Map<string, IWatchedFileState>> => {
                    return watchGlobAsync(pattern, {
                      ...options,
                      fs: getWatchFileSystemAdapter()
                    });
                  },
                  requestRun: requestRun!
                };
                await hooks.runIncremental.promise(runIncrementalHookOptions);
              } else {
                await hooks.run.promise(runHookOptions);
              }
            } catch (e) {
              // Log out using the task logger, and return an error status
              if (!(e instanceof AlreadyReportedError)) {
                logger.emitError(e as Error);
              }
              return OperationStatus.Failure;
            }

            if (abortSignal.aborted) {
              return OperationStatus.Aborted;
            }

            return OperationStatus.Success;
          },
          () => `Starting ${shouldRunIncremental ? 'incremental ' : ''}task execution`,
          () => {
            const finishedWord: string = abortSignal.aborted ? 'Aborted' : 'Finished';
            return `${finishedWord} ${shouldRunIncremental ? 'incremental ' : ''}task execution`;
          },
          terminal.writeVerboseLine.bind(terminal)
        )
      : // This branch only occurs if only file operations are defined.
        OperationStatus.Success;

    if (this._fileOperations) {
      const { copyOperations, deleteOperations } = this._fileOperations;
      const copyConfigHash: string | undefined = this._copyConfigHash;

      await Promise.all([
        copyConfigHash
          ? copyFilesAsync(
              copyOperations,
              logger.terminal,
              `${taskSession.tempFolderPath}/file-copy.json`,
              copyConfigHash,
              isWatchMode ? getWatchFileSystemAdapter() : undefined
            )
          : Promise.resolve(),
        deleteOperations.size > 0
          ? deleteFilesAsync(rootFolderPath, deleteOperations, logger.terminal)
          : Promise.resolve()
      ]);
    }

    if (watchFileSystemAdapter) {
      if (!requestRun) {
        throw new InternalError(`watchFileSystemAdapter was initialized but requestRun is not defined!`);
      }
      watchFileSystemAdapter.watch(requestRun);
    }

    // Even if the entire process has completed, we should mark the operation as cancelled if
    // cancellation has been requested.
    if (abortSignal.aborted) {
      return OperationStatus.Aborted;
    }

    if (logger.hasErrors) {
      return OperationStatus.Failure;
    }

    return runResult;
  }
}
