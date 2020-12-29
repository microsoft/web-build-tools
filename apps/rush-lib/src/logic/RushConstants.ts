// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * Constants used by the Rush tool.
 *
 * @remarks
 *
 * These are NOT part of the public API surface for rush-lib.
 * The rationale is that we don't want people implementing custom parsers for
 * the Rush config files; instead, they should rely on the official APIs from rush-lib.
 */
export class RushConstants {
  /**
   * The filename ("browser-approved-packages.json") for an optional policy configuration file
   * that stores a list of NPM packages that have been approved for usage by Rush projects.
   * This is part of a pair of config files, one for projects that run in a web browser
   * (e.g. whose approval criteria mostly focuses on licensing and code size), and one for everywhere else
   * (e.g. tooling projects whose approval criteria mostly focuses on avoiding node_modules sprawl).
   */
  public static readonly browserApprovedPackagesFilename: string = 'browser-approved-packages.json';

  /**
   * The folder name ("changes") where change files will be stored.
   */
  public static readonly changeFilesFolderName: string = 'changes';

  /**
   * The filename for file globs which should be ignored when running `rush change`. Uses the same syntax
   * as `.gitignore`, `.npmignore`, `.eslintignore` etc.
   */
  public static readonly changeignoreFileName: string = '.changeignore';

  /**
   * The filename ("nonbrowser-approved-packages.json") for an optional policy configuration file
   * that stores a list of NPM packages that have been approved for usage by Rush projects.
   * This is part of a pair of config files, one for projects that run in a web browser
   * (e.g. whose approval criteria mostly focuses on licensing and code size), and one for everywhere else
   * (e.g. tooling projects whose approval criteria mostly focuses on avoiding node_modules sprawl).
   */
  public static readonly nonbrowserApprovedPackagesFilename: string = 'nonbrowser-approved-packages.json';

  /**
   * The folder name ("common") where Rush's common data will be stored.
   */
  public static readonly commonFolderName: string = 'common';

  /**
   * The NPM scope ("@rush-temp") that is used for Rush's temporary projects.
   */
  public static readonly rushTempNpmScope: string = '@rush-temp';

  /**
   * The folder name ("temp") under the common folder, or under the .rush folder in each project's directory where
   * temporary files will be stored.
   * Example: `C:\MyRepo\common\temp`
   */
  public static readonly rushTempFolderName: string = 'temp';

  /**
   * The folder name ("projects") where temporary projects will be stored.
   * Example: `C:\MyRepo\common\temp\projects`
   */
  public static readonly rushTempProjectsFolderName: string = 'projects';

  /**
   * The folder name ("variants") under which named variant configurations for
   * alternate dependency sets may be found.
   * Example: "C:\MyRepo\common\config\rush\variants"
   */
  public static readonly rushVariantsFolderName: string = 'variants';

  /**
   * The filename ("npm-shrinkwrap.json") used to store an installation plan for the NPM package manger.
   */
  public static readonly npmShrinkwrapFilename: string = 'npm-shrinkwrap.json';

  /**
   * The filename ("shrinkwrap.yaml") used to store an installation plan for the PNPM package manger
   * (PNPM version 2.x and earlier).
   */
  public static readonly pnpmV1ShrinkwrapFilename: string = 'shrinkwrap.yaml';

  /**
   * Number of installation attempts
   */
  public static readonly defaultMaxInstallAttempts: number = 3;

  /**
   * The filename ("pnpm-lock.yaml") used to store an installation plan for the PNPM package manger
   * (PNPM version 3.x and later).
   */
  public static readonly pnpmV3ShrinkwrapFilename: string = 'pnpm-lock.yaml';

  /**
   * The filename ("pnpmfile.js") used to add custom configuration to PNPM
   */
  public static readonly pnpmfileFilename: string = 'pnpmfile.js';

  /**
   * The filename ("shrinkwrap.yaml") used to store state for pnpm
   */
  public static readonly yarnShrinkwrapFilename: string = 'yarn.lock';

  /**
   * The folder name ("node_modules") where NPM installs its packages.
   */
  public static readonly nodeModulesFolderName: string = 'node_modules';

  /**
   * The filename ("pinned-versions.json") for an old configuration file that
   * that is no longer supported.
   *
   * @deprecated This feature has been superseded by the "preferredVersions" setting
   * in common-versions.json
   */
  // NOTE: Although this is marked as "deprecated", we will probably never retire it,
  // since we always want to report the warning when someone upgrades an old repo.
  public static readonly pinnedVersionsFilename: string = 'pinned-versions.json';

  /**
   * The filename ("common-versions.json") for an optional configuration file
   * that stores dependency version information that affects all projects in the repo.
   * This configuration file should go in the "common/config/rush" folder.
   */
  public static readonly commonVersionsFilename: string = 'common-versions.json';

  /**
   * The filename ("repo-state.json") for a file used by Rush to
   * store the state of various features as they stand in the repo.
   */
  public static readonly repoStateFilename: string = 'repo-state.json';

  /**
   * The name of the per-project folder where project-specific Rush files are stored. For example,
   * the package-deps files, which are used by commands to determine if a particular project needs to be rebuilt.
   */
  public static readonly projectRushFolderName: string = '.rush';

  /**
   * Custom command line configuration file, which is used by rush for implementing
   * custom command and options.
   */
  public static readonly commandLineFilename: string = 'command-line.json';

  public static readonly versionPoliciesFilename: string = 'version-policies.json';

  /**
   * Experiments configuration file, which
   */
  public static readonly experimentsFilename: string = 'experiments.json';

  /**
   * Build cache configuration file.
   */
  public static readonly buildCacheFilename: string = 'build-cache.json';

  /**
   * Per-project configuration filename.
   */
  public static readonly rushProjectConfigFilename: string = 'rush-project.json';

  /**
   * The URL ("http://rushjs.io") for the Rush web site.
   */
  public static readonly rushWebSiteUrl: string = 'https://rushjs.io';

  /**
   * The name of the NPM package for the Rush tool ("@microsoft/rush").
   */
  public static readonly rushPackageName: string = '@microsoft/rush';

  /**
   * The folder name ("rush-recycler") where Rush moves large folder trees
   * before asynchronously deleting them.
   */
  public static readonly rushRecyclerFolderName: string = 'rush-recycler';

  /**
   * The name of the file to drop in project-folder/.rush/temp/ containing a listing of the project's direct
   * and indirect dependencies. This is used to detect if a project's dependencies have changed since the last build.
   */
  public static readonly projectDependencyManifestFilename: string = 'shrinkwrap-deps.json';

  /**
   * The value of the "commandKind" property for a bulk command in command-line.json
   */
  public static readonly bulkCommandKind: 'bulk' = 'bulk';

  /**
   * The value of the "commandKind" property for a global command in command-line.json
   */
  public static readonly globalCommandKind: 'global' = 'global';

  /**
   * The name of the incremental build command.
   */
  public static readonly buildCommandName: string = 'build';

  /**
   * The name of the non-incremental build command.
   */
  public static readonly rebuildCommandName: string = 'rebuild';

  public static readonly updateCloudCredentialsCommandName: string = 'update-cloud-credentials';

  /**
   * When a hash generated that contains multiple input segments, this character may be used
   * to separate them to avoid issues like
   * crypto.createHash('sha1').update('a').update('bc').digest('hex') === crypto.createHash('sha1').update('ab').update('c').digest('hex')
   */
  public static readonly hashDelimiter: string = '|';

  /**
   * The name of the per-user Rush configuration data folder.
   */
  public static readonly rushUserConfigurationFolderName: string = '.rush-user';
}
