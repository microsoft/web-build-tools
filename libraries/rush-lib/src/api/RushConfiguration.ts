// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/* eslint max-lines: off */

import * as path from 'path';
import * as semver from 'semver';
import {
  JsonFile,
  JsonSchema,
  Path,
  FileSystem,
  type PackageNameParser,
  type FileSystemStats,
  InternalError,
  type JsonNull
} from '@rushstack/node-core-library';
import { LookupByPath } from '@rushstack/lookup-by-path';
import { trueCasePathSync } from 'true-case-path';

import { Rush } from './Rush';
import { RushConfigurationProject, type IRushConfigurationProjectJson } from './RushConfigurationProject';
import { RushConstants } from '../logic/RushConstants';
import { ApprovedPackagesPolicy } from './ApprovedPackagesPolicy';
import { EventHooks } from './EventHooks';
import { VersionPolicyConfiguration } from './VersionPolicyConfiguration';
import { EnvironmentConfiguration } from './EnvironmentConfiguration';
import type { CommonVersionsConfiguration } from './CommonVersionsConfiguration';
import { Utilities } from '../utilities/Utilities';
import type { PackageManagerName, PackageManager } from './packageManager/PackageManager';
import { NpmPackageManager } from './packageManager/NpmPackageManager';
import { YarnPackageManager } from './packageManager/YarnPackageManager';
import { PnpmPackageManager } from './packageManager/PnpmPackageManager';
import { ExperimentsConfiguration } from './ExperimentsConfiguration';
import { PackageNameParsers } from './PackageNameParsers';
import type { RepoStateFile } from '../logic/RepoStateFile';
import { RushPluginsConfiguration } from './RushPluginsConfiguration';
import { type IPnpmOptionsJson, PnpmOptionsConfiguration } from '../logic/pnpm/PnpmOptionsConfiguration';
import { type INpmOptionsJson, NpmOptionsConfiguration } from '../logic/npm/NpmOptionsConfiguration';
import { type IYarnOptionsJson, YarnOptionsConfiguration } from '../logic/yarn/YarnOptionsConfiguration';
import schemaJson from '../schemas/rush.schema.json';
import projectSchemaJson from '../schemas/projects.schema.json';

import type * as DependencyAnalyzerModuleType from '../logic/DependencyAnalyzer';
import type { PackageManagerOptionsConfigurationBase } from '../logic/base/BasePackageManagerOptionsConfiguration';
import { CustomTipsConfiguration } from './CustomTipsConfiguration';
import { SubspacesConfiguration } from './SubspacesConfiguration';
import { Subspace } from './Subspace';

const MINIMUM_SUPPORTED_RUSH_JSON_VERSION: string = '0.0.0';
const DEFAULT_BRANCH: string = 'main';
const DEFAULT_REMOTE: string = 'origin';

/**
 * A list of known config filenames that are expected to appear in the "./common/config/rush" folder.
 * To avoid confusion/mistakes, any extra files will be reported as an error.
 */
const knownRushConfigFilenames: string[] = [
  '.npmrc-publish',
  '.npmrc',
  'deploy.json',
  RushConstants.artifactoryFilename,
  RushConstants.browserApprovedPackagesFilename,
  RushConstants.buildCacheFilename,
  RushConstants.cobuildFilename,
  RushConstants.commandLineFilename,
  RushConstants.commonVersionsFilename,
  RushConstants.customTipsFilename,
  RushConstants.experimentsFilename,
  RushConstants.nonbrowserApprovedPackagesFilename,
  RushConstants.pinnedVersionsFilename,
  RushConstants.repoStateFilename,
  RushConstants.versionPoliciesFilename,
  RushConstants.rushPluginsConfigFilename,
  RushConstants.pnpmConfigFilename,
  RushConstants.subspacesConfigFilename,
  RushConstants.rushAlertsConfigFilename
];

/**
 * Part of IRushConfigurationJson.
 */
export interface IApprovedPackagesPolicyJson {
  reviewCategories?: string[];
  ignoredNpmScopes?: string[];
}

/**
 * Part of IRushConfigurationJson.
 */
export interface IRushGitPolicyJson {
  allowedEmailRegExps?: string[];
  sampleEmail?: string;
  versionBumpCommitMessage?: string;
  changeLogUpdateCommitMessage?: string;
  changefilesCommitMessage?: string;
  tagSeparator?: string;
}

/**
 * Part of IRushConfigurationJson.
 * @beta
 */
export interface IEventHooksJson {
  /**
   * The list of scripts to run after every Rush build command finishes
   */
  postRushBuild?: string[];
}

/**
 * Part of IRushConfigurationJson.
 */
export interface IRushRepositoryJsonBase {
  /**
   * The default branch name. This tells "rush change" which remote branch to compare against.
   */
  defaultBranch?: string;

  /**
   * The default remote. This tells "rush change" which remote to compare against if the remote URL is not set
   * or if a remote matching the provided remote URL is not found.
   */
  defaultRemote?: string;
}

export interface IRushRepositoryJsonSingleUrl extends IRushRepositoryJsonBase {
  /**
   * The remote url of the repository. If a value is provided,
   * \"rush change\" will use it to find the right remote to compare against.
   *
   * @deprecated Use "urls" instead.
   */
  url?: string;
}

export interface IRushRepositoryJsonMultipleUrls extends IRushRepositoryJsonBase {
  /**
   * Remote url(s) of the repository. If a value is provided, \"rush change\" will
   * use one of these to find the right remote to compare against. Specifying multiple URLs
   * is useful if a GitHub repository is renamed or for `<projectName>.visualstudio.com` versus
   * `dev.azure.com/<projectName>` URLs.
   */
  urls?: string[];
}

export type IRushRepositoryJson = IRushRepositoryJsonSingleUrl | IRushRepositoryJsonMultipleUrls;

/**
 * Options defining an allowed variant as part of IRushConfigurationJson.
 */
export interface IRushVariantOptionsJson {
  variantName: string;
  description: string;
}

/**
 * This represents the JSON data structure for the "rush.json" configuration file.
 * See rush.schema.json for documentation.
 */
export interface IRushConfigurationJson {
  $schema: string;
  npmVersion?: string;
  pnpmVersion?: string;
  yarnVersion?: string;
  rushVersion: string;
  repository?: IRushRepositoryJson;
  nodeSupportedVersionRange?: string;
  nodeSupportedVersionInstructions?: string;
  suppressNodeLtsWarning?: boolean;
  suppressRushIsPublicVersionCheck?: boolean;
  projectFolderMinDepth?: number;
  projectFolderMaxDepth?: number;
  allowMostlyStandardPackageNames?: boolean;
  approvedPackagesPolicy?: IApprovedPackagesPolicyJson;
  gitPolicy?: IRushGitPolicyJson;
  telemetryEnabled?: boolean;
  allowedProjectTags?: string[];
  projects: IRushConfigurationProjectJson[];
  eventHooks?: IEventHooksJson;
  hotfixChangeEnabled?: boolean;
  npmOptions?: INpmOptionsJson;
  pnpmOptions?: IPnpmOptionsJson;
  yarnOptions?: IYarnOptionsJson;
  ensureConsistentVersions?: boolean;
  variants?: IRushVariantOptionsJson[];
}

/**
 * This represents the JSON data structure for the "current-variant.json" data file.
 */
export interface ICurrentVariantJson {
  variant: string | JsonNull;
}

/**
 * This represents the JSON data structure for the "rush-projects.json" configuration file.
 * See projects.schema.json for documentation
 */
export interface IRushProjectsJson {
  projects: IRushConfigurationProjectJson[];
}

/**
 * The filter parameters to search from all projects
 */
export interface IRushConfigurationProjectsFilter {
  /**
   * A string representation of the subspace to filter for
   */
  subspace: string;
}

/**
 * Options for `RushConfiguration.tryFindRushJsonLocation`.
 * @public
 */
export interface ITryFindRushJsonLocationOptions {
  /**
   * Whether to show verbose console messages.  Defaults to false.
   */
  showVerbose?: boolean; // Defaults to false (inverse of old `verbose` parameter)

  /**
   * The folder path where the search will start.  Defaults to the current working directory.
   */
  startingFolder?: string; // Defaults to cwd
}

/**
 * This represents the Rush configuration for a repository, based on the "rush.json"
 * configuration file.
 * @public
 */
export class RushConfiguration {
  private static _jsonSchema: JsonSchema = JsonSchema.fromLoadedObject(schemaJson);
  private static _projectsJsonSchema: JsonSchema = JsonSchema.fromLoadedObject(projectSchemaJson);

  private readonly _pathTrees: Map<string, LookupByPath<RushConfigurationProject>>;

  /**
   * @internal
   */
  public _currentVariantJsonLoadingPromise: Promise<ICurrentVariantJson | undefined> | undefined;

  // Lazily loaded when the projects() getter is called.
  private _projects: RushConfigurationProject[] | undefined;

  // Lazily loaded when the projectsByName() getter is called.
  private _projectsByName: Map<string, RushConfigurationProject> | undefined;

  // Lazily loaded when the projectsByTag() getter is called.
  private _projectsByTag: ReadonlyMap<string, ReadonlySet<RushConfigurationProject>> | undefined;

  // subspaceName -> subspace
  private readonly _subspacesByName: Map<string, Subspace>;
  private readonly _subspaces: Subspace[] = [];

  /**
   * The name of the package manager being used to install dependencies
   */
  public readonly packageManager!: PackageManagerName;

  /**
   * If true, the repository is using PNPM as its package manager.
   */
  public readonly isPnpm!: boolean;

  /**
   * {@inheritdoc PackageManager}
   *
   * @privateremarks
   * In the next major breaking API change, we will rename this property to "packageManager" and eliminate the
   * old property with that name.
   *
   * @beta
   */
  public readonly packageManagerWrapper: PackageManager;

  /**
   * Gets the JSON data structure for the "rush.json" configuration file.
   *
   * @internal
   */
  public readonly rushConfigurationJson: IRushConfigurationJson;

  /**
   * Gets the JSON data structure for the "rush-projects.json" configuration file.
   *
   * @internal
   */
  public readonly _rushProjectsJson: IRushProjectsJson | undefined;

  /**
   * The absolute path to the "rush.json" configuration file that was loaded to construct this object.
   */
  public readonly rushJsonFile: string;

  /**
   * The absolute path of the folder that contains rush.json for this project.
   */
  public readonly rushJsonFolder: string;

  /**
   * The folder that contains all change files.
   */
  public readonly changesFolder: string;

  /**
   * The fully resolved path for the "common" folder where Rush will store settings that
   * affect all Rush projects.  This is always a subfolder of the folder containing "rush.json".
   * Example: `C:\MyRepo\common`
   */
  public readonly commonFolder: string;

  /**
   * The folder where Rush's additional config files are stored.  This folder is always a
   * subfolder called `config\rush` inside the common folder.  (The `common\config` folder
   * is reserved for configuration files used by other tools.)  To avoid confusion or mistakes,
   * Rush will report an error if this this folder contains any unrecognized files.
   *
   * Example: `C:\MyRepo\common\config\rush`
   */
  public readonly commonRushConfigFolder: string;

  /**
   * The folder where temporary files will be stored.  This is always a subfolder called "temp"
   * under the common folder.
   * Example: `C:\MyRepo\common\temp`
   */
  public readonly commonTempFolder: string;

  /**
   * The folder where automation scripts are stored.  This is always a subfolder called "scripts"
   * under the common folder.
   * Example: `C:\MyRepo\common\scripts`
   */
  public readonly commonScriptsFolder: string;

  /**
   * The local folder that will store the NPM package cache.  Rush does not rely on the
   * npm's default global cache folder, because npm's caching implementation does not
   * reliably handle multiple processes.  (For example, if a build box is running
   * "rush install" simultaneously for two different working folders, it may fail randomly.)
   *
   * Example: `C:\MyRepo\common\temp\npm-cache`
   */
  public readonly npmCacheFolder: string;

  /**
   * The local folder where npm's temporary files will be written during installation.
   * Rush does not rely on the global default folder, because it may be on a different
   * hard disk.
   *
   * Example: `C:\MyRepo\common\temp\npm-tmp`
   */
  public readonly npmTmpFolder: string;

  /**
   * The local folder that will store the Yarn package cache.
   *
   * Example: `C:\MyRepo\common\temp\yarn-cache`
   */
  public readonly yarnCacheFolder: string;

  /**
   * The filename (without any path) of the shrinkwrap file that is used by the package manager.
   * @remarks
   * This property merely reports the filename; the file itself may not actually exist.
   * Example: `npm-shrinkwrap.json` or `pnpm-lock.yaml`
   */
  public readonly shrinkwrapFilename: string;

  /**
   * The object that specifies subspace configurations if they are provided in the rush workspace.
   * @beta
   */
  public readonly subspacesConfiguration: SubspacesConfiguration | undefined;

  /**
   * Returns true if subspaces.json is present with "subspacesEnabled=true".
   */
  public readonly subspacesFeatureEnabled: boolean;

  /**
   * The filename of the variant dependency data file.  By default this is
   * called 'current-variant.json' and resides in the Rush common folder.
   * Its data structure is defined by ICurrentVariantJson.
   *
   * Example: `C:\MyRepo\common\temp\current-variant.json`
   */
  public readonly currentVariantJsonFilePath: string;

  /**
   * The version of the locally package manager tool.  (Example: "1.2.3")
   */
  public readonly packageManagerToolVersion: string;

  /**
   * The absolute path to the locally package manager tool.  If "rush install" has not
   * been run, then this file may not exist yet.
   * Example: `C:\MyRepo\common\temp\npm-local\node_modules\.bin\npm`
   */
  public readonly packageManagerToolFilename: string;

  /**
   * The minimum allowable folder depth for the projectFolder field in the rush.json file.
   * This setting provides a way for repository maintainers to discourage nesting of project folders
   * that makes the directory tree more difficult to navigate.  The default value is 2,
   * which implements a standard 2-level hierarchy of `<categoryFolder>/<projectFolder>/package.json`.
   */
  public readonly projectFolderMinDepth: number;

  /**
   * The maximum allowable folder depth for the projectFolder field in the rush.json file.
   * This setting provides a way for repository maintainers to discourage nesting of project folders
   * that makes the directory tree more difficult to navigate.  The default value is 2,
   * which implements on a standard convention of `<categoryFolder>/<projectFolder>/package.json`.
   */
  public readonly projectFolderMaxDepth: number;

  /**
   * Today the npmjs.com registry enforces fairly strict naming rules for packages, but in the early
   * days there was no standard and hardly any enforcement.  A few large legacy projects are still using
   * nonstandard package names, and private registries sometimes allow it.  Set "allowMostlyStandardPackageNames"
   * to true to relax Rush's enforcement of package names.  This allows upper case letters and in the future may
   * relax other rules, however we want to minimize these exceptions.  Many popular tools use certain punctuation
   * characters as delimiters, based on the assumption that they will never appear in a package name; thus if we relax
   * the rules too much it is likely to cause very confusing malfunctions.
   *
   * The default value is false.
   */
  public readonly allowMostlyStandardPackageNames: boolean;

  /**
   * The "approvedPackagesPolicy" settings.
   */
  public readonly approvedPackagesPolicy: ApprovedPackagesPolicy;

  /**
   * [Part of the "gitPolicy" feature.]
   * A list of regular expressions describing allowable email patterns for Git commits.
   * They are case-insensitive anchored JavaScript RegExps.
   * Example: `".*@example\.com"`
   * This array will never be undefined.
   */
  public readonly gitAllowedEmailRegExps: string[];

  /**
   * [Part of the "gitPolicy" feature.]
   * An example valid email address that conforms to one of the allowedEmailRegExps.
   * Example: `"foxtrot@example\.com"`
   * This will never be undefined, and will always be nonempty if gitAllowedEmailRegExps is used.
   */
  public readonly gitSampleEmail: string;

  /**
   * [Part of the "gitPolicy" feature.]
   * The commit message to use when committing changes during 'rush publish'
   */
  public readonly gitVersionBumpCommitMessage: string | undefined;

  /**
   * [Part of the "gitPolicy" feature.]
   * The commit message to use when committing change log files 'rush version'
   */
  public readonly gitChangeLogUpdateCommitMessage: string | undefined;

  /**
   * [Part of the "gitPolicy" feature.]
   * The commit message to use when committing change log files 'rush version'
   */
  public readonly gitChangefilesCommitMessage: string | undefined;

  /**
   * [Part of the "gitPolicy" feature.]
   * The separator between package name and version in git tag.
   */
  public readonly gitTagSeparator: string | undefined;

  /**
   * [Part of the "hotfixChange" feature.]
   * Enables creating hotfix changes
   */
  public readonly hotfixChangeEnabled: boolean;

  /**
   * Remote URL(s) of the repository. If a value is provided, \"rush change\" will
   * use one of these to find the right remote to compare against. Specifying multiple URLs
   * is useful if a GitHub repository is renamed or for `<projectName>.visualstudio.com` versus
   * `dev.azure.com/<projectName>` URLs.
   */
  public readonly repositoryUrls: string[];

  /**
   * The default branch name. This tells "rush change" which remote branch to compare against.
   */
  public readonly repositoryDefaultBranch: string;

  /**
   * The default remote. This tells "rush change" which remote to compare against if the remote URL is not set
   * or if a remote matching the provided remote URL is not found.
   */
  public readonly repositoryDefaultRemote: string;

  /**
   * Odd-numbered major versions of Node.js are experimental.  Even-numbered releases
   * spend six months in a stabilization period before the first Long Term Support (LTS) version.
   * For example, 8.9.0 was the first LTS version of Node.js 8.  Pre-LTS versions are not recommended
   * for production usage because they frequently have bugs.  They may cause Rush itself
   * to malfunction.
   *
   * Rush normally prints a warning if it detects a pre-LTS Node.js version.  If you are testing
   * pre-LTS versions in preparation for supporting the first LTS version, you can use this setting
   * to disable Rush's warning.
   */
  public readonly suppressNodeLtsWarning: boolean;

  /**
   * The raw value of `ensureConsistentVersions` from the `rush.json` file.
   *
   * @internal
   */
  public readonly _ensureConsistentVersionsJsonValue: boolean | undefined;

  /**
   * If true, then consistent version specifiers for dependencies will be enforced.
   * I.e. "rush check" is run before some commands.
   *
   * @deprecated
   * This setting was moved from `rush.json` to `common-versions.json`.
   * Read it using {@link Subspace.shouldEnsureConsistentVersions} instead.
   */
  public readonly ensureConsistentVersions: boolean;

  /**
   * Indicates whether telemetry collection is enabled for Rush runs.
   * @beta
   */
  public readonly telemetryEnabled: boolean;

  /**
   * {@inheritDoc NpmOptionsConfiguration}
   */
  public readonly npmOptions: NpmOptionsConfiguration;

  /**
   * {@inheritDoc PnpmOptionsConfiguration}
   */
  public readonly pnpmOptions: PnpmOptionsConfiguration;

  /**
   * {@inheritDoc YarnOptionsConfiguration}
   */
  public readonly yarnOptions: YarnOptionsConfiguration;

  /**
   * The configuration options used by the current package manager.
   * @remarks
   * For package manager specific variants, reference {@link RushConfiguration.npmOptions | npmOptions},
   * {@link RushConfiguration.pnpmOptions | pnpmOptions}, or {@link RushConfiguration.yarnOptions | yarnOptions}.
   */
  public readonly packageManagerOptions!: PackageManagerOptionsConfigurationBase;

  /**
   * The rush hooks. It allows customized scripts to run at the specified point.
   * @beta
   */
  public readonly eventHooks: EventHooks;

  /**
   * The rush hooks. It allows customized scripts to run at the specified point.
   */
  public readonly packageNameParser: PackageNameParser;

  /**
   * @beta
   */
  public readonly versionPolicyConfiguration: VersionPolicyConfiguration;

  /**
   * @beta
   */
  public readonly versionPolicyConfigurationFilePath: string;

  /**
   * Accesses the custom-tips.json configuration.
   * @beta
   */
  public readonly customTipsConfiguration: CustomTipsConfiguration;

  /**
   * The absolute path to the custom tips configuration file.
   * @beta
   */
  public readonly customTipsConfigurationFilePath: string;

  /**
   * This configuration object contains settings repo maintainers have specified to enable
   * and disable experimental Rush features.
   *
   * @beta
   */
  public readonly experimentsConfiguration: ExperimentsConfiguration;

  /**
   * @internal
   */
  public readonly _rushPluginsConfiguration: RushPluginsConfiguration;

  /**
   * The variants specified in the rush.json configuration file.
   *
   * @beta
   */
  public readonly variants: ReadonlySet<string>;

  /**
   * Use RushConfiguration.loadFromConfigurationFile() or Use RushConfiguration.loadFromDefaultLocation()
   * instead.
   */
  private constructor(rushConfigurationJson: IRushConfigurationJson, rushJsonFilename: string) {
    this.rushConfigurationJson = rushConfigurationJson;
    EnvironmentConfiguration.validate();

    if (rushConfigurationJson.nodeSupportedVersionRange) {
      if (!semver.validRange(rushConfigurationJson.nodeSupportedVersionRange)) {
        throw new Error(
          'Error parsing the node-semver expression in the "nodeSupportedVersionRange"' +
            ` field from ${RushConstants.rushJsonFilename}: "${rushConfigurationJson.nodeSupportedVersionRange}"`
        );
      }
      if (!semver.satisfies(process.version, rushConfigurationJson.nodeSupportedVersionRange)) {
        let message: string =
          `Your dev environment is running Node.js version ${process.version} which does` +
          ` not meet the requirements for building this repository.  (The ${RushConstants.rushJsonFilename} configuration` +
          ` requires nodeSupportedVersionRange="${rushConfigurationJson.nodeSupportedVersionRange}")`;

        if (rushConfigurationJson.nodeSupportedVersionInstructions) {
          message += '\n\n' + rushConfigurationJson.nodeSupportedVersionInstructions;
        }

        if (EnvironmentConfiguration.allowUnsupportedNodeVersion) {
          // eslint-disable-next-line no-console
          console.warn(message);
        } else {
          throw new Error(message);
        }
      }
    }

    this.rushJsonFile = rushJsonFilename;
    this.rushJsonFolder = path.dirname(rushJsonFilename);

    this.commonFolder = path.resolve(path.join(this.rushJsonFolder, RushConstants.commonFolderName));

    this.commonRushConfigFolder = path.join(this.commonFolder, 'config', 'rush');

    this.commonTempFolder =
      EnvironmentConfiguration.rushTempFolderOverride ||
      path.join(this.commonFolder, RushConstants.rushTempFolderName);

    this.commonScriptsFolder = path.join(this.commonFolder, 'scripts');

    this.npmCacheFolder = path.resolve(path.join(this.commonTempFolder, 'npm-cache'));
    this.npmTmpFolder = path.resolve(path.join(this.commonTempFolder, 'npm-tmp'));
    this.yarnCacheFolder = path.resolve(path.join(this.commonTempFolder, 'yarn-cache'));

    this.changesFolder = path.join(this.commonFolder, RushConstants.changeFilesFolderName);

    this.currentVariantJsonFilePath = path.join(this.commonTempFolder, RushConstants.currentVariantsFilename);

    this.suppressNodeLtsWarning = !!rushConfigurationJson.suppressNodeLtsWarning;

    this._ensureConsistentVersionsJsonValue = rushConfigurationJson.ensureConsistentVersions;
    this.ensureConsistentVersions = !!rushConfigurationJson.ensureConsistentVersions;

    // Try getting a subspace configuration
    this.subspacesConfiguration = SubspacesConfiguration.tryLoadFromDefaultLocation(this);
    this.subspacesFeatureEnabled = !!this.subspacesConfiguration?.subspacesEnabled;

    this._subspacesByName = new Map();

    const experimentsConfigFile: string = path.join(
      this.commonRushConfigFolder,
      RushConstants.experimentsFilename
    );
    this.experimentsConfiguration = new ExperimentsConfiguration(experimentsConfigFile);

    const rushPluginsConfigFilename: string = path.join(
      this.commonRushConfigFolder,
      RushConstants.rushPluginsConfigFilename
    );
    this._rushPluginsConfiguration = new RushPluginsConfiguration(rushPluginsConfigFilename);

    this.npmOptions = new NpmOptionsConfiguration(rushConfigurationJson.npmOptions || {});
    this.yarnOptions = new YarnOptionsConfiguration(rushConfigurationJson.yarnOptions || {});
    try {
      this.pnpmOptions = PnpmOptionsConfiguration.loadFromJsonFileOrThrow(
        `${this.commonRushConfigFolder}/${RushConstants.pnpmConfigFilename}`,
        this.commonTempFolder
      );
      if (rushConfigurationJson.pnpmOptions) {
        throw new Error(
          'Because the new config file "common/config/rush/pnpm-config.json" is being used, ' +
            `you must remove the old setting "pnpmOptions" from ${RushConstants.rushJsonFilename}`
        );
      }
    } catch (error) {
      if (FileSystem.isNotExistError(error as Error)) {
        this.pnpmOptions = PnpmOptionsConfiguration.loadFromJsonObject(
          rushConfigurationJson.pnpmOptions || {},
          this.commonTempFolder
        );
      } else {
        throw error;
      }
    }

    // TODO: Add an actual "packageManager" field in rush.json
    const packageManagerFields: string[] = [];

    this.isPnpm = false;
    if (rushConfigurationJson.npmVersion) {
      this.packageManager = 'npm';
      this.packageManagerOptions = this.npmOptions;
      packageManagerFields.push('npmVersion');
    }

    if (rushConfigurationJson.pnpmVersion) {
      this.packageManager = 'pnpm';
      this.isPnpm = true;
      this.packageManagerOptions = this.pnpmOptions;
      packageManagerFields.push('pnpmVersion');
    }

    if (rushConfigurationJson.yarnVersion) {
      this.packageManager = 'yarn';
      this.packageManagerOptions = this.yarnOptions;
      packageManagerFields.push('yarnVersion');
    }

    if (packageManagerFields.length === 0) {
      throw new Error(
        `The ${RushConstants.rushJsonFilename} configuration must specify one of: npmVersion, pnpmVersion, or yarnVersion`
      );
    }

    if (packageManagerFields.length > 1) {
      throw new Error(
        `The ${RushConstants.rushJsonFilename} configuration cannot specify both ${packageManagerFields[0]}` +
          ` and ${packageManagerFields[1]} `
      );
    }

    if (this.packageManager === 'npm') {
      this.packageManagerToolVersion = rushConfigurationJson.npmVersion!;
      this.packageManagerWrapper = new NpmPackageManager(this.packageManagerToolVersion);
    } else if (this.packageManager === 'pnpm') {
      this.packageManagerToolVersion = rushConfigurationJson.pnpmVersion!;
      this.packageManagerWrapper = new PnpmPackageManager(this.packageManagerToolVersion);
    } else {
      this.packageManagerToolVersion = rushConfigurationJson.yarnVersion!;
      this.packageManagerWrapper = new YarnPackageManager(this.packageManagerToolVersion);
    }

    this.shrinkwrapFilename = this.packageManagerWrapper.shrinkwrapFilename;

    this.packageManagerToolFilename = path.resolve(
      path.join(
        this.commonTempFolder,
        `${this.packageManager}-local`,
        'node_modules',
        '.bin',
        `${this.packageManager}`
      )
    );

    RushConfiguration._validateCommonRushConfigFolder(
      this.commonRushConfigFolder,
      this.packageManagerWrapper,
      this.experimentsConfiguration,
      this.subspacesFeatureEnabled
    );

    this.projectFolderMinDepth =
      rushConfigurationJson.projectFolderMinDepth !== undefined
        ? rushConfigurationJson.projectFolderMinDepth
        : 1;
    if (this.projectFolderMinDepth < 1) {
      throw new Error('Invalid projectFolderMinDepth; the minimum possible value is 1');
    }

    this.projectFolderMaxDepth =
      rushConfigurationJson.projectFolderMaxDepth !== undefined
        ? rushConfigurationJson.projectFolderMaxDepth
        : 2;
    if (this.projectFolderMaxDepth < this.projectFolderMinDepth) {
      throw new Error('The projectFolderMaxDepth cannot be smaller than the projectFolderMinDepth');
    }

    this.allowMostlyStandardPackageNames = !!rushConfigurationJson.allowMostlyStandardPackageNames;
    this.packageNameParser = this.allowMostlyStandardPackageNames
      ? PackageNameParsers.mostlyStandard
      : PackageNameParsers.rushDefault;

    this.approvedPackagesPolicy = new ApprovedPackagesPolicy(this, rushConfigurationJson);

    this.gitAllowedEmailRegExps = [];
    this.gitSampleEmail = '';
    if (rushConfigurationJson.gitPolicy) {
      if (rushConfigurationJson.gitPolicy.sampleEmail) {
        this.gitSampleEmail = rushConfigurationJson.gitPolicy.sampleEmail;
      }

      if (rushConfigurationJson.gitPolicy.allowedEmailRegExps) {
        this.gitAllowedEmailRegExps = rushConfigurationJson.gitPolicy.allowedEmailRegExps;

        if (this.gitSampleEmail.trim().length < 1) {
          throw new Error(
            `The ${RushConstants.rushJsonFilename} file is missing the "sampleEmail" option, ` +
              'which is required when using "allowedEmailRegExps"'
          );
        }
      }

      if (rushConfigurationJson.gitPolicy.versionBumpCommitMessage) {
        this.gitVersionBumpCommitMessage = rushConfigurationJson.gitPolicy.versionBumpCommitMessage;
      }

      if (rushConfigurationJson.gitPolicy.changeLogUpdateCommitMessage) {
        this.gitChangeLogUpdateCommitMessage = rushConfigurationJson.gitPolicy.changeLogUpdateCommitMessage;
      }

      if (rushConfigurationJson.gitPolicy.changefilesCommitMessage) {
        this.gitChangefilesCommitMessage = rushConfigurationJson.gitPolicy.changefilesCommitMessage;
      }

      if (rushConfigurationJson.gitPolicy.tagSeparator) {
        this.gitTagSeparator = rushConfigurationJson.gitPolicy.tagSeparator;
      }
    }

    this.hotfixChangeEnabled = false;
    if (rushConfigurationJson.hotfixChangeEnabled) {
      this.hotfixChangeEnabled = rushConfigurationJson.hotfixChangeEnabled;
    }

    if (!rushConfigurationJson.repository) {
      rushConfigurationJson.repository = {};
    }

    this.repositoryDefaultBranch = rushConfigurationJson.repository.defaultBranch || DEFAULT_BRANCH;
    this.repositoryDefaultRemote = rushConfigurationJson.repository.defaultRemote || DEFAULT_REMOTE;
    const repositoryFieldWithMultipleUrls: IRushRepositoryJsonMultipleUrls =
      rushConfigurationJson.repository as IRushRepositoryJsonMultipleUrls;
    const repositoryFieldWithSingleUrl: IRushRepositoryJsonSingleUrl =
      rushConfigurationJson.repository as IRushRepositoryJsonSingleUrl;
    if (repositoryFieldWithMultipleUrls.urls) {
      if (repositoryFieldWithSingleUrl.url) {
        throw new Error("The 'repository.url' field cannot be used when 'repository.urls' is present");
      }

      this.repositoryUrls = repositoryFieldWithMultipleUrls.urls;
    } else if (repositoryFieldWithSingleUrl.url) {
      this.repositoryUrls = [repositoryFieldWithSingleUrl.url];
    } else {
      this.repositoryUrls = [];
    }

    this.telemetryEnabled = !!rushConfigurationJson.telemetryEnabled;
    this.eventHooks = new EventHooks(rushConfigurationJson.eventHooks || {});

    this.versionPolicyConfigurationFilePath = path.join(
      this.commonRushConfigFolder,
      RushConstants.versionPoliciesFilename
    );
    this.versionPolicyConfiguration = new VersionPolicyConfiguration(this.versionPolicyConfigurationFilePath);

    this.customTipsConfigurationFilePath = path.join(
      this.commonRushConfigFolder,
      RushConstants.customTipsFilename
    );
    this.customTipsConfiguration = new CustomTipsConfiguration(this.customTipsConfigurationFilePath);

    const variants: Set<string> = new Set();
    for (const variantOptions of rushConfigurationJson.variants ?? []) {
      const { variantName } = variantOptions;

      if (variants.has(variantName)) {
        throw new Error(`Duplicate variant named '${variantName}' specified in configuration.`);
      }

      variants.add(variantName);
    }

    this.variants = variants;

    this._pathTrees = new Map();
  }

  private _initializeAndValidateLocalProjects(): void {
    this._projects = [];
    this._projectsByName = new Map<string, RushConfigurationProject>();
    this._subspacesByName.clear();
    this._subspaces.length = 0;

    // Build the subspaces map
    const subspaceNames: string[] = [];
    let splitWorkspaceCompatibility: boolean = false;
    if (this.subspacesConfiguration?.subspacesEnabled) {
      splitWorkspaceCompatibility = this.subspacesConfiguration.splitWorkspaceCompatibility;

      subspaceNames.push(...this.subspacesConfiguration.subspaceNames);
    }
    if (subspaceNames.indexOf(RushConstants.defaultSubspaceName) < 0) {
      subspaceNames.push(RushConstants.defaultSubspaceName);
    }

    // Sort the subspaces in alphabetical order.  This ensures that they are processed
    // in a deterministic order by the various Rush algorithms.
    subspaceNames.sort();
    for (const subspaceName of subspaceNames) {
      const subspace: Subspace = new Subspace({
        subspaceName,
        rushConfiguration: this,
        splitWorkspaceCompatibility
      });
      this._subspacesByName.set(subspaceName, subspace);
      this._subspaces.push(subspace);
    }
    const defaultSubspace: Subspace | undefined = this._subspacesByName.get(
      RushConstants.defaultSubspaceName
    );
    if (!defaultSubspace) {
      throw new InternalError('The default subspace was not created');
    }

    // Look for rush projects in a seperate file first, and if it does not exist fallback onto rush.json

    const resolvedRushProjectsFilename: string = `${this.rushJsonFolder}/${RushConstants.rushProjectsFilename}`;
    let rushProjects: IRushConfigurationProjectJson[] | undefined;
    try {
      const rushProjectsJson: IRushProjectsJson = JsonFile.load(resolvedRushProjectsFilename);
      RushConfiguration._projectsJsonSchema.validateObject(rushProjectsJson, resolvedRushProjectsFilename);
      rushProjects = rushProjectsJson.projects;
    } catch (e) {
      if (!FileSystem.isNotExistError(e)) {
        throw e;
      }
    }
    if (this.rushConfigurationJson.projects) {
      if (rushProjects) {
        throw new Error(
          `When using the ${RushConstants.rushProjectsFilename} configuration file, the "projects" field of the ${RushConstants.rushJsonFilename} is no longer allowed.`
        );
      }
      rushProjects = this.rushConfigurationJson.projects;
    }

    if (!rushProjects) {
      throw new Error(
        `The rush.json is missing a projects field, and a seperate ${RushConstants.rushProjectsFilename} file is missing. Rush projects need to be defined in one of the two places.`
      );
    }
    // Sort the projects array in alphabetical order.  This ensures that the packages
    // are processed in a deterministic order by the various Rush algorithms.
    const sortedProjectJsons: IRushConfigurationProjectJson[] = rushProjects.slice(0);
    sortedProjectJsons.sort((a: IRushConfigurationProjectJson, b: IRushConfigurationProjectJson) =>
      a.packageName.localeCompare(b.packageName)
    );

    const allowedProjectTags: Set<string> | undefined = this.rushConfigurationJson.allowedProjectTags
      ? new Set(this.rushConfigurationJson.allowedProjectTags)
      : undefined;
    const usedTempNames: Set<string> = new Set();
    for (let i: number = 0, len: number = sortedProjectJsons.length; i < len; i++) {
      const projectJson: IRushConfigurationProjectJson = sortedProjectJsons[i];
      const tempProjectName: string | undefined = RushConfiguration._generateTempNameForProject(
        projectJson,
        usedTempNames
      );

      let subspace: Subspace | undefined = undefined;
      if (this.subspacesFeatureEnabled) {
        if (projectJson.subspaceName) {
          subspace = this._subspacesByName.get(projectJson.subspaceName);
          if (subspace === undefined) {
            throw new Error(
              `The project "${projectJson.packageName}" in ${RushConstants.rushJsonFilename} references` +
                ` a nonexistent subspace "${projectJson.subspaceName}"`
            );
          }
        }
      }
      if (subspace === undefined) {
        subspace = defaultSubspace;
      }

      const project: RushConfigurationProject = new RushConfigurationProject({
        projectJson,
        rushConfiguration: this,
        tempProjectName,
        allowedProjectTags,
        subspace
      });
      subspace._addProject(project);

      this._projects.push(project);
      if (this._projectsByName.has(project.packageName)) {
        throw new Error(
          `The project name "${project.packageName}" was specified more than once` +
            ` in the ${RushConstants.rushJsonFilename} configuration file.`
        );
      }
      this._projectsByName.set(project.packageName, project);
    }

    for (const project of this._projects) {
      project.decoupledLocalDependencies.forEach((decoupledLocalDependency: string) => {
        if (!this.getProjectByName(decoupledLocalDependency)) {
          throw new Error(
            `In ${RushConstants.rushJsonFilename}, the "${decoupledLocalDependency}" project does not exist,` +
              ` but was referenced by the decoupledLocalDependencies (previously cyclicDependencyProjects) for ${project.packageName}`
          );
        }
      });
      this.versionPolicyConfiguration.validate(this.projectsByName);

      // Consumer relationships will be established the first time one is requested
    }
  }

  /**
   * Loads the configuration data from an Rush.json configuration file and returns
   * an RushConfiguration object.
   */
  public static loadFromConfigurationFile(rushJsonFilename: string): RushConfiguration {
    let resolvedRushJsonFilename: string = path.resolve(rushJsonFilename);
    // Load the rush.json before we fix the casing. If the case is wrong on a case-sensitive filesystem,
    // the next line show throw.
    const rushConfigurationJson: IRushConfigurationJson = JsonFile.load(resolvedRushJsonFilename);

    try {
      resolvedRushJsonFilename = trueCasePathSync(resolvedRushJsonFilename);
    } catch (error) {
      /* ignore errors from true-case-path */
    }

    // Check the Rush version *before* we validate the schema, since if the version is outdated
    // then the schema may have changed. This should no longer be a problem after Rush 4.0 and the C2R wrapper,
    // but we'll validate anyway.
    const expectedRushVersion: string = rushConfigurationJson.rushVersion;

    const rushJsonBaseName: string = path.basename(resolvedRushJsonFilename);

    // If the version is missing or malformed, fall through and let the schema handle it.
    if (expectedRushVersion && semver.valid(expectedRushVersion)) {
      // Make sure the requested version isn't too old
      if (semver.lt(expectedRushVersion, MINIMUM_SUPPORTED_RUSH_JSON_VERSION)) {
        throw new Error(
          `${rushJsonBaseName} is version ${expectedRushVersion}, which is too old for this tool. ` +
            `The minimum supported version is ${MINIMUM_SUPPORTED_RUSH_JSON_VERSION}.`
        );
      }

      // Make sure the requested version isn't too new.
      //
      // If the major/minor versions are the same, then we consider the file to be compatible.
      // This is somewhat lax, e.g. "5.0.2-dev.3" will be assumed to be loadable by rush-lib 5.0.0.
      //
      // IMPORTANT: Whenever a breaking change is introduced for one of the config files, we must
      // increment the minor version number for Rush.
      if (
        semver.major(Rush.version) !== semver.major(expectedRushVersion) ||
        semver.minor(Rush.version) !== semver.minor(expectedRushVersion)
      ) {
        // If the major/minor are different, then make sure it's an older version.
        if (semver.lt(Rush.version, expectedRushVersion)) {
          throw new Error(
            `Unable to load ${rushJsonBaseName} because its RushVersion is` +
              ` ${rushConfigurationJson.rushVersion}, whereas @microsoft/rush-lib is version ${Rush.version}.` +
              ` Consider upgrading the library.`
          );
        }
      }
    }

    RushConfiguration._jsonSchema.validateObject(rushConfigurationJson, resolvedRushJsonFilename);

    return new RushConfiguration(rushConfigurationJson, resolvedRushJsonFilename);
  }

  public static tryLoadFromDefaultLocation(
    options?: ITryFindRushJsonLocationOptions
  ): RushConfiguration | undefined {
    const rushJsonLocation: string | undefined = RushConfiguration.tryFindRushJsonLocation(options);
    if (rushJsonLocation) {
      return RushConfiguration.loadFromConfigurationFile(rushJsonLocation);
    }
  }

  public static loadFromDefaultLocation(options?: ITryFindRushJsonLocationOptions): RushConfiguration {
    const rushConfiguration: RushConfiguration | undefined =
      RushConfiguration.tryLoadFromDefaultLocation(options);

    if (rushConfiguration) {
      return rushConfiguration;
    } else {
      throw Utilities.getRushConfigNotFoundError();
    }
  }

  /**
   * Find the rush.json location and return the path, or undefined if a rush.json can't be found.
   *
   * @privateRemarks
   * Keep this in sync with `findRushJsonLocation` in `rush-sdk/src/index.ts`.
   */
  public static tryFindRushJsonLocation(options?: ITryFindRushJsonLocationOptions): string | undefined {
    const optionsIn: ITryFindRushJsonLocationOptions = options || {};
    const verbose: boolean = optionsIn.showVerbose || false;
    let currentFolder: string = optionsIn.startingFolder || process.cwd();
    let parentFolder: string = path.dirname(currentFolder);

    // look upwards at parent folders until we find a folder containing rush.json,
    // or we reach the root directory without finding a rush.json file
    while (parentFolder && parentFolder !== currentFolder) {
      const rushJsonFilename: string = path.join(currentFolder, RushConstants.rushJsonFilename);
      if (FileSystem.exists(rushJsonFilename)) {
        if (currentFolder !== optionsIn.startingFolder && verbose) {
          // eslint-disable-next-line no-console
          console.log('Found configuration in ' + rushJsonFilename);
        }

        if (verbose) {
          // eslint-disable-next-line no-console
          console.log('');
        }

        return rushJsonFilename;
      }
      currentFolder = parentFolder;
      parentFolder = path.dirname(currentFolder);
    }

    // no match
    return undefined;
  }

  /**
   * This generates the unique names that are used to create temporary projects
   * in the Rush common folder.
   * NOTE: sortedProjectJsons is sorted by the caller.
   */
  private static _generateTempNameForProject(
    projectJson: IRushConfigurationProjectJson,
    usedTempNames: Set<string>
  ): string {
    // If the name is "@ms/MyProject", extract the "MyProject" part
    const unscopedName: string = PackageNameParsers.permissive.getUnscopedName(projectJson.packageName);

    // Generate a unique like name "@rush-temp/MyProject", or "@rush-temp/MyProject-2" if
    // there is a naming conflict
    let counter: number = 0;
    let tempProjectName: string = `${RushConstants.rushTempNpmScope}/${unscopedName}`;
    while (usedTempNames.has(tempProjectName)) {
      ++counter;
      tempProjectName = `${RushConstants.rushTempNpmScope}/${unscopedName}-${counter}`;
    }
    usedTempNames.add(tempProjectName);

    return tempProjectName;
  }

  /**
   * If someone adds a config file in the "common/rush/config" folder, it would be a bad
   * experience for Rush to silently ignore their file simply because they misspelled the
   * filename, or maybe it's an old format that's no longer supported.  The
   * _validateCommonRushConfigFolder() function makes sure that this folder only contains
   * recognized config files.
   */
  private static _validateCommonRushConfigFolder(
    commonRushConfigFolder: string,
    packageManagerWrapper: PackageManager,
    experiments: ExperimentsConfiguration,
    subspacesFeatureEnabled: boolean
  ): void {
    if (!FileSystem.exists(commonRushConfigFolder)) {
      // eslint-disable-next-line no-console
      console.log(`Creating folder: ${commonRushConfigFolder}`);
      FileSystem.ensureFolder(commonRushConfigFolder);
      return;
    }

    for (const filename of FileSystem.readFolderItemNames(commonRushConfigFolder)) {
      // Ignore things that aren't actual files
      const stat: FileSystemStats = FileSystem.getLinkStatistics(path.join(commonRushConfigFolder, filename));
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        continue;
      }

      // Ignore harmless file extensions
      const fileExtension: string = path.extname(filename);
      if (['.bak', '.disabled', '.md', '.old', '.orig'].indexOf(fileExtension) >= 0) {
        continue;
      }

      // Check if there are prohibited files when subspaces is enabled
      if (subspacesFeatureEnabled) {
        if (filename === RushConstants.pnpmfileV6Filename || filename === RushConstants.pnpmfileV1Filename) {
          throw new Error(
            'When the subspaces feature is enabled, a separate lockfile is stored in each subspace folder. ' +
              `To avoid confusion, remove this file: ${commonRushConfigFolder}/${filename}`
          );
        }
      }

      // Ignore hidden files such as ".DS_Store"
      if (filename.startsWith('.')) {
        continue;
      }

      if (filename.startsWith('deploy-') && fileExtension === '.json') {
        // Ignore "rush deploy" files, which use the naming pattern "deploy-<scenario-name>.json".
        continue;
      }

      const knownSet: Set<string> = new Set<string>(knownRushConfigFilenames.map((x) => x.toUpperCase()));

      // Add the shrinkwrap filename for the package manager to the known set.
      knownSet.add(packageManagerWrapper.shrinkwrapFilename.toUpperCase());

      // If the package manager is pnpm, then also add the pnpm file to the known set.
      if (packageManagerWrapper.packageManager === 'pnpm') {
        const pnpmPackageManager: PnpmPackageManager = packageManagerWrapper as PnpmPackageManager;
        knownSet.add(pnpmPackageManager.pnpmfileFilename.toUpperCase());
      }

      // Is the filename something we know?  If not, report an error.
      if (!knownSet.has(filename.toUpperCase())) {
        throw new Error(
          `An unrecognized file "${filename}" was found in the Rush config folder:` +
            ` ${commonRushConfigFolder}`
        );
      }
    }

    const pinnedVersionsFilename: string = path.join(
      commonRushConfigFolder,
      RushConstants.pinnedVersionsFilename
    );
    if (FileSystem.exists(pinnedVersionsFilename)) {
      throw new Error(
        'The "pinned-versions.json" config file is no longer supported;' +
          ' please move your settings to the "preferredVersions" field of a "common-versions.json" config file.' +
          ` (See the ${RushConstants.rushWebSiteUrl} documentation for details.)\n\n` +
          pinnedVersionsFilename
      );
    }
  }

  /**
   * The fully resolved path for the "autoinstallers" folder.
   * Example: `C:\MyRepo\common\autoinstallers`
   */
  public get commonAutoinstallersFolder(): string {
    return path.join(this.commonFolder, 'autoinstallers');
  }

  /**
   * The folder where rush-plugin options json files are stored.
   * Example: `C:\MyRepo\common\config\rush-plugins`
   */
  public get rushPluginOptionsFolder(): string {
    return path.join(this.commonFolder, 'config', 'rush-plugins');
  }

  /**
   * The full path of the temporary shrinkwrap file that is used during "rush install".
   * This file may get rewritten by the package manager during installation.
   * @remarks
   * This property merely reports the filename; the file itself may not actually exist.
   * Example: `C:\MyRepo\common\temp\npm-shrinkwrap.json` or `C:\MyRepo\common\temp\pnpm-lock.yaml`
   *
   * @deprecated Introduced with subspaces is subspace specific tempShrinkwrapFilename accessible from the Subspace class.
   */
  public get tempShrinkwrapFilename(): string {
    if (this.subspacesFeatureEnabled) {
      throw new Error(
        'tempShrinkwrapFilename() is not available when using subspaces. Use the subspace specific temp shrinkwrap filename.'
      );
    }
    return path.join(this.commonTempFolder, this.shrinkwrapFilename);
  }

  /**
   * The full path of a backup copy of tempShrinkwrapFilename. This backup copy is made
   * before installation begins, and can be compared to determine how the package manager
   * modified tempShrinkwrapFilename.
   * @remarks
   * This property merely reports the filename; the file itself may not actually exist.
   * Example: `C:\MyRepo\common\temp\npm-shrinkwrap-preinstall.json`
   * or `C:\MyRepo\common\temp\pnpm-lock-preinstall.yaml`
   *
   * @deprecated Introduced with subspaces is subspace specific tempShrinkwrapPreinstallFilename accessible from the Subspace class.
   */
  public get tempShrinkwrapPreinstallFilename(): string {
    if (this.subspacesFeatureEnabled) {
      throw new Error(
        'tempShrinkwrapPreinstallFilename() is not available when using subspaces. Use the subspace specific temp shrinkwrap preinstall filename.'
      );
    }
    const parsedPath: path.ParsedPath = path.parse(this.tempShrinkwrapFilename);
    return path.join(parsedPath.dir, parsedPath.name + '-preinstall' + parsedPath.ext);
  }

  /**
   * Returns an English phrase such as "shrinkwrap file" that can be used in logging messages
   * to refer to the shrinkwrap file using appropriate terminology for the currently selected
   * package manager.
   */
  public get shrinkwrapFilePhrase(): string {
    return `shrinkwrap file (${this.shrinkwrapFilename})`;
  }

  /**
   * The filename of the build dependency data file.  By default this is
   * called 'rush-link.json' resides in the Rush common folder.
   * Its data structure is defined by IRushLinkJson.
   *
   * Example: `C:\MyRepo\common\temp\rush-link.json`
   *
   * @deprecated The "rush-link.json" file was removed in Rush 5.30.0.
   * Use `RushConfigurationProject.localDependencyProjects` instead.
   */
  public get rushLinkJsonFilename(): string {
    throw new Error(
      'The "rush-link.json" file was removed in Rush 5.30.0. Use ' +
        'RushConfigurationProject.localDependencyProjects instead.'
    );
  }

  /**
   * The default fully-qualified git remote branch of the repository. This helps "rush change" find the right branch to compare against.
   */
  public get repositoryDefaultFullyQualifiedRemoteBranch(): string {
    return `${this.repositoryDefaultRemote}/${this.repositoryDefaultBranch}`;
  }

  public get projects(): RushConfigurationProject[] {
    if (!this._projects) {
      this._initializeAndValidateLocalProjects();
    }

    return this._projects!;
  }

  /**
   * @beta
   */
  public get defaultSubspace(): Subspace {
    // TODO: Enable the default subspace to be obtained without initializing the full set of all projects
    if (!this._projects) {
      this._initializeAndValidateLocalProjects();
    }
    const defaultSubspace: Subspace | undefined = this.tryGetSubspace(RushConstants.defaultSubspaceName);
    if (!defaultSubspace) {
      throw new InternalError('Default subspace was not created');
    }
    return defaultSubspace;
  }

  /**
   * A list of all the available subspaces in this workspace.
   * @beta
   */
  public get subspaces(): readonly Subspace[] {
    if (!this._projects) {
      this._initializeAndValidateLocalProjects();
    }
    return this._subspaces;
  }

  /**
   * @beta
   */
  public tryGetSubspace(subspaceName: string): Subspace | undefined {
    if (!this._projects) {
      this._initializeAndValidateLocalProjects();
    }
    const subspace: Subspace | undefined = this._subspacesByName.get(subspaceName);
    if (!subspace) {
      // If the name is not even valid, that is more important information than if the subspace doesn't exist
      SubspacesConfiguration.requireValidSubspaceName(
        subspaceName,
        this.subspacesConfiguration?.splitWorkspaceCompatibility
      );
    }
    return subspace;
  }

  /**
   * @beta
   */
  public getSubspace(subspaceName: string): Subspace {
    const subspace: Subspace | undefined = this.tryGetSubspace(subspaceName);
    if (!subspace) {
      throw new Error(`The specified subspace "${subspaceName}" does not exist`);
    }
    return subspace;
  }

  /**
   * Returns the set of subspaces that the given projects belong to
   * @beta
   */
  public getSubspacesForProjects(projects: Iterable<RushConfigurationProject>): ReadonlySet<Subspace> {
    if (!this._projects) {
      this._initializeAndValidateLocalProjects();
    }

    const subspaceSet: Set<Subspace> = new Set();
    for (const project of projects) {
      subspaceSet.add(project.subspace);
    }

    return subspaceSet;
  }

  /**
   * @beta
   */
  public get projectsByName(): ReadonlyMap<string, RushConfigurationProject> {
    if (!this._projectsByName) {
      this._initializeAndValidateLocalProjects();
    }

    return this._projectsByName!;
  }

  /**
   * Obtains the mapping from custom tags to projects.
   * @beta
   */
  public get projectsByTag(): ReadonlyMap<string, ReadonlySet<RushConfigurationProject>> {
    if (!this._projectsByTag) {
      const projectsByTag: Map<string, Set<RushConfigurationProject>> = new Map();
      for (const project of this.projects) {
        for (const tag of project.tags) {
          let collection: Set<RushConfigurationProject> | undefined = projectsByTag.get(tag);
          if (!collection) {
            projectsByTag.set(tag, (collection = new Set()));
          }
          collection.add(project);
        }
      }
      this._projectsByTag = projectsByTag;
    }
    return this._projectsByTag;
  }

  /**
   * Settings from the common-versions.json config file.
   * @remarks
   * If the common-versions.json file is missing, this property will not be undefined.
   * Instead it will be initialized in an empty state, and calling CommonVersionsConfiguration.save()
   * will create the file.
   *
   * @deprecated Use `getCommonVersions` instead, which gets the correct common version data
   * for a given active variant.
   */
  public get commonVersions(): CommonVersionsConfiguration {
    return this.defaultSubspace.getCommonVersions(undefined);
  }

  /**
   * Gets the currently-installed variant, if an installation has occurred.
   * For Rush operations which do not take a --variant parameter, this method
   * determines which variant, if any, was last specified when performing "rush install"
   * or "rush update".
   */
  public async getCurrentlyInstalledVariantAsync(): Promise<string | undefined> {
    if (!this._currentVariantJsonLoadingPromise) {
      this._currentVariantJsonLoadingPromise = this._loadCurrentVariantJsonAsync();
    }

    return (await this._currentVariantJsonLoadingPromise)?.variant ?? undefined;
  }

  /**
   * @deprecated Use {@link Subspace.getCommonVersionsFilePath} instead
   */
  public getCommonVersionsFilePath(subspace?: Subspace, variant?: string): string {
    return (subspace ?? this.defaultSubspace).getCommonVersionsFilePath(variant);
  }

  /**
   * @deprecated Use {@link Subspace.getCommonVersions} instead
   */
  public getCommonVersions(subspace?: Subspace, variant?: string): CommonVersionsConfiguration {
    return (subspace ?? this.defaultSubspace).getCommonVersions(variant);
  }

  /**
   * Returns a map of all direct dependencies that only have a single semantic version specifier.
   *
   * @param subspace - The subspace to use
   * @param variant - The name of the current variant in use by the active command.
   *
   * @returns A map of dependency name --\> version specifier for implicitly preferred versions.
   */
  public getImplicitlyPreferredVersions(subspace?: Subspace, variant?: string): Map<string, string> {
    // TODO: During the next major release of Rush, replace this `require` call with a dynamic import, and
    // change this function to be async.
    const DependencyAnalyzerModule: typeof DependencyAnalyzerModuleType = require('../logic/DependencyAnalyzer');
    const dependencyAnalyzer: DependencyAnalyzerModuleType.DependencyAnalyzer =
      DependencyAnalyzerModule.DependencyAnalyzer.forRushConfiguration(this);
    const dependencyAnalysis: DependencyAnalyzerModuleType.IDependencyAnalysis =
      dependencyAnalyzer.getAnalysis(subspace, variant, false);
    return dependencyAnalysis.implicitlyPreferredVersionByPackageName;
  }

  /**
   * @deprecated Use {@link Subspace.getRepoStateFilePath} instead
   */
  public getRepoStateFilePath(subspace?: Subspace): string {
    return (subspace ?? this.defaultSubspace).getRepoStateFilePath();
  }

  /**
   * @deprecated Use {@link Subspace.getRepoState} instead
   */
  public getRepoState(subspace?: Subspace): RepoStateFile {
    return (subspace ?? this.defaultSubspace).getRepoState();
  }

  /**
   * @deprecated Use {@link Subspace.getCommittedShrinkwrapFilePath} instead
   */
  public getCommittedShrinkwrapFilename(subspace?: Subspace, variant?: string): string {
    return (subspace ?? this.defaultSubspace).getCommittedShrinkwrapFilePath(variant);
  }

  /**
   * @deprecated Use {@link Subspace.getPnpmfilePath} instead
   */
  public getPnpmfilePath(subspace?: Subspace, variant?: string): string {
    return (subspace ?? this.defaultSubspace).getPnpmfilePath(variant);
  }

  /**
   * Looks up a project in the projectsByName map.  If the project is not found,
   * then undefined is returned.
   */
  public getProjectByName(projectName: string): RushConfigurationProject | undefined {
    return this.projectsByName.get(projectName);
  }

  /**
   * This is used e.g. by command-line interfaces such as "rush build --to example".
   * If "example" is not a project name, then it also looks for a scoped name
   * like `@something/example`.  If exactly one project matches this heuristic, it
   * is returned.  Otherwise, undefined is returned.
   */
  public findProjectByShorthandName(shorthandProjectName: string): RushConfigurationProject | undefined {
    // Is there an exact match?
    let result: RushConfigurationProject | undefined = this.projectsByName.get(shorthandProjectName);
    if (result) {
      return result;
    }

    // Is there an approximate match?
    for (const project of this.projects) {
      if (this.packageNameParser.getUnscopedName(project.packageName) === shorthandProjectName) {
        if (result) {
          // Ambiguous -- there is more than one match
          return undefined;
        } else {
          result = project;
        }
      }
    }
    return result;
  }

  /**
   * Looks up a project by its RushConfigurationProject.tempProjectName field.
   * @returns The found project, or undefined if no match was found.
   */
  public findProjectByTempName(tempProjectName: string): RushConfigurationProject | undefined {
    // Is there an approximate match?
    for (const project of this.projects) {
      if (project.tempProjectName === tempProjectName) {
        return project;
      }
    }
    return undefined;
  }

  /**
   * @returns An optimized lookup engine to find a project by its path relative to the specified root.
   * @beta
   */
  public getProjectLookupForRoot(rootPath: string): LookupByPath<RushConfigurationProject> {
    let pathTree: LookupByPath<RushConfigurationProject> | undefined = this._pathTrees.get(rootPath);
    if (!pathTree) {
      this._pathTrees.set(rootPath, (pathTree = new LookupByPath()));
      for (const project of this.projects) {
        const relativePath: string = path.relative(rootPath, project.projectFolder);
        pathTree.setItemFromSegments(LookupByPath.iteratePathSegments(relativePath, path.sep), project);
      }
    }
    return pathTree;
  }

  /**
   * Returns the project for which the specified path is underneath that project's folder.
   * If the path is not under any project's folder, returns undefined.
   */
  public tryGetProjectForPath(currentFolderPath: string): RushConfigurationProject | undefined {
    // TODO: Improve the method in which a package is found, perhaps without having to sort / loop though the entire package list
    const resolvedPath: string = path.resolve(currentFolderPath);
    const sortedProjects: RushConfigurationProject[] = this.projects.sort(
      (a, b) => b.projectFolder.length - a.projectFolder.length
    );
    for (const project of sortedProjects) {
      if (Path.isUnderOrEqual(resolvedPath, project.projectFolder)) {
        return project;
      }
    }
    return undefined;
  }

  private async _loadCurrentVariantJsonAsync(): Promise<ICurrentVariantJson | undefined> {
    try {
      return await JsonFile.loadAsync(this.currentVariantJsonFilePath);
    } catch (e) {
      if (!FileSystem.isNotExistError(e)) {
        throw e;
      }
    }
  }
}
