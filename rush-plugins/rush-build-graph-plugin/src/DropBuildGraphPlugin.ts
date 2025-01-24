// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type {
  ICreateOperationsContext,
  IPhasedCommand,
  IRushPlugin,
  Operation,
  RushConfiguration,
  RushSession
} from '@rushstack/rush-sdk';
import type { IDropGraphOptions } from './DropGraph';

const PLUGIN_NAME: 'RushDropBuildGraphPlugin' = 'RushDropBuildGraphPlugin';

/**
 * The graph JSON object
 * @beta
 */
export interface IRushGraph {
  /**
   * The nodes in the graph representing the commands to run
   */
  nodes: IGraphNode[];
  /**
   * Configuration settings universal to all packages
   */
  repoSettings: {
    /**
     * The common temp folder for the repo
     */
    commonTempFolder: string;
  };
}

/**
 * This is the schema of a graph node
 * @beta
 */
export interface IGraphNode {
  /**
   * The unique identifier for this node
   */
  id: string;
  /**
   * The package name for this node
   */
  package: string;
  /**
   * The task to be run for the package
   */
  task: string;
  /**
   * The command to run for the given package and task, usually defined in the package.json
   */
  command: string;
  /**
   * The working directory where the command should be run
   */
  workingDirectory: string;
  /**
   * The dependencies for this node, as an array of other node ids
   */
  dependencies: string[];
}

/**
 * This plugin is used to drop the build graph to a file for BuildXL to consume.
 * @beta
 */
export class DropBuildGraphPlugin implements IRushPlugin {
  private readonly _pluginName: string = PLUGIN_NAME;

  public apply(session: RushSession, configuration: RushConfiguration): void {
    const dropIndex: number = process.argv.indexOf('--drop-graph');
    const dropGraphPath: string | undefined = dropIndex > -1 ? process.argv[dropIndex + 1] : undefined;

    if (!dropGraphPath) {
      return;
    }

    session.hooks.runAnyPhasedCommand.tap(this._pluginName, (command: IPhasedCommand) => {
      command.hooks.createOperations.tapPromise(
        {
          name: this._pluginName,
          stage: Number.MAX_SAFE_INTEGER // Run this after other plugins have created all operations
        },
        async (operations: Set<Operation>, context: ICreateOperationsContext) => {
          const { _dropGraphAsync: _dropGraph } = await import('./DropGraph');
          const parameters: IDropGraphOptions = {
            operations,
            context,
            dropGraphPath,
            configuration,
            logger: session.getLogger(this._pluginName)
          };
          const isValid: boolean = await _dropGraph(parameters);
          if (isValid) {
            process.exit(0);
          } else {
            process.exit(1);
          }
        }
      );
    });
  }
}
