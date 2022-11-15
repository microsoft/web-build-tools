// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { ArgumentParser } from 'argparse';
import { CommandLineParser, type CommandLineFlagParameter } from '@rushstack/ts-command-line';
import {
  Terminal,
  InternalError,
  ConsoleTerminalProvider,
  AlreadyReportedError,
  type ITerminal
} from '@rushstack/node-core-library';

import { MetricsCollector } from '../metrics/MetricsCollector';
import { HeftConfiguration } from '../configuration/HeftConfiguration';
import { InternalHeftSession } from '../pluginFramework/InternalHeftSession';
import { LoggingManager } from '../pluginFramework/logging/LoggingManager';
import { Constants } from '../utilities/Constants';
import { PhaseAction } from './actions/PhaseAction';
import { RunAction } from './actions/RunAction';
import type { IHeftActionOptions } from './actions/IHeftAction';

/**
 * This interfaces specifies values for parameters that must be parsed before the CLI
 * is fully initialized.
 */
interface IPreInitializationArgumentValues {
  debug?: boolean;
  unmanaged?: boolean;
}

export class HeftCommandLineParser extends CommandLineParser {
  public readonly globalTerminal: ITerminal;

  private readonly _debugFlag: CommandLineFlagParameter;
  private readonly _unmanagedFlag: CommandLineFlagParameter;
  private readonly _debug: boolean;
  private readonly _terminalProvider: ConsoleTerminalProvider;
  private readonly _loggingManager: LoggingManager;
  private readonly _metricsCollector: MetricsCollector;
  private readonly _heftConfiguration: HeftConfiguration;

  public constructor() {
    super({
      toolFilename: 'heft',
      toolDescription: 'Heft is a pluggable build system designed for web projects.'
    });

    // Initialize the debug flag as a parameter on the tool itself
    this._debugFlag = this.defineFlagParameter({
      parameterLongName: Constants.debugParameterLongName,
      description: 'Show the full call stack if an error occurs while executing the tool'
    });

    // Initialize the unmanaged flag as a parameter on the tool itself. While this parameter
    // is only used during version selection, we need to support parsing it here so that we
    // don't throw due to an unrecognized parameter.
    this._unmanagedFlag = this.defineFlagParameter({
      parameterLongName: Constants.unmanagedParameterLongName,
      description:
        'Disables the Heft version selector: When Heft is invoked via the shell path, normally it' +
        " will examine the project's package.json dependencies and try to use the locally installed version" +
        ' of Heft. Specify "--unmanaged" to force the invoked version of Heft to be used. This is useful for' +
        ' example if you want to test a different version of Heft.'
    });

    // Pre-initialize with known argument values to determine state of "--debug"
    const preInitializationArgumentValues: IPreInitializationArgumentValues =
      this._getPreInitializationArgumentValues();
    this._debug = !!preInitializationArgumentValues.debug;

    // Enable debug and verbose logging if the "--debug" flag is set
    this._terminalProvider = new ConsoleTerminalProvider({
      debugEnabled: this._debug,
      verboseEnabled: this._debug
    });
    this.globalTerminal = new Terminal(this._terminalProvider);
    this._loggingManager = new LoggingManager({ terminalProvider: this._terminalProvider });
    if (this._debug) {
      // Enable printing stacktraces if the "--debug" flag is set
      this._loggingManager.enablePrintStacks();
      InternalError.breakInDebugger = true;
    }

    this._heftConfiguration = HeftConfiguration.initialize({
      cwd: process.cwd(),
      terminalProvider: this._terminalProvider
    });

    this._metricsCollector = new MetricsCollector();
  }

  public async execute(args?: string[]): Promise<boolean> {
    // Defensively set the exit code to 1 so if the tool crashes for whatever reason,
    // we'll have a nonzero exit code.
    process.exitCode = 1;

    try {
      this._normalizeCwd();

      const internalHeftSession: InternalHeftSession = await InternalHeftSession.initializeAsync({
        debug: this._debug,
        heftConfiguration: this._heftConfiguration,
        loggingManager: this._loggingManager,
        metricsCollector: this._metricsCollector
      });

      const actionOptions: IHeftActionOptions = {
        internalHeftSession: internalHeftSession,
        terminal: this.globalTerminal,
        loggingManager: this._loggingManager,
        metricsCollector: this._metricsCollector,
        heftConfiguration: this._heftConfiguration
      };

      // Add the run action and the individual phase actions
      this.addAction(new RunAction(actionOptions));
      for (const phase of internalHeftSession.phases) {
        this.addAction(new PhaseAction({ ...actionOptions, phase }));
      }

      // Add the watch variant of the run action and the individual phase actions
      this.addAction(new RunAction({ ...actionOptions, watch: true }));
      for (const phase of internalHeftSession.phases) {
        this.addAction(new PhaseAction({ ...actionOptions, phase, watch: true }));
      }

      return await super.execute(args);
    } catch (e) {
      await this._reportErrorAndSetExitCode(e as Error);
      return false;
    }
  }

  protected async onExecute(): Promise<void> {
    try {
      await super.onExecute();
    } catch (e) {
      await this._reportErrorAndSetExitCode(e as Error);
    }

    // If we make it here, things are fine and reset the exit code back to 0
    process.exitCode = 0;
  }

  private _normalizeCwd(): void {
    const buildFolder: string = this._heftConfiguration.buildFolderPath;
    const currentCwd: string = process.cwd();
    if (currentCwd !== buildFolder) {
      // Update the CWD to the project's build root. Some tools, like Jest, use process.cwd()
      this.globalTerminal.writeVerboseLine(`CWD is "${currentCwd}". Normalizing to "${buildFolder}".`);
      // If `process.cwd()` and `buildFolder` differ only by casing on Windows, the chdir operation will not fix the casing, which is the entire purpose of the exercise.
      // As such, chdir to a different directory first. That directory needs to exist, so use the parent of the current directory.
      // This will not work if the current folder is the drive root, but that is a rather exotic case.
      process.chdir(__dirname);
      process.chdir(buildFolder);
    }
  }

  private _getPreInitializationArgumentValues(
    args: string[] = process.argv
  ): IPreInitializationArgumentValues {
    if (!this._debugFlag) {
      // The `this._debugFlag` parameter (the parameter itself, not its value)
      // has not yet been defined. Parameters need to be defined before we
      // try to evaluate any parameters. This is to ensure that the
      // `--debug` flag is defined correctly before we do this not-so-rigorous
      // parameter parsing.
      throw new InternalError('onDefineParameters() has not yet been called.');
    }

    // This is a rough parsing of the --debug parameter
    const parser: ArgumentParser = new ArgumentParser({ addHelp: false });
    parser.addArgument(this._debugFlag.longName, { dest: 'debug', action: 'storeTrue' });
    parser.addArgument(this._unmanagedFlag.longName, { dest: 'unmanaged', action: 'storeTrue' });

    const [result]: IPreInitializationArgumentValues[] = parser.parseKnownArgs(args);
    return result;
  }

  private async _reportErrorAndSetExitCode(error: Error): Promise<void> {
    if (!(error instanceof AlreadyReportedError)) {
      this.globalTerminal.writeErrorLine(error.toString());
    }

    if (this._debug) {
      this.globalTerminal.writeLine();
      this.globalTerminal.writeErrorLine(error.stack!);
    }

    if (!process.exitCode || process.exitCode > 0) {
      process.exit(process.exitCode);
    } else {
      process.exit(1);
    }
  }
}
