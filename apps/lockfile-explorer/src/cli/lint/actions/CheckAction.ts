// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { Colorize, type ITerminal } from '@rushstack/terminal';
import { CommandLineAction } from '@rushstack/ts-command-line';
import { RushConfiguration, type RushConfigurationProject, type Subspace } from '@rushstack/rush-sdk';
import path from 'path';
import yaml from 'js-yaml';
import semver from 'semver';
import { AlreadyReportedError, Async, FileSystem, JsonFile, JsonSchema } from '@rushstack/node-core-library';

import lockfileLintSchema from '../../../schemas/lockfile-lint.schema.json';
import { LOCKFILE_EXPLORER_FOLDERNAME, LOCKFILE_LINT_JSON_FILENAME } from '../../../constants/common';
import type { LintCommandLineParser } from '../LintCommandLineParser';
import {
  getShrinkwrapFileMajorVersion,
  parseDependencyPath,
  splicePackageWithVersion
} from '../../../utils/shrinkwrap';
import type { Lockfile, LockfileV6 } from '@pnpm/lockfile-types';

export interface ILintRule {
  rule: 'restrict-versions';
  project: string;
  requiredVersions: Record<string, string>;
  exemptProjectList?: string[];
}

export interface ILockfileLint {
  rules: ILintRule[];
}

export interface ILintIssue {
  project: string;
  rule: string;
  message: string;
}

export class CheckAction extends CommandLineAction {
  private readonly _terminal: ITerminal;

  private _rushConfiguration!: RushConfiguration;
  private _checkedProjects: Set<RushConfigurationProject>;
  private _docMap: Map<string, Lockfile | LockfileV6>;

  public constructor(parser: LintCommandLineParser) {
    super({
      actionName: 'check',
      summary: 'Check and report dependency issues in your workspace',
      documentation:
        'This command applies the policies that are configured in ' +
        LOCKFILE_LINT_JSON_FILENAME +
        ', reporting any problems found in your PNPM workspace.'
    });

    this._terminal = parser.globalTerminal;
    this._checkedProjects = new Set();
    this._docMap = new Map();
  }

  private async _checkVersionCompatibilityAsync(
    shrinkwrapFileMajorVersion: number,
    packages: Lockfile['packages'],
    dependencyPath: string,
    requiredVersions: Record<string, string>,
    checkedDependencyPaths: Set<string>
  ): Promise<void> {
    if (packages && packages[dependencyPath] && !checkedDependencyPaths.has(dependencyPath)) {
      checkedDependencyPaths.add(dependencyPath);
      const { name, version } = parseDependencyPath(shrinkwrapFileMajorVersion, dependencyPath);
      if (name in requiredVersions && !semver.satisfies(version, requiredVersions[name])) {
        throw new Error(
          `The version of "${name}" should match "${requiredVersions[name]}";` +
            ` actual version is "${version}"`
        );
      }

      await Promise.all(
        Object.entries(packages[dependencyPath].dependencies ?? {}).map(
          async ([dependencyPackageName, dependencyPackageVersion]) => {
            await this._checkVersionCompatibilityAsync(
              shrinkwrapFileMajorVersion,
              packages,
              splicePackageWithVersion(
                shrinkwrapFileMajorVersion,
                dependencyPackageName,
                dependencyPackageVersion
              ),
              requiredVersions,
              checkedDependencyPaths
            );
          }
        )
      );
    }
  }

  private async _searchAndValidateDependenciesAsync(
    project: RushConfigurationProject,
    requiredVersions: Record<string, string>,
    exemptProjectList: string[]
  ): Promise<void> {
    this._terminal.writeLine(`Checking project "${project.packageName}"`);

    const projectFolder: string = project.projectFolder;
    const subspace: Subspace = project.subspace;
    const shrinkwrapFilename: string = subspace.getCommittedShrinkwrapFilePath();
    let doc: Lockfile | LockfileV6;
    if (this._docMap.has(shrinkwrapFilename)) {
      doc = this._docMap.get(shrinkwrapFilename)!;
    } else {
      const pnpmLockfileText: string = await FileSystem.readFileAsync(shrinkwrapFilename);
      doc = yaml.load(pnpmLockfileText) as Lockfile | LockfileV6;
      this._docMap.set(shrinkwrapFilename, doc);
    }
    const { importers, lockfileVersion, packages } = doc;
    const shrinkwrapFileMajorVersion: number = getShrinkwrapFileMajorVersion(lockfileVersion);
    const checkedDependencyPaths: Set<string> = new Set<string>();

    await Promise.all(
      Object.entries(importers).map(async ([relativePath, { dependencies, devDependencies }]) => {
        if (path.resolve(projectFolder, relativePath) === projectFolder) {
          const dependenciesEntries = Object.entries({ ...dependencies, ...devDependencies } ?? {});
          for (const [dependencyName, dependencyValue] of dependenciesEntries) {
            const fullDependencyPath = splicePackageWithVersion(
              shrinkwrapFileMajorVersion,
              dependencyName,
              typeof dependencyValue === 'string'
                ? dependencyValue
                : (
                    dependencyValue as {
                      version: string;
                      specifier: string;
                    }
                  ).version
            );
            if (fullDependencyPath.includes('link:')) {
              const dependencyProject: RushConfigurationProject | undefined =
                this._rushConfiguration.getProjectByName(dependencyName);
              if (
                dependencyProject &&
                !this._checkedProjects?.has(dependencyProject) &&
                !exemptProjectList.includes(dependencyName)
              ) {
                this._checkedProjects!.add(project);
                await this._searchAndValidateDependenciesAsync(
                  dependencyProject,
                  requiredVersions,
                  exemptProjectList
                );
              }
            } else {
              await this._checkVersionCompatibilityAsync(
                shrinkwrapFileMajorVersion,
                packages,
                fullDependencyPath,
                requiredVersions,
                checkedDependencyPaths
              );
            }
          }
        }
      })
    );
  }

  private async _performVersionRestrictionCheckAsync(
    requiredVersions: Record<string, string>,
    projectName: string,
    exemptProjectList: string[]
  ): Promise<string | undefined> {
    try {
      const project: RushConfigurationProject | undefined =
        this._rushConfiguration?.getProjectByName(projectName);
      if (!project) {
        throw new Error(
          `Specified project "${projectName}" does not exist in ${LOCKFILE_LINT_JSON_FILENAME}`
        );
      }
      this._checkedProjects.add(project);
      await this._searchAndValidateDependenciesAsync(project, requiredVersions, exemptProjectList);
      return undefined;
    } catch (e) {
      return e.message;
    }
  }

  protected async onExecute(): Promise<void> {
    const rushConfiguration: RushConfiguration | undefined = RushConfiguration.tryLoadFromDefaultLocation();
    if (!rushConfiguration) {
      throw new Error(
        'The "lockfile-explorer check" must be executed in a folder that is under a Rush workspace folder'
      );
    }
    this._rushConfiguration = rushConfiguration!;

    const lintingFile: string = path.resolve(
      this._rushConfiguration.commonFolder,
      'config',
      LOCKFILE_EXPLORER_FOLDERNAME,
      LOCKFILE_LINT_JSON_FILENAME
    );
    const { rules }: ILockfileLint = await JsonFile.loadAndValidateAsync(
      lintingFile,
      JsonSchema.fromLoadedObject(lockfileLintSchema)
    );
    const issues: ILintIssue[] = [];
    await Async.forEachAsync(
      rules,
      async ({ requiredVersions, project, rule, exemptProjectList }) => {
        switch (rule) {
          case 'restrict-versions': {
            const message: string | undefined = await this._performVersionRestrictionCheckAsync(
              requiredVersions,
              project,
              exemptProjectList ?? []
            );
            if (message) {
              issues.push({ project, rule, message });
            }
            break;
          }

          default: {
            throw new Error('Unsupported rule name: ' + rule);
          }
        }
      },
      { concurrency: 50 }
    );
    if (issues.length > 0) {
      this._terminal.writeLine();

      // Deterministic order
      for (const issue of issues.sort((a, b): number => {
        let diff: number = a.project.localeCompare(b.project);
        if (diff !== 0) {
          return diff;
        }
        diff = a.rule.localeCompare(b.rule);
        if (diff !== 0) {
          return diff;
        }
        return a.message.localeCompare(b.message);
      })) {
        this._terminal.writeLine(
          Colorize.red('PROBLEM: ') + Colorize.cyan(`[${issue.rule}] `) + issue.message + '\n'
        );
      }

      throw new AlreadyReportedError();
    }
    this._terminal.writeLine(Colorize.green('SUCCESS: ') + 'All checks passed.');
  }
}
