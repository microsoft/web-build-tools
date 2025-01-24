// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { JsonFile, Path } from '@rushstack/node-core-library';
import type { ICreateOperationsContext, ILogger, Operation, RushConfiguration } from '@rushstack/rush-sdk';
import { basename, dirname } from 'path';
import type { IRushGraph, IGraphNode } from './DropBuildGraphPlugin';
import { filterObjectForDebug, filterObjectForTesting } from './GraphDebugHelpers';
import { GraphParser } from './GraphParser';

export interface IDropGraphOptions {
  operations: Set<Operation>;
  context: ICreateOperationsContext;
  dropGraphPath: string;
  configuration: RushConfiguration;
  logger: ILogger;
}

export async function _dropGraphAsync(parameters: IDropGraphOptions): Promise<boolean> {
  const { operations, context, dropGraphPath, configuration, logger } = parameters;

  const graphParser: GraphParser = new GraphParser(logger, configuration.rushJsonFolder);
  const graph: IGraphNode[] = graphParser.processOperations(operations);

  if (process.env.DEBUG_RUSH_BUILD_GRAPH) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let filterFn: ((obj: any, depth?: number) => any) | undefined;
    switch (process.env.DEBUG_RUSH_BUILD_GRAPH) {
      case 'test':
        filterFn = filterObjectForTesting;
        break;
      case 'full':
        filterFn = filterObjectForDebug;
        break;
      default:
        logger.terminal.writeWarningLine("ignoring DEBUG_RUSH_BUILD_GRAPH, not set to 'test' or 'full'");
    }
    if (filterFn) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const graphOut: any = [];
      for (const operation of operations.keys()) {
        graphOut.push(filterFn(operation));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const debugOutput: any = {
        OperationMap: graphOut,
        ICreateOperationsContext: filterFn(context)
      };
      const debugPathOut: string = `${dirname(dropGraphPath)}debug-${basename(dropGraphPath)}`;

      await JsonFile.saveAsync(debugOutput, debugPathOut, { ensureFolderExists: true });
    }
  }
  let rushJsonFolder: string = Path.convertToSlashes(configuration.rushJsonFolder);
  if (!rushJsonFolder.endsWith('/')) {
    rushJsonFolder += '/';
  }

  let commonTempFolder: string | undefined = configuration.commonTempFolder;
  if (commonTempFolder && commonTempFolder.startsWith(rushJsonFolder)) {
    commonTempFolder = commonTempFolder.replace(rushJsonFolder, '');
  }

  const dropGraphOutput: IRushGraph = {
    nodes: graph,
    repoSettings: {
      commonTempFolder
    }
  };

  await JsonFile.saveAsync(dropGraphOutput, dropGraphPath, { ensureFolderExists: true });
  return graphParser.validateGraph(dropGraphOutput.nodes);
}
