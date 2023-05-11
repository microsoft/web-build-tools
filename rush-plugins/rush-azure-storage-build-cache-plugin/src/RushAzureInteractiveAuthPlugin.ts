// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { DeviceCodeCredential, type DeviceCodeInfo, AzureAuthorityHosts } from '@azure/identity';
import type { IRushPlugin, RushSession, RushConfiguration, ILogger } from '@rushstack/rush-sdk';
import type { AzureEnvironmentName, ICredentialResult } from './AzureAuthenticationBase';
import { PrintUtilities } from '@rushstack/terminal';
import { AzureStorageAuthentication } from './AzureStorageAuthentication';
import { Terminal, ITerminal } from '@rushstack/node-core-library';
import { CredentialCache } from '@rushstack/rush-sdk';

const PLUGIN_NAME: 'AzureInteractiveAuthPlugin' = 'AzureInteractiveAuthPlugin';

/**
 * @public
 */
export interface IAzureInteractiveAuthOptions {
  /**
   * The name of the the Azure storage account to authenticate to.
   */
  readonly storageAccountName?: string;

  /**
   * The name of the container in the Azure storage account to authenticate to.
   */
  readonly storageContainerName?: string;

  /**
   * The Azure environment the storage account exists in. Defaults to AzureCloud.
   */
  readonly azureEnvironment?: AzureEnvironmentName;

  /**
   * If specified and a credential exists that will be valid for at least this many minutes from the time
   * of execution, no action will be taken.
   */
  readonly minimumValidityInMinutes?: number;

  /**
   * The set of Rush global commands before which credentials should be updated.
   */
  readonly globalCommands?: string[];

  /**
   * The set of Rush phased commands before which credentials should be updated.
   */
  readonly phasedCommands?: string[];

  /**
   * The list of credentials to be retrieved from Azure.
   */
  readonly authList: IAzureAuthenticationConfiguration[];
}

/**
 * @public
 */
export interface IAzureAuthenticationConfiguration {
  readonly azureStorageType: string;
  readonly storageAccountName: string;
  readonly storageContainerName?: string;
  readonly keyVaultSecretName?: string;
  readonly keyVaultName?: string;
  readonly filePath: string;
}

export interface IFetchCredentialsScripts {
  additionalCredentialFetchers: (
    deviceCodeCredential: DeviceCodeCredential,
    terminal: Terminal,
    options: IAzureAuthenticationConfiguration
  ) => Promise<ICredentialResultWithId>;
}

export interface ICredentialResultWithId {
  credentialId: string;
  credential: ICredentialResult;
}

/**
 * This plugin is for performing interactive authentication to an arbitrary Azure blob storage account.
 * It is meant to be used for scenarios where custom commands may interact with Azure blob storage beyond
 * the scope of the build cache (for build cache, use the RushAzureStorageBuildCachePlugin).
 *
 * However, since the authentication has the same dependencies, if the repository already uses the build
 * cache plugin, the additional functionality for authentication can be provided at minimal cost.
 *
 * @public
 */
export default class RushAzureInteractieAuthPlugin implements IRushPlugin {
  private readonly _options: IAzureInteractiveAuthOptions | undefined;

  public readonly pluginName: 'AzureInteractiveAuthPlugin' = PLUGIN_NAME;

  public constructor(options: IAzureInteractiveAuthOptions | undefined) {
    this._options = options;
  }

  private async updateCachedCredentialListAsync(
    terminal: ITerminal,
    credentialList: ICredentialResultWithId[]
  ): Promise<void> {
    await CredentialCache.usingAsync(
      {
        supportEditing: true
      },
      async (credentialsCache: CredentialCache) => {
        for (const credential of credentialList) {
          const credentialId: string = credential.credentialId;
          const credentialCore: ICredentialResult = credential.credential;
          credentialsCache.setCacheEntry(credentialId, {
            credential: credentialCore.credentialString,
            expires: credentialCore.expiresOn,
            credentialMetadata: credentialCore.credentialMetadata
          });
        }

        await credentialsCache.saveIfModifiedAsync();
      }
    );
  }

  public apply(rushSession: RushSession, rushConfig: RushConfiguration): void {
    const options: Array<IAzureInteractiveAuthOptions> | IAzureInteractiveAuthOptions | undefined =
      this._options;

    if (!options) {
      // Plugin is not enabled.
      return;
    }

    const { hooks } = rushSession;
    const logger: ILogger = rushSession.getLogger(PLUGIN_NAME);

    const { globalCommands, phasedCommands } = options;

    const handler: () => Promise<void> = async () => {
      const { authList, azureEnvironment = 'AzurePublicCloud', minimumValidityInMinutes } = options;
      const authorityHost: string | undefined = AzureAuthorityHosts[azureEnvironment];

      let minimumExpiry: Date | undefined;
      if (typeof minimumValidityInMinutes === 'number') {
        minimumExpiry = new Date(Date.now() + minimumValidityInMinutes * 60 * 1000);
      }

      const deviceCodeCredential: DeviceCodeCredential = new DeviceCodeCredential({
        authorityHost: authorityHost,
        userPromptCallback: (deviceCodeInfo: DeviceCodeInfo) => {
          PrintUtilities.printMessageInBox(deviceCodeInfo.message, logger.terminal);
        }
      });

      const credentials: ICredentialResultWithId[] = [];

      for (const configuration of authList) {
        const {
          azureStorageType,
          storageAccountName,
          storageContainerName = 'dev',
          filePath
        } = configuration;

        if (azureStorageType === 'AzureBlobStorage') {
          await new AzureStorageAuthentication({
            storageAccountName: storageAccountName,
            storageContainerName: storageContainerName,
            azureEnvironment: options.azureEnvironment,
            isCacheWriteAllowed: true,
            deviceCodeCredentails: deviceCodeCredential
          }).updateCachedCredentialInteractiveAsync(logger.terminal, minimumExpiry);
        } else {
          const fetchers: IFetchCredentialsScripts = await import(filePath);

          const credential: ICredentialResultWithId = await fetchers.additionalCredentialFetchers(
            deviceCodeCredential,
            logger.terminal,
            configuration
          );

          credentials.push(credential);
        }
      }

      await this.updateCachedCredentialListAsync(logger.terminal, credentials);
    };

    if (globalCommands) {
      for (const commandName of globalCommands) {
        hooks.runGlobalCustomCommand.for(commandName).tapPromise(PLUGIN_NAME, handler);
      }
    }

    if (phasedCommands) {
      for (const commandName of phasedCommands) {
        hooks.runPhasedCommand.for(commandName).tapPromise(PLUGIN_NAME, handler);
      }
    }
  }
}
