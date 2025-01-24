// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { performance } from 'perf_hooks';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import os from 'os';

import { AlreadyReportedError, InternalError, type IPackageJson } from '@rushstack/node-core-library';
import { Colorize, ConsoleTerminalProvider, type ITerminal } from '@rushstack/terminal';
import {
  type IOperationExecutionOptions,
  type IWatchLoopState,
  Operation,
  OperationExecutionManager,
  OperationStatus,
  WatchLoop
} from '@rushstack/operation-graph';
import type {
  CommandLineFlagParameter,
  CommandLineParameterProvider,
  CommandLineStringListParameter
} from '@rushstack/ts-command-line';

import type { InternalHeftSession } from '../pluginFramework/InternalHeftSession';
import type { HeftConfiguration } from '../configuration/HeftConfiguration';
import type { LoggingManager } from '../pluginFramework/logging/LoggingManager';
import type { MetricsCollector } from '../metrics/MetricsCollector';
import { HeftParameterManager } from '../pluginFramework/HeftParameterManager';
import { TaskOperationRunner } from '../operations/runners/TaskOperationRunner';
import { PhaseOperationRunner } from '../operations/runners/PhaseOperationRunner';
import type { HeftPhase } from '../pluginFramework/HeftPhase';
import type { IHeftAction, IHeftActionOptions } from './actions/IHeftAction';
import type {
  IHeftLifecycleCleanHookOptions,
  IHeftLifecycleSession,
  IHeftLifecycleToolFinishHookOptions,
  IHeftLifecycleToolStartHookOptions
} from '../pluginFramework/HeftLifecycleSession';
import type { HeftLifecycle } from '../pluginFramework/HeftLifecycle';
import type { HeftTask } from '../pluginFramework/HeftTask';
import { deleteFilesAsync, type IDeleteOperation } from '../plugins/DeleteFilesPlugin';
import { Constants } from '../utilities/Constants';

export interface IHeftActionRunnerOptions extends IHeftActionOptions {
  action: IHeftAction;
}

export function initializeHeft(
  heftConfiguration: HeftConfiguration,
  terminal: ITerminal,
  isVerbose: boolean
): void {
  // Ensure that verbose is enabled on the terminal if requested. terminalProvider.verboseEnabled
  // should already be `true` if the `--debug` flag was provided. This is set in HeftCommandLineParser
  if (heftConfiguration.terminalProvider instanceof ConsoleTerminalProvider) {
    heftConfiguration.terminalProvider.verboseEnabled =
      heftConfiguration.terminalProvider.verboseEnabled || isVerbose;
  }

  // Log some information about the execution
  const projectPackageJson: IPackageJson = heftConfiguration.projectPackageJson;
  terminal.writeVerboseLine(`Project: ${projectPackageJson.name}@${projectPackageJson.version}`);
  terminal.writeVerboseLine(`Project build folder: ${heftConfiguration.buildFolderPath}`);
  if (heftConfiguration.rigConfig.rigFound) {
    terminal.writeVerboseLine(`Rig package: ${heftConfiguration.rigConfig.rigPackageName}`);
    terminal.writeVerboseLine(`Rig profile: ${heftConfiguration.rigConfig.rigProfile}`);
  }
  terminal.writeVerboseLine(`Heft version: ${heftConfiguration.heftPackageJson.version}`);
  terminal.writeVerboseLine(`Node version: ${process.version}`);
  terminal.writeVerboseLine('');
}

let _cliAbortSignal: AbortSignal | undefined;
export function ensureCliAbortSignal(terminal: ITerminal): AbortSignal {
  if (!_cliAbortSignal) {
    // Set up the ability to terminate the build via Ctrl+C and have it exit gracefully if pressed once,
    // less gracefully if pressed a second time.
    const cliAbortController: AbortController = new AbortController();
    _cliAbortSignal = cliAbortController.signal;
    const cli: ReadlineInterface = createInterface(process.stdin, undefined, undefined, true);
    let forceTerminate: boolean = false;
    cli.on('SIGINT', () => {
      cli.close();

      if (forceTerminate) {
        terminal.writeErrorLine(`Forcibly terminating.`);
        process.exit(1);
      } else {
        terminal.writeLine(
          Colorize.yellow(Colorize.bold(`Canceling... Press Ctrl+C again to forcibly terminate.`))
        );
      }

      forceTerminate = true;
      cliAbortController.abort();
    });
  }

  return _cliAbortSignal;
}

export async function runWithLoggingAsync(
  fn: () => Promise<OperationStatus>,
  action: IHeftAction,
  loggingManager: LoggingManager,
  terminal: ITerminal,
  metricsCollector: MetricsCollector,
  abortSignal: AbortSignal,
  throwOnFailure?: boolean
): Promise<OperationStatus> {
  const startTime: number = performance.now();
  loggingManager.resetScopedLoggerErrorsAndWarnings();

  let result: OperationStatus = OperationStatus.Failure;

  // Execute the action operations
  let encounteredError: boolean = false;
  try {
    result = await fn();
    if (result === OperationStatus.Failure) {
      encounteredError = true;
    }
  } catch (e) {
    encounteredError = true;
    throw e;
  } finally {
    const warningStrings: string[] = loggingManager.getWarningStrings();
    const errorStrings: string[] = loggingManager.getErrorStrings();

    const wasAborted: boolean = abortSignal.aborted;
    const encounteredWarnings: boolean = warningStrings.length > 0 || wasAborted;
    encounteredError = encounteredError || errorStrings.length > 0;

    await metricsCollector.recordAsync(
      action.actionName,
      {
        encounteredError
      },
      action.getParameterStringMap()
    );

    const finishedLoggingWord: string = encounteredError ? 'Failed' : wasAborted ? 'Aborted' : 'Finished';
    const duration: number = performance.now() - startTime;
    const durationSeconds: number = Math.round(duration) / 1000;
    const finishedLoggingLine: string = `-------------------- ${finishedLoggingWord} (${durationSeconds}s) --------------------`;
    terminal.writeLine(
      Colorize.bold(
        (encounteredError ? Colorize.red : encounteredWarnings ? Colorize.yellow : Colorize.green)(
          finishedLoggingLine
        )
      )
    );

    if (warningStrings.length > 0) {
      terminal.writeWarningLine(
        `Encountered ${warningStrings.length} warning${warningStrings.length === 1 ? '' : 's'}`
      );
      for (const warningString of warningStrings) {
        terminal.writeWarningLine(`  ${warningString}`);
      }
    }

    if (errorStrings.length > 0) {
      terminal.writeErrorLine(
        `Encountered ${errorStrings.length} error${errorStrings.length === 1 ? '' : 's'}`
      );
      for (const errorString of errorStrings) {
        terminal.writeErrorLine(`  ${errorString}`);
      }
    }
  }

  if (encounteredError && throwOnFailure) {
    throw new AlreadyReportedError();
  }

  return result;
}

export class HeftActionRunner {
  private readonly _action: IHeftAction;
  private readonly _terminal: ITerminal;
  private readonly _internalHeftSession: InternalHeftSession;
  private readonly _metricsCollector: MetricsCollector;
  private readonly _loggingManager: LoggingManager;
  private readonly _heftConfiguration: HeftConfiguration;
  private _parameterManager: HeftParameterManager | undefined;
  private readonly _parallelism: number;

  public constructor(options: IHeftActionRunnerOptions) {
    this._action = options.action;
    this._internalHeftSession = options.internalHeftSession;
    this._heftConfiguration = options.heftConfiguration;
    this._loggingManager = options.loggingManager;
    this._terminal = options.terminal;
    this._metricsCollector = options.metricsCollector;

    const numberOfCores: number = os.cpus().length;

    // If an explicit parallelism number wasn't provided, then choose a sensible
    // default.
    if (os.platform() === 'win32') {
      // On desktop Windows, some people have complained that their system becomes
      // sluggish if Node is using all the CPU cores.  Leave one thread for
      // other operations. For CI environments, you can use the "max" argument to use all available cores.
      this._parallelism = Math.max(numberOfCores - 1, 1);
    } else {
      // Unix-like operating systems have more balanced scheduling, so default
      // to the number of CPU cores
      this._parallelism = numberOfCores;
    }
  }

  protected get parameterManager(): HeftParameterManager {
    if (!this._parameterManager) {
      throw new InternalError(`HeftActionRunner.defineParameters() has not been called.`);
    }
    return this._parameterManager;
  }

  public defineParameters(parameterProvider?: CommandLineParameterProvider | undefined): void {
    if (!this._parameterManager) {
      // Use the provided parameter provider if one was provided. This is used by the RunAction
      // to allow for the Heft plugin parameters to be applied as scoped parameters.
      parameterProvider = parameterProvider || this._action;
    } else {
      throw new InternalError(`HeftActionParameters.defineParameters() has already been called.`);
    }

    const verboseFlag: CommandLineFlagParameter = parameterProvider.defineFlagParameter({
      parameterLongName: Constants.verboseParameterLongName,
      parameterShortName: Constants.verboseParameterShortName,
      description: 'If specified, log information useful for debugging.'
    });
    const productionFlag: CommandLineFlagParameter = parameterProvider.defineFlagParameter({
      parameterLongName: Constants.productionParameterLongName,
      description: 'If specified, run Heft in production mode.'
    });
    const localesParameter: CommandLineStringListParameter = parameterProvider.defineStringListParameter({
      parameterLongName: Constants.localesParameterLongName,
      argumentName: 'LOCALE',
      description: 'Use the specified locale for this run, if applicable.'
    });

    let cleanFlagDescription: string =
      'If specified, clean the outputs at the beginning of the lifecycle and before running each phase.';
    if (this._action.watch) {
      cleanFlagDescription =
        `${cleanFlagDescription} Cleaning will only be performed once for the lifecycle and each phase, ` +
        `and further incremental runs will not be cleaned for the duration of execution.`;
    }
    const cleanFlag: CommandLineFlagParameter = parameterProvider.defineFlagParameter({
      parameterLongName: Constants.cleanParameterLongName,
      description: cleanFlagDescription
    });

    const parameterManager: HeftParameterManager = new HeftParameterManager({
      getIsDebug: () => this._internalHeftSession.debug,
      getIsVerbose: () => verboseFlag.value,
      getIsProduction: () => productionFlag.value,
      getIsWatch: () => this._action.watch,
      getLocales: () => localesParameter.values,
      getIsClean: () => !!cleanFlag?.value
    });

    // Add all the lifecycle parameters for the action
    for (const lifecyclePluginDefinition of this._internalHeftSession.lifecycle.pluginDefinitions) {
      parameterManager.addPluginParameters(lifecyclePluginDefinition);
    }

    // Add all the task parameters for the action
    for (const phase of this._action.selectedPhases) {
      for (const task of phase.tasks) {
        parameterManager.addPluginParameters(task.pluginDefinition);
      }
    }

    // Finalize and apply to the CommandLineParameterProvider
    parameterManager.finalizeParameters(parameterProvider);
    this._parameterManager = parameterManager;
  }

  public async executeAsync(): Promise<void> {
    const terminal: ITerminal = this._terminal;
    // Set the parameter manager on the internal session, which is used to provide the selected
    // parameters to plugins. Set this in onExecute() since we now know that this action is being
    // executed, and the session should be populated with the executing parameters.
    this._internalHeftSession.parameterManager = this.parameterManager;

    initializeHeft(this._heftConfiguration, terminal, this.parameterManager.defaultParameters.verbose);

    const operations: ReadonlySet<Operation> = this._generateOperations();

    const executionManager: OperationExecutionManager = new OperationExecutionManager(operations);

    const cliAbortSignal: AbortSignal = ensureCliAbortSignal(this._terminal);

    try {
      await _startLifecycleAsync(this._internalHeftSession);

      if (this._action.watch) {
        const watchLoop: WatchLoop = this._createWatchLoop(executionManager);

        if (process.send) {
          await watchLoop.runIPCAsync();
        } else {
          await watchLoop.runUntilAbortedAsync(cliAbortSignal, () => {
            terminal.writeLine(Colorize.bold('Waiting for changes. Press CTRL + C to exit...'));
            terminal.writeLine('');
          });
        }
      } else {
        await this._executeOnceAsync(executionManager, cliAbortSignal);
      }
    } finally {
      // Invoke this here both to ensure it always runs and that it does so after recordMetrics
      // This is treated as a finalizer for any assets created in lifecycle plugins.
      // It is the responsibility of the lifecycle plugin to ensure that finish gracefully handles
      // aborted runs.
      await _finishLifecycleAsync(this._internalHeftSession);
    }
  }

  private _createWatchLoop(executionManager: OperationExecutionManager): WatchLoop {
    const { _terminal: terminal } = this;
    const watchLoop: WatchLoop = new WatchLoop({
      onBeforeExecute: () => {
        // Write an empty line to the terminal for separation between iterations. We've already iterated
        // at this point, so log out that we're about to start a new run.
        terminal.writeLine('');
        terminal.writeLine(Colorize.bold('Starting incremental build...'));
      },
      executeAsync: (state: IWatchLoopState): Promise<OperationStatus> => {
        return this._executeOnceAsync(executionManager, state.abortSignal, state.requestRun);
      },
      onRequestRun: (requestor: string) => {
        terminal.writeLine(Colorize.bold(`New run requested by ${requestor}`));
      },
      onAbort: () => {
        terminal.writeLine(Colorize.bold(`Cancelling incremental build...`));
      }
    });
    return watchLoop;
  }

  private async _executeOnceAsync(
    executionManager: OperationExecutionManager,
    abortSignal: AbortSignal,
    requestRun?: (requestor: string) => void
  ): Promise<OperationStatus> {
    // Record this as the start of task execution.
    this._metricsCollector.setStartTime();
    // Execute the action operations
    return await runWithLoggingAsync(
      () => {
        const operationExecutionManagerOptions: IOperationExecutionOptions = {
          terminal: this._terminal,
          parallelism: this._parallelism,
          abortSignal,
          requestRun
        };

        return executionManager.executeAsync(operationExecutionManagerOptions);
      },
      this._action,
      this._loggingManager,
      this._terminal,
      this._metricsCollector,
      abortSignal,
      !requestRun
    );
  }

  private _generateOperations(): Set<Operation> {
    const { selectedPhases } = this._action;

    const operations: Map<string, Operation> = new Map();
    const internalHeftSession: InternalHeftSession = this._internalHeftSession;

    let hasWarnedAboutSkippedPhases: boolean = false;
    for (const phase of selectedPhases) {
      // Warn if any dependencies are excluded from the list of selected phases
      if (!hasWarnedAboutSkippedPhases) {
        for (const dependencyPhase of phase.dependencyPhases) {
          if (!selectedPhases.has(dependencyPhase)) {
            // Only write once, and write with yellow to make it stand out without writing a warning to stderr
            hasWarnedAboutSkippedPhases = true;
            this._terminal.writeLine(
              Colorize.bold(
                'The provided list of phases does not contain all phase dependencies. You may need to run the ' +
                  'excluded phases manually.'
              )
            );
            break;
          }
        }
      }

      // Create operation for the phase start node
      const phaseOperation: Operation = _getOrCreatePhaseOperation(internalHeftSession, phase, operations);

      // Create operations for each task
      for (const task of phase.tasks) {
        const taskOperation: Operation = _getOrCreateTaskOperation(internalHeftSession, task, operations);
        // Set the phase operation as a dependency of the task operation to ensure the phase operation runs first
        taskOperation.addDependency(phaseOperation);

        // Set all dependency tasks as dependencies of the task operation
        for (const dependencyTask of task.dependencyTasks) {
          taskOperation.addDependency(
            _getOrCreateTaskOperation(internalHeftSession, dependencyTask, operations)
          );
        }

        // Set all tasks in a in a phase as dependencies of the consuming phase
        for (const consumingPhase of phase.consumingPhases) {
          if (this._action.selectedPhases.has(consumingPhase)) {
            // Set all tasks in a dependency phase as dependencies of the consuming phase to ensure the dependency
            // tasks run first
            const consumingPhaseOperation: Operation = _getOrCreatePhaseOperation(
              internalHeftSession,
              consumingPhase,
              operations
            );
            consumingPhaseOperation.addDependency(taskOperation);
            // This is purely to simplify the reported graph for phase circularities
            consumingPhaseOperation.addDependency(phaseOperation);
          }
        }
      }
    }

    return new Set(operations.values());
  }
}

function _getOrCreatePhaseOperation(
  this: void,
  internalHeftSession: InternalHeftSession,
  phase: HeftPhase,
  operations: Map<string, Operation>
): Operation {
  const key: string = phase.phaseName;

  let operation: Operation | undefined = operations.get(key);
  if (!operation) {
    // Only create the operation. Dependencies are hooked up separately
    operation = new Operation({
      groupName: phase.phaseName,
      operationName: `${phase.phaseName} phase`,
      runner: new PhaseOperationRunner({ phase, internalHeftSession })
    });
    operations.set(key, operation);
  }
  return operation;
}

function _getOrCreateTaskOperation(
  this: void,
  internalHeftSession: InternalHeftSession,
  task: HeftTask,
  operations: Map<string, Operation>
): Operation {
  const key: string = `${task.parentPhase.phaseName}.${task.taskName}`;

  let operation: Operation | undefined = operations.get(key);
  if (!operation) {
    operation = new Operation({
      groupName: task.parentPhase.phaseName,
      operationName: `${task.taskName} task`,
      runner: new TaskOperationRunner({
        internalHeftSession,
        task
      })
    });
    operations.set(key, operation);
  }
  return operation;
}

async function _startLifecycleAsync(this: void, internalHeftSession: InternalHeftSession): Promise<void> {
  const { clean } = internalHeftSession.parameterManager.defaultParameters;

  // Load and apply the lifecycle plugins
  const lifecycle: HeftLifecycle = internalHeftSession.lifecycle;
  const { lifecycleLogger } = lifecycle;
  await lifecycle.applyPluginsAsync(lifecycleLogger.terminal);

  if (lifecycleLogger.hasErrors) {
    throw new AlreadyReportedError();
  }

  if (clean) {
    const startTime: number = performance.now();
    lifecycleLogger.terminal.writeVerboseLine('Starting clean');

    // Grab the additional clean operations from the phase
    const deleteOperations: IDeleteOperation[] = [];

    // Delete all temp folders for tasks by default
    for (const pluginDefinition of lifecycle.pluginDefinitions) {
      const lifecycleSession: IHeftLifecycleSession =
        await lifecycle.getSessionForPluginDefinitionAsync(pluginDefinition);
      deleteOperations.push({ sourcePath: lifecycleSession.tempFolderPath });
    }

    // Create the options and provide a utility method to obtain paths to delete
    const cleanHookOptions: IHeftLifecycleCleanHookOptions = {
      addDeleteOperations: (...deleteOperationsToAdd: IDeleteOperation[]) =>
        deleteOperations.push(...deleteOperationsToAdd)
    };

    // Run the plugin clean hook
    if (lifecycle.hooks.clean.isUsed()) {
      try {
        await lifecycle.hooks.clean.promise(cleanHookOptions);
      } catch (e) {
        // Log out using the clean logger, and return an error status
        if (!(e instanceof AlreadyReportedError)) {
          lifecycleLogger.emitError(e as Error);
        }
        throw new AlreadyReportedError();
      }
    }

    // Delete the files if any were specified
    if (deleteOperations.length) {
      const rootFolderPath: string = internalHeftSession.heftConfiguration.buildFolderPath;
      await deleteFilesAsync(rootFolderPath, deleteOperations, lifecycleLogger.terminal);
    }

    lifecycleLogger.terminal.writeVerboseLine(`Finished clean (${performance.now() - startTime}ms)`);

    if (lifecycleLogger.hasErrors) {
      throw new AlreadyReportedError();
    }
  }

  // Run the start hook
  if (lifecycle.hooks.toolStart.isUsed()) {
    const lifecycleToolStartHookOptions: IHeftLifecycleToolStartHookOptions = {};
    await lifecycle.hooks.toolStart.promise(lifecycleToolStartHookOptions);

    if (lifecycleLogger.hasErrors) {
      throw new AlreadyReportedError();
    }
  }
}

async function _finishLifecycleAsync(internalHeftSession: InternalHeftSession): Promise<void> {
  const lifecycleToolFinishHookOptions: IHeftLifecycleToolFinishHookOptions = {};
  await internalHeftSession.lifecycle.hooks.toolFinish.promise(lifecycleToolFinishHookOptions);
}
