// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as lodash from 'lodash';

export class Constants {
  public static LOCALE_FILENAME_TOKEN: string = '[locale]';
  public static LOCALE_FILENAME_TOKEN_REGEX: RegExp = new RegExp(
    lodash.escapeRegExp(Constants.LOCALE_FILENAME_TOKEN),
    'gi'
  );
  public static NO_LOCALE_SOURCE_MAP_FILENAME_TOKEN: string = '[no-locale-file]';
  public static NO_LOCALE_SOURCE_MAP_FILENAME_TOKEN_REGEX: RegExp = new RegExp(
    lodash.escapeRegExp(Constants.NO_LOCALE_SOURCE_MAP_FILENAME_TOKEN),
    'gi'
  );
  public static STRING_PLACEHOLDER_PREFIX: string = '_LOCALIZED_STRING_f12dy0i7_n4bo_dqwj_39gf_sasqehjmihz9';

  public static RESOURCE_FILE_NAME_REGEXP: RegExp = /\.(resx|resx\.json|loc\.json|resjson)$/i;

  public static STRING_PLACEHOLDER_LABEL: string = 'A';
  public static LOCALE_NAME_PLACEHOLDER_LABEL: string = 'B';
  public static JSONP_PLACEHOLDER_LABEL: string = 'C';

  public static LOCALE_NAME_PLACEHOLDER: string = `${Constants.STRING_PLACEHOLDER_PREFIX}__${Constants.LOCALE_NAME_PLACEHOLDER_LABEL}_0`;
  public static JSONP_PLACEHOLDER: string = `${Constants.STRING_PLACEHOLDER_PREFIX}__${Constants.JSONP_PLACEHOLDER_LABEL}+chunkId+_0`;
}
