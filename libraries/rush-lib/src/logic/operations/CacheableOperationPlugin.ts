// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as crypto from 'crypto';
import { InternalError, NewlineKind, Sort } from '@rushstack/node-core-library';
import { CollatedTerminal, type CollatedWriter } from '@rushstack/stream-collator';
import { DiscardStdoutTransform, TextRewriterTransform } from '@rushstack/terminal';
import { SplitterTransform, type TerminalWritable, type ITerminal, Terminal } from '@rushstack/terminal';

import { CollatedTerminalProvider } from '../../utilities/CollatedTerminalProvider';
import { OperationStatus } from './OperationStatus';
import { CobuildLock, type ICobuildCompletedState } from '../cobuild/CobuildLock';
import { ProjectBuildCache } from '../buildCache/ProjectBuildCache';
import { RushConstants } from '../RushConstants';
import type { RushProjectConfiguration } from '../../api/RushProjectConfiguration';
import {
  initializeProjectLogFilesAsync,
  getProjectLogFilePaths,
  type ILogFilePaths
} from './ProjectLogWritable';
import type { CobuildConfiguration } from '../../api/CobuildConfiguration';
import { DisjointSet } from '../cobuild/DisjointSet';
import { PeriodicCallback } from './PeriodicCallback';
import { NullTerminalProvider } from '../../utilities/NullTerminalProvider';

import type { Operation } from './Operation';
import type { IOperationRunnerContext } from './IOperationRunner';
import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import type {
  IExecuteOperationsContext,
  IPhasedCommandPlugin,
  PhasedCommandHooks
} from '../../pluginFramework/PhasedCommandHooks';
import type { IPhase } from '../../api/CommandLineConfiguration';
import type { BuildCacheConfiguration } from '../../api/BuildCacheConfiguration';
import type { IOperationExecutionResult } from './IOperationExecutionResult';
import type { OperationExecutionRecord } from './OperationExecutionRecord';

const PLUGIN_NAME: 'CacheablePhasedOperationPlugin' = 'CacheablePhasedOperationPlugin';
const PERIODIC_CALLBACK_INTERVAL_IN_SECONDS: number = 10;

export interface IProjectDeps {
  files: { [filePath: string]: string };
  arguments: string;
}

export interface IOperationBuildCacheContext {
  isCacheWriteAllowed: boolean;
  isCacheReadAllowed: boolean;

  stateHash: string;

  operationBuildCache: ProjectBuildCache | undefined;
  cacheDisabledReason: string | undefined;
  outputFolderNames: ReadonlyArray<string>;

  cobuildLock: CobuildLock | undefined;

  // The id of the cluster contains the operation, used when acquiring cobuild lock
  cobuildClusterId: string | undefined;

  // Controls the log for the cache subsystem
  buildCacheTerminal: ITerminal | undefined;
  buildCacheTerminalWritable: TerminalWritable | undefined;

  periodicCallback: PeriodicCallback;
  cacheRestored: boolean;
  isCacheReadAttempted: boolean;
}

export interface ICacheableOperationPluginOptions {
  allowWarningsInSuccessfulBuild: boolean;
  buildCacheConfiguration: BuildCacheConfiguration;
  cobuildConfiguration: CobuildConfiguration | undefined;
  terminal: ITerminal;
}

export class CacheableOperationPlugin implements IPhasedCommandPlugin {
  private _buildCacheContextByOperation: Map<Operation, IOperationBuildCacheContext> = new Map();

  private readonly _options: ICacheableOperationPluginOptions;

  public constructor(options: ICacheableOperationPluginOptions) {
    this._options = options;
  }

  public apply(hooks: PhasedCommandHooks): void {
    const { allowWarningsInSuccessfulBuild, buildCacheConfiguration, cobuildConfiguration } = this._options;

    hooks.beforeExecuteOperations.tap(
      PLUGIN_NAME,
      (
        recordByOperation: Map<Operation, IOperationExecutionResult>,
        context: IExecuteOperationsContext
      ): void => {
        const { isIncrementalBuildAllowed, inputsSnapshot, projectConfigurations, isInitial } = context;

        if (!inputsSnapshot) {
          throw new Error(
            `Build cache is only supported if running in a Git repository. Either disable the build cache or run Rush in a Git repository.`
          );
        }

        const disjointSet: DisjointSet<Operation> | undefined = cobuildConfiguration?.cobuildFeatureEnabled
          ? new DisjointSet()
          : undefined;

        for (const [operation, record] of recordByOperation) {
          const stateHash: string = (record as OperationExecutionRecord).calculateStateHash({
            inputsSnapshot,
            buildCacheConfiguration
          });
          const { associatedProject, associatedPhase, runner, settings: operationSettings } = operation;
          if (!associatedProject || !associatedPhase || !runner) {
            return;
          }

          const { name: phaseName } = associatedPhase;

          const projectConfiguration: RushProjectConfiguration | undefined =
            projectConfigurations.get(associatedProject);

          // This value can *currently* be cached per-project, but in the future the list of files will vary
          // depending on the selected phase.
          const fileHashes: ReadonlyMap<string, string> | undefined =
            inputsSnapshot.getTrackedFileHashesForOperation(associatedProject, phaseName);

          const cacheDisabledReason: string | undefined = projectConfiguration
            ? projectConfiguration.getCacheDisabledReason(fileHashes.keys(), phaseName, operation.isNoOp)
            : `Project does not have a ${RushConstants.rushProjectConfigFilename} configuration file, ` +
              'or one provided by a rig, so it does not support caching.';

          const metadataFolderPath: string | undefined = record.metadataFolderPath;

          const outputFolderNames: string[] = metadataFolderPath ? [metadataFolderPath] : [];
          const configuredOutputFolderNames: string[] | undefined = operationSettings?.outputFolderNames;
          if (configuredOutputFolderNames) {
            for (const folderName of configuredOutputFolderNames) {
              outputFolderNames.push(folderName);
            }
          }

          disjointSet?.add(operation);

          const buildCacheContext: IOperationBuildCacheContext = {
            // Supports cache writes by default for initial operations.
            // Don't write during watch runs for performance reasons (and to avoid flooding the cache)
            isCacheWriteAllowed: isInitial,
            isCacheReadAllowed: isIncrementalBuildAllowed,
            operationBuildCache: undefined,
            outputFolderNames,
            stateHash,
            cacheDisabledReason,
            cobuildLock: undefined,
            cobuildClusterId: undefined,
            buildCacheTerminal: undefined,
            buildCacheTerminalWritable: undefined,
            periodicCallback: new PeriodicCallback({
              interval: PERIODIC_CALLBACK_INTERVAL_IN_SECONDS * 1000
            }),
            cacheRestored: false,
            isCacheReadAttempted: false
          };
          // Upstream runners may mutate the property of build cache context for downstream runners
          this._buildCacheContextByOperation.set(operation, buildCacheContext);
        }

        if (disjointSet) {
          clusterOperations(disjointSet, this._buildCacheContextByOperation);
          for (const operationSet of disjointSet.getAllSets()) {
            if (cobuildConfiguration?.cobuildFeatureEnabled && cobuildConfiguration.cobuildContextId) {
              // Get a deterministic ordered array of operations, which is important to get a deterministic cluster id.
              const groupedOperations: Operation[] = Array.from(operationSet);
              Sort.sortBy(groupedOperations, (operation: Operation) => {
                return operation.name;
              });

              // Generates cluster id, cluster id comes from the project folder and operation name of all operations in the same cluster.
              const hash: crypto.Hash = crypto.createHash('sha1');
              for (const operation of groupedOperations) {
                const { associatedPhase: phase, associatedProject: project } = operation;
                if (project && phase) {
                  hash.update(project.projectRelativeFolder);
                  hash.update(RushConstants.hashDelimiter);
                  hash.update(operation.name ?? phase.name);
                  hash.update(RushConstants.hashDelimiter);
                }
              }
              const cobuildClusterId: string = hash.digest('hex');

              // Assign same cluster id to all operations in the same cluster.
              for (const record of groupedOperations) {
                const buildCacheContext: IOperationBuildCacheContext =
                  this._getBuildCacheContextByOperationOrThrow(record);
                buildCacheContext.cobuildClusterId = cobuildClusterId;
              }
            }
          }
        }
      }
    );

    hooks.beforeExecuteOperation.tapPromise(
      PLUGIN_NAME,
      async (
        runnerContext: IOperationRunnerContext & IOperationExecutionResult
      ): Promise<OperationStatus | undefined> => {
        if (this._buildCacheContextByOperation.size === 0) {
          return;
        }

        const buildCacheContext: IOperationBuildCacheContext | undefined =
          this._getBuildCacheContextByOperation(runnerContext.operation);

        if (!buildCacheContext) {
          return;
        }

        const record: OperationExecutionRecord = runnerContext as OperationExecutionRecord;

        const {
          associatedProject: project,
          associatedPhase: phase,
          runner,
          _operationMetadataManager: operationMetadataManager,
          operation
        } = record;

        if (
          !operation.enabled ||
          !project ||
          !phase ||
          !runner?.cacheable ||
          // this check is just to make the types happy, it will always be defined if project + phase are defined.
          !operationMetadataManager
        ) {
          return;
        }

        const runBeforeExecute = async (): Promise<OperationStatus | undefined> => {
          if (
            !buildCacheContext.buildCacheTerminal ||
            buildCacheContext.buildCacheTerminalWritable?.isOpen === false
          ) {
            // The writable does not exist or has been closed, re-create one
            // eslint-disable-next-line require-atomic-updates
            buildCacheContext.buildCacheTerminal = await this._createBuildCacheTerminalAsync({
              record,
              buildCacheContext,
              buildCacheEnabled: buildCacheConfiguration?.buildCacheEnabled,
              rushProject: project,
              logFilenameIdentifier: operation.logFilenameIdentifier,
              quietMode: record.quietMode,
              debugMode: record.debugMode
            });
          }

          const buildCacheTerminal: ITerminal = buildCacheContext.buildCacheTerminal;

          let projectBuildCache: ProjectBuildCache | undefined = this._tryGetProjectBuildCache({
            buildCacheContext,
            buildCacheConfiguration,
            terminal: buildCacheTerminal,
            record
          });

          // Try to acquire the cobuild lock
          let cobuildLock: CobuildLock | undefined;
          if (cobuildConfiguration?.cobuildFeatureEnabled) {
            if (
              cobuildConfiguration?.cobuildLeafProjectLogOnlyAllowed &&
              operation.consumers.size === 0 &&
              !projectBuildCache
            ) {
              // When the leaf project log only is allowed and the leaf project is build cache "disabled", try to get
              // a log files only project build cache
              projectBuildCache = await this._tryGetLogOnlyProjectBuildCacheAsync({
                buildCacheConfiguration,
                cobuildConfiguration,
                buildCacheContext,
                rushProject: project,
                phase,
                terminal: buildCacheTerminal
              });
              if (projectBuildCache) {
                buildCacheTerminal.writeVerboseLine(
                  `Log files only build cache is enabled for the project "${project.packageName}" because the cobuild leaf project log only is allowed`
                );
              } else {
                buildCacheTerminal.writeWarningLine(
                  `Failed to get log files only build cache for the project "${project.packageName}"`
                );
              }
            }

            cobuildLock = await this._tryGetCobuildLockAsync({
              buildCacheContext,
              projectBuildCache,
              cobuildConfiguration,
              packageName: project.packageName,
              phaseName: phase.name
            });
          }

          // eslint-disable-next-line require-atomic-updates -- we are mutating the build cache context intentionally
          buildCacheContext.cobuildLock = cobuildLock;

          // If possible, we want to skip this operation -- either by restoring it from the
          // cache, if caching is enabled, or determining that the project
          // is unchanged (using the older incremental execution logic). These two approaches,
          // "caching" and "skipping", are incompatible, so only one applies.
          //
          // Note that "caching" and "skipping" take two different approaches
          // to tracking dependents:
          //
          //   - For caching, "isCacheReadAllowed" is set if a project supports
          //     incremental builds, and determining whether this project or a dependent
          //     has changed happens inside the hashing logic.
          //

          const { error: errorLogPath } = getProjectLogFilePaths({
            project,
            logFilenameIdentifier: operation.logFilenameIdentifier
          });
          const restoreCacheAsync = async (
            // TODO: Investigate if `projectBuildCacheForRestore` is always the same instance as `projectBuildCache`
            // above, and if it is, remove this parameter
            projectBuildCacheForRestore: ProjectBuildCache | undefined,
            specifiedCacheId?: string
          ): Promise<boolean> => {
            buildCacheContext.isCacheReadAttempted = true;
            const restoreFromCacheSuccess: boolean | undefined =
              await projectBuildCacheForRestore?.tryRestoreFromCacheAsync(
                buildCacheTerminal,
                specifiedCacheId
              );
            if (restoreFromCacheSuccess) {
              buildCacheContext.cacheRestored = true;
              await runnerContext.runWithTerminalAsync(
                async (taskTerminal, terminalProvider) => {
                  // Restore the original state of the operation without cache
                  await operationMetadataManager?.tryRestoreAsync({
                    terminalProvider,
                    terminal: buildCacheTerminal,
                    errorLogPath,
                    cobuildContextId: cobuildConfiguration?.cobuildContextId,
                    cobuildRunnerId: cobuildConfiguration?.cobuildRunnerId
                  });
                },
                { createLogFile: false }
              );
            }
            return !!restoreFromCacheSuccess;
          };
          if (cobuildLock) {
            // handling rebuilds. "rush rebuild" or "rush retest" command will save operations to
            // the build cache once completed, but does not retrieve them (since the "incremental"
            // flag is disabled). However, we still need a cobuild to be able to retrieve a finished
            // build from another cobuild in this case.
            const cobuildCompletedState: ICobuildCompletedState | undefined =
              await cobuildLock.getCompletedStateAsync();
            if (cobuildCompletedState) {
              const { status, cacheId } = cobuildCompletedState;

              if (record.operation.settings?.allowCobuildWithoutCache) {
                // This should only be enabled if the experiment for cobuild orchestration is enabled.
                return status;
              }

              const restoreFromCacheSuccess: boolean = await restoreCacheAsync(
                cobuildLock.projectBuildCache,
                cacheId
              );

              if (restoreFromCacheSuccess) {
                return status;
              }
            } else if (!buildCacheContext.isCacheReadAttempted && buildCacheContext.isCacheReadAllowed) {
              const restoreFromCacheSuccess: boolean = await restoreCacheAsync(projectBuildCache);

              if (restoreFromCacheSuccess) {
                return OperationStatus.FromCache;
              }
            }
          } else if (buildCacheContext.isCacheReadAllowed) {
            const restoreFromCacheSuccess: boolean = await restoreCacheAsync(projectBuildCache);

            if (restoreFromCacheSuccess) {
              return OperationStatus.FromCache;
            }
          }

          if (buildCacheContext.isCacheWriteAllowed && cobuildLock) {
            const acquireSuccess: boolean = await cobuildLock.tryAcquireLockAsync();
            if (acquireSuccess) {
              const { periodicCallback } = buildCacheContext;
              periodicCallback.addCallback(async () => {
                await cobuildLock?.renewLockAsync();
              });
              periodicCallback.start();
            } else {
              setTimeout(() => {
                record.status = OperationStatus.Ready;
              }, 500);
              return OperationStatus.Executing;
            }
          }
        };

        return await runBeforeExecute();
      }
    );

    hooks.afterExecuteOperation.tapPromise(
      PLUGIN_NAME,
      async (runnerContext: IOperationRunnerContext): Promise<void> => {
        const record: OperationExecutionRecord = runnerContext as OperationExecutionRecord;
        const { status, stopwatch, _operationMetadataManager: operationMetadataManager, operation } = record;

        const { associatedProject: project, associatedPhase: phase, runner, enabled } = operation;

        if (!enabled || !project || !phase || !runner?.cacheable || !operationMetadataManager) {
          return;
        }

        const buildCacheContext: IOperationBuildCacheContext | undefined =
          this._getBuildCacheContextByOperation(operation);

        if (!buildCacheContext) {
          return;
        }

        // No need to run for the following operation status
        if (!record.isTerminal || record.status === OperationStatus.NoOp) {
          return;
        }

        const { cobuildLock, operationBuildCache, isCacheWriteAllowed, buildCacheTerminal, cacheRestored } =
          buildCacheContext;

        try {
          if (!cacheRestored) {
            // Save the metadata to disk
            const { logFilenameIdentifier } = operationMetadataManager;
            const { duration: durationInSeconds } = stopwatch;
            const {
              text: logPath,
              error: errorLogPath,
              jsonl: logChunksPath
            } = getProjectLogFilePaths({
              project,
              logFilenameIdentifier
            });
            await operationMetadataManager.saveAsync({
              durationInSeconds,
              cobuildContextId: cobuildLock?.cobuildConfiguration.cobuildContextId,
              cobuildRunnerId: cobuildLock?.cobuildConfiguration.cobuildRunnerId,
              logPath,
              errorLogPath,
              logChunksPath
            });
          }

          if (!buildCacheTerminal) {
            // This should not happen
            throw new InternalError(`Build Cache Terminal is not created`);
          }

          let setCompletedStatePromiseFunction: (() => Promise<void> | undefined) | undefined;
          let setCacheEntryPromise: (() => Promise<boolean> | undefined) | undefined;
          if (cobuildLock && isCacheWriteAllowed) {
            const { cacheId, contextId } = cobuildLock.cobuildContext;

            let finalCacheId: string = cacheId;
            if (status === OperationStatus.Failure) {
              finalCacheId = `${cacheId}-${contextId}-failed`;
            } else if (status === OperationStatus.SuccessWithWarning && !record.runner.warningsAreAllowed) {
              finalCacheId = `${cacheId}-${contextId}-warnings`;
            }
            switch (status) {
              case OperationStatus.SuccessWithWarning:
              case OperationStatus.Success:
              case OperationStatus.Failure: {
                const currentStatus: ICobuildCompletedState['status'] = status;
                setCompletedStatePromiseFunction = () => {
                  return cobuildLock?.setCompletedStateAsync({
                    status: currentStatus,
                    cacheId: finalCacheId
                  });
                };
                setCacheEntryPromise = () =>
                  cobuildLock.projectBuildCache.trySetCacheEntryAsync(buildCacheTerminal, finalCacheId);
              }
            }
          }

          const taskIsSuccessful: boolean =
            status === OperationStatus.Success ||
            (status === OperationStatus.SuccessWithWarning &&
              record.runner.warningsAreAllowed &&
              allowWarningsInSuccessfulBuild);

          // If the command is successful, we can calculate project hash, and no dependencies were skipped,
          // write a new cache entry.
          if (!setCacheEntryPromise && taskIsSuccessful && isCacheWriteAllowed && operationBuildCache) {
            setCacheEntryPromise = () => operationBuildCache.trySetCacheEntryAsync(buildCacheTerminal);
          }
          if (!cacheRestored) {
            const cacheWriteSuccess: boolean | undefined = await setCacheEntryPromise?.();
            await setCompletedStatePromiseFunction?.();

            if (cacheWriteSuccess === false && status === OperationStatus.Success) {
              record.status = OperationStatus.SuccessWithWarning;
            }
          }
        } finally {
          buildCacheContext.buildCacheTerminalWritable?.close();
          buildCacheContext.periodicCallback.stop();
        }
      }
    );

    hooks.afterExecuteOperation.tap(
      PLUGIN_NAME,
      (record: IOperationRunnerContext & IOperationExecutionResult): void => {
        const { operation } = record;
        const buildCacheContext: IOperationBuildCacheContext | undefined =
          this._buildCacheContextByOperation.get(operation);
        // Status changes to direct dependents
        let blockCacheWrite: boolean = !buildCacheContext?.isCacheWriteAllowed;

        switch (record.status) {
          case OperationStatus.Skipped: {
            // Skipping means cannot guarantee integrity, so prevent cache writes in dependents.
            blockCacheWrite = true;
            break;
          }
        }

        // Apply status changes to direct dependents
        if (blockCacheWrite) {
          for (const consumer of operation.consumers) {
            const consumerBuildCacheContext: IOperationBuildCacheContext | undefined =
              this._getBuildCacheContextByOperation(consumer);
            if (consumerBuildCacheContext) {
              consumerBuildCacheContext.isCacheWriteAllowed = false;
            }
          }
        }
      }
    );

    hooks.afterExecuteOperations.tapPromise(PLUGIN_NAME, async () => {
      this._buildCacheContextByOperation.clear();
    });
  }

  private _getBuildCacheContextByOperation(operation: Operation): IOperationBuildCacheContext | undefined {
    const buildCacheContext: IOperationBuildCacheContext | undefined =
      this._buildCacheContextByOperation.get(operation);
    return buildCacheContext;
  }

  private _getBuildCacheContextByOperationOrThrow(operation: Operation): IOperationBuildCacheContext {
    const buildCacheContext: IOperationBuildCacheContext | undefined =
      this._getBuildCacheContextByOperation(operation);
    if (!buildCacheContext) {
      // This should not happen
      throw new InternalError(`Build cache context for operation ${operation.name} should be defined`);
    }
    return buildCacheContext;
  }

  private _tryGetProjectBuildCache({
    buildCacheConfiguration,
    buildCacheContext,
    terminal,
    record
  }: {
    buildCacheContext: IOperationBuildCacheContext;
    buildCacheConfiguration: BuildCacheConfiguration | undefined;
    terminal: ITerminal;
    record: OperationExecutionRecord;
  }): ProjectBuildCache | undefined {
    if (!buildCacheContext.operationBuildCache) {
      const { cacheDisabledReason } = buildCacheContext;
      if (cacheDisabledReason && !record.operation.settings?.allowCobuildWithoutCache) {
        terminal.writeVerboseLine(cacheDisabledReason);
        return;
      }

      if (!buildCacheConfiguration) {
        // Unreachable, since this will have set `cacheDisabledReason`.
        return;
      }

      // eslint-disable-next-line require-atomic-updates -- This is guaranteed to not be concurrent
      buildCacheContext.operationBuildCache = ProjectBuildCache.forOperation(record, {
        buildCacheConfiguration,
        terminal
      });
    }

    return buildCacheContext.operationBuildCache;
  }

  // Get a ProjectBuildCache only cache/restore log files
  private async _tryGetLogOnlyProjectBuildCacheAsync({
    buildCacheContext,
    rushProject,
    terminal,
    buildCacheConfiguration,
    cobuildConfiguration,
    phase
  }: {
    buildCacheContext: IOperationBuildCacheContext;
    buildCacheConfiguration: BuildCacheConfiguration | undefined;
    cobuildConfiguration: CobuildConfiguration;
    rushProject: RushConfigurationProject;
    phase: IPhase;
    terminal: ITerminal;
  }): Promise<ProjectBuildCache | undefined> {
    if (!buildCacheConfiguration?.buildCacheEnabled) {
      return;
    }

    const { outputFolderNames, stateHash } = buildCacheContext;

    const hasher: crypto.Hash = crypto.createHash('sha1');
    hasher.update(stateHash);

    if (cobuildConfiguration.cobuildContextId) {
      hasher.update(`\ncobuildContextId=${cobuildConfiguration.cobuildContextId}`);
    }

    hasher.update(`\nlogFilesOnly=1`);

    const operationStateHash: string = hasher.digest('hex');

    const projectBuildCache: ProjectBuildCache = ProjectBuildCache.getProjectBuildCache({
      project: rushProject,
      projectOutputFolderNames: outputFolderNames,
      buildCacheConfiguration,
      terminal,
      operationStateHash,
      phaseName: phase.name
    });

    // eslint-disable-next-line require-atomic-updates -- This is guaranteed to not be concurrent
    buildCacheContext.operationBuildCache = projectBuildCache;

    return projectBuildCache;
  }

  private async _tryGetCobuildLockAsync({
    cobuildConfiguration,
    buildCacheContext,
    projectBuildCache,
    packageName,
    phaseName
  }: {
    cobuildConfiguration: CobuildConfiguration | undefined;
    buildCacheContext: IOperationBuildCacheContext;
    projectBuildCache: ProjectBuildCache | undefined;
    packageName: string;
    phaseName: string;
  }): Promise<CobuildLock | undefined> {
    if (!buildCacheContext.cobuildLock) {
      if (projectBuildCache && cobuildConfiguration?.cobuildFeatureEnabled) {
        if (!buildCacheContext.cobuildClusterId) {
          // This should not happen
          throw new InternalError('Cobuild cluster id is not defined');
        }
        buildCacheContext.cobuildLock = new CobuildLock({
          cobuildConfiguration,
          projectBuildCache,
          cobuildClusterId: buildCacheContext.cobuildClusterId,
          lockExpireTimeInSeconds: PERIODIC_CALLBACK_INTERVAL_IN_SECONDS * 3,
          packageName,
          phaseName
        });
      }
    }
    return buildCacheContext.cobuildLock;
  }

  private async _createBuildCacheTerminalAsync({
    record,
    buildCacheContext,
    buildCacheEnabled,
    rushProject,
    logFilenameIdentifier,
    quietMode,
    debugMode
  }: {
    record: OperationExecutionRecord;
    buildCacheContext: IOperationBuildCacheContext;
    buildCacheEnabled: boolean | undefined;
    rushProject: RushConfigurationProject;
    logFilenameIdentifier: string;
    quietMode: boolean;
    debugMode: boolean;
  }): Promise<ITerminal> {
    const silent: boolean = record.silent;
    if (silent) {
      const nullTerminalProvider: NullTerminalProvider = new NullTerminalProvider();
      return new Terminal(nullTerminalProvider);
    }

    let cacheConsoleWritable: TerminalWritable;
    // This creates the writer, only do this if necessary.
    const collatedWriter: CollatedWriter = record.collatedWriter;
    const cacheProjectLogWritable: TerminalWritable | undefined =
      await this._tryGetBuildCacheTerminalWritableAsync({
        buildCacheContext,
        buildCacheEnabled,
        rushProject,
        logFilenameIdentifier
      });

    if (quietMode) {
      const discardTransform: DiscardStdoutTransform = new DiscardStdoutTransform({
        destination: collatedWriter
      });
      const normalizeNewlineTransform: TextRewriterTransform = new TextRewriterTransform({
        destination: discardTransform,
        normalizeNewlines: NewlineKind.Lf,
        ensureNewlineAtEnd: true
      });
      cacheConsoleWritable = normalizeNewlineTransform;
    } else {
      cacheConsoleWritable = collatedWriter;
    }

    let cacheCollatedTerminal: CollatedTerminal;
    if (cacheProjectLogWritable) {
      const cacheSplitterTransform: SplitterTransform = new SplitterTransform({
        destinations: [cacheConsoleWritable, cacheProjectLogWritable]
      });
      cacheCollatedTerminal = new CollatedTerminal(cacheSplitterTransform);
    } else {
      cacheCollatedTerminal = new CollatedTerminal(cacheConsoleWritable);
    }

    const buildCacheTerminalProvider: CollatedTerminalProvider = new CollatedTerminalProvider(
      cacheCollatedTerminal,
      {
        debugEnabled: debugMode
      }
    );
    return new Terminal(buildCacheTerminalProvider);
  }

  private async _tryGetBuildCacheTerminalWritableAsync({
    buildCacheEnabled,
    rushProject,
    buildCacheContext,
    logFilenameIdentifier
  }: {
    buildCacheEnabled: boolean | undefined;
    rushProject: RushConfigurationProject;
    buildCacheContext: IOperationBuildCacheContext;
    logFilenameIdentifier: string;
  }): Promise<TerminalWritable | undefined> {
    // Only open the *.cache.log file(s) if the cache is enabled.
    if (!buildCacheEnabled) {
      return;
    }

    const logFilePaths: ILogFilePaths = getProjectLogFilePaths({
      project: rushProject,
      logFilenameIdentifier: `${logFilenameIdentifier}.cache`
    });

    buildCacheContext.buildCacheTerminalWritable = await initializeProjectLogFilesAsync({
      logFilePaths
    });

    return buildCacheContext.buildCacheTerminalWritable;
  }
}

export function clusterOperations(
  initialClusters: DisjointSet<Operation>,
  operationBuildCacheMap: Map<Operation, { cacheDisabledReason: string | undefined }>
): void {
  // If disjoint set exists, connect build cache disabled project with its consumers
  for (const [operation, { cacheDisabledReason }] of operationBuildCacheMap) {
    const { associatedProject: project, associatedPhase: phase } = operation;
    if (project && phase) {
      if (cacheDisabledReason && !operation.settings?.allowCobuildWithoutCache) {
        /**
         * Group the project build cache disabled with its consumers. This won't affect too much in
         * a monorepo with high build cache coverage.
         *
         * The mental model is that if X disables the cache, and Y depends on X, then:
         *   1. Y must be built by the same VM that build X;
         *   2. OR, Y must be rebuilt on each VM that needs it.
         * Approach 1 is probably the better choice.
         */
        for (const consumer of operation.consumers) {
          initialClusters?.union(operation, consumer);
        }
      }
    }
  }
}
