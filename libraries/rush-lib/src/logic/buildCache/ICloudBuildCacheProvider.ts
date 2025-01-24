// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { ITerminal } from '@rushstack/terminal';

/**
 * @beta
 */
export interface ICloudBuildCacheProvider {
  readonly isCacheWriteAllowed: boolean;

  /**
   * Gets a cache entry from the provider and stores it at `filePath`.
   * @returns true if the file was written, false otherwise
   */
  tryGetCacheEntryFileByIdAsync?(terminal: ITerminal, cacheId: string, filePath: string): Promise<boolean>;
  /**
   * Sets the cache entry located at `filePath` in this provider.
   * @returns true if the cache entry was persisted, false otherwise
   */
  trySetCacheEntryFileAsync?(terminal: ITerminal, cacheId: string, filePath: string): Promise<boolean>;

  tryGetCacheEntryBufferByIdAsync(terminal: ITerminal, cacheId: string): Promise<Buffer | undefined>;
  trySetCacheEntryBufferAsync(terminal: ITerminal, cacheId: string, entryBuffer: Buffer): Promise<boolean>;
  updateCachedCredentialAsync(terminal: ITerminal, credential: string): Promise<void>;
  updateCachedCredentialInteractiveAsync(terminal: ITerminal): Promise<void>;
  deleteCachedCredentialsAsync(terminal: ITerminal): Promise<void>;
}
