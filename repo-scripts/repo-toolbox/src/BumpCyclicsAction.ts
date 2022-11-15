// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See the @microsoft/rush package's LICENSE file for license information.

import { Async, ConsoleTerminalProvider, Executable, JsonFile, Terminal } from '@rushstack/node-core-library';
import { DependencyType, RushConfiguration } from '@microsoft/rush-lib';
import { CommandLineAction } from '@rushstack/ts-command-line';
import { ChildProcess } from 'child_process';

export class BumpCyclicsAction extends CommandLineAction {
  public constructor() {
    super({
      actionName: 'bump-cyclic-dependencies',
      summary: 'Updates cyclic dependencies inside the repo.',
      documentation: ''
    });
  }

  protected async onExecute(): Promise<void> {
    const terminal: Terminal = new Terminal(new ConsoleTerminalProvider());
    const rushConfiguration: RushConfiguration = RushConfiguration.loadFromDefaultLocation({
      startingFolder: process.cwd()
    });

    const cyclicDependencyNames: Set<string> = new Set<string>();

    for (const project of rushConfiguration.projects) {
      for (const cyclicDependencyProject of project.decoupledLocalDependencies) {
        cyclicDependencyNames.add(cyclicDependencyProject);
      }
    }

    const cyclicDependencyVersions: Map<string, string> = new Map<string, string>();
    await Async.forEachAsync(
      Array.from(cyclicDependencyNames),
      async (cyclicDependencyName) => {
        const version: string = await this._getLatestPublishedVersionAsync(terminal, cyclicDependencyName);
        cyclicDependencyVersions.set(cyclicDependencyName, version);
      },
      {
        concurrency: 10
      }
    );

    terminal.writeLine();

    for (const project of rushConfiguration.projects) {
      for (const cyclicDependencyProject of project.decoupledLocalDependencies) {
        const version: string = cyclicDependencyVersions.get(cyclicDependencyProject)!;
        if (project.packageJsonEditor.tryGetDependency(cyclicDependencyProject)) {
          project.packageJsonEditor.addOrUpdateDependency(
            cyclicDependencyProject,
            version,
            DependencyType.Regular
          );
        }

        if (project.packageJsonEditor.tryGetDevDependency(cyclicDependencyProject)) {
          project.packageJsonEditor.addOrUpdateDependency(
            cyclicDependencyProject,
            version,
            DependencyType.Dev
          );
        }
      }

      if (project.packageJsonEditor.saveIfModified()) {
        terminal.writeLine(`Updated ${project.packageName}`);
      }
    }

    terminal.writeLine();

    // Update the Rush version in rush.json
    const latestRushVersion: string = await this._getLatestPublishedVersionAsync(terminal, '@microsoft/rush');
    const rushJson: { rushVersion: string } = await JsonFile.loadAsync(rushConfiguration.rushJsonFile);
    rushJson.rushVersion = latestRushVersion;
    await JsonFile.saveAsync(rushJson, rushConfiguration.rushJsonFile, { updateExistingFile: true });
    terminal.writeLine(`Updated ${rushConfiguration.rushJsonFile}`);
  }

  private async _getLatestPublishedVersionAsync(terminal: Terminal, packageName: string): Promise<string> {
    return await new Promise((resolve: (result: string) => void, reject: (error: Error) => void) => {
      const childProcess: ChildProcess = Executable.spawn('npm', ['view', packageName, 'version']);
      const stdoutBuffer: string[] = [];
      childProcess.stdout!.on('data', (chunk) => stdoutBuffer.push(chunk));
      childProcess.on('exit', (code: number) => {
        if (code) {
          reject(new Error(`Exited with ${code}`));
        } else {
          const version: string = stdoutBuffer.join('').trim();
          terminal.writeLine(`Found version "${version}" for "${packageName}"`);
          resolve(version);
        }
      });
    });
  }
}
