// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as semver from 'semver';
import {
  FileSystem,
  JsonFile,
  PosixModeBits,
  NewlineKind,
  AlreadyReportedError,
  type FileSystemStats,
  Path,
  type FolderItem,
  Async
} from '@rushstack/node-core-library';
import { existsSync } from 'fs';
import { readFile, unlink } from 'fs/promises';
import { PrintUtilities, Colorize, type ITerminal } from '@rushstack/terminal';
import {
  type ILockfile,
  type ILockfilePackage,
  type ILogMessageCallbackOptions,
  pnpmSyncGetJsonVersion,
  pnpmSyncPrepareAsync
} from 'pnpm-sync-lib';

import { ApprovedPackagesChecker } from '../ApprovedPackagesChecker';
import type { AsyncRecycler } from '../../utilities/AsyncRecycler';
import type { BaseShrinkwrapFile } from './BaseShrinkwrapFile';
import { EnvironmentConfiguration } from '../../api/EnvironmentConfiguration';
import { Git } from '../Git';
import {
  type LastInstallFlag,
  getCommonTempFlag,
  type ILastInstallFlagJson
} from '../../api/LastInstallFlag';
import type { PnpmPackageManager } from '../../api/packageManager/PnpmPackageManager';
import type { PurgeManager } from '../PurgeManager';
import type { ICurrentVariantJson, RushConfiguration } from '../../api/RushConfiguration';
import { Rush } from '../../api/Rush';
import type { RushGlobalFolder } from '../../api/RushGlobalFolder';
import { RushConstants } from '../RushConstants';
import { ShrinkwrapFileFactory } from '../ShrinkwrapFileFactory';
import { Utilities } from '../../utilities/Utilities';
import { InstallHelpers } from '../installManager/InstallHelpers';
import * as PolicyValidator from '../policy/PolicyValidator';
import type { WebClient as WebClientType, IWebClientResponse } from '../../utilities/WebClient';
import { SetupPackageRegistry } from '../setup/SetupPackageRegistry';
import { PnpmfileConfiguration } from '../pnpm/PnpmfileConfiguration';
import type { IInstallManagerOptions } from './BaseInstallManagerTypes';
import { isVariableSetInNpmrcFile } from '../../utilities/npmrcUtilities';
import type { PnpmResolutionMode } from '../pnpm/PnpmOptionsConfiguration';
import { SubspacePnpmfileConfiguration } from '../pnpm/SubspacePnpmfileConfiguration';
import type { Subspace } from '../../api/Subspace';
import { ProjectImpactGraphGenerator } from '../ProjectImpactGraphGenerator';
import { FlagFile } from '../../api/FlagFile';
import { PnpmShrinkwrapFile } from '../pnpm/PnpmShrinkwrapFile';
import { PnpmSyncUtilities } from '../../utilities/PnpmSyncUtilities';

/**
 * Pnpm don't support --ignore-compatibility-db, so use --config.ignoreCompatibilityDb for now.
 */
export const pnpmIgnoreCompatibilityDbParameter: string = '--config.ignoreCompatibilityDb';
const pnpmCacheDirParameter: string = '--config.cacheDir';
const pnpmStateDirParameter: string = '--config.stateDir';

const gitLfsHooks: ReadonlySet<string> = new Set(['post-checkout', 'post-commit', 'post-merge', 'pre-push']);

/**
 * This class implements common logic between "rush install" and "rush update".
 */
export abstract class BaseInstallManager {
  private readonly _commonTempLinkFlag: FlagFile;
  private _npmSetupValidated: boolean = false;
  private _syncNpmrcAlreadyCalled: boolean = false;

  protected readonly _terminal: ITerminal;

  protected readonly rushConfiguration: RushConfiguration;
  protected readonly rushGlobalFolder: RushGlobalFolder;
  protected readonly installRecycler: AsyncRecycler;
  protected readonly options: IInstallManagerOptions;
  // Mapping of subspaceName -> LastInstallFlag
  protected readonly subspaceInstallFlags: Map<string, LastInstallFlag>;

  public constructor(
    rushConfiguration: RushConfiguration,
    rushGlobalFolder: RushGlobalFolder,
    purgeManager: PurgeManager,
    options: IInstallManagerOptions
  ) {
    this._terminal = options.terminal;
    this.rushConfiguration = rushConfiguration;
    this.rushGlobalFolder = rushGlobalFolder;
    this.installRecycler = purgeManager.commonTempFolderRecycler;
    this.options = options;

    this._commonTempLinkFlag = new FlagFile(
      options.subspace.getSubspaceTempFolderPath(),
      RushConstants.lastLinkFlagFilename,
      {}
    );

    this.subspaceInstallFlags = new Map();
    if (rushConfiguration.subspacesFeatureEnabled) {
      for (const subspace of rushConfiguration.subspaces) {
        this.subspaceInstallFlags.set(subspace.subspaceName, getCommonTempFlag(rushConfiguration, subspace));
      }
    }
  }

  public async doInstallAsync(): Promise<void> {
    const { allowShrinkwrapUpdates, selectedProjects, pnpmFilterArgumentValues, resolutionOnly, variant } =
      this.options;
    const isFilteredInstall: boolean = pnpmFilterArgumentValues.length > 0;
    const useWorkspaces: boolean =
      this.rushConfiguration.pnpmOptions && this.rushConfiguration.pnpmOptions.useWorkspaces;
    // Prevent filtered installs when workspaces is disabled
    if (isFilteredInstall && !useWorkspaces) {
      // eslint-disable-next-line no-console
      console.log();
      // eslint-disable-next-line no-console
      console.log(
        Colorize.red(
          'Project filtering arguments can only be used when running in a workspace environment. Run the ' +
            'command again without specifying these arguments.'
        )
      );
      throw new AlreadyReportedError();
    }

    // Prevent update when using a filter, as modifications to the shrinkwrap shouldn't be saved
    if (allowShrinkwrapUpdates && isFilteredInstall) {
      // Allow partial update when there are subspace projects
      if (!this.rushConfiguration.subspacesFeatureEnabled) {
        // eslint-disable-next-line no-console
        console.log();
        // eslint-disable-next-line no-console
        console.log(
          Colorize.red(
            'Project filtering arguments cannot be used when running "rush update". Run the command again ' +
              'without specifying these arguments.'
          )
        );
        throw new AlreadyReportedError();
      }
    }

    const subspace: Subspace = this.options.subspace;

    const projectImpactGraphGenerator: ProjectImpactGraphGenerator | undefined = this.rushConfiguration
      .experimentsConfiguration.configuration.generateProjectImpactGraphDuringRushUpdate
      ? new ProjectImpactGraphGenerator(this._terminal, this.rushConfiguration)
      : undefined;
    const { shrinkwrapIsUpToDate, npmrcHash, projectImpactGraphIsUpToDate, variantIsUpToDate } =
      await this.prepareAsync(subspace, variant, projectImpactGraphGenerator);

    if (this.options.checkOnly) {
      return;
    }

    // eslint-disable-next-line no-console
    console.log('\n' + Colorize.bold(`Checking installation in "${subspace.getSubspaceTempFolderPath()}"`));

    // This marker file indicates that the last "rush install" completed successfully.
    // Always perform a clean install if filter flags were provided. Additionally, if
    // "--purge" was specified, or if the last install was interrupted, then we will
    // need to perform a clean install.  Otherwise, we can do an incremental install.
    const commonTempInstallFlag: LastInstallFlag = getCommonTempFlag(this.rushConfiguration, subspace, {
      npmrcHash: npmrcHash || '<NO NPMRC>'
    });
    if (isFilteredInstall && selectedProjects) {
      const selectedProjectNames: string[] = [];
      for (const { packageName } of selectedProjects) {
        selectedProjectNames.push(packageName);
      }

      selectedProjectNames.sort();
      // Get the projects involved in this filtered install
      commonTempInstallFlag.mergeFromObject({
        selectedProjectNames
      });
    }
    const optionsToIgnore: (keyof ILastInstallFlagJson)[] | undefined = !this.rushConfiguration
      .experimentsConfiguration.configuration.cleanInstallAfterNpmrcChanges
      ? ['npmrcHash'] // If the "cleanInstallAfterNpmrcChanges" experiment is disabled, ignore the npmrcHash
      : undefined;
    const cleanInstall: boolean = !(await commonTempInstallFlag.checkValidAndReportStoreIssuesAsync({
      rushVerb: allowShrinkwrapUpdates ? 'update' : 'install',
      statePropertiesToIgnore: optionsToIgnore
    }));

    // Allow us to defer the file read until we need it
    const canSkipInstallAsync: () => Promise<boolean> = async () => {
      // Based on timestamps, can we skip this install entirely?
      const outputStats: FileSystemStats = await FileSystem.getStatisticsAsync(commonTempInstallFlag.path);
      return this.canSkipInstallAsync(outputStats.mtime, subspace, variant);
    };

    if (
      resolutionOnly ||
      cleanInstall ||
      !variantIsUpToDate ||
      !shrinkwrapIsUpToDate ||
      !(await canSkipInstallAsync()) ||
      !projectImpactGraphIsUpToDate
    ) {
      // eslint-disable-next-line no-console
      console.log();
      await this.validateNpmSetupAsync();

      if (!this.rushConfiguration.rushConfigurationJson.suppressRushIsPublicVersionCheck) {
        let publishedRelease: boolean | undefined;
        try {
          publishedRelease = await this._checkIfReleaseIsPublishedAsync();
        } catch {
          // If the user is working in an environment that can't reach the registry,
          // don't bother them with errors.
        }

        if (publishedRelease === false) {
          // eslint-disable-next-line no-console
          console.log(
            Colorize.yellow('Warning: This release of the Rush tool was unpublished; it may be unstable.')
          );
        }
      }

      if (!resolutionOnly) {
        // Delete the successful install file to indicate the install transaction has started
        await commonTempInstallFlag.clearAsync();

        // Since we're going to be tampering with common/node_modules, delete the "rush link" flag file if it exists;
        // this ensures that a full "rush link" is required next time
        await this._commonTempLinkFlag.clearAsync();
      }

      // Give plugins an opportunity to act before invoking the installation process
      if (this.options.beforeInstallAsync !== undefined) {
        await this.options.beforeInstallAsync(subspace);
      }

      await Promise.all([
        // Perform the actual install
        this.installAsync(cleanInstall, subspace),
        // If allowed, generate the project impact graph
        allowShrinkwrapUpdates ? projectImpactGraphGenerator?.generateAsync() : undefined
      ]);

      if (this.options.allowShrinkwrapUpdates && !shrinkwrapIsUpToDate) {
        const committedShrinkwrapFileName: string = subspace.getCommittedShrinkwrapFilePath(variant);
        const shrinkwrapFile: BaseShrinkwrapFile | undefined = ShrinkwrapFileFactory.getShrinkwrapFile(
          this.rushConfiguration.packageManager,
          committedShrinkwrapFileName
        );
        shrinkwrapFile?.validateShrinkwrapAfterUpdate(this.rushConfiguration, subspace, this._terminal);
        // Copy (or delete) common\temp\pnpm-lock.yaml --> common\config\rush\pnpm-lock.yaml
        Utilities.syncFile(subspace.getTempShrinkwrapFilename(), committedShrinkwrapFileName);
      } else {
        // TODO: Validate whether the package manager updated it in a nontrivial way
      }

      // Always update the state file if running "rush update"
      if (this.options.allowShrinkwrapUpdates) {
        if (subspace.getRepoState().refreshState(this.rushConfiguration, subspace, variant)) {
          // eslint-disable-next-line no-console
          console.log(
            Colorize.yellow(
              `${RushConstants.repoStateFilename} has been modified and must be committed to source control.`
            )
          );
        }
      }
    } else {
      // eslint-disable-next-line no-console
      console.log('Installation is already up-to-date.');
    }

    const { configuration: experiments } = this.rushConfiguration.experimentsConfiguration;
    // if usePnpmSyncForInjectedDependencies is true
    // the pnpm-sync will generate the pnpm-sync.json based on lockfile
    if (this.rushConfiguration.isPnpm && experiments?.usePnpmSyncForInjectedDependencies) {
      const pnpmLockfilePath: string = subspace.getTempShrinkwrapFilename();
      const dotPnpmFolder: string = `${subspace.getSubspaceTempFolderPath()}/node_modules/.pnpm`;

      // we have an edge case here
      // if a package.json has no dependencies, pnpm will still generate the pnpm-lock.yaml but not .pnpm folder
      // so we need to make sure pnpm-lock.yaml and .pnpm exists before calling the pnpmSync APIs
      if ((await FileSystem.existsAsync(pnpmLockfilePath)) && (await FileSystem.existsAsync(dotPnpmFolder))) {
        await pnpmSyncPrepareAsync({
          lockfilePath: pnpmLockfilePath,
          dotPnpmFolder,
          lockfileId: subspace.subspaceName,
          ensureFolderAsync: FileSystem.ensureFolderAsync,
          // eslint-disable-next-line @typescript-eslint/naming-convention
          readPnpmLockfile: async (lockfilePath: string) => {
            const wantedPnpmLockfile: PnpmShrinkwrapFile | undefined = PnpmShrinkwrapFile.loadFromFile(
              lockfilePath,
              { withCaching: true }
            );

            if (!wantedPnpmLockfile) {
              return undefined;
            } else {
              const lockfilePackages: Record<string, ILockfilePackage> = Object.create(null);
              for (const versionPath of wantedPnpmLockfile.packages.keys()) {
                lockfilePackages[versionPath] = {
                  dependencies: wantedPnpmLockfile.packages.get(versionPath)?.dependencies as Record<
                    string,
                    string
                  >,
                  optionalDependencies: wantedPnpmLockfile.packages.get(versionPath)
                    ?.optionalDependencies as Record<string, string>
                };
              }

              const result: ILockfile = {
                lockfileVersion: wantedPnpmLockfile.shrinkwrapFileMajorVersion,
                importers: Object.fromEntries(wantedPnpmLockfile.importers.entries()),
                packages: lockfilePackages
              };

              return result;
            }
          },
          logMessageCallback: (logMessageOptions: ILogMessageCallbackOptions) =>
            PnpmSyncUtilities.processLogMessage(logMessageOptions, this._terminal)
        });
      }

      // clean up the out of date .pnpm-sync.json
      for (const rushProject of subspace.getProjects()) {
        const pnpmSyncJsonPath: string = `${rushProject.projectFolder}/node_modules/.pnpm-sync.json`;
        if (!existsSync(pnpmSyncJsonPath)) {
          continue;
        }

        let existingPnpmSyncJsonFile: { version: string } | undefined;
        try {
          existingPnpmSyncJsonFile = JSON.parse((await readFile(pnpmSyncJsonPath)).toString());
          if (existingPnpmSyncJsonFile?.version !== pnpmSyncGetJsonVersion()) {
            await unlink(pnpmSyncJsonPath);
          }
        } catch (e) {
          await unlink(pnpmSyncJsonPath);
        }
      }
    }

    // Perform any post-install work the install manager requires
    await this.postInstallAsync(subspace);

    if (!resolutionOnly) {
      // Create the marker file to indicate a successful install
      await commonTempInstallFlag.createAsync();
    }

    // Give plugins an opportunity to act after a successful install
    if (this.options.afterInstallAsync !== undefined) {
      await this.options.afterInstallAsync(subspace);
    }

    // eslint-disable-next-line no-console
    console.log('');
  }

  protected abstract prepareCommonTempAsync(
    subspace: Subspace,
    shrinkwrapFile: BaseShrinkwrapFile | undefined
  ): Promise<{ shrinkwrapIsUpToDate: boolean; shrinkwrapWarnings: string[] }>;

  protected abstract installAsync(cleanInstall: boolean, subspace: Subspace): Promise<void>;

  protected abstract postInstallAsync(subspace: Subspace): Promise<void>;

  protected async canSkipInstallAsync(
    lastModifiedDate: Date,
    subspace: Subspace,
    variant: string | undefined
  ): Promise<boolean> {
    // Based on timestamps, can we skip this install entirely?
    const potentiallyChangedFiles: string[] = [];

    // Consider the timestamp on the node_modules folder; if someone tampered with it
    // or deleted it entirely, then we can't skip this install
    potentiallyChangedFiles.push(
      path.join(subspace.getSubspaceTempFolderPath(), RushConstants.nodeModulesFolderName)
    );

    // Additionally, if they pulled an updated shrinkwrap file from Git,
    // then we can't skip this install
    potentiallyChangedFiles.push(subspace.getCommittedShrinkwrapFilePath(variant));

    // Add common-versions.json file to the potentially changed files list.
    potentiallyChangedFiles.push(subspace.getCommonVersionsFilePath(variant));

    // Add pnpm-config.json file to the potentially changed files list.
    potentiallyChangedFiles.push(subspace.getPnpmConfigFilePath());

    if (this.rushConfiguration.isPnpm) {
      // If the repo is using pnpmfile.js, consider that also
      const pnpmFileFilePath: string = subspace.getPnpmfilePath(variant);
      const pnpmFileExists: boolean = await FileSystem.existsAsync(pnpmFileFilePath);

      if (pnpmFileExists) {
        potentiallyChangedFiles.push(pnpmFileFilePath);
      }
    }

    return await Utilities.isFileTimestampCurrentAsync(lastModifiedDate, potentiallyChangedFiles);
  }

  protected async prepareAsync(
    subspace: Subspace,
    variant: string | undefined,
    projectImpactGraphGenerator: ProjectImpactGraphGenerator | undefined
  ): Promise<{
    shrinkwrapIsUpToDate: boolean;
    npmrcHash: string | undefined;
    projectImpactGraphIsUpToDate: boolean;
    variantIsUpToDate: boolean;
  }> {
    const terminal: ITerminal = this._terminal;
    const { allowShrinkwrapUpdates } = this.options;

    // Check the policies
    await PolicyValidator.validatePolicyAsync(this.rushConfiguration, subspace, variant, this.options);

    await this._installGitHooksAsync();

    const approvedPackagesChecker: ApprovedPackagesChecker = new ApprovedPackagesChecker(
      this.rushConfiguration
    );
    if (approvedPackagesChecker.approvedPackagesFilesAreOutOfDate) {
      approvedPackagesChecker.rewriteConfigFiles();
      if (allowShrinkwrapUpdates) {
        terminal.writeLine(
          Colorize.yellow(
            'Approved package files have been updated. These updates should be committed to source control'
          )
        );
      } else {
        throw new Error(`Approved packages files are out-of date. Run "rush update" to update them.`);
      }
    }

    // Ensure that the package manager is installed
    await InstallHelpers.ensureLocalPackageManagerAsync(
      this.rushConfiguration,
      this.rushGlobalFolder,
      this.options.maxInstallAttempts
    );

    let shrinkwrapFile: BaseShrinkwrapFile | undefined = undefined;

    // (If it's a full update, then we ignore the shrinkwrap from Git since it will be overwritten)
    if (!this.options.fullUpgrade) {
      const committedShrinkwrapFileName: string = subspace.getCommittedShrinkwrapFilePath(variant);
      try {
        shrinkwrapFile = ShrinkwrapFileFactory.getShrinkwrapFile(
          this.rushConfiguration.packageManager,
          committedShrinkwrapFileName
        );
      } catch (ex) {
        terminal.writeLine();
        terminal.writeLine(
          `Unable to load the ${this.rushConfiguration.shrinkwrapFilePhrase}: ${(ex as Error).message}`
        );

        if (!allowShrinkwrapUpdates) {
          terminal.writeLine();
          terminal.writeLine(Colorize.red('You need to run "rush update" to fix this problem'));
          throw new AlreadyReportedError();
        }

        shrinkwrapFile = undefined;
      }
    }

    // Write a file indicating which variant is being installed.
    // This will be used by bulk scripts to determine the correct Shrinkwrap file to track.
    const currentVariantJsonFilePath: string = this.rushConfiguration.currentVariantJsonFilePath;
    const currentVariantJson: ICurrentVariantJson = {
      variant: variant ?? null
    };

    // Determine if the variant is already current by updating current-variant.json.
    // If nothing is written, the variant has not changed.
    const variantIsUpToDate: boolean = !(await JsonFile.saveAsync(
      currentVariantJson,
      currentVariantJsonFilePath,
      {
        onlyIfChanged: true
      }
    ));
    this.rushConfiguration._currentVariantJsonLoadingPromise = undefined;

    if (this.options.variant) {
      terminal.writeLine();
      terminal.writeLine(Colorize.bold(`Using variant '${this.options.variant}' for installation.`));
    } else if (!variantIsUpToDate && !variant && this.rushConfiguration.variants.size > 0) {
      terminal.writeLine();
      terminal.writeLine(Colorize.bold('Using the default variant for installation.'));
    }

    const extraNpmrcLines: string[] = [];
    if (this.rushConfiguration.subspacesFeatureEnabled) {
      // Look for a monorepo level .npmrc file
      const commonNpmrcPath: string = `${this.rushConfiguration.commonRushConfigFolder}/.npmrc`;
      let commonNpmrcFileLines: string[] | undefined;
      try {
        commonNpmrcFileLines = (await FileSystem.readFileAsync(commonNpmrcPath)).split('\n');
      } catch (e) {
        if (!FileSystem.isNotExistError(e)) {
          throw e;
        }
      }

      if (commonNpmrcFileLines) {
        extraNpmrcLines.push(...commonNpmrcFileLines);
      }

      extraNpmrcLines.push(
        `global-pnpmfile=${subspace.getSubspaceTempFolderPath()}/${RushConstants.pnpmfileGlobalFilename}`
      );
    }

    // Also copy down the committed .npmrc file, if there is one
    // "common\config\rush\.npmrc" --> "common\temp\.npmrc"
    // Also ensure that we remove any old one that may be hanging around
    const npmrcText: string | undefined = Utilities.syncNpmrc({
      sourceNpmrcFolder: subspace.getSubspaceConfigFolderPath(),
      targetNpmrcFolder: subspace.getSubspaceTempFolderPath(),
      linesToPrepend: extraNpmrcLines,
      createIfMissing: this.rushConfiguration.subspacesFeatureEnabled,
      supportEnvVarFallbackSyntax: this.rushConfiguration.isPnpm
    });
    this._syncNpmrcAlreadyCalled = true;

    const npmrcHash: string | undefined = npmrcText
      ? crypto.createHash('sha1').update(npmrcText).digest('hex')
      : undefined;

    if (this.rushConfiguration.isPnpm) {
      // Copy the committed patches folder if using pnpm
      const commonTempPnpmPatchesFolder: string = `${subspace.getSubspaceTempFolderPath()}/${
        RushConstants.pnpmPatchesFolderName
      }`;
      const rushPnpmPatchesFolder: string = subspace.getSubspacePnpmPatchesFolderPath();
      let rushPnpmPatches: FolderItem[] | undefined;
      try {
        rushPnpmPatches = await FileSystem.readFolderItemsAsync(rushPnpmPatchesFolder);
      } catch (e) {
        if (!FileSystem.isNotExistError(e)) {
          throw e;
        }
      }

      if (rushPnpmPatches) {
        await FileSystem.ensureFolderAsync(commonTempPnpmPatchesFolder);
        const existingPatches: FolderItem[] =
          await FileSystem.readFolderItemsAsync(commonTempPnpmPatchesFolder);
        const copiedPatchNames: Set<string> = new Set();
        await Async.forEachAsync(
          rushPnpmPatches,
          async (patch: FolderItem) => {
            const name: string = patch.name;
            const sourcePath: string = `${rushPnpmPatchesFolder}/${name}`;
            if (patch.isFile()) {
              await FileSystem.copyFileAsync({
                sourcePath,
                destinationPath: `${commonTempPnpmPatchesFolder}/${name}`
              });
              copiedPatchNames.add(name);
            } else {
              throw new Error(`Unexpected non-file item found in ${rushPnpmPatchesFolder}: ${sourcePath}`);
            }
          },
          { concurrency: 50 }
        );

        await Async.forEachAsync(
          existingPatches,
          async (patch: FolderItem) => {
            const name: string = patch.name;
            if (!copiedPatchNames.has(name)) {
              await FileSystem.deleteFileAsync(`${commonTempPnpmPatchesFolder}/${name}`);
            }
          },
          { concurrency: 50 }
        );
      } else {
        await FileSystem.deleteFolderAsync(commonTempPnpmPatchesFolder);
      }
    }

    // Shim support for pnpmfile in.
    // Additionally when in workspaces, the shim implements support for common versions.
    if (this.rushConfiguration.isPnpm) {
      await PnpmfileConfiguration.writeCommonTempPnpmfileShimAsync(
        this.rushConfiguration,
        subspace.getSubspaceTempFolderPath(),
        subspace,
        variant
      );

      if (this.rushConfiguration.subspacesFeatureEnabled) {
        await SubspacePnpmfileConfiguration.writeCommonTempSubspaceGlobalPnpmfileAsync(
          this.rushConfiguration,
          subspace,
          variant
        );
      }
    }

    // eslint-disable-next-line prefer-const
    let [{ shrinkwrapIsUpToDate, shrinkwrapWarnings }, projectImpactGraphIsUpToDate = true] =
      await Promise.all([
        // Allow for package managers to do their own preparation and check that the shrinkwrap is up to date
        this.prepareCommonTempAsync(subspace, shrinkwrapFile),
        projectImpactGraphGenerator?.validateAsync()
      ]);
    shrinkwrapIsUpToDate = shrinkwrapIsUpToDate && !this.options.recheckShrinkwrap;

    this._syncTempShrinkwrap(subspace, variant, shrinkwrapFile);

    // Write out the reported warnings
    if (shrinkwrapWarnings.length > 0) {
      terminal.writeLine();
      terminal.writeLine(
        Colorize.yellow(
          PrintUtilities.wrapWords(
            `The ${this.rushConfiguration.shrinkwrapFilePhrase} contains the following issues:`
          )
        )
      );

      for (const shrinkwrapWarning of shrinkwrapWarnings) {
        terminal.writeLine(Colorize.yellow('  ' + shrinkwrapWarning));
      }

      terminal.writeLine();
    }

    let hasErrors: boolean = false;
    // Force update if the shrinkwrap is out of date
    if (!shrinkwrapIsUpToDate && !allowShrinkwrapUpdates) {
      terminal.writeErrorLine();
      terminal.writeErrorLine(
        `The ${this.rushConfiguration.shrinkwrapFilePhrase} is out of date. You need to run "rush update".`
      );
      hasErrors = true;
    }

    if (!projectImpactGraphIsUpToDate && !allowShrinkwrapUpdates) {
      hasErrors = true;
      terminal.writeErrorLine();
      terminal.writeErrorLine(
        Colorize.red(
          `The ${RushConstants.projectImpactGraphFilename} file is missing or out of date. You need to run "rush update".`
        )
      );
    }

    if (hasErrors) {
      throw new AlreadyReportedError();
    }

    return { shrinkwrapIsUpToDate, npmrcHash, projectImpactGraphIsUpToDate, variantIsUpToDate };
  }

  /**
   * Git hooks are only installed if the repo opts in by including files in /common/git-hooks
   */
  private async _installGitHooksAsync(): Promise<void> {
    const hookSource: string = path.join(this.rushConfiguration.commonFolder, 'git-hooks');
    const git: Git = new Git(this.rushConfiguration);
    const hookDestination: string | undefined = git.getHooksFolder();

    if (FileSystem.exists(hookSource) && hookDestination) {
      const allHookFilenames: string[] = FileSystem.readFolderItemNames(hookSource);
      // Ignore the ".sample" file(s) in this folder.
      const hookFilenames: string[] = allHookFilenames.filter((x) => !/\.sample$/.test(x));
      if (hookFilenames.length > 0) {
        // eslint-disable-next-line no-console
        console.log('\n' + Colorize.bold('Found files in the "common/git-hooks" folder.'));

        if (!(await git.getIsHooksPathDefaultAsync())) {
          const hooksPath: string = await git.getConfigHooksPathAsync();
          const color: (str: string) => string = this.options.bypassPolicy ? Colorize.yellow : Colorize.red;
          // eslint-disable-next-line no-console
          console.error(
            color(
              [
                ' ',
                `Rush cannot install the "common/git-hooks" scripts because your Git configuration `,
                `specifies "core.hooksPath=${hooksPath}". You can remove the setting by running:`,
                ' ',
                '    git config --unset core.hooksPath',
                ' '
              ].join('\n')
            )
          );
          if (this.options.bypassPolicy) {
            // If "--bypass-policy" is specified, skip installation of hooks because Rush doesn't
            // own the hooks folder
            return;
          }
          // eslint-disable-next-line no-console
          console.error(
            color(
              [
                '(Or, to temporarily ignore this problem, invoke Rush with the ' +
                  `"${RushConstants.bypassPolicyFlagLongName}" option.)`,
                ' '
              ].join('\n')
            )
          );
          throw new AlreadyReportedError();
        }

        // Clear the currently installed git hooks and install fresh copies
        FileSystem.ensureEmptyFolder(hookDestination);

        // Find the relative path from Git hooks directory to the directory storing the actual scripts.
        const hookRelativePath: string = Path.convertToSlashes(path.relative(hookDestination, hookSource));

        // Only copy files that look like Git hook names
        const filteredHookFilenames: string[] = hookFilenames.filter((x) => /^[a-z\-]+/.test(x));
        for (const filename of filteredHookFilenames) {
          const hookFilePath: string = `${hookSource}/${filename}`;
          // Make sure the actual script in the hookSource directory has correct Linux compatible line endings
          const originalHookFileContent: string = FileSystem.readFile(hookFilePath);
          FileSystem.writeFile(hookFilePath, originalHookFileContent, {
            convertLineEndings: NewlineKind.Lf
          });
          // Make sure the actual script in the hookSource directory has required permission bits
          const originalPosixModeBits: PosixModeBits = FileSystem.getPosixModeBits(hookFilePath);
          FileSystem.changePosixModeBits(
            hookFilePath,
            // eslint-disable-next-line no-bitwise
            originalPosixModeBits | PosixModeBits.UserRead | PosixModeBits.UserExecute
          );

          const gitLfsHookHandling: string = gitLfsHooks.has(filename)
            ? `
# Inspired by https://github.com/git-lfs/git-lfs/issues/2865#issuecomment-365742940
if command -v git-lfs &> /dev/null; then
  git lfs ${filename} "$@"
fi
`
            : '';

          const hookFileContent: string = `#!/bin/bash
set -e
SCRIPT_DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
SCRIPT_IMPLEMENTATION_PATH="$SCRIPT_DIR/${hookRelativePath}/${filename}"

if [[ -f "$SCRIPT_IMPLEMENTATION_PATH" ]]; then
  "$SCRIPT_IMPLEMENTATION_PATH" $@
else
  echo "The ${filename} Git hook no longer exists in your version of the repo. Run 'rush install' or 'rush update' to refresh your installed Git hooks." >&2
fi
${gitLfsHookHandling}
`;
          // Create the hook file.  Important: For Bash scripts, the EOL must not be CRLF.
          FileSystem.writeFile(path.join(hookDestination, filename), hookFileContent, {
            convertLineEndings: NewlineKind.Lf
          });

          FileSystem.changePosixModeBits(
            path.join(hookDestination, filename),
            // eslint-disable-next-line no-bitwise
            PosixModeBits.UserRead | PosixModeBits.UserExecute
          );
        }

        // eslint-disable-next-line no-console
        console.log(
          'Successfully installed these Git hook scripts: ' + filteredHookFilenames.join(', ') + '\n'
        );
      }
    }
  }

  /**
   * Used when invoking the NPM tool.  Appends the common configuration options
   * to the command-line.
   */
  protected pushConfigurationArgs(args: string[], options: IInstallManagerOptions, subspace: Subspace): void {
    const {
      offline,
      collectLogFile,
      pnpmFilterArgumentValues,
      onlyShrinkwrap,
      networkConcurrency,
      allowShrinkwrapUpdates,
      resolutionOnly
    } = options;

    if (offline && this.rushConfiguration.packageManager !== 'pnpm') {
      throw new Error('The "--offline" parameter is only supported when using the PNPM package manager.');
    }
    if (resolutionOnly && this.rushConfiguration.packageManager !== 'pnpm') {
      throw new Error(
        'The "--resolution-only" parameter is only supported when using the PNPM package manager.'
      );
    }
    if (this.rushConfiguration.packageManager === 'npm') {
      if (semver.lt(this.rushConfiguration.packageManagerToolVersion, '5.0.0')) {
        // NOTE:
        //
        // When using an npm version older than v5.0.0, we do NOT install optional dependencies for
        // Rush, because npm does not generate the shrinkwrap file consistently across platforms.
        //
        // Consider the "fsevents" package. This is a Mac specific package
        // which is an optional second-order dependency. Optional dependencies work by attempting to install
        // the package, but removes the package if the install failed.
        // This means that someone running generate on a Mac WILL have fsevents included in their shrinkwrap.
        // When someone using Windows attempts to install from the shrinkwrap, the install will fail.
        //
        // If someone generates the shrinkwrap using Windows, then fsevents will NOT be listed in the shrinkwrap.
        // When someone using Mac attempts to install from the shrinkwrap, they will NOT have the
        // optional dependency installed.
        //
        // This issue has been fixed as of npm v5.0.0: https://github.com/npm/npm/releases/tag/v5.0.0
        //
        // For more context, see https://github.com/microsoft/rushstack/issues/761#issuecomment-428689600
        args.push('--no-optional');
      }
      args.push('--cache', this.rushConfiguration.npmCacheFolder);
      args.push('--tmp', this.rushConfiguration.npmTmpFolder);

      if (collectLogFile) {
        args.push('--verbose');
      }
    } else if (this.rushConfiguration.isPnpm) {
      // Only explicitly define the store path if `pnpmStore` is using the default, or has been set to
      // 'local'.  If `pnpmStore` = 'global', then allow PNPM to use the system's default
      // path.  In all cases, this will be overridden by RUSH_PNPM_STORE_PATH
      if (
        this.rushConfiguration.pnpmOptions.pnpmStore === 'local' ||
        EnvironmentConfiguration.pnpmStorePathOverride
      ) {
        args.push('--store', this.rushConfiguration.pnpmOptions.pnpmStorePath);
        if (semver.gte(this.rushConfiguration.packageManagerToolVersion, '6.10.0')) {
          args.push(`${pnpmCacheDirParameter}=${this.rushConfiguration.pnpmOptions.pnpmStorePath}`);
          args.push(`${pnpmStateDirParameter}=${this.rushConfiguration.pnpmOptions.pnpmStorePath}`);
        }
      }

      // This will be overridden by RUSH_PNPM_VIRTUAL_STORE_PATH
      if (EnvironmentConfiguration.pnpmVirtualStorePathOverride) {
        args.push('--virtual-store-dir', this.rushConfiguration.pnpmOptions.pnpmVirtualStorePath);
      }

      const { pnpmVerifyStoreIntegrity } = EnvironmentConfiguration;
      if (pnpmVerifyStoreIntegrity !== undefined) {
        args.push(`--verify-store-integrity`, `${pnpmVerifyStoreIntegrity}`);
      }

      const { configuration: experiments } = this.rushConfiguration.experimentsConfiguration;

      if (experiments.usePnpmFrozenLockfileForRushInstall && !allowShrinkwrapUpdates) {
        args.push('--frozen-lockfile');

        if (
          pnpmFilterArgumentValues.length > 0 &&
          Number.parseInt(this.rushConfiguration.packageManagerToolVersion, 10) >= 8 // PNPM Major version 8+
        ) {
          // On pnpm@8, disable the "dedupe-peer-dependents" feature when doing a filtered CI install so that filters take effect.
          args.push('--config.dedupe-peer-dependents=false');
        }
      } else if (experiments.usePnpmPreferFrozenLockfileForRushUpdate) {
        // In workspaces, we want to avoid unnecessary lockfile churn
        args.push('--prefer-frozen-lockfile');
      } else {
        // Ensure that Rush's tarball dependencies get synchronized properly with the pnpm-lock.yaml file.
        // See this GitHub issue: https://github.com/pnpm/pnpm/issues/1342
        args.push('--no-prefer-frozen-lockfile');
      }

      if (onlyShrinkwrap) {
        args.push(`--lockfile-only`);
      }

      if (collectLogFile) {
        args.push('--reporter', 'ndjson');
      }

      if (networkConcurrency) {
        args.push('--network-concurrency', networkConcurrency.toString());
      }

      if (offline) {
        args.push('--offline');
      }

      if (this.rushConfiguration.pnpmOptions.strictPeerDependencies === false) {
        args.push('--no-strict-peer-dependencies');
      } else {
        args.push('--strict-peer-dependencies');
      }

      if (resolutionOnly) {
        args.push('--resolution-only');
      }

      /*
        If user set auto-install-peers in pnpm-config.json only, use the value in pnpm-config.json
        If user set auto-install-peers in pnpm-config.json and .npmrc, use the value in pnpm-config.json
        If user set auto-install-peers in .npmrc only, do nothing, let pnpm handle it
        If user does not set auto-install-peers in both pnpm-config.json and .npmrc, rush will default it to "false"
      */
      const isAutoInstallPeersInNpmrc: boolean = isVariableSetInNpmrcFile(
        subspace.getSubspaceConfigFolderPath(),
        'auto-install-peers',
        this.rushConfiguration.isPnpm
      );

      let autoInstallPeers: boolean | undefined = this.rushConfiguration.pnpmOptions.autoInstallPeers;
      if (autoInstallPeers !== undefined) {
        if (isAutoInstallPeersInNpmrc) {
          this._terminal.writeWarningLine(
            `Warning: PNPM's auto-install-peers is specified in both .npmrc and pnpm-config.json. ` +
              `The value in pnpm-config.json will take precedence.`
          );
        }
      } else if (!isAutoInstallPeersInNpmrc) {
        // if auto-install-peers isn't specified in either .npmrc or pnpm-config.json,
        // then rush will default it to "false"
        autoInstallPeers = false;
      }
      if (autoInstallPeers !== undefined) {
        args.push(`--config.auto-install-peers=${autoInstallPeers}`);
      }

      /*
        If user set resolution-mode in pnpm-config.json only, use the value in pnpm-config.json
        If user set resolution-mode in pnpm-config.json and .npmrc, use the value in pnpm-config.json
        If user set resolution-mode in .npmrc only, do nothing, let pnpm handle it
        If user does not set resolution-mode in pnpm-config.json and .npmrc, rush will default it to "highest"
      */
      const isResolutionModeInNpmrc: boolean = isVariableSetInNpmrcFile(
        subspace.getSubspaceConfigFolderPath(),
        'resolution-mode',
        this.rushConfiguration.isPnpm
      );

      let resolutionMode: PnpmResolutionMode | undefined = this.rushConfiguration.pnpmOptions.resolutionMode;
      if (resolutionMode) {
        if (isResolutionModeInNpmrc) {
          this._terminal.writeWarningLine(
            `Warning: PNPM's resolution-mode is specified in both .npmrc and pnpm-config.json. ` +
              `The value in pnpm-config.json will take precedence.`
          );
        }
      } else if (!isResolutionModeInNpmrc) {
        // if resolution-mode isn't specified in either .npmrc or pnpm-config.json,
        // then rush will default it to "highest"
        resolutionMode = 'highest';
      }
      if (resolutionMode) {
        args.push(`--config.resolutionMode=${resolutionMode}`);
      }

      if (
        semver.satisfies(
          this.rushConfiguration.packageManagerToolVersion,
          '6.32.12 - 6.33.x || 7.0.1 - 7.8.x'
        )
      ) {
        this._terminal.writeWarningLine(
          `Warning: Your ${RushConstants.rushJsonFilename} specifies a pnpmVersion with a known issue ` +
            'that may cause unintended version selections.' +
            " It's recommended to upgrade to PNPM >=6.34.0 or >=7.9.0. " +
            'For details see: https://rushjs.io/link/pnpm-issue-5132'
        );
      }
      if (
        semver.gte(this.rushConfiguration.packageManagerToolVersion, '7.9.0') ||
        semver.satisfies(this.rushConfiguration.packageManagerToolVersion, '^6.34.0')
      ) {
        args.push(pnpmIgnoreCompatibilityDbParameter);
      }
    } else if (this.rushConfiguration.packageManager === 'yarn') {
      args.push('--link-folder', 'yarn-link');
      args.push('--cache-folder', this.rushConfiguration.yarnCacheFolder);

      // Without this option, Yarn will sometimes stop and ask for user input on STDIN
      // (e.g. "Which command would you like to run?").
      args.push('--non-interactive');

      if (networkConcurrency) {
        args.push('--network-concurrency', networkConcurrency.toString());
      }

      if (this.rushConfiguration.yarnOptions.ignoreEngines) {
        args.push('--ignore-engines');
      }

      if (collectLogFile) {
        args.push('--verbose');
      }
    }
  }

  private async _checkIfReleaseIsPublishedAsync(): Promise<boolean> {
    const lastCheckFile: string = path.join(
      this.rushGlobalFolder.nodeSpecificPath,
      'rush-' + Rush.version,
      'last-check.flag'
    );

    if (FileSystem.exists(lastCheckFile)) {
      let cachedResult: boolean | 'error' | undefined = undefined;
      try {
        // NOTE: mtimeMs is not supported yet in Node.js 6.x
        const nowMs: number = new Date().getTime();
        const ageMs: number = nowMs - FileSystem.getStatistics(lastCheckFile).mtime.getTime();
        const HOUR: number = 60 * 60 * 1000;

        // Is the cache too old?
        if (ageMs < 24 * HOUR) {
          // No, read the cached result
          cachedResult = JsonFile.load(lastCheckFile);
        }
      } catch (e) {
        // Unable to parse file
      }
      if (cachedResult === 'error') {
        throw new Error('Unable to contact server');
      }
      if (cachedResult === true || cachedResult === false) {
        return cachedResult;
      }
    }

    // Before we start the network operation, record a failed state.  If the process exits for some reason,
    // this will record the error.  It will also update the timestamp to prevent other Rush instances
    // from attempting to update the file.
    await JsonFile.saveAsync('error', lastCheckFile, { ensureFolderExists: true });

    try {
      // For this check we use the official registry, not the private registry
      const publishedRelease: boolean = await this._queryIfReleaseIsPublishedAsync(
        'https://registry.npmjs.org:443'
      );
      // Cache the result
      await JsonFile.saveAsync(publishedRelease, lastCheckFile, { ensureFolderExists: true });
      return publishedRelease;
    } catch (error) {
      await JsonFile.saveAsync('error', lastCheckFile, { ensureFolderExists: true });
      throw error;
    }
  }

  // Helper for checkIfReleaseIsPublished()
  private async _queryIfReleaseIsPublishedAsync(registryUrl: string): Promise<boolean> {
    let queryUrl: string = registryUrl;
    if (queryUrl[-1] !== '/') {
      queryUrl += '/';
    }
    // Note that the "@" symbol does not normally get URL-encoded
    queryUrl += RushConstants.rushPackageName.replace('/', '%2F');

    const { WebClient } = await import('../../utilities/WebClient');

    const webClient: WebClientType = new WebClient();
    webClient.userAgent = `pnpm/? npm/? node/${process.version} ${os.platform()} ${os.arch()}`;
    webClient.accept = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

    const response: IWebClientResponse = await webClient.fetchAsync(queryUrl);
    if (!response.ok) {
      throw new Error('Failed to query');
    }

    const data: { versions: { [version: string]: { dist: { tarball: string } } } } =
      await response.getJsonAsync();
    let url: string;
    try {
      if (!data.versions[Rush.version]) {
        // Version was not published
        return false;
      }

      url = data.versions[Rush.version].dist.tarball;
      if (!url) {
        throw new Error(`URL not found`);
      }
    } catch (e) {
      throw new Error('Error parsing response');
    }

    // Make sure the tarball wasn't deleted from the CDN
    webClient.accept = '*/*';

    const response2: IWebClientResponse = await webClient.fetchAsync(url);

    if (!response2.ok) {
      if (response2.status === 404) {
        return false;
      } else {
        throw new Error('Failed to fetch');
      }
    }

    return true;
  }

  private _syncTempShrinkwrap(
    subspace: Subspace,
    variant: string | undefined,
    shrinkwrapFile: BaseShrinkwrapFile | undefined
  ): void {
    const committedShrinkwrapFileName: string = subspace.getCommittedShrinkwrapFilePath(variant);
    if (shrinkwrapFile) {
      Utilities.syncFile(committedShrinkwrapFileName, subspace.getTempShrinkwrapFilename());
      Utilities.syncFile(committedShrinkwrapFileName, subspace.getTempShrinkwrapPreinstallFilename());
    } else {
      // Otherwise delete the temporary file
      FileSystem.deleteFile(subspace.getTempShrinkwrapFilename());

      if (this.rushConfiguration.isPnpm) {
        // Workaround for https://github.com/pnpm/pnpm/issues/1890
        //
        // When "rush update --full" is run, Rush deletes "common/temp/pnpm-lock.yaml"
        // so that a new lockfile will be generated. However "pnpm install" by design will try to recover
        // "pnpm-lock.yaml" from "common/temp/node_modules/.pnpm/lock.yaml", which may prevent a full upgrade.
        // Deleting both files ensures that a new lockfile will always be generated.
        const pnpmPackageManager: PnpmPackageManager = this.rushConfiguration
          .packageManagerWrapper as PnpmPackageManager;

        FileSystem.deleteFile(
          path.join(subspace.getSubspaceTempFolderPath(), pnpmPackageManager.internalShrinkwrapRelativePath)
        );
      }
    }
  }

  protected async validateNpmSetupAsync(): Promise<void> {
    if (this._npmSetupValidated) {
      return;
    }

    if (!this.options.bypassPolicy) {
      const setupPackageRegistry: SetupPackageRegistry = new SetupPackageRegistry({
        rushConfiguration: this.rushConfiguration,
        isDebug: this.options.debug,
        syncNpmrcAlreadyCalled: this._syncNpmrcAlreadyCalled
      });
      const valid: boolean = await setupPackageRegistry.checkOnlyAsync();
      if (!valid) {
        // eslint-disable-next-line no-console
        console.error();
        // eslint-disable-next-line no-console
        console.error(Colorize.red('ERROR: NPM credentials are missing or expired'));
        // eslint-disable-next-line no-console
        console.error();
        // eslint-disable-next-line no-console
        console.error(
          Colorize.bold(
            '==> Please run "rush setup" to update your NPM token. ' +
              `(Or append "${RushConstants.bypassPolicyFlagLongName}" to proceed anyway.)`
          )
        );
        throw new AlreadyReportedError();
      }
    }

    this._npmSetupValidated = true;
  }
}
