// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import { EnvironmentConfiguration } from '../EnvironmentConfiguration';

describe(EnvironmentConfiguration.name, () => {
  let _oldEnv: typeof process.env;

  beforeEach(() => {
    EnvironmentConfiguration.reset();
    _oldEnv = process.env;
    process.env = {};
  });

  afterEach(() => {
    process.env = _oldEnv;
  });

  describe(EnvironmentConfiguration.validate.name, () => {
    it('correctly allows no environment variables', () => {
      expect(EnvironmentConfiguration.validate).not.toThrow();
    });

    it('allows known environment variables', () => {
      process.env['RUSH_TEMP_FOLDER'] = '/var/temp'; // eslint-disable-line dot-notation
      expect(EnvironmentConfiguration.validate).not.toThrow();
    });

    it('does not allow unknown environment variables', () => {
      process.env['rush_foobar'] = 'asdf'; // eslint-disable-line dot-notation
      expect(EnvironmentConfiguration.validate).toThrow();
    });

    it('can revalidate after a reset', () => {
      process.env['RUSH_TEMP_FOLDER'] = '/var/tempA'; // eslint-disable-line dot-notation
      EnvironmentConfiguration.validate({ doNotNormalizePaths: true });

      expect(EnvironmentConfiguration.rushTempFolderOverride).toEqual('/var/tempA');

      process.env['RUSH_TEMP_FOLDER'] = '/var/tempB'; // eslint-disable-line dot-notation
      EnvironmentConfiguration.validate({ doNotNormalizePaths: true });

      expect(EnvironmentConfiguration.rushTempFolderOverride).toEqual('/var/tempB');
    });
  });

  describe('rushTempDirOverride', () => {
    it('returns undefined for unset environment variables', () => {
      EnvironmentConfiguration.validate();

      expect(EnvironmentConfiguration.rushTempFolderOverride).not.toBeDefined();
    });

    it('returns the value for a set environment variable', () => {
      const expectedValue: string = '/var/temp';
      process.env['RUSH_TEMP_FOLDER'] = expectedValue; // eslint-disable-line dot-notation
      EnvironmentConfiguration.validate({ doNotNormalizePaths: true });

      expect(EnvironmentConfiguration.rushTempFolderOverride).toEqual(expectedValue);
    });
  });

  describe('binaryOverride', () => {
    it('returns undefined for unset environment variables', () => {
      EnvironmentConfiguration.validate();

      expect(EnvironmentConfiguration.gitBinaryPath).not.toBeDefined();
      expect(EnvironmentConfiguration.tarBinaryPath).not.toBeDefined();
    });

    it('returns the value for a set environment variable', () => {
      const gitPath: string = '/usr/bin/git';
      const tarPath: string = '/usr/bin/tar';
      process.env.RUSH_GIT_BINARY_PATH = gitPath;
      process.env.RUSH_TAR_BINARY_PATH = tarPath;
      EnvironmentConfiguration.validate({ doNotNormalizePaths: true });

      expect(EnvironmentConfiguration.gitBinaryPath).toEqual(gitPath);
      expect(EnvironmentConfiguration.tarBinaryPath).toEqual(tarPath);
    });
  });

  describe('pnpmStorePathOverride', () => {
    const ENV_VAR: string = 'RUSH_PNPM_STORE_PATH';

    it('returns undefined for unset environment variable', () => {
      EnvironmentConfiguration.validate();

      expect(EnvironmentConfiguration.pnpmStorePathOverride).not.toBeDefined();
    });

    it('returns the expected path from environment variable without normalization', () => {
      const expectedValue: string = '/var/temp';
      process.env[ENV_VAR] = expectedValue;
      EnvironmentConfiguration.validate({ doNotNormalizePaths: true });

      expect(EnvironmentConfiguration.pnpmStorePathOverride).toEqual(expectedValue);
    });

    it('returns expected path from environment variable with normalization', () => {
      const expectedValue: string = path.resolve(process.cwd(), 'temp');
      const envVar: string = './temp';
      process.env[ENV_VAR] = envVar;

      EnvironmentConfiguration.validate();

      expect(EnvironmentConfiguration.pnpmStorePathOverride).toEqual(expectedValue);
    });
  });

  describe('pnpmVirtualStorePathOverride', () => {
    const ENV_VAR: string = 'RUSH_PNPM_VIRTUAL_STORE_PATH';

    it('returns undefined for unset environment variable', () => {
      EnvironmentConfiguration.validate();

      expect(EnvironmentConfiguration.pnpmVirtualStorePathOverride).not.toBeDefined();
    });

    it('returns the expected path from environment variable without normalization', () => {
      const expectedValue: string = '/var/temp';
      process.env[ENV_VAR] = expectedValue;
      EnvironmentConfiguration.validate({ doNotNormalizePaths: true });

      expect(EnvironmentConfiguration.pnpmVirtualStorePathOverride).toEqual(expectedValue);
    });

    it('returns expected path from environment variable with normalization', () => {
      const expectedValue: string = path.resolve(process.cwd(), 'temp');
      const envVar: string = './temp';
      process.env[ENV_VAR] = envVar;

      EnvironmentConfiguration.validate();

      expect(EnvironmentConfiguration.pnpmVirtualStorePathOverride).toEqual(expectedValue);
    });
  });
});
