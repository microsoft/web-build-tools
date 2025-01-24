// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * Constants used by the Rush tool.
 * @beta
 *
 * @remarks
 *
 * These are NOT part of the public API surface for rush-lib.
 * The rationale is that we don't want people implementing custom parsers for
 * the Rush config files; instead, they should rely on the official APIs from rush-lib.
 */
export class RushConstants {
  /**
   * The filename ("rush.json") for the root-level configuration file.
   */
  public static readonly rushJsonFilename: 'rush.json' = 'rush.json';

  /**
   * The filename ("rush-projects.json") for the root-level projects configuration file.
   */
  public static readonly rushProjectsFilename: 'rush-projects.json' = 'rush-projects.json';

  /**
   * The filename ("browser-approved-packages.json") for an optional policy configuration file
   * that stores a list of NPM packages that have been approved for usage by Rush projects.
   * This is part of a pair of config files, one for projects that run in a web browser
   * (e.g. whose approval criteria mostly focuses on licensing and code size), and one for everywhere else
   * (e.g. tooling projects whose approval criteria mostly focuses on avoiding node_modules sprawl).
   */
  public static readonly browserApprovedPackagesFilename: 'browser-approved-packages.json' =
    'browser-approved-packages.json';

  /**
   * The folder name ("changes") where change files will be stored.
   */
  public static readonly changeFilesFolderName: 'changes' = 'changes';

  /**
   * The filename ("nonbrowser-approved-packages.json") for an optional policy configuration file
   * that stores a list of NPM packages that have been approved for usage by Rush projects.
   * This is part of a pair of config files, one for projects that run in a web browser
   * (e.g. whose approval criteria mostly focuses on licensing and code size), and one for everywhere else
   * (e.g. tooling projects whose approval criteria mostly focuses on avoiding node_modules sprawl).
   */
  public static readonly nonbrowserApprovedPackagesFilename: 'nonbrowser-approved-packages.json' =
    'nonbrowser-approved-packages.json';

  /**
   * The folder name ("common") where Rush's common data will be stored.
   */
  public static readonly commonFolderName: 'common' = 'common';

  /**
   * The NPM scope ("\@rush-temp") that is used for Rush's temporary projects.
   */
  public static readonly rushTempNpmScope: '@rush-temp' = '@rush-temp';

  /**
   * The folder name ("variants") under which named variant configurations for
   * alternate dependency sets may be found.
   * Example: `C:\MyRepo\common\config\rush\variants`
   */
  public static readonly rushVariantsFolderName: 'variants' = 'variants';

  /**
   * The folder name ("temp") under the common folder, or under the .rush folder in each project's directory where
   * temporary files will be stored.
   * Example: `C:\MyRepo\common\temp`
   */
  public static readonly rushTempFolderName: 'temp' = 'temp';

  /**
   * The folder name ("projects") where temporary projects will be stored.
   * Example: `C:\MyRepo\common\temp\projects`
   */
  public static readonly rushTempProjectsFolderName: 'projects' = 'projects';

  /**
   * The filename ("npm-shrinkwrap.json") used to store an installation plan for the NPM package manger.
   */
  public static readonly npmShrinkwrapFilename: 'npm-shrinkwrap.json' = 'npm-shrinkwrap.json';

  /**
   * Number of installation attempts
   */
  public static readonly defaultMaxInstallAttempts: 1 = 1;

  /**
   * The filename ("pnpm-lock.yaml") used to store an installation plan for the PNPM package manger
   * (PNPM version 3.x and later).
   */
  public static readonly pnpmV3ShrinkwrapFilename: 'pnpm-lock.yaml' = 'pnpm-lock.yaml';

  /**
   * The filename ("pnpmfile.js") used to add custom configuration to PNPM (PNPM version 1.x and later).
   */
  public static readonly pnpmfileV1Filename: 'pnpmfile.js' = 'pnpmfile.js';

  /**
   * The filename (".pnpmfile.cjs") used to add custom configuration to PNPM (PNPM version 6.x and later).
   */
  public static readonly pnpmfileV6Filename: '.pnpmfile.cjs' = '.pnpmfile.cjs';

  /**
   * The filename (".modules.yaml") used by pnpm to specify configurations in the node_modules directory
   */
  public static readonly pnpmModulesFilename: '.modules.yaml' = '.modules.yaml';

  /**
   * The filename ("global-pnpmfile.cjs") used to add custom configuration to subspaces
   */
  public static readonly pnpmfileGlobalFilename: 'global-pnpmfile.cjs' = 'global-pnpmfile.cjs';

  /**
   * The folder name used to store patch files for pnpm
   * Example: `C:\MyRepo\common\config\pnpm-patches`
   * Example: `C:\MyRepo\common\temp\patches`
   */
  public static readonly pnpmPatchesFolderName: 'patches' = 'patches';

  /**
   * The folder name under `/common/temp` used to store checked-in patches.
   * Example: `C:\MyRepo\common\pnpm-patches`
   */
  public static readonly pnpmPatchesCommonFolderName: `pnpm-patches` = `pnpm-${RushConstants.pnpmPatchesFolderName}`;

  /**
   * The filename ("shrinkwrap.yaml") used to store state for pnpm
   */
  public static readonly yarnShrinkwrapFilename: 'yarn.lock' = 'yarn.lock';

  /**
   * The folder name ("node_modules") where NPM installs its packages.
   */
  public static readonly nodeModulesFolderName: 'node_modules' = 'node_modules';

  /**
   * The filename ("pinned-versions.json") for an old configuration file that
   * that is no longer supported.
   *
   * @deprecated This feature has been superseded by the "preferredVersions" setting
   * in common-versions.json
   */
  // NOTE: Although this is marked as "deprecated", we will probably never retire it,
  // since we always want to report the warning when someone upgrades an old repo.
  public static readonly pinnedVersionsFilename: 'pinned-versions.json' = 'pinned-versions.json';

  /**
   * The filename ("common-versions.json") for an optional configuration file
   * that stores dependency version information that affects all projects in the repo.
   * This configuration file should go in the "common/config/rush" folder.
   */
  public static readonly commonVersionsFilename: 'common-versions.json' = 'common-versions.json';

  /**
   * The filename ("repo-state.json") for a file used by Rush to
   * store the state of various features as they stand in the repo.
   */
  public static readonly repoStateFilename: 'repo-state.json' = 'repo-state.json';

  /**
   * The filename ("custom-tips.json") for the file used by Rush to
   * print user-customized messages.
   * This configuration file should go in the "common/config/rush" folder.
   */
  public static readonly customTipsFilename: 'custom-tips.json' = 'custom-tips.json';

  /**
   * The name of the per-project folder where project-specific Rush files are stored. For example,
   * the package-deps files, which are used by commands to determine if a particular project needs to be rebuilt.
   */
  public static readonly projectRushFolderName: '.rush' = '.rush';

  /**
   * Custom command line configuration file, which is used by rush for implementing
   * custom command and options.
   */
  public static readonly commandLineFilename: 'command-line.json' = 'command-line.json';

  public static readonly versionPoliciesFilename: 'version-policies.json' = 'version-policies.json';

  /**
   * Experiments configuration file.
   */
  public static readonly experimentsFilename: 'experiments.json' = 'experiments.json';

  /**
   * Pnpm configuration file
   */
  public static readonly pnpmConfigFilename: 'pnpm-config.json' = 'pnpm-config.json';

  /**
   * Rush plugins configuration file name.
   */
  public static readonly rushPluginsConfigFilename: 'rush-plugins.json' = 'rush-plugins.json';

  /**
   * Rush plugin manifest file name.
   */
  public static readonly rushPluginManifestFilename: 'rush-plugin-manifest.json' =
    'rush-plugin-manifest.json';

  /**
   * The artifactory.json configuration file name.
   */
  public static readonly artifactoryFilename: 'artifactory.json' = 'artifactory.json';

  /**
   * The subspaces.json configuration file name
   */
  public static readonly subspacesConfigFilename: 'subspaces.json' = 'subspaces.json';

  /**
   * The name of the default subspace if one isn't specified but subspaces is enabled.
   */
  public static readonly defaultSubspaceName: 'default' = 'default';

  /**
   * Build cache configuration file.
   */
  public static readonly buildCacheFilename: 'build-cache.json' = 'build-cache.json';

  /**
   * Build cache version number, incremented when the logic to create cache entries changes.
   * Changing this ensures that cache entries generated by an old version will no longer register as a cache hit.
   */
  public static readonly buildCacheVersion: 1 = 1;

  /**
   * Cobuild configuration file.
   */
  public static readonly cobuildFilename: 'cobuild.json' = 'cobuild.json';

  /**
   * Per-project configuration filename.
   */
  public static readonly rushProjectConfigFilename: 'rush-project.json' = 'rush-project.json';

  /**
   * The URL ("http://rushjs.io") for the Rush web site.
   */
  public static readonly rushWebSiteUrl: 'https://rushjs.io' = 'https://rushjs.io';

  /**
   * The name of the NPM package for the Rush tool ("\@microsoft/rush").
   */
  public static readonly rushPackageName: '@microsoft/rush' = '@microsoft/rush';

  /**
   * The folder name ("rush-recycler") where Rush moves large folder trees
   * before asynchronously deleting them.
   */
  public static readonly rushRecyclerFolderName: 'rush-recycler' = 'rush-recycler';

  /**
   * The name of the file to drop in project-folder/.rush/temp/ containing a listing of the project's direct
   * and indirect dependencies. This is used to detect if a project's dependencies have changed since the last build.
   */
  public static readonly projectShrinkwrapFilename: 'shrinkwrap-deps.json' = 'shrinkwrap-deps.json';

  /**
   * The value of the "commandKind" property for a bulk command in command-line.json
   */
  public static readonly bulkCommandKind: 'bulk' = 'bulk';

  /**
   * The value of the "commandKind" property for a global command in command-line.json
   */
  public static readonly globalCommandKind: 'global' = 'global';

  /**
   * The value of the "commandKind" property for a phased command in command-line.json
   */
  public static readonly phasedCommandKind: 'phased' = 'phased';

  /**
   * The name of the incremental build command.
   */
  public static readonly buildCommandName: 'build' = 'build';

  /**
   * The name of the non-incremental build command.
   */
  public static readonly rebuildCommandName: 'rebuild' = 'rebuild';

  public static readonly updateCloudCredentialsCommandName: 'update-cloud-credentials' =
    'update-cloud-credentials';

  /**
   * When a hash generated that contains multiple input segments, this character may be used
   * to separate them to avoid issues like
   * crypto.createHash('sha1').update('a').update('bc').digest('hex') === crypto.createHash('sha1').update('ab').update('c').digest('hex')
   */
  public static readonly hashDelimiter: '|' = '|';

  /**
   * The name of the per-user Rush configuration data folder.
   */
  public static readonly rushUserConfigurationFolderName: '.rush-user' = '.rush-user';

  /**
   * The name of the project `rush-logs` folder.
   */
  public static readonly rushLogsFolderName: 'rush-logs' = 'rush-logs';

  /**
   * The expected prefix for phase names in "common/config/rush/command-line.json"
   */
  public static readonly phaseNamePrefix: '_phase:' = '_phase:';

  /**
   * The default debounce value for Rush multi-project watch mode. When watching, controls
   * how long to wait after the last encountered file system event before execution. If another
   * file system event occurs in this interval, the timeout will reset.
   */
  public static readonly defaultWatchDebounceMs: 1000 = 1000;

  /**
   * The name of the parameter that can be used to bypass policies.
   */
  public static readonly bypassPolicyFlagLongName: '--bypass-policy' = '--bypass-policy';

  /**
   * Merge Queue ignore configuration file.
   */
  public static readonly mergeQueueIgnoreFileName: '.mergequeueignore' = '.mergequeueignore';

  /**
   * The filename ("project-impact-graph.yaml") for the project impact graph file.
   */
  public static readonly projectImpactGraphFilename: 'project-impact-graph.yaml' =
    'project-impact-graph.yaml';

  /**
   * The filename for the last link flag
   */
  public static readonly lastLinkFlagFilename: 'last-link' = 'last-link';

  /**
   * The filename for the Rush alerts config file.
   */
  public static readonly rushAlertsConfigFilename: 'rush-alerts.json' = 'rush-alerts.json';

  /**
   * The filename for the machine-generated file that tracks state for Rush alerts.
   */
  public static readonly rushAlertsStateFilename: 'rush-alerts-state.json' = 'rush-alerts-state.json';

  /**
   * The filename for the file that tracks which variant is currently installed.
   */
  public static readonly currentVariantsFilename: 'current-variants.json' = 'current-variants.json';
}
