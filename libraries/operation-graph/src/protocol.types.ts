// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { OperationStatus } from './OperationStatus';

/**
 * A message sent to the host to ask it to run this task.
 *
 * @beta
 */
export interface IRequestRunEventMessage {
  event: 'requestRun';
  requestor: string;
}

/**
 * A message sent to the host upon completion of a run of this task.
 *
 * @beta
 */
export interface IAfterExecuteEventMessage {
  event: 'after-execute';
  status: OperationStatus;
}

/**
 * A message sent to the host upon connection of the channel, to indicate
 * to the host that this task supports the protocol and to provide baseline status information.
 *
 * @beta
 */
export interface ISyncEventMessage {
  event: 'sync';
  status: OperationStatus;
}

/**
 * A message sent by the host to tell the watch loop to cancel the current run.
 *
 * @beta
 */
export interface ICancelCommandMessage {
  command: 'cancel';
}

/**
 * A message sent by the host to tell the watch loop to shutdown gracefully.
 *
 * @beta
 */
export interface IExitCommandMessage {
  command: 'exit';
}

/**
 * A message sent by the host to tell the watch loop to perform a single run.
 *
 * @beta
 */
export interface IRunCommandMessage {
  command: 'run';
}

/**
 * A message sent by the host to ask for to resync status information.
 *
 * @beta
 */
export interface ISyncCommandMessage {
  command: 'sync';
}

/**
 * The set of known messages from the host to the watch loop.
 * @beta
 */
export type CommandMessageFromHost =
  | ICancelCommandMessage
  | IExitCommandMessage
  | IRunCommandMessage
  | ISyncCommandMessage;

/**
 * The set of known messages from the watch loop to the host.
 * @beta
 */
export type EventMessageFromClient = IRequestRunEventMessage | IAfterExecuteEventMessage | ISyncEventMessage;

/**
 * The interface contract for IPC send/receive, to support alternate channels and unit tests.
 *
 * @beta
 */
export type IPCHost = Pick<typeof process, 'on' | 'send'>;
