// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import {
  CommandLineParser,
  CommandLineStringListParameter,
  CommandLineFlagParameter
} from '@rushstack/ts-command-line';
import {
  Terminal,
  InternalError,
  ConsoleTerminalProvider,
  AlreadyReportedError,
  Path,
  FileSystem
} from '@rushstack/node-core-library';
import { ArgumentParser } from 'argparse';
import { SyncHook } from 'tapable';

import { MetricsCollector } from '../metrics/MetricsCollector';
import { CleanAction } from './actions/CleanAction';
import { BuildAction } from './actions/BuildAction';
import { StartAction } from './actions/StartAction';
import { TestAction } from './actions/TestAction';
import { PluginManager } from '../pluginFramework/PluginManager';
import { HeftConfiguration } from '../configuration/HeftConfiguration';
import { IHeftActionBaseOptions, IStages } from './actions/HeftActionBase';
import { InternalHeftSession } from '../pluginFramework/InternalHeftSession';
import { CleanStage } from '../stages/CleanStage';
import { BuildStage } from '../stages/BuildStage';
import { TestStage } from '../stages/TestStage';
import { LoggingManager } from '../pluginFramework/logging/LoggingManager';
import { ICustomActionOptions, CustomAction } from './actions/CustomAction';
import { Constants } from '../utilities/Constants';
import { IHeftLifecycle, HeftLifecycleHooks } from '../pluginFramework/HeftLifecycle';

/**
 * This interfaces specifies values for parameters that must be parsed before the CLI
 * is fully initialized.
 */
interface IPreInitializationArgumentValues {
  plugins?: string[];
  debug?: boolean;
  trace?: boolean;
}

export class HeftToolsCommandLineParser extends CommandLineParser {
  private _terminalProvider: ConsoleTerminalProvider;
  private _terminal: Terminal;
  private _loggingManager: LoggingManager;
  private _metricsCollector: MetricsCollector;
  private _pluginManager: PluginManager;
  private _heftConfiguration: HeftConfiguration;
  private _internalHeftSession: InternalHeftSession;
  private _heftLifecycleHook: SyncHook<IHeftLifecycle>;

  private _preInitializationArgumentValues: IPreInitializationArgumentValues;

  private _unmanagedFlag!: CommandLineFlagParameter;
  private _debugFlag!: CommandLineFlagParameter;
  private _traceFlag!: CommandLineFlagParameter;
  private _pluginsParameter!: CommandLineStringListParameter;

  public get isDebug(): boolean {
    return !!this._preInitializationArgumentValues.debug;
  }

  public get enableTrace(): boolean {
    return !!this._preInitializationArgumentValues.trace;
  }

  public get terminal(): Terminal {
    return this._terminal;
  }

  public constructor() {
    super({
      toolFilename: 'heft',
      toolDescription: 'Heft is a pluggable build system designed for web projects.'
    });

    this._preInitializationArgumentValues = this._getPreInitializationArgumentValues();

    this._terminalProvider = new ConsoleTerminalProvider();
    this._terminal = new Terminal(this._terminalProvider);
    this._metricsCollector = new MetricsCollector();
    this._loggingManager = new LoggingManager({
      terminalProvider: this._terminalProvider
    });

    if (this.isDebug) {
      this._loggingManager.enablePrintStacks();
      InternalError.breakInDebugger = true;
    }

    this._heftConfiguration = HeftConfiguration.initialize({
      cwd: process.cwd(),
      terminalProvider: this._terminalProvider
    });

    const stages: IStages = {
      buildStage: new BuildStage(this._heftConfiguration, this._loggingManager),
      cleanStage: new CleanStage(this._heftConfiguration, this._loggingManager),
      testStage: new TestStage(this._heftConfiguration, this._loggingManager)
    };
    const actionOptions: IHeftActionBaseOptions = {
      terminal: this._terminal,
      loggingManager: this._loggingManager,
      metricsCollector: this._metricsCollector,
      heftConfiguration: this._heftConfiguration,
      stages
    };

    this._heftLifecycleHook = new SyncHook<IHeftLifecycle>(['heftLifecycle']);
    this._internalHeftSession = new InternalHeftSession({
      getIsDebugMode: () => this.isDebug,
      ...stages,
      heftLifecycleHook: this._heftLifecycleHook,
      loggingManager: this._loggingManager,
      metricsCollector: this._metricsCollector,
      registerAction: <TParameters>(options: ICustomActionOptions<TParameters>) => {
        const action: CustomAction<TParameters> = new CustomAction(options, actionOptions);
        this.addAction(action);
      }
    });

    this._pluginManager = new PluginManager({
      terminal: this._terminal,
      heftConfiguration: this._heftConfiguration,
      internalHeftSession: this._internalHeftSession
    });

    const cleanAction: CleanAction = new CleanAction(actionOptions);
    const buildAction: BuildAction = new BuildAction(actionOptions);
    const startAction: StartAction = new StartAction(actionOptions);
    const testAction: TestAction = new TestAction(actionOptions);

    this.addAction(cleanAction);
    this.addAction(buildAction);
    this.addAction(startAction);
    this.addAction(testAction);
  }

  protected onDefineParameters(): void {
    this._unmanagedFlag = this.defineFlagParameter({
      parameterLongName: '--unmanaged',
      description:
        'Disables the Heft version selector: When Heft is invoked via the shell path, normally it' +
        " will examine the project's package.json dependencies and try to use the locally installed version" +
        ' of Heft. Specify "--unmanaged" to force the invoked version of Heft to be used. This is useful for' +
        ' example if you want to test a different version of Heft.'
    });

    this._debugFlag = this.defineFlagParameter({
      parameterLongName: Constants.debugParameterLongName,
      description: 'Show the full call stack if an error occurs while executing the tool'
    });

    this._traceFlag = this.defineFlagParameter({
      parameterLongName: Constants.traceParameterLongName,
      description: 'Generate a timeline trace in the Chrome Trace Events format in the working directory'
    });

    this._pluginsParameter = this.defineStringListParameter({
      parameterLongName: Constants.pluginParameterLongName,
      argumentName: 'PATH',
      description: 'Used to specify Heft plugins.'
    });
  }

  public async execute(args?: string[]): Promise<boolean> {
    // Defensively set the exit code to 1 so if the tool crashes for whatever reason, we'll have a nonzero exit code.
    process.exitCode = 1;

    this._terminalProvider.verboseEnabled = this.isDebug;

    try {
      this._normalizeCwd();

      await this._checkForUpgradeAsync();

      await this._heftConfiguration._checkForRigAsync();

      if (this._heftConfiguration.rigConfig.rigFound) {
        const rigProfileFolder: string = await this._heftConfiguration.rigConfig.getResolvedProfileFolderAsync();
        const relativeRigFolderPath: string = Path.formatConcisely({
          pathToConvert: rigProfileFolder,
          baseFolder: this._heftConfiguration.buildFolder
        });
        this._terminal.writeLine(`Using rig configuration from ${relativeRigFolderPath}`);
      }

      await this._initializePluginsAsync();

      const heftLifecycle: IHeftLifecycle = {
        hooks: new HeftLifecycleHooks()
      };
      this._heftLifecycleHook.call(heftLifecycle);

      await heftLifecycle.hooks.toolStart.promise();

      return await super.execute(args);
    } catch (e) {
      await this._reportErrorAndSetExitCode(e);
      return false;
    }
  }

  private async _checkForUpgradeAsync(): Promise<void> {
    // The .heft/clean.json file is a fairly reliable heuristic for detecting projects created prior to
    // the big config file redesign with Heft 0.14.0
    if (await FileSystem.existsAsync('.heft/clean.json')) {
      this._terminal.writeErrorLine(
        '\nThis project has a ".heft/clean.json" file, which is now obsolete as of Heft 0.14.0.'
      );
      this._terminal.writeLine(
        '\nFor instructions for migrating config files, please read UPGRADING.md in the @rushstack/heft package folder.\n'
      );
      throw new AlreadyReportedError();
    }
  }

  protected async onExecute(): Promise<void> {
    try {
      await super.onExecute();
      await this._metricsCollector.flushAndTeardownAsync();
    } catch (e) {
      await this._reportErrorAndSetExitCode(e);
    }

    // If we make it here, things are fine and reset the exit code back to 0
    process.exitCode = 0;
  }

  private _normalizeCwd(): void {
    const buildFolder: string = this._heftConfiguration.buildFolder;
    this._terminal.writeLine(`Project build folder is "${buildFolder}"`);
    const currentCwd: string = process.cwd();
    if (currentCwd !== buildFolder) {
      // Update the CWD to the project's build root. Some tools, like Jest, use process.cwd()
      this._terminal.writeVerboseLine(`CWD is "${currentCwd}". Normalizing to project build folder.`);
      process.chdir(buildFolder);
    }
  }

  private _getPreInitializationArgumentValues(
    args: string[] = process.argv
  ): IPreInitializationArgumentValues {
    // This is a rough parsing of the --plugin parameters
    const parser: ArgumentParser = new ArgumentParser({ addHelp: false });
    parser.addArgument(this._pluginsParameter.longName, { dest: 'plugins', action: 'append' });
    parser.addArgument(this._debugFlag.longName, { dest: 'debug', action: 'storeTrue' });
    parser.addArgument(this._traceFlag.longName, { dest: 'trace', action: 'storeTrue' });

    const [result]: IPreInitializationArgumentValues[] = parser.parseKnownArgs(args);
    return result;
  }

  private async _initializePluginsAsync(): Promise<void> {
    if (this.enableTrace) {
      await this._pluginManager.initializeTracingPluginAsync();
    }

    await this._pluginManager.initializeDefaultPluginsAsync();

    await this._pluginManager.initializePluginsFromConfigFileAsync();

    const pluginSpecifiers: string[] = this._preInitializationArgumentValues.plugins || [];
    for (const pluginSpecifier of pluginSpecifiers) {
      this._pluginManager.initializePlugin(pluginSpecifier);
    }

    this._pluginManager.afterInitializeAllPlugins();
  }

  private async _reportErrorAndSetExitCode(error: Error): Promise<void> {
    if (!(error instanceof AlreadyReportedError)) {
      this._terminal.writeErrorLine(error.toString());
    }

    if (this.isDebug) {
      this._terminal.writeLine();
      this._terminal.writeErrorLine(error.stack!);
    }

    await this._metricsCollector.flushAndTeardownAsync();

    if (!process.exitCode || process.exitCode > 0) {
      process.exit(process.exitCode);
    } else {
      process.exit(1);
    }
  }
}
