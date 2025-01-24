// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';

import {
  CommandLineParser,
  type CommandLineFlagParameter,
  CommandLineHelper
} from '@rushstack/ts-command-line';
import { InternalError, AlreadyReportedError, Text } from '@rushstack/node-core-library';
import {
  ConsoleTerminalProvider,
  Terminal,
  PrintUtilities,
  Colorize,
  type ITerminal
} from '@rushstack/terminal';

import { RushConfiguration } from '../api/RushConfiguration';
import { RushConstants } from '../logic/RushConstants';
import {
  type Command,
  CommandLineConfiguration,
  type IGlobalCommandConfig,
  type IPhasedCommandConfig
} from '../api/CommandLineConfiguration';

import { AddAction } from './actions/AddAction';
import { AnalyzeTelemetryAction } from './actions/AnalyzeTelemetryAction';
import { ChangeAction } from './actions/ChangeAction';
import { CheckAction } from './actions/CheckAction';
import { DeployAction } from './actions/DeployAction';
import { InitAction } from './actions/InitAction';
import { InitAutoinstallerAction } from './actions/InitAutoinstallerAction';
import { InitDeployAction } from './actions/InitDeployAction';
import { InstallAction } from './actions/InstallAction';
import { LinkAction } from './actions/LinkAction';
import { ListAction } from './actions/ListAction';
import { PublishAction } from './actions/PublishAction';
import { PurgeAction } from './actions/PurgeAction';
import { RemoveAction } from './actions/RemoveAction';
import { ScanAction } from './actions/ScanAction';
import { UnlinkAction } from './actions/UnlinkAction';
import { UpdateAction } from './actions/UpdateAction';
import { UpdateAutoinstallerAction } from './actions/UpdateAutoinstallerAction';
import { VersionAction } from './actions/VersionAction';
import { UpdateCloudCredentialsAction } from './actions/UpdateCloudCredentialsAction';
import { UpgradeInteractiveAction } from './actions/UpgradeInteractiveAction';
import { AlertAction } from './actions/AlertAction';

import { GlobalScriptAction } from './scriptActions/GlobalScriptAction';
import type { IBaseScriptActionOptions } from './scriptActions/BaseScriptAction';

import { Telemetry } from '../logic/Telemetry';
import { RushGlobalFolder } from '../api/RushGlobalFolder';
import { NodeJsCompatibility } from '../logic/NodeJsCompatibility';
import { SetupAction } from './actions/SetupAction';
import { type ICustomCommandLineConfigurationInfo, PluginManager } from '../pluginFramework/PluginManager';
import { RushSession } from '../pluginFramework/RushSession';
import { PhasedScriptAction } from './scriptActions/PhasedScriptAction';
import type { IBuiltInPluginConfiguration } from '../pluginFramework/PluginLoader/BuiltInPluginLoader';
import { InitSubspaceAction } from './actions/InitSubspaceAction';
import { RushAlerts } from '../utilities/RushAlerts';
import { InstallAutoinstallerAction } from './actions/InstallAutoinstallerAction';

/**
 * Options for `RushCommandLineParser`.
 */
export interface IRushCommandLineParserOptions {
  cwd: string; // Defaults to `cwd`
  alreadyReportedNodeTooNewError: boolean;
  builtInPluginConfigurations: IBuiltInPluginConfiguration[];
}

export class RushCommandLineParser extends CommandLineParser {
  public telemetry: Telemetry | undefined;
  public rushGlobalFolder: RushGlobalFolder;
  public readonly rushConfiguration!: RushConfiguration;
  public readonly rushSession: RushSession;
  public readonly pluginManager: PluginManager;

  private readonly _debugParameter: CommandLineFlagParameter;
  private readonly _quietParameter: CommandLineFlagParameter;
  private readonly _restrictConsoleOutput: boolean = RushCommandLineParser.shouldRestrictConsoleOutput();
  private readonly _rushOptions: IRushCommandLineParserOptions;
  private readonly _terminalProvider: ConsoleTerminalProvider;
  private readonly _terminal: Terminal;

  public constructor(options?: Partial<IRushCommandLineParserOptions>) {
    super({
      toolFilename: 'rush',
      toolDescription:
        'Rush makes life easier for JavaScript developers who develop, build, and publish' +
        ' many packages from a central Git repo.  It is designed to handle very large repositories' +
        ' supporting many projects and people.  Rush provides policies, protections, and customizations' +
        ' that help coordinate teams and safely onboard new contributors.  Rush also generates change logs' +
        ' and automates package publishing.  It can manage decoupled subsets of projects with different' +
        ' release and versioning strategies.  A full API is included to facilitate integration with other' +
        ' automation tools.  If you are looking for a proven turnkey solution for monorepo management,' +
        ' Rush is for you.',
      enableTabCompletionAction: true
    });

    this._debugParameter = this.defineFlagParameter({
      parameterLongName: '--debug',
      parameterShortName: '-d',
      description: 'Show the full call stack if an error occurs while executing the tool'
    });

    this._quietParameter = this.defineFlagParameter({
      parameterLongName: '--quiet',
      parameterShortName: '-q',
      description: 'Hide rush startup information'
    });

    this._terminalProvider = new ConsoleTerminalProvider();
    this._terminal = new Terminal(this._terminalProvider);
    this._rushOptions = this._normalizeOptions(options || {});

    try {
      const rushJsonFilename: string | undefined = RushConfiguration.tryFindRushJsonLocation({
        startingFolder: this._rushOptions.cwd,
        showVerbose: !this._restrictConsoleOutput
      });
      if (rushJsonFilename) {
        this.rushConfiguration = RushConfiguration.loadFromConfigurationFile(rushJsonFilename);
      }
    } catch (error) {
      this._reportErrorAndSetExitCode(error as Error);
    }

    NodeJsCompatibility.warnAboutCompatibilityIssues({
      isRushLib: true,
      alreadyReportedNodeTooNewError: this._rushOptions.alreadyReportedNodeTooNewError,
      rushConfiguration: this.rushConfiguration
    });

    this.rushGlobalFolder = new RushGlobalFolder();

    this.rushSession = new RushSession({
      getIsDebugMode: () => this.isDebug,
      terminalProvider: this._terminalProvider
    });
    this.pluginManager = new PluginManager({
      rushSession: this.rushSession,
      rushConfiguration: this.rushConfiguration,
      terminal: this._terminal,
      builtInPluginConfigurations: this._rushOptions.builtInPluginConfigurations,
      restrictConsoleOutput: this._restrictConsoleOutput,
      rushGlobalFolder: this.rushGlobalFolder
    });

    this._populateActions();

    const pluginCommandLineConfigurations: ICustomCommandLineConfigurationInfo[] =
      this.pluginManager.tryGetCustomCommandLineConfigurationInfos();
    for (const { commandLineConfiguration, pluginLoader } of pluginCommandLineConfigurations) {
      try {
        this._addCommandLineConfigActions(commandLineConfiguration);
      } catch (e) {
        this._terminal.writeErrorLine(
          `Error from plugin ${pluginLoader.pluginName} by ${pluginLoader.packageName}: ${(
            e as Error
          ).toString()}`
        );
      }
    }
  }

  public get isDebug(): boolean {
    return this._debugParameter.value;
  }

  public get isQuiet(): boolean {
    return this._quietParameter.value;
  }

  public get terminal(): ITerminal {
    return this._terminal;
  }

  /**
   * Utility to determine if the app should restrict writing to the console.
   */
  public static shouldRestrictConsoleOutput(): boolean {
    if (CommandLineHelper.isTabCompletionActionRequest(process.argv)) {
      return true;
    }

    for (let i: number = 2; i < process.argv.length; i++) {
      const arg: string = process.argv[i];
      if (arg === '-q' || arg === '--quiet' || arg === '--json') {
        return true;
      }
    }

    return false;
  }

  public flushTelemetry(): void {
    this.telemetry?.flush();
  }

  public async executeAsync(args?: string[]): Promise<boolean> {
    // debugParameter will be correctly parsed during super.executeAsync(), so manually parse here.
    this._terminalProvider.verboseEnabled = this._terminalProvider.debugEnabled =
      process.argv.indexOf('--debug') >= 0;

    await this.pluginManager.tryInitializeUnassociatedPluginsAsync();

    return await super.executeAsync(args);
  }

  protected async onExecute(): Promise<void> {
    // Defensively set the exit code to 1 so if Rush crashes for whatever reason, we'll have a nonzero exit code.
    // For example, Node.js currently has the inexcusable design of terminating with zero exit code when
    // there is an uncaught promise exception.  This will supposedly be fixed in Node.js 9.
    // Ideally we should do this for all the Rush actions, but "rush build" is the most critical one
    // -- if it falsely appears to succeed, we could merge bad PRs, publish empty packages, etc.
    process.exitCode = 1;

    if (this._debugParameter.value) {
      InternalError.breakInDebugger = true;
    }

    try {
      await this._wrapOnExecuteAsync();

      // TODO: rushConfiguration is typed as "!: RushConfiguration" here, but can sometimes be undefined
      if (this.rushConfiguration) {
        try {
          const { configuration: experiments } = this.rushConfiguration.experimentsConfiguration;

          if (experiments.rushAlerts) {
            // TODO: Fix this
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const actionName: string = (this as any)
              ._getArgumentParser()
              .parseArgs(process.argv.slice(2)).action;

            // only display alerts when certain specific actions are triggered
            if (RushAlerts.alertTriggerActions.includes(actionName)) {
              this._terminal.writeDebugLine('Checking Rush alerts...');
              const rushAlerts: RushAlerts = await RushAlerts.loadFromConfigurationAsync(
                this.rushConfiguration,
                this._terminal
              );
              // Print out alerts if have after each successful command actions
              await rushAlerts.printAlertsAsync();
            }
          }
        } catch (error) {
          if (error instanceof AlreadyReportedError) {
            throw error;
          }
          // Generally the RushAlerts implementation should handle its own error reporting; if not,
          // clarify the source, since the Rush Alerts behavior is nondeterministic and may not repro easily:
          this._terminal.writeErrorLine(`\nAn unexpected error was encountered by the Rush alerts feature:`);
          this._terminal.writeErrorLine(error.message);
          throw new AlreadyReportedError();
        }
      }

      // If we make it here, everything went fine, so reset the exit code back to 0
      process.exitCode = 0;
    } catch (error) {
      this._reportErrorAndSetExitCode(error as Error);
    }

    // This only gets hit if the wrapped execution completes successfully
    await this.telemetry?.ensureFlushedAsync();
  }

  private _normalizeOptions(options: Partial<IRushCommandLineParserOptions>): IRushCommandLineParserOptions {
    return {
      cwd: options.cwd || process.cwd(),
      alreadyReportedNodeTooNewError: options.alreadyReportedNodeTooNewError || false,
      builtInPluginConfigurations: options.builtInPluginConfigurations || []
    };
  }

  private async _wrapOnExecuteAsync(): Promise<void> {
    if (this.rushConfiguration) {
      this.telemetry = new Telemetry(this.rushConfiguration, this.rushSession);
    }

    try {
      await super.onExecute();
    } finally {
      if (this.telemetry) {
        this.flushTelemetry();
      }
    }
  }

  private _populateActions(): void {
    try {
      // Alphabetical order
      this.addAction(new AddAction(this));
      this.addAction(new AnalyzeTelemetryAction(this));
      this.addAction(new ChangeAction(this));
      this.addAction(new CheckAction(this));
      this.addAction(new DeployAction(this));
      this.addAction(new InitAction(this));
      this.addAction(new InitAutoinstallerAction(this));
      this.addAction(new InitDeployAction(this));
      this.addAction(new InitSubspaceAction(this));
      this.addAction(new InstallAction(this));
      this.addAction(new LinkAction(this));
      this.addAction(new ListAction(this));
      this.addAction(new PublishAction(this));
      this.addAction(new PurgeAction(this));
      this.addAction(new RemoveAction(this));
      this.addAction(new ScanAction(this));
      this.addAction(new SetupAction(this));
      this.addAction(new UnlinkAction(this));
      this.addAction(new UpdateAction(this));
      this.addAction(new InstallAutoinstallerAction(this));
      this.addAction(new UpdateAutoinstallerAction(this));
      this.addAction(new UpdateCloudCredentialsAction(this));
      this.addAction(new UpgradeInteractiveAction(this));
      this.addAction(new VersionAction(this));
      this.addAction(new AlertAction(this));

      this._populateScriptActions();
    } catch (error) {
      this._reportErrorAndSetExitCode(error as Error);
    }
  }

  private _populateScriptActions(): void {
    // If there is not a rush.json file, we still want "build" and "rebuild" to appear in the
    // command-line help
    let commandLineConfigFilePath: string | undefined;
    if (this.rushConfiguration) {
      commandLineConfigFilePath = path.join(
        this.rushConfiguration.commonRushConfigFolder,
        RushConstants.commandLineFilename
      );
    }

    const commandLineConfiguration: CommandLineConfiguration =
      CommandLineConfiguration.loadFromFileOrDefault(commandLineConfigFilePath);
    this._addCommandLineConfigActions(commandLineConfiguration);
  }

  private _addCommandLineConfigActions(commandLineConfiguration: CommandLineConfiguration): void {
    // Register each custom command
    for (const command of commandLineConfiguration.commands.values()) {
      this._addCommandLineConfigAction(commandLineConfiguration, command);
    }
  }

  private _addCommandLineConfigAction(
    commandLineConfiguration: CommandLineConfiguration,
    command: Command
  ): void {
    if (this.tryGetAction(command.name)) {
      throw new Error(
        `${RushConstants.commandLineFilename} defines a command "${command.name}"` +
          ` using a name that already exists`
      );
    }

    switch (command.commandKind) {
      case RushConstants.globalCommandKind: {
        this._addGlobalScriptAction(commandLineConfiguration, command);
        break;
      }

      case RushConstants.phasedCommandKind: {
        this._addPhasedCommandLineConfigAction(commandLineConfiguration, command);
        break;
      }

      default:
        throw new Error(
          `${RushConstants.commandLineFilename} defines a command "${(command as Command).name}"` +
            ` using an unsupported command kind "${(command as Command).commandKind}"`
        );
    }
  }

  private _getSharedCommandActionOptions<TCommand extends Command>(
    commandLineConfiguration: CommandLineConfiguration,
    command: TCommand
  ): IBaseScriptActionOptions<TCommand> {
    return {
      actionName: command.name,
      summary: command.summary,
      documentation: command.description || command.summary,
      safeForSimultaneousRushProcesses: command.safeForSimultaneousRushProcesses,

      command,
      parser: this,
      commandLineConfiguration: commandLineConfiguration
    };
  }

  private _addGlobalScriptAction(
    commandLineConfiguration: CommandLineConfiguration,
    command: IGlobalCommandConfig
  ): void {
    if (
      command.name === RushConstants.buildCommandName ||
      command.name === RushConstants.rebuildCommandName
    ) {
      throw new Error(
        `${RushConstants.commandLineFilename} defines a command "${command.name}" using ` +
          `the command kind "${RushConstants.globalCommandKind}". This command can only be designated as a command ` +
          `kind "${RushConstants.bulkCommandKind}" or "${RushConstants.phasedCommandKind}".`
      );
    }

    const sharedCommandOptions: IBaseScriptActionOptions<IGlobalCommandConfig> =
      this._getSharedCommandActionOptions(commandLineConfiguration, command);

    this.addAction(
      new GlobalScriptAction({
        ...sharedCommandOptions,

        shellCommand: command.shellCommand,
        autoinstallerName: command.autoinstallerName
      })
    );
  }

  private _addPhasedCommandLineConfigAction(
    commandLineConfiguration: CommandLineConfiguration,
    command: IPhasedCommandConfig
  ): void {
    const baseCommandOptions: IBaseScriptActionOptions<IPhasedCommandConfig> =
      this._getSharedCommandActionOptions(commandLineConfiguration, command);

    this.addAction(
      new PhasedScriptAction({
        ...baseCommandOptions,

        enableParallelism: command.enableParallelism,
        incremental: command.incremental || false,
        disableBuildCache: command.disableBuildCache || false,

        initialPhases: command.phases,
        originalPhases: command.originalPhases,
        watchPhases: command.watchPhases,
        watchDebounceMs: command.watchDebounceMs ?? RushConstants.defaultWatchDebounceMs,
        phases: commandLineConfiguration.phases,

        alwaysWatch: command.alwaysWatch,
        alwaysInstall: command.alwaysInstall
      })
    );
  }

  private _reportErrorAndSetExitCode(error: Error): void {
    if (!(error instanceof AlreadyReportedError)) {
      const prefix: string = 'ERROR: ';

      // The colors package will eat multi-newlines, which could break formatting
      // in user-specified messages and instructions, so we prefer to color each
      // line individually.
      const message: string = Text.splitByNewLines(PrintUtilities.wrapWords(prefix + error.message))
        .map((line) => Colorize.red(line))
        .join('\n');
      // eslint-disable-next-line no-console
      console.error(`\n${message}`);
    }

    if (this._debugParameter.value) {
      // If catchSyncErrors() called this, then show a call stack similar to what Node.js
      // would show for an uncaught error
      // eslint-disable-next-line no-console
      console.error(`\n${error.stack}`);
    }

    this.flushTelemetry();

    const handleExit = (): never => {
      // Ideally we want to eliminate all calls to process.exit() from our code, and replace them
      // with normal control flow that properly cleans up its data structures.
      // For this particular call, we have a problem that the RushCommandLineParser constructor
      // performs nontrivial work that can throw an exception.  Either the Rush class would need
      // to handle reporting for those exceptions, or else _populateActions() should be moved
      // to a RushCommandLineParser lifecycle stage that can handle it.
      if (process.exitCode !== undefined) {
        process.exit(process.exitCode);
      } else {
        process.exit(1);
      }
    };

    if (this.telemetry && this.rushSession.hooks.flushTelemetry.isUsed()) {
      this.telemetry.ensureFlushedAsync().then(handleExit).catch(handleExit);
    } else {
      handleExit();
    }
  }
}
