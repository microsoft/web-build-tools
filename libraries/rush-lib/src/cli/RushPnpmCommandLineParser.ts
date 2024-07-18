// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import {
  AlreadyReportedError,
  EnvironmentMap,
  FileConstants,
  FileSystem,
  JsonFile,
  type JsonObject
} from '@rushstack/node-core-library';
import {
  Colorize,
  ConsoleTerminalProvider,
  type ITerminal,
  type ITerminalProvider,
  Terminal
} from '@rushstack/terminal';

import { RushConfiguration } from '../api/RushConfiguration';
import { NodeJsCompatibility } from '../logic/NodeJsCompatibility';
import { PrintUtilities } from '@rushstack/terminal';
import { RushConstants } from '../logic/RushConstants';
import { RushGlobalFolder } from '../api/RushGlobalFolder';
import { PurgeManager } from '../logic/PurgeManager';

import type { IBuiltInPluginConfiguration } from '../pluginFramework/PluginLoader/BuiltInPluginLoader';
import type { BaseInstallManager } from '../logic/base/BaseInstallManager';
import type { IInstallManagerOptions } from '../logic/base/BaseInstallManagerTypes';
import { Utilities } from '../utilities/Utilities';
import type { Subspace } from '../api/Subspace';

const RUSH_SKIP_CHECKS_PARAMETER: string = '--rush-skip-checks';

/**
 * Options for RushPnpmCommandLineParser
 */
export interface IRushPnpmCommandLineParserOptions {
  alreadyReportedNodeTooNewError?: boolean;
  builtInPluginConfigurations?: IBuiltInPluginConfiguration[];
  terminalProvider?: ITerminalProvider;
}

function _reportErrorAndSetExitCode(error: Error, terminal: ITerminal, debugEnabled: boolean): never {
  if (!(error instanceof AlreadyReportedError)) {
    const prefix: string = 'ERROR: ';
    terminal.writeErrorLine('\n' + PrintUtilities.wrapWords(prefix + error.message));
  }

  if (debugEnabled) {
    // If catchSyncErrors() called this, then show a call stack similar to what Node.js
    // would show for an uncaught error
    terminal.writeErrorLine('\n' + error.stack);
  }

  process.exit(process.exitCode ?? 1);
}

export class RushPnpmCommandLineParser {
  private readonly _terminal: ITerminal;
  private readonly _rushConfiguration: RushConfiguration;
  private readonly _pnpmArgs: string[];
  private _commandName: string | undefined;
  private readonly _debugEnabled: boolean;
  private _subspace: Subspace;

  private constructor(
    options: IRushPnpmCommandLineParserOptions,
    terminal: ITerminal,
    debugEnabled: boolean
  ) {
    this._debugEnabled = debugEnabled;

    this._terminal = terminal;

    // Are we in a Rush repo?
    const rushConfiguration: RushConfiguration | undefined = RushConfiguration.tryLoadFromDefaultLocation({
      // showVerbose is false because the logging message may break JSON output
      showVerbose: false
    });
    NodeJsCompatibility.warnAboutCompatibilityIssues({
      isRushLib: true,
      alreadyReportedNodeTooNewError: !!options.alreadyReportedNodeTooNewError,
      rushConfiguration
    });

    if (!rushConfiguration) {
      throw new Error(
        'The "rush-pnpm" command must be executed in a folder that is under a Rush workspace folder'
      );
    }
    this._rushConfiguration = rushConfiguration;

    if (rushConfiguration.packageManager !== 'pnpm') {
      throw new Error(
        `The "rush-pnpm" command requires your ${RushConstants.rushJsonFilename} to be configured to use the PNPM package manager`
      );
    }

    if (!rushConfiguration.pnpmOptions.useWorkspaces) {
      const pnpmConfigFilename: string =
        rushConfiguration.pnpmOptions.jsonFilename || RushConstants.rushJsonFilename;
      throw new Error(
        `The "rush-pnpm" command requires the "useWorkspaces" setting to be enabled in ${pnpmConfigFilename}`
      );
    }

    let pnpmArgs: string[] = [];
    let subspaceName: string = 'default';

    if (process.argv.indexOf('--subspace') >= 0) {
      if (process.argv[2] !== '--subspace') {
        throw new Error(
          'If you want to specify a subspace, you should place "--subspace <subspace_name>" immediately after the "rush-pnpm" command'
        );
      }

      subspaceName = process.argv[3];

      // 0 = node.exe
      // 1 = rush-pnpm
      // 2 = --subspace
      // 3 = <subspace_name>
      pnpmArgs = process.argv.slice(4);
    } else {
      // 0 = node.exe
      // 1 = rush-pnpm
      pnpmArgs = process.argv.slice(2);
    }

    this._pnpmArgs = pnpmArgs;

    const subspace: Subspace = rushConfiguration.getSubspace(subspaceName);
    this._subspace = subspace;

    const workspaceFolder: string = subspace.getSubspaceTempFolder();
    const workspaceFilePath: string = `${workspaceFolder}/pnpm-workspace.yaml`;

    if (!FileSystem.exists(workspaceFilePath)) {
      this._terminal.writeErrorLine('Error: The PNPM workspace file has not been generated:');
      this._terminal.writeErrorLine(`  ${workspaceFilePath}\n`);
      this._terminal.writeLine(Colorize.cyan(`Do you need to run "rush install" or "rush update"?`));
      throw new AlreadyReportedError();
    }

    if (!FileSystem.exists(rushConfiguration.packageManagerToolFilename)) {
      this._terminal.writeErrorLine('Error: The PNPM local binary has not been installed yet.');
      this._terminal.writeLine('\n' + Colorize.cyan(`Do you need to run "rush install" or "rush update"?`));
      throw new AlreadyReportedError();
    }
  }

  public static async initializeAsync(
    options: IRushPnpmCommandLineParserOptions
  ): Promise<RushPnpmCommandLineParser> {
    const debugEnabled: boolean = process.argv.indexOf('--debug') >= 0;
    const verboseEnabled: boolean = process.argv.indexOf('--verbose') >= 0;
    const localTerminalProvider: ITerminalProvider =
      options.terminalProvider ??
      new ConsoleTerminalProvider({
        debugEnabled,
        verboseEnabled
      });
    const terminal: ITerminal = new Terminal(localTerminalProvider);

    try {
      const rushPnpmCommandLineParser: RushPnpmCommandLineParser = new RushPnpmCommandLineParser(
        options,
        terminal,
        debugEnabled
      );
      await rushPnpmCommandLineParser._validatePnpmUsageAsync(rushPnpmCommandLineParser._pnpmArgs);
      return rushPnpmCommandLineParser;
    } catch (error) {
      _reportErrorAndSetExitCode(error as Error, terminal, debugEnabled);
    }
  }

  public async executeAsync(): Promise<void> {
    // Node.js can sometimes accidentally terminate with a zero exit code  (e.g. for an uncaught
    // promise exception), so we start with the assumption that the exit code is 1
    // and set it to 0 only on success.
    process.exitCode = 1;
    await this._executeAsync();

    if (process.exitCode === 0) {
      await this._postExecuteAsync();
    }
  }

  private async _validatePnpmUsageAsync(pnpmArgs: string[]): Promise<void> {
    if (pnpmArgs[0] === RUSH_SKIP_CHECKS_PARAMETER) {
      pnpmArgs.shift();
      // Ignore other checks
      return;
    }

    if (pnpmArgs.length === 0) {
      return;
    }
    const firstArg: string = pnpmArgs[0];

    // Detect common safe invocations
    if (pnpmArgs.includes('-h') || pnpmArgs.includes('--help') || pnpmArgs.includes('-?')) {
      return;
    }

    if (pnpmArgs.length === 1) {
      if (firstArg === '-v' || firstArg === '--version') {
        return;
      }
    }

    const BYPASS_NOTICE: string = `To bypass this check, add "${RUSH_SKIP_CHECKS_PARAMETER}" as the very first command line option.`;

    if (!/^[a-z]+([a-z0-9\-])*$/.test(firstArg)) {
      // We can't parse this CLI syntax
      this._terminal.writeErrorLine(
        `Warning: The "rush-pnpm" wrapper expects a command verb before "${firstArg}"\n`
      );
      this._terminal.writeLine(Colorize.cyan(BYPASS_NOTICE));
      throw new AlreadyReportedError();
    } else {
      const commandName: string = firstArg;

      // Also accept SKIP_RUSH_CHECKS_PARAMETER immediately after the command verb
      if (pnpmArgs[1] === RUSH_SKIP_CHECKS_PARAMETER) {
        pnpmArgs.splice(1, 1);
        return;
      }

      if (pnpmArgs.indexOf(RUSH_SKIP_CHECKS_PARAMETER) >= 0) {
        // We do not attempt to parse PNPM's complete CLI syntax, so we cannot be sure how to interpret
        // strings that appear outside of the specific patterns that this parser recognizes
        this._terminal.writeErrorLine(
          PrintUtilities.wrapWords(
            `Error: The "${RUSH_SKIP_CHECKS_PARAMETER}" option must be the first parameter for the "rush-pnpm" command.`
          )
        );
        throw new AlreadyReportedError();
      }

      this._commandName = commandName;

      // Warn about commands known not to work
      /* eslint-disable no-fallthrough */
      switch (commandName) {
        // Blocked
        case 'import': {
          this._terminal.writeErrorLine(
            PrintUtilities.wrapWords(
              `Error: The "pnpm ${commandName}" command is known to be incompatible with Rush's environment.`
            ) + '\n'
          );
          this._terminal.writeLine(Colorize.cyan(BYPASS_NOTICE));
          throw new AlreadyReportedError();
        }

        // Show warning for install commands
        case 'add':
        case 'install':
        /* synonym */
        case 'i':
        case 'install-test':
        /* synonym */
        case 'it': {
          this._terminal.writeErrorLine(
            PrintUtilities.wrapWords(
              `Error: The "pnpm ${commandName}" command is incompatible with Rush's environment.` +
                ` Use the "rush install" or "rush update" commands instead.`
            ) + '\n'
          );
          this._terminal.writeLine(Colorize.cyan(BYPASS_NOTICE));
          throw new AlreadyReportedError();
        }

        // Show warning
        case 'link':
        /* synonym */
        case 'ln':
        case 'remove':
        /* synonym */
        case 'rm':
        case 'unlink':
        case 'update':
        /* synonym */
        case 'up': {
          this._terminal.writeWarningLine(
            PrintUtilities.wrapWords(
              `Warning: The "pnpm ${commandName}" command makes changes that may invalidate Rush's workspace state.`
            ) + '\n'
          );
          this._terminal.writeWarningLine(
            `==> Consider running "rush install" or "rush update" afterwards.\n`
          );
          break;
        }

        // Know safe after validation
        case 'patch': {
          const semver: typeof import('semver') = await import('semver');
          /**
           * If you were to accidentally attempt to use rush-pnpm patch with a pnpmVersion < 7.4.0, pnpm patch may fallback to the system patch command.
           * For instance, /usr/bin/patch which may just hangs forever
           * So, erroring out the command if the pnpm version is < 7.4.0
           */
          if (semver.lt(this._rushConfiguration.packageManagerToolVersion, '7.4.0')) {
            this._terminal.writeErrorLine(
              PrintUtilities.wrapWords(
                `Error: The "pnpm patch" command is added after pnpm@7.4.0.` +
                  ` Please update "pnpmVersion" >= 7.4.0 in ${RushConstants.rushJsonFilename} file and run "rush update" to use this command.`
              ) + '\n'
            );
            throw new AlreadyReportedError();
          }
          break;
        }

        case 'patch-commit': {
          if (this._rushConfiguration.rushConfigurationJson.pnpmOptions) {
            const pnpmOptionsJsonFilename: string = `${this._rushConfiguration.commonRushConfigFolder}/${RushConstants.pnpmConfigFilename}`;
            this._terminal.writeErrorLine(
              PrintUtilities.wrapWords(
                `Error: The "pnpm patch-commit" command is incompatible with specifying "pnpmOptions" in ${RushConstants.rushJsonFilename} file.` +
                  ` Please move the content of "pnpmOptions" in ${RushConstants.rushJsonFilename} file to ${pnpmOptionsJsonFilename}`
              ) + '\n'
            );
            throw new AlreadyReportedError();
          }

          // patch-commit internally calls installation under cwd instead of the common/temp folder
          // It throws missing package.json error, so in this case, we need to set the dir to the common/temp folder here
          if (!pnpmArgs.includes('--dir') && !pnpmArgs.includes('-C')) {
            if (!(await FileSystem.existsAsync(`${process.cwd()}/${FileConstants.PackageJson}`))) {
              pnpmArgs.push('--dir');
              pnpmArgs.push(this._rushConfiguration.commonTempFolder);
            }
          }
          break;
        }

        // Known safe
        case 'audit':
        case 'exec':
        case 'list':
        /* synonym */
        case 'ls':
        case 'outdated':
        case 'pack':
        case 'prune':
        case 'publish':
        case 'rebuild':
        /* synonym */
        case 'rb':
        case 'root':
        case 'run':
        case 'start':
        case 'store':
        case 'test':
        /* synonym */
        case 't':
        case 'why': {
          break;
        }

        // Unknown
        default: {
          this._terminal.writeErrorLine(
            PrintUtilities.wrapWords(
              `Error: The "pnpm ${commandName}" command has not been tested with Rush's environment. It may be incompatible.`
            ) + '\n'
          );
          this._terminal.writeLine(Colorize.cyan(BYPASS_NOTICE));
        }
      }
      /* eslint-enable no-fallthrough */
    }
  }

  private async _executeAsync(): Promise<void> {
    const rushConfiguration: RushConfiguration = this._rushConfiguration;
    const workspaceFolder: string = this._subspace.getSubspaceTempFolder();
    const pnpmEnvironmentMap: EnvironmentMap = new EnvironmentMap(process.env);
    pnpmEnvironmentMap.set('NPM_CONFIG_WORKSPACE_DIR', workspaceFolder);

    if (rushConfiguration.pnpmOptions.pnpmStorePath) {
      pnpmEnvironmentMap.set('NPM_CONFIG_STORE_DIR', rushConfiguration.pnpmOptions.pnpmStorePath);
      pnpmEnvironmentMap.set('NPM_CONFIG_CACHE_DIR', rushConfiguration.pnpmOptions.pnpmStorePath);
      pnpmEnvironmentMap.set('NPM_CONFIG_STATE_DIR', rushConfiguration.pnpmOptions.pnpmStorePath);
    }

    if (rushConfiguration.pnpmOptions.environmentVariables) {
      for (const [envKey, { value: envValue, override }] of Object.entries(
        rushConfiguration.pnpmOptions.environmentVariables
      )) {
        if (override) {
          pnpmEnvironmentMap.set(envKey, envValue);
        } else {
          if (undefined === pnpmEnvironmentMap.get(envKey)) {
            pnpmEnvironmentMap.set(envKey, envValue);
          }
        }
      }
    }

    let onStdoutStreamChunk: ((chunk: string) => string | void) | undefined;
    switch (this._commandName) {
      case 'patch': {
        // Replace `pnpm patch-commit` with `rush-pnpm patch-commit` when running
        // `pnpm patch` to avoid the `pnpm patch` command being suggested in the output
        onStdoutStreamChunk = (stdoutChunk: string) => {
          return stdoutChunk.replace(
            /pnpm patch-commit/g,
            `rush-pnpm --subspace ${this._subspace.subspaceName} patch-commit`
          );
        };

        break;
      }
    }

    try {
      const { exitCode } = await Utilities.executeCommandAsync({
        command: rushConfiguration.packageManagerToolFilename,
        args: this._pnpmArgs,
        workingDirectory: process.cwd(),
        environment: pnpmEnvironmentMap.toObject(),
        keepEnvironment: true,
        onStdoutStreamChunk,
        captureExitCodeAndSignal: true
      });

      if (typeof exitCode === 'number') {
        process.exitCode = exitCode;
      } else {
        // If the exit code is not a number, the process was terminated by a signal
        process.exitCode = 1;
      }
    } catch (e) {
      this._terminal.writeDebugLine(`Error: ${e}`);
    }
  }

  private async _postExecuteAsync(): Promise<void> {
    const commandName: string | undefined = this._commandName;
    if (!commandName) {
      return;
    }

    const subspaceTempFolder: string = this._subspace.getSubspaceTempFolder();

    switch (commandName) {
      case 'patch-commit': {
        // Example: "C:\MyRepo\common\temp\package.json"
        const commonPackageJsonFilename: string = `${subspaceTempFolder}/${FileConstants.PackageJson}`;
        const commonPackageJson: JsonObject = await JsonFile.loadAsync(commonPackageJsonFilename);
        const newGlobalPatchedDependencies: Record<string, string> | undefined =
          commonPackageJson?.pnpm?.patchedDependencies;

        const commonTempPnpmPatchesFolder: string = `${subspaceTempFolder}/${RushConstants.pnpmPatchesFolderName}`;
        const rushPnpmPatchesFolder: string = `${this._rushConfiguration.commonFolder}/${RushConstants.pnpmPatchesCommonFolderName}`;
        // Copy (or delete) common\temp\patches\ --> common\pnpm-patches\
        if (await FileSystem.existsAsync(commonTempPnpmPatchesFolder)) {
          await FileSystem.ensureEmptyFolderAsync(rushPnpmPatchesFolder);
          // eslint-disable-next-line no-console
          console.log(`Copying ${commonTempPnpmPatchesFolder}`);
          // eslint-disable-next-line no-console
          console.log(`  --> ${rushPnpmPatchesFolder}`);
          await FileSystem.copyFilesAsync({
            sourcePath: commonTempPnpmPatchesFolder,
            destinationPath: rushPnpmPatchesFolder
          });
        } else {
          if (await FileSystem.existsAsync(rushPnpmPatchesFolder)) {
            // eslint-disable-next-line no-console
            console.log(`Deleting ${rushPnpmPatchesFolder}`);
            await FileSystem.deleteFolderAsync(rushPnpmPatchesFolder);
          }
        }

        // Update patchedDependencies to pnpm configuration file
        this._rushConfiguration.pnpmOptions.updateGlobalPatchedDependencies(newGlobalPatchedDependencies);

        // Rerun installation to update
        await this._doRushUpdateAsync();

        this._terminal.writeWarningLine(
          `Rush refreshed the ${RushConstants.pnpmConfigFilename}, shrinkwrap file and patch files under the ` +
            `"${RushConstants.commonFolderName}/${RushConstants.pnpmPatchesCommonFolderName}" folder.\n` +
            '  Please commit this change to Git.'
        );
        break;
      }
    }
  }

  private async _doRushUpdateAsync(): Promise<void> {
    this._terminal.writeLine();
    this._terminal.writeLine(Colorize.green('Running "rush update"'));
    this._terminal.writeLine();

    const rushGlobalFolder: RushGlobalFolder = new RushGlobalFolder();
    const purgeManager: PurgeManager = new PurgeManager(this._rushConfiguration, rushGlobalFolder);
    const installManagerOptions: IInstallManagerOptions = {
      debug: this._debugEnabled,
      allowShrinkwrapUpdates: true,
      bypassPolicy: false,
      noLink: false,
      fullUpgrade: false,
      recheckShrinkwrap: true,
      networkConcurrency: undefined,
      offline: false,
      collectLogFile: false,
      maxInstallAttempts: RushConstants.defaultMaxInstallAttempts,
      pnpmFilterArgumentValues: [],
      selectedProjects: new Set(this._rushConfiguration.projects),
      checkOnly: false,
      subspace: this._subspace,
      terminal: this._terminal
    };

    const installManagerFactoryModule: typeof import('../logic/InstallManagerFactory') = await import(
      /* webpackChunkName: 'InstallManagerFactory' */
      '../logic/InstallManagerFactory'
    );
    const installManager: BaseInstallManager =
      await installManagerFactoryModule.InstallManagerFactory.getInstallManagerAsync(
        this._rushConfiguration,
        rushGlobalFolder,
        purgeManager,
        installManagerOptions
      );
    try {
      await installManager.doInstallAsync();
    } finally {
      await purgeManager.startDeleteAllAsync();
    }
  }
}
