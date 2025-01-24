// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import builtinPackageNames from 'builtin-modules';
import { Colorize, type ITerminal } from '@rushstack/terminal';
import type { CommandLineFlagParameter, CommandLineStringListParameter } from '@rushstack/ts-command-line';
import { FileSystem, FileConstants, JsonFile } from '@rushstack/node-core-library';
import type FastGlob from 'fast-glob';

import type { RushCommandLineParser } from '../RushCommandLineParser';
import { BaseConfiglessRushAction } from './BaseRushAction';
import type { RushConfigurationProject } from '../../api/RushConfigurationProject';

export interface IScanResult {
  /**
   * Dependencies scan from source code
   */
  detectedDependencies: string[];
  /**
   * Dependencies detected but not declared in package.json
   */
  missingDependencies: string[];
  /**
   * Dependencies declared in package.json, but not used in source code
   */
  unusedDependencies: string[];
}

export class ScanAction extends BaseConfiglessRushAction {
  private readonly _terminal: ITerminal;
  private readonly _jsonFlag: CommandLineFlagParameter;
  private readonly _allFlag: CommandLineFlagParameter;
  private readonly _projectFolderNamesParameter: CommandLineStringListParameter;
  private readonly _projects: CommandLineStringListParameter;

  public constructor(parser: RushCommandLineParser) {
    super({
      actionName: 'scan',
      summary:
        'When migrating projects into a Rush repo, this command is helpful for detecting' +
        ' undeclared dependencies.',
      documentation:
        `The Node.js module system allows a project to import NPM packages without explicitly` +
        ` declaring them as dependencies in the package.json file.  Such "phantom dependencies"` +
        ` can cause problems.  Rush and PNPM use symlinks specifically to protect against phantom dependencies.` +
        ` These protections may cause runtime errors for existing projects when they are first migrated into` +
        ` a Rush monorepo.  The "rush scan" command is a handy tool for fixing these errors. By default, it scans the "./src"` +
        ` and "./lib" folders for import syntaxes such as "import __ from '__'", "require('__')",` +
        ` and "System.import('__').  It prints a report of the referenced packages.  This heuristic is` +
        ` not perfect, but it can save a lot of time when migrating projects.`,
      safeForSimultaneousRushProcesses: true,
      parser
    });

    this._jsonFlag = this.defineFlagParameter({
      parameterLongName: '--json',
      description: 'If this flag is specified, output will be in JSON format.'
    });
    this._allFlag = this.defineFlagParameter({
      parameterLongName: '--all',
      description: 'If this flag is specified, output will list all detected dependencies.'
    });
    this._projectFolderNamesParameter = this.defineStringListParameter({
      parameterLongName: '--project-folder-name',
      parameterShortName: '-f',
      argumentName: 'FOLDER',
      description:
        'The folders that need to be scanned, default is src and lib.' +
        'Normally we can input all the folders under the project directory, excluding the ignored folders.'
    });
    this._projects = this.defineStringListParameter({
      parameterLongName: '--project',
      parameterShortName: '-p',
      argumentName: 'PROJECT',
      description: 'Projects that need to be checked for phantom dependencies.'
    });
    this._terminal = parser.terminal;
  }

  private async _scanAsync(params: {
    packageJsonFilePath: string;
    folders: readonly string[];
    glob: typeof FastGlob;
    terminal: ITerminal;
  }): Promise<IScanResult> {
    const { packageJsonFilePath, folders, glob, terminal } = params;
    const packageJsonFilename: string = path.resolve(packageJsonFilePath);

    const requireRegExps: RegExp[] = [
      // Example: require('something')
      /\brequire\s*\(\s*[']([^']+\s*)[']\s*\)/,
      /\brequire\s*\(\s*["]([^"]+\s*)["]\s*\)/,

      // Example: require.ensure('something')
      /\brequire\.ensure\s*\(\s*[']([^']+\s*)[']\s*\)/,
      /\brequire\.ensure\s*\(\s*["]([^"]+\s*)["]\s*\)/,

      // Example: require.resolve('something')
      /\brequire\.resolve\s*\(\s*[']([^']+\s*)[']\s*\)/,
      /\brequire\.resolve\s*\(\s*["]([^"]+\s*)["]\s*\)/,

      // Example: System.import('something')
      /\bSystem\.import\s*\(\s*[']([^']+\s*)[']\s*\)/,
      /\bSystem\.import\s*\(\s*["]([^"]+\s*)["]\s*\)/,

      // Example: Import.lazy('something', require);
      /\bImport\.lazy\s*\(\s*[']([^']+\s*)[']/,
      /\bImport\.lazy\s*\(\s*["]([^"]+\s*)["]/,

      // Example:
      //
      // import {
      //   A, B
      // } from 'something';
      /\bfrom\s*[']([^']+)[']/,
      /\bfrom\s*["]([^"]+)["]/,

      // Example:  import 'something';
      /\bimport\s*[']([^']+)[']\s*\;/,
      /\bimport\s*["]([^"]+)["]\s*\;/,

      // Example: await import('fast-glob')
      /\bimport\s*\(\s*[']([^']+)[']\s*\)/,
      /\bimport\s*\(\s*["]([^"]+)["]\s*\)/,

      // Example:
      // /// <reference types="something" />
      /\/\/\/\s*<\s*reference\s+types\s*=\s*["]([^"]+)["]\s*\/>/
    ];

    // Example: "my-package/lad/dee/dah" --> "my-package"
    // Example: "@ms/my-package" --> "@ms/my-package"
    // Example: "lodash.get" --> "lodash.get"
    const packageRegExp: RegExp = /^((@[a-z\-0-9!_]+\/)?[a-z\-0-9!_][a-z\-0-9!_.]*)\/?/;

    const requireMatches: Set<string> = new Set<string>();

    const scanResults: string[] = await glob(
      [
        './*.{ts,js,tsx,jsx}',
        `./${folders.length > 1 ? '{' + folders.join(',') + '}' : folders[0]}/**/*.{ts,js,tsx,jsx}`
      ],
      { cwd: path.dirname(packageJsonFilePath), absolute: true }
    );
    for (const filename of scanResults) {
      try {
        const contents: string = FileSystem.readFile(filename);
        const lines: string[] = contents.split('\n');

        for (const line of lines) {
          for (const requireRegExp of requireRegExps) {
            const requireRegExpResult: RegExpExecArray | null = requireRegExp.exec(line);
            if (requireRegExpResult) {
              requireMatches.add(requireRegExpResult[1]);
            }
          }
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.log(error);
        terminal.writeErrorLine(Colorize.bold('Skipping file due to error: ' + filename));
      }
    }

    const packageMatches: Set<string> = new Set<string>();

    requireMatches.forEach((requireMatch: string) => {
      const packageRegExpResult: RegExpExecArray | null = packageRegExp.exec(requireMatch);
      if (packageRegExpResult) {
        packageMatches.add(packageRegExpResult[1]);
      }
    });

    const detectedPackageNames: string[] = [];

    packageMatches.forEach((packageName: string) => {
      if (builtinPackageNames.indexOf(packageName) < 0) {
        detectedPackageNames.push(packageName);
      }
    });

    detectedPackageNames.sort();

    const declaredDependencies: Set<string> = new Set<string>();
    const declaredDevDependencies: Set<string> = new Set<string>();
    const missingDependencies: string[] = [];
    const unusedDependencies: string[] = [];
    const packageJsonContent: string = FileSystem.readFile(packageJsonFilename);
    try {
      const manifest: {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      } = JSON.parse(packageJsonContent);
      if (manifest.dependencies) {
        for (const depName of Object.keys(manifest.dependencies)) {
          declaredDependencies.add(depName);
        }
      }
      if (manifest.devDependencies) {
        for (const depName of Object.keys(manifest.devDependencies)) {
          declaredDevDependencies.add(depName);
        }
      }
    } catch (e) {
      terminal.writeErrorLine(`JSON.parse ${packageJsonFilename} error`);
    }

    for (const detectedPkgName of detectedPackageNames) {
      /**
       * Missing(phantom) dependencies are
       * - used in source code
       * - not decalred in dependencies and devDependencies in package.json
       */
      if (!declaredDependencies.has(detectedPkgName) && !declaredDevDependencies.has(detectedPkgName)) {
        missingDependencies.push(detectedPkgName);
      }
    }
    for (const declaredPkgName of declaredDependencies) {
      /**
       * Unused dependencies are
       * - declared in dependencies in package.json (devDependencies not included)
       * - not used in source code
       */
      if (!detectedPackageNames.includes(declaredPkgName) && !declaredPkgName.startsWith('@types/')) {
        unusedDependencies.push(declaredPkgName);
      }
    }

    const output: IScanResult = {
      detectedDependencies: detectedPackageNames,
      missingDependencies: missingDependencies,
      unusedDependencies: unusedDependencies
    };

    return output;
  }

  private _getPackageJsonPathsFromProjects(projectNames: readonly string[]): string[] {
    const result: string[] = [];
    if (!this.rushConfiguration) {
      throw new Error(
        `This project select parameter can only be performed in a Rush managed project.
        To specify a project, you must be within a project directory managed by Rush.
        Otherwise, please navigate into the project directory and execute the scan command.`
      );
    }
    for (const projectName of projectNames) {
      const project: RushConfigurationProject | undefined =
        this.rushConfiguration.getProjectByName(projectName);
      if (!project) {
        throw new Error(
          `The project name "${projectName}" is invalid. Please check the project name and ensure it is correctly specified.`
        );
      }
      const packageJsonFilePath: string = path.join(project.projectFolder, FileConstants.PackageJson);
      result.push(packageJsonFilePath);
    }
    return result;
  }

  protected async runAsync(): Promise<void> {
    const packageJsonFilePaths: string[] = this._projects.values.length
      ? this._getPackageJsonPathsFromProjects(this._projects.values)
      : [path.resolve('./package.json')];
    const { default: glob } = await import('fast-glob');
    const folders: readonly string[] = this._projectFolderNamesParameter.values.length
      ? this._projectFolderNamesParameter.values
      : ['src', 'lib'];

    const output: Record<string, IScanResult> = {};

    for (const packageJsonFilePath of packageJsonFilePaths) {
      if (!FileSystem.exists(packageJsonFilePath)) {
        throw new Error(`${packageJsonFilePath} is not exist`);
      }
      const packageName: string = JsonFile.load(packageJsonFilePath).name;
      const scanResult: IScanResult = await this._scanAsync({
        packageJsonFilePath,
        folders,
        glob,
        terminal: this._terminal
      });
      output[packageName] = scanResult;
    }
    if (this._jsonFlag.value) {
      this._terminal.writeLine(JSON.stringify(output, undefined, 2));
    } else if (this._allFlag.value) {
      for (const [packageName, scanResult] of Object.entries(output)) {
        this._terminal.writeLine(`-------------------- ${packageName} result start --------------------`);
        const { detectedDependencies } = scanResult;
        if (detectedDependencies.length !== 0) {
          this._terminal.writeLine(`Dependencies that seem to be imported by this project ${packageName}:`);
          for (const detectedDependency of detectedDependencies) {
            this._terminal.writeLine('  ' + detectedDependency);
          }
        } else {
          this._terminal.writeLine(`This project ${packageName} does not seem to import any NPM packages.`);
        }
        this._terminal.writeLine(`-------------------- ${packageName} result end --------------------`);
      }
    } else {
      for (const [packageName, scanResult] of Object.entries(output)) {
        this._terminal.writeLine(`-------------------- ${packageName} result start --------------------`);
        const { missingDependencies, unusedDependencies } = scanResult;
        let wroteAnything: boolean = false;

        if (missingDependencies.length > 0) {
          this._terminal.writeWarningLine(
            Colorize.yellow('Possible phantom dependencies') +
              " - these seem to be imported but aren't listed in package.json:"
          );
          for (const missingDependency of missingDependencies) {
            this._terminal.writeLine('  ' + missingDependency);
          }
          wroteAnything = true;
        }

        if (unusedDependencies.length > 0) {
          if (wroteAnything) {
            this._terminal.writeLine('');
          }
          this._terminal.writeWarningLine(
            Colorize.yellow('Possible unused dependencies') +
              " - these are listed in package.json but don't seem to be imported:"
          );
          for (const unusedDependency of unusedDependencies) {
            this._terminal.writeLine('  ' + unusedDependency);
          }
          wroteAnything = true;
        }

        if (!wroteAnything) {
          this._terminal.writeLine(
            Colorize.green('Everything looks good.') + '  No missing or unused dependencies were found.'
          );
        }

        this._terminal.writeLine(`-------------------- ${packageName} result end --------------------`);
      }
    }
  }
}
