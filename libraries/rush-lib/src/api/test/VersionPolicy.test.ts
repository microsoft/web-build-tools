// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { IPackageJson } from '@rushstack/node-core-library';

import { VersionPolicyConfiguration } from '../VersionPolicyConfiguration';
import { VersionPolicy, LockStepVersionPolicy, IndividualVersionPolicy, BumpType } from '../VersionPolicy';

describe(VersionPolicy.name, () => {
  describe(LockStepVersionPolicy.name, () => {
    const filename: string = `${__dirname}/jsonFiles/rushWithLockVersion.json`;
    let versionPolicyConfig: VersionPolicyConfiguration;
    let versionPolicy1: VersionPolicy;
    let versionPolicy2: VersionPolicy;
    let versionPolicy3: VersionPolicy;
    let versionPolicy4: VersionPolicy;
    let versionPolicy5: VersionPolicy;

    beforeEach(() => {
      versionPolicyConfig = new VersionPolicyConfiguration(filename);
      versionPolicy1 = versionPolicyConfig.getVersionPolicy('testPolicy1');
      versionPolicy2 = versionPolicyConfig.getVersionPolicy('testPolicy2');
      versionPolicy3 = versionPolicyConfig.getVersionPolicy('testPolicy3');
      versionPolicy4 = versionPolicyConfig.getVersionPolicy('testPolicy4');
      versionPolicy5 = versionPolicyConfig.getVersionPolicy('testPolicy5');
    });

    it('loads configuration.', () => {
      expect(versionPolicy1).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy1: LockStepVersionPolicy = versionPolicy1 as LockStepVersionPolicy;
      expect(lockStepVersionPolicy1.version).toEqual('1.1.0');
      expect(lockStepVersionPolicy1.nextBump).toEqual(BumpType.patch);

      expect(versionPolicy2).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy2: LockStepVersionPolicy = versionPolicy2 as LockStepVersionPolicy;
      expect(lockStepVersionPolicy2.version).toEqual('1.2.0');
      expect(lockStepVersionPolicy2.nextBump).toEqual(undefined);
    });

    it('skips packageJson if version is already the locked step version', () => {
      expect(versionPolicy1).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy: LockStepVersionPolicy = versionPolicy1 as LockStepVersionPolicy;
      expect(
        lockStepVersionPolicy.ensure({
          name: 'a',
          version: '1.1.0'
        })
      ).not.toBeDefined();
    });

    it('updates packageJson if version is lower than the locked step version', () => {
      expect(versionPolicy1).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy: LockStepVersionPolicy = versionPolicy1 as LockStepVersionPolicy;
      const expectedPackageJson: IPackageJson = {
        name: 'a',
        version: '1.1.0'
      };
      const originalPackageJson: IPackageJson = {
        name: 'a',
        version: '1.0.1'
      };
      expect(lockStepVersionPolicy.ensure(originalPackageJson)).toEqual(expectedPackageJson);
    });

    it('throws exception if version is higher than the locked step version', () => {
      expect(versionPolicy1).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy: LockStepVersionPolicy = versionPolicy1 as LockStepVersionPolicy;
      const originalPackageJson: IPackageJson = {
        name: 'a',
        version: '2.1.0'
      };
      expect(() => {
        lockStepVersionPolicy.ensure(originalPackageJson);
      }).toThrow();
    });

    it('update version with force if version is higher than the locked step version', () => {
      expect(versionPolicy1).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy: LockStepVersionPolicy = versionPolicy1 as LockStepVersionPolicy;
      const originalPackageJson: IPackageJson = {
        name: 'a',
        version: '2.1.0'
      };
      const expectedPackageJson: IPackageJson = {
        name: 'a',
        version: '1.1.0'
      };
      expect(lockStepVersionPolicy.ensure(originalPackageJson, true)).toEqual(expectedPackageJson);
    });

    it('doesnt bump version if nextBump is undefined', () => {
      expect(versionPolicy1).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy: LockStepVersionPolicy = versionPolicy2 as LockStepVersionPolicy;
      expect(lockStepVersionPolicy.nextBump).toEqual(undefined);
      lockStepVersionPolicy.bump();
      expect(lockStepVersionPolicy.version).toEqual('1.2.0');
      expect(lockStepVersionPolicy.nextBump).toEqual(undefined);
    });

    it('bumps version for premajor release', () => {
      expect(versionPolicy1).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy: LockStepVersionPolicy = versionPolicy1 as LockStepVersionPolicy;
      lockStepVersionPolicy.bump(BumpType.premajor, 'pr');
      expect(lockStepVersionPolicy.version).toEqual('2.0.0-pr.0');
      expect(lockStepVersionPolicy.nextBump).toEqual(BumpType.patch);
    });

    it('patch gets rid of prerelease version made with premajor', () => {
      expect(versionPolicy3).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy: LockStepVersionPolicy = versionPolicy3 as LockStepVersionPolicy;
      expect(lockStepVersionPolicy.nextBump).toEqual(undefined);
      lockStepVersionPolicy.bump(BumpType.patch);
      expect(lockStepVersionPolicy.version).toEqual('1.0.0');
      expect(lockStepVersionPolicy.nextBump).toEqual(undefined);
    });

    it('bumps version for preminor release', () => {
      expect(versionPolicy1).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy: LockStepVersionPolicy = versionPolicy1 as LockStepVersionPolicy;
      lockStepVersionPolicy.bump(BumpType.preminor, 'pr');
      expect(lockStepVersionPolicy.version).toEqual('1.2.0-pr.0');
      expect(lockStepVersionPolicy.nextBump).toEqual(BumpType.patch);
    });

    it('patch gets rid of prerelease version made with preminor', () => {
      expect(versionPolicy4).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy: LockStepVersionPolicy = versionPolicy4 as LockStepVersionPolicy;
      expect(lockStepVersionPolicy.nextBump).toEqual(undefined);
      lockStepVersionPolicy.bump(BumpType.patch);
      expect(lockStepVersionPolicy.version).toEqual('1.1.0');
      expect(lockStepVersionPolicy.nextBump).toEqual(undefined);
    });

    it('bumps version for prepatch release', () => {
      expect(versionPolicy1).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy: LockStepVersionPolicy = versionPolicy1 as LockStepVersionPolicy;
      lockStepVersionPolicy.bump(BumpType.prepatch, 'pr');
      expect(lockStepVersionPolicy.version).toEqual('1.1.1-pr.0');
      expect(lockStepVersionPolicy.nextBump).toEqual(BumpType.patch);
    });

    it('patch gets rid of prepatch version made with preminor', () => {
      expect(versionPolicy5).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy: LockStepVersionPolicy = versionPolicy5 as LockStepVersionPolicy;
      expect(lockStepVersionPolicy.nextBump).toEqual(undefined);
      lockStepVersionPolicy.bump(BumpType.patch);
      expect(lockStepVersionPolicy.version).toEqual('1.1.1');
      expect(lockStepVersionPolicy.nextBump).toEqual(undefined);
    });

    it('bumps version for minor release', () => {
      expect(versionPolicy1).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy: LockStepVersionPolicy = versionPolicy1 as LockStepVersionPolicy;
      lockStepVersionPolicy.bump(BumpType.minor);
      expect(lockStepVersionPolicy.version).toEqual('1.2.0');
      expect(lockStepVersionPolicy.nextBump).toEqual(BumpType.patch);
    });

    it('can update version directly', () => {
      expect(versionPolicy1).toBeInstanceOf(LockStepVersionPolicy);
      const lockStepVersionPolicy: LockStepVersionPolicy = versionPolicy1 as LockStepVersionPolicy;
      const newVersion: string = '1.5.6-beta.0';
      lockStepVersionPolicy.update(newVersion);
      expect(lockStepVersionPolicy.version).toEqual(newVersion);
    });
  });

  describe(IndividualVersionPolicy.name, () => {
    const fileName: string = `${__dirname}/jsonFiles/rushWithIndividualVersion.json`;
    const versionPolicyConfig: VersionPolicyConfiguration = new VersionPolicyConfiguration(fileName);
    const versionPolicy: VersionPolicy = versionPolicyConfig.getVersionPolicy('testPolicy2');

    it('loads configuration', () => {
      expect(versionPolicy).toBeInstanceOf(IndividualVersionPolicy);
      const individualVersionPolicy: IndividualVersionPolicy = versionPolicy as IndividualVersionPolicy;
      expect(individualVersionPolicy.lockedMajor).toEqual(2);
    });

    it('skips packageJson if no need to change', () => {
      const individualVersionPolicy: IndividualVersionPolicy = versionPolicy as IndividualVersionPolicy;
      expect(
        individualVersionPolicy.ensure({
          name: 'a',
          version: '2.1.0'
        })
      ).not.toBeDefined();
    });

    it('updates packageJson if version is lower than the locked major', () => {
      const individualVersionPolicy: IndividualVersionPolicy = versionPolicy as IndividualVersionPolicy;
      const expectedPackageJson: IPackageJson = {
        name: 'a',
        version: '2.0.0'
      };
      const originalPackageJson: IPackageJson = {
        name: 'a',
        version: '1.0.1'
      };
      expect(individualVersionPolicy.ensure(originalPackageJson)).toEqual(expectedPackageJson);
    });

    it('throws exception if version is higher than the locked step version', () => {
      const individualVersionPolicy: IndividualVersionPolicy = versionPolicy as IndividualVersionPolicy;
      const originalPackageJson: IPackageJson = {
        name: 'a',
        version: '3.1.0'
      };
      expect(() => {
        individualVersionPolicy.ensure(originalPackageJson);
      }).toThrow();
    });
  });
});
