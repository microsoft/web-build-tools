// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { InternalError } from '@rushstack/node-core-library';
import { Colorize, type ITerminal } from '@rushstack/terminal';

import type {
  ICreateOperationsContext,
  IPhasedCommandPlugin,
  PhasedCommandHooks
} from '../../pluginFramework/PhasedCommandHooks';
import type { IExecutionResult, IOperationExecutionResult } from './IOperationExecutionResult';
import type { Operation } from './Operation';
import { OperationStatus } from './OperationStatus';
import type { OperationExecutionRecord } from './OperationExecutionRecord';
import type { IStopwatchResult } from '../../utilities/Stopwatch';

const PLUGIN_NAME: 'OperationResultSummarizerPlugin' = 'OperationResultSummarizerPlugin';

/**
 * Format "======" lines for a shell window with classic 80 columns
 */
const ASCII_HEADER_WIDTH: number = 79;

type IOperationAndResult = [Operation, IOperationExecutionResult];
type IOperationsByStatus = Map<OperationStatus, IOperationAndResult[]>;

/**
 * Phased command plugin that emits a summary of build results to the console.
 */
export class OperationResultSummarizerPlugin implements IPhasedCommandPlugin {
  private readonly _terminal: ITerminal;

  public constructor(terminal: ITerminal) {
    this._terminal = terminal;
  }

  public apply(hooks: PhasedCommandHooks): void {
    hooks.afterExecuteOperations.tap(
      PLUGIN_NAME,
      (result: IExecutionResult, context: ICreateOperationsContext): void => {
        _printOperationStatus(this._terminal, result);
      }
    );
  }
}

/**
 * Prints out a report of the status of each project
 * @internal
 */
export function _printOperationStatus(terminal: ITerminal, result: IExecutionResult): void {
  const { operationResults } = result;

  const operationsByStatus: IOperationsByStatus = new Map();
  for (const record of operationResults) {
    if (record[1].silent) {
      // Don't report silenced operations
      continue;
    }

    const { status } = record[1];
    switch (status) {
      // These are the sections that we will report below
      case OperationStatus.Skipped:
      case OperationStatus.FromCache:
      case OperationStatus.Success:
      case OperationStatus.SuccessWithWarning:
      case OperationStatus.Blocked:
      case OperationStatus.Failure:
      case OperationStatus.NoOp:
        break;
      default:
        // This should never happen
        throw new InternalError(`Unexpected operation status: ${status}`);
    }

    const collection: IOperationAndResult[] | undefined = operationsByStatus.get(status);
    if (collection) {
      collection.push(record);
    } else {
      operationsByStatus.set(status, [record]);
    }
  }

  // Skip a few lines before we start the summary
  terminal.writeLine('\n\n');

  // These are ordered so that the most interesting statuses appear last:
  writeCondensedSummary(
    terminal,
    OperationStatus.Skipped,
    operationsByStatus,
    Colorize.green,
    'These operations were already up to date:'
  );

  writeCondensedSummary(
    terminal,
    OperationStatus.NoOp,
    operationsByStatus,
    Colorize.gray,
    'These operations did not define any work:'
  );

  writeCondensedSummary(
    terminal,
    OperationStatus.FromCache,
    operationsByStatus,
    Colorize.green,
    'These operations were restored from the build cache:'
  );

  writeCondensedSummary(
    terminal,
    OperationStatus.Success,
    operationsByStatus,
    Colorize.green,
    'These operations completed successfully:'
  );

  writeDetailedSummary(
    terminal,
    OperationStatus.SuccessWithWarning,
    operationsByStatus,
    Colorize.yellow,
    'WARNING'
  );

  writeCondensedSummary(
    terminal,
    OperationStatus.Blocked,
    operationsByStatus,
    Colorize.white,
    'These operations were blocked by dependencies that failed:'
  );

  writeDetailedSummary(terminal, OperationStatus.Failure, operationsByStatus, Colorize.red);

  terminal.writeLine('');

  switch (result.status) {
    case OperationStatus.Failure:
      terminal.writeErrorLine('Operations failed.\n');
      break;
    case OperationStatus.SuccessWithWarning:
      terminal.writeWarningLine('Operations succeeded with warnings.\n');
      break;
  }
}

function writeCondensedSummary(
  terminal: ITerminal,
  status: OperationStatus,
  operationsByStatus: IOperationsByStatus,
  headingColor: (text: string) => string,
  preamble: string
): void {
  // Example:
  //
  // ==[ BLOCKED: 4 projects ]==============================================================
  //
  // These projects were blocked by dependencies that failed:
  //   @scope/name
  //   e
  //   k
  const operations: IOperationAndResult[] | undefined = operationsByStatus.get(status);
  if (!operations || operations.length === 0) {
    return;
  }

  writeSummaryHeader(terminal, status, operations, headingColor);
  terminal.writeLine(preamble);

  let longestTaskName: number = 0;
  for (const [operation] of operations) {
    const nameLength: number = (operation.name || '').length;
    if (nameLength > longestTaskName) {
      longestTaskName = nameLength;
    }
  }

  for (const [operation, operationResult] of operations) {
    const { _operationMetadataManager: operationMetadataManager } =
      operationResult as OperationExecutionRecord;
    const stopwatch: IStopwatchResult =
      operationMetadataManager?.tryRestoreStopwatch(operationResult.stopwatch) ?? operationResult.stopwatch;
    if (
      stopwatch.duration !== 0 &&
      operation.runner!.reportTiming &&
      operationResult.status !== OperationStatus.Skipped
    ) {
      const time: string = stopwatch.toString();
      const padding: string = ' '.repeat(longestTaskName - (operation.name || '').length);
      const cacheString: string = operationMetadataManager?.wasCobuilt
        ? ` (restore ${(
            (operationResult.stopwatch.endTime ?? 0) - (operationResult.stopwatch.startTime ?? 0)
          ).toFixed(1)}ms)`
        : '';
      terminal.writeLine(`  ${operation.name}${padding}    ${time}${cacheString}`);
    } else {
      terminal.writeLine(`  ${operation.name}`);
    }
  }
  terminal.writeLine('');
}

function writeDetailedSummary(
  terminal: ITerminal,
  status: OperationStatus,
  operationsByStatus: IOperationsByStatus,
  headingColor: (text: string) => string,
  shortStatusName?: string
): void {
  // Example:
  //
  // ==[ SUCCESS WITH WARNINGS: 2 projects ]================================
  //
  // --[ WARNINGS: f ]------------------------------------[ 5.07 seconds ]--
  //
  // [eslint] Warning: src/logic/operations/OperationsExecutionManager.ts:393:3 ...

  const operations: IOperationAndResult[] | undefined = operationsByStatus.get(status);
  if (!operations || operations.length === 0) {
    return;
  }

  writeSummaryHeader(terminal, status, operations, headingColor);

  if (shortStatusName === undefined) {
    shortStatusName = status;
  }

  for (const [operation, operationResult] of operations) {
    const { _operationMetadataManager: operationMetadataManager } =
      operationResult as OperationExecutionRecord;
    // Format a header like this
    //
    // --[ WARNINGS: f ]------------------------------------[ 5.07 seconds ]--

    // leftPart: "--[ WARNINGS: f "
    const subheadingText: string = `${shortStatusName}: ${operation.name}`;

    const leftPartLength: number = 4 + subheadingText.length + 1;

    // rightPart: " 5.07 seconds ]--"
    const stopwatch: IStopwatchResult =
      operationMetadataManager?.tryRestoreStopwatch(operationResult.stopwatch) ?? operationResult.stopwatch;
    const time: string = stopwatch.toString();
    const rightPartLength: number = 1 + time.length + 1 + 3;

    // middlePart: "]----------------------["
    const twoBracketsLength: 2 = 2;
    const middlePartLengthMinusTwoBrackets: number = Math.max(
      ASCII_HEADER_WIDTH - (leftPartLength + rightPartLength + twoBracketsLength),
      0
    );

    terminal.writeLine(
      `${Colorize.gray('--[')} ${headingColor(subheadingText)} ${Colorize.gray(
        `]${'-'.repeat(middlePartLengthMinusTwoBrackets)}[`
      )} ${Colorize.white(time)} ${Colorize.gray(']--')}\n`
    );

    const details: string = operationResult.stdioSummarizer.getReport();
    if (details) {
      // Don't write a newline, because the report will always end with a newline
      terminal.write(details);
    }

    terminal.writeLine('');
  }
}

function writeSummaryHeader(
  terminal: ITerminal,
  status: OperationStatus,
  operations: ReadonlyArray<unknown>,
  headingColor: (text: string) => string
): void {
  // Format a header like this
  //
  // ==[ FAILED: 2 operations ]================================================

  // "2 operations"
  const projectsText: string = `${operations.length}${
    operations.length === 1 ? ' operation' : ' operations'
  }`;
  const headingText: string = `${status}: ${projectsText}`;

  // leftPart: "==[ FAILED: 2 operations "
  const leftPartLength: number = 3 + 1 + headingText.length + 1;

  const rightPartLengthMinusBracket: number = Math.max(ASCII_HEADER_WIDTH - (leftPartLength + 1), 0);

  // rightPart: "]======================"

  terminal.writeLine(
    `${Colorize.gray('==[')} ${headingColor(headingText)} ${Colorize.gray(
      `]${'='.repeat(rightPartLengthMinusBracket)}`
    )}\n`
  );
}
