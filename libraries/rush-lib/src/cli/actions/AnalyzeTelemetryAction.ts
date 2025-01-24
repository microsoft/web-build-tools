// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as os from 'os';
import * as path from 'path';
import { CommandLineFlagParameter, CommandLineStringParameter } from '@rushstack/ts-command-line';
import { Terminal, JsonFile } from '@rushstack/node-core-library';

import { BaseRushAction } from './BaseRushAction';
import { RushCommandLineParser } from '../RushCommandLineParser';
import { ITelemetryData, ITelemetryMachineInfo, ITelemetryOperationResult } from '../../logic/Telemetry';

const MAX_CORES: number = 128;

interface IAnalysisBuildTimeSavedRecord {
  project: string;
  secondsSaved: number;
}

interface IAnalysisDependencyGraphEntry {
  project: string;
  dependencies: string[];
}

export class AnalyzeTelemetryAction extends BaseRushAction {
  private _printBuildTimesFlag!: CommandLineFlagParameter;
  private _simulateFlag!: CommandLineFlagParameter;
  private _telemetryFileName!: CommandLineStringParameter;

  public constructor(parser: RushCommandLineParser) {
    const documentation: string[] = [
      'Analyzes the provided telemetry file to provide insight into the build timing data. The "--build-times" flag ' +
        'will identify the projects which are chokepoints during the build. Reducing the build times of these projects will ' +
        'directly reduce the overall build time by 1 second. The --simulate flag will identify the optimal number of CPU cores ' +
        'to build your project to help teams make more informed decisions about the number of CPU cores to use to build their project.'
    ];
    super({
      actionName: 'analyze-telemetry',
      summary: 'Analyzes the Rush Project based on a telemetry file.',
      documentation: documentation.join(os.EOL),
      safeForSimultaneousRushProcesses: false,
      parser
    });
  }

  public onDefineParameters(): void {
    this._printBuildTimesFlag = this.defineFlagParameter({
      parameterLongName: '--build-times',
      parameterShortName: '-b',
      description: 'print build timing analysis by project'
    });
    this._simulateFlag = this.defineFlagParameter({
      parameterLongName: '--simulate',
      description:
        'Simulate the build with different number of CPU cores and find the optimal number of CPU cores.'
    });
    this._telemetryFileName = this.defineStringParameter({
      parameterLongName: '--file',
      required: true,
      argumentName: 'FILE',
      description:
        'The name of the telemetry file for dependency analysis to utilize. The telemetry file should exist in the rush telemetry folder'
    });
  }

  public async runAsync(): Promise<void> {
    const terminal: Terminal = new Terminal(this.rushSession.terminalProvider);
    const telemetryFolderName: string = path.join(this.rushConfiguration.commonTempFolder, 'telemetry');
    const fullPath: string = path.join(telemetryFolderName, this._telemetryFileName?.value ?? '');

    if (this._printBuildTimesFlag.value) {
      this._printProjectBuildTimes(fullPath, terminal);
    }

    if (this._simulateFlag.value) {
      this._simulateBuildTime(fullPath, terminal);
    }
  }

  private _extractBuildTimeMap(
    operationResults: Record<string, ITelemetryOperationResult> | undefined
  ): Map<string, number> {
    const buildTimeMap: Map<string, number> = new Map();
    if (operationResults) {
      Object.entries(operationResults).forEach(
        ([project, operationTelemetry]: [string, ITelemetryOperationResult], index) => {
          const durationSeconds: number = Number(
            (
              ((operationTelemetry.endTimestamp ?? 0) - (operationTelemetry.startTimestamp ?? 0)) /
              1000
            ).toFixed(2)
          );
          buildTimeMap.set(project, durationSeconds);
        }
      );
    }
    return buildTimeMap;
  }

  private _printProjectBuildTimes(filename: string, terminal: Terminal): void {
    const telemetryFile: ITelemetryData = JsonFile.load(filename)[0];
    const operationResults: Record<string, ITelemetryOperationResult> | undefined =
      telemetryFile.operationResults ?? undefined;
    const buildTimeMap: Map<string, number> = this._extractBuildTimeMap(operationResults);
    const machineInfo: ITelemetryMachineInfo = telemetryFile.machineInfo ?? ({} as ITelemetryMachineInfo);

    if (!operationResults) {
      throw new Error(`The telemetry file does not have the field 'telemetryFile'`);
    }
    const totalBuildTime: number = this._calculateBuildTime(operationResults, buildTimeMap);
    terminal.writeLine(
      `\nThe original build took ${totalBuildTime} seconds to build with ${machineInfo.machineCores} CPU Cores.\n`
    );
    const buildTimeList: IAnalysisBuildTimeSavedRecord[] = [];

    Object.entries(operationResults).forEach(
      ([project, operationTelemtry]: [string, ITelemetryOperationResult]) => {
        const buildTimePlaceHolder: number = buildTimeMap.get(project) ?? -1;
        buildTimeMap.set(project, 0);
        const secondsSaved: number =
          totalBuildTime - this._calculateBuildTime(operationResults, buildTimeMap);
        buildTimeList.push({
          project,
          secondsSaved: Number(secondsSaved.toFixed(2))
        });
        buildTimeMap.set(project, buildTimePlaceHolder);
      }
    );

    buildTimeList.sort((a, b) => b.secondsSaved - a.secondsSaved);

    this._writeDependencyAnalysisSummary(terminal, buildTimeList);
  }

  private _simulateBuildTime(filename: string, terminal: Terminal): void {
    const telemetryFile: ITelemetryData = JsonFile.load(filename)[0];
    const operationResults: Record<string, ITelemetryOperationResult> | undefined =
      telemetryFile.operationResults ?? undefined;
    const buildTimeMap: Map<string, number> = this._extractBuildTimeMap(operationResults);
    const machineInfo: ITelemetryMachineInfo = telemetryFile.machineInfo ?? ({} as ITelemetryMachineInfo);

    const simulatedBuildTimes: number[] = [];

    if (!operationResults) {
      throw new Error(`The telemetry file does not have the field 'telemetryFile'`);
    }

    const totalBuildTime: number = this._calculateBuildTime(operationResults, buildTimeMap);
    terminal.writeLine(
      `\nThe original build took ${totalBuildTime} seconds to build with ${machineInfo.machineCores} CPU Cores.\n`
    );

    for (let numCores: number = 1; numCores < MAX_CORES; numCores++) {
      const simulatedBuildTime: number = this._calculateBuildTime(operationResults, buildTimeMap, numCores);
      if (simulatedBuildTimes.length === 0) {
        simulatedBuildTimes.push(simulatedBuildTime);
      } else {
        if (simulatedBuildTimes[simulatedBuildTimes.length - 1] * 0.999 > simulatedBuildTime) {
          simulatedBuildTimes.push(simulatedBuildTime);
        } else {
          simulatedBuildTimes.push(simulatedBuildTime);
          this._writeSimulationSummary(terminal, simulatedBuildTimes);
          return;
        }
      }
    }
  }

  private _calculateBuildTime(
    operationResults: Record<string, ITelemetryOperationResult>,
    buildTimeMap: Map<string, number>,
    numberOfCores?: number
  ): number {
    // accumulativeBuildTimeMap <project, accumulated project build time>
    const accumulativeBuildTimeMap: Map<string, number> = new Map();

    // to simulate the number of CPUs
    if (!numberOfCores) {
      numberOfCores = os.cpus().length;
    }
    const processes: number[] = [];

    // Extract the Dependency Graph
    const dependencyGraph: IAnalysisDependencyGraphEntry[] = [];
    Object.entries(operationResults).forEach(
      ([project, operationTelemery]: [string, ITelemetryOperationResult], index) => {
        dependencyGraph.push({
          project,
          dependencies: operationTelemery.dependencies
        } as IAnalysisDependencyGraphEntry);
      }
    );

    while (dependencyGraph.length !== 0) {
      // pop the first thing in the list:
      const project: IAnalysisDependencyGraphEntry = dependencyGraph.shift() as IAnalysisDependencyGraphEntry;

      // project in scope has no dependencies:
      if (!project.dependencies.length) {
        accumulativeBuildTimeMap.set(project.project, buildTimeMap.get(project.project) ?? -1);
      } else {
        let knownDependencyCount: number = 0;
        let projectPushed: boolean = false;
        project.dependencies.forEach((dependency) => {
          // we don't have data for all dependencies yet, so push project to end of queue and process later:
          if (!accumulativeBuildTimeMap.has(dependency) && !projectPushed) {
            dependencyGraph.push(project);
            projectPushed = true;
          } else {
            knownDependencyCount += 1;
          }
        });
        // we have data for all dependencies, find the max build time in dependencies (this is the limiting factor)
        if (knownDependencyCount === project.dependencies.length) {
          let firstEndTime: number = 0;
          if (processes.length === numberOfCores) {
            firstEndTime = Math.min(...processes);
            const firstEndTimeInd: number = processes.indexOf(firstEndTime);
            processes.splice(firstEndTimeInd, 1);
          }
          processes.push(firstEndTime + (buildTimeMap.get(project.project) ?? -1));
          const dependencyBuildTimings: number[] = project.dependencies.map((dependency) => {
            return accumulativeBuildTimeMap.get(dependency) ?? -1;
          });
          const projectStartTime: number = Math.max(firstEndTime, ...dependencyBuildTimings);
          const accumulativeBuildTime: number = projectStartTime + (buildTimeMap.get(project.project) ?? -1);
          accumulativeBuildTimeMap.set(project.project, Number(accumulativeBuildTime.toFixed(2)));
        }
      }
    }
    const totalBuildTime: number = Math.max(...accumulativeBuildTimeMap.values());
    return totalBuildTime;
  }

  private _writeSimulationSummary(terminal: Terminal, simulatedBuildTimes: number[]): void {
    terminal.writeLine(`Simulating build time given number of cores:`);

    simulatedBuildTimes.forEach((value, index) => {
      const padding: string = ' '.repeat(20 - (index + 1).toString().length);
      terminal.writeLine(`  Number of cores: ${index + 1}${padding} ${value} seconds`);
    });

    terminal.writeLine(
      `The optimal number of cores to build your project is ${simulatedBuildTimes.length - 1}`
    );
  }

  private _writeDependencyAnalysisSummary(
    terminal: Terminal,
    buildTimeList: IAnalysisBuildTimeSavedRecord[]
  ): void {
    let longestTaskName: number = 0;
    for (const project of buildTimeList) {
      const nameLength: number = (project.project || '').length;
      if (nameLength > longestTaskName) {
        longestTaskName = nameLength;
      }
    }

    terminal.writeLine(
      `If the following project had a 0 second build time, then the total build time will change by:`
    );

    for (const project of buildTimeList) {
      const padding: string = ' '.repeat(longestTaskName - (project.project || '').length);
      terminal.writeLine(`  ${project.project}${padding}    ${project.secondsSaved} seconds saved`);
    }
  }
}
