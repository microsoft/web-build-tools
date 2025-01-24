// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';

import yaml = require('js-yaml');
import {
  JsonFile,
  JsonSchema,
  PackageName,
  FileSystem,
  NewlineKind,
  InternalError
} from '@rushstack/node-core-library';
import {
  StringBuilder,
  type DocSection,
  type DocComment,
  type DocBlock,
  StandardTags
} from '@microsoft/tsdoc';
import {
  type ApiModel,
  type ApiItem,
  ApiItemKind,
  ApiDocumentedItem,
  ApiReleaseTagMixin,
  ReleaseTag,
  type ApiPropertyItem,
  ApiItemContainerMixin,
  type ApiPackage,
  type ApiEnumMember,
  ApiClass,
  ApiInterface,
  type ApiMethod,
  type ApiMethodSignature,
  type ApiConstructor,
  type ApiFunction,
  ApiReturnTypeMixin,
  ApiTypeParameterListMixin,
  type Excerpt,
  type ExcerptToken,
  ExcerptTokenKind,
  type HeritageType,
  type ApiVariable,
  type ApiTypeAlias
} from '@microsoft/api-extractor-model';
import {
  type DeclarationReference,
  Navigation,
  Meaning
} from '@microsoft/tsdoc/lib-commonjs/beta/DeclarationReference';
import type {
  IYamlApiFile,
  IYamlItem,
  IYamlSyntax,
  IYamlParameter,
  IYamlReference,
  IYamlReferenceSpec,
  IYamlInheritanceTree
} from '../yaml/IYamlApiFile';
import type { IYamlTocFile, IYamlTocItem } from '../yaml/IYamlTocFile';
import { Utilities } from '../utils/Utilities';
import { CustomMarkdownEmitter } from '../markdown/CustomMarkdownEmitter';
import { convertUDPYamlToSDP } from '../utils/ToSdpConvertHelper';
import typescriptSchema from '../yaml/typescript.schema.json';

const yamlApiSchema: JsonSchema = JsonSchema.fromLoadedObject(typescriptSchema);

interface IYamlReferences {
  references: IYamlReference[];
  typeNameToUid: Map<string, string>;
  uidTypeReferenceCounters: Map<string, number>;
}

enum FlattenMode {
  /** Include entries for nested namespaces and non-namespace children. */
  NestedNamespacesAndChildren,
  /** Include entries for nested namespaces only. */
  NestedNamespacesOnly,
  /** Include entries for non-namespace immediate children. */
  ImmediateChildren,
  /** Include entries for nested non-namespace children. */
  NestedChildren
}

interface INameOptions {
  includeSignature?: boolean;
  includeNamespace?: boolean;
}

export type YamlFormat = 'udp' | 'sdp';

/**
 * Writes documentation in the Universal Reference YAML file format, as defined by typescript.schema.json.
 */
export class YamlDocumenter {
  protected readonly newDocfxNamespaces: boolean;
  private readonly _yamlFormat: string;
  private readonly _apiModel: ApiModel;
  private readonly _markdownEmitter: CustomMarkdownEmitter;

  private _apiItemsByCanonicalReference: Map<string, ApiItem>;
  private _yamlReferences: IYamlReferences | undefined;

  public constructor(
    apiModel: ApiModel,
    newDocfxNamespaces: boolean = false,
    yamlFormat: YamlFormat = 'sdp'
  ) {
    this._apiModel = apiModel;
    this.newDocfxNamespaces = newDocfxNamespaces;
    this._yamlFormat = yamlFormat;
    this._markdownEmitter = new CustomMarkdownEmitter(this._apiModel);
    this._apiItemsByCanonicalReference = new Map<string, ApiItem>();

    this._initApiItems();
  }

  /** @virtual */
  public generateFiles(outputFolder: string): void {
    console.log();
    this._deleteOldOutputFiles(outputFolder);

    for (const apiPackage of this._apiModel.packages) {
      console.log(`Writing ${apiPackage.name} package`);
      this._visitApiItems(outputFolder, apiPackage, undefined);
    }

    if (this._yamlFormat === 'sdp') {
      convertUDPYamlToSDP(outputFolder);
    }

    this._writeTocFile(outputFolder, this._apiModel.packages);
  }

  /** @virtual */
  protected onGetTocRoot(): IYamlTocItem {
    return {
      name: 'SharePoint Framework reference',
      href: '~/overview/sharepoint.md',
      items: []
    };
  }

  /** @virtual */
  protected onCustomizeYamlItem(yamlItem: IYamlItem): void {
    // virtual
    // (overridden by child class)
  }

  private _visitApiItems(
    outputFolder: string,
    apiItem: ApiDocumentedItem,
    parentYamlFile: IYamlApiFile | undefined
  ): boolean {
    let savedYamlReferences: IYamlReferences | undefined;
    if (!this._shouldEmbed(apiItem.kind)) {
      savedYamlReferences = this._yamlReferences;
      this._yamlReferences = undefined;
    }

    const yamlItem: IYamlItem | undefined = this._generateYamlItem(apiItem);
    if (!yamlItem) {
      return false;
    }

    this.onCustomizeYamlItem(yamlItem);

    if (this._shouldEmbed(apiItem.kind)) {
      if (!parentYamlFile) {
        throw new InternalError('Missing file context');
      }
      parentYamlFile.items.push(yamlItem);
    } else {
      const newYamlFile: IYamlApiFile = {
        items: []
      };
      newYamlFile.items.push(yamlItem);

      const children: ApiItem[] = this._getLogicalChildren(apiItem);
      for (const child of children) {
        if (child instanceof ApiDocumentedItem) {
          if (this._visitApiItems(outputFolder, child, newYamlFile)) {
            if (!yamlItem.children) {
              yamlItem.children = [];
            }
            yamlItem.children.push(this._getUid(child));
          }
        }
      }

      if (this._yamlReferences && this._yamlReferences.references.length > 0) {
        newYamlFile.references = this._yamlReferences.references;
      }

      this._yamlReferences = savedYamlReferences;

      const yamlFilePath: string = this._getYamlFilePath(outputFolder, apiItem);

      if (apiItem.kind === ApiItemKind.Package) {
        console.log('Writing ' + yamlFilePath);
      }

      this._writeYamlFile(newYamlFile, yamlFilePath, 'UniversalReference', yamlApiSchema);

      if (parentYamlFile) {
        // References should be recorded in the parent YAML file with the local name of the embedded item.
        // This avoids unnecessary repetition when listing items inside of a namespace.
        this._recordYamlReference(
          this._ensureYamlReferences(),
          this._getUid(apiItem),
          this._getYamlItemName(apiItem, {
            includeNamespace: !this.newDocfxNamespaces,
            includeSignature: true
          }),
          this._getYamlItemName(apiItem, { includeNamespace: true, includeSignature: true })
        );
      }
    }

    return true;
  }

  protected _getLogicalChildren(apiItem: ApiItem): ApiItem[] {
    const children: ApiItem[] = [];
    if (apiItem.kind === ApiItemKind.Package) {
      // Skip over the entry point, since it's not part of the documentation hierarchy
      this._flattenNamespaces(
        apiItem.members[0].members,
        children,
        this.newDocfxNamespaces ? FlattenMode.NestedNamespacesAndChildren : FlattenMode.NestedChildren
      );
    } else {
      this._flattenNamespaces(
        apiItem.members,
        children,
        this.newDocfxNamespaces ? FlattenMode.ImmediateChildren : FlattenMode.NestedChildren
      );
    }
    return children;
  }

  // Flattens nested namespaces into top level entries so that the following:
  //   namespace X { export namespace Y { export namespace Z { } }
  // Is represented as:
  //   - X
  //   - X.Y
  //   - X.Y.Z
  private _flattenNamespaces(
    items: ReadonlyArray<ApiItem>,
    childrenOut: ApiItem[],
    mode: FlattenMode
  ): boolean {
    let hasNonNamespaceChildren: boolean = false;
    for (const item of items) {
      if (item.kind === ApiItemKind.Namespace) {
        switch (mode) {
          case FlattenMode.NestedChildren:
            // Include children of namespaces, but not the namespaces themselves. This matches existing legacy behavior.
            this._flattenNamespaces(item.members, childrenOut, FlattenMode.NestedChildren);
            break;
          case FlattenMode.NestedNamespacesOnly:
          case FlattenMode.NestedNamespacesAndChildren:
            // At any level, always include a nested namespace if it has non-namespace children, but do not include its
            // non-namespace children in the result.

            // Record the offset at which the namespace is added in case we need to remove it later.
            const index: number = childrenOut.length;
            childrenOut.push(item);

            if (!this._flattenNamespaces(item.members, childrenOut, FlattenMode.NestedNamespacesOnly)) {
              // This namespace had no non-namespace children, remove it.
              childrenOut.splice(index, 1);
            }
            break;
        }
      } else if (this._shouldInclude(item.kind)) {
        switch (mode) {
          case FlattenMode.NestedChildren:
          case FlattenMode.NestedNamespacesAndChildren:
          case FlattenMode.ImmediateChildren:
            // At the top level, include non-namespace children as well.
            childrenOut.push(item);
            break;
        }
        hasNonNamespaceChildren = true;
      }
    }
    return hasNonNamespaceChildren;
  }

  /**
   * Write the table of contents
   */
  private _writeTocFile(outputFolder: string, apiItems: ReadonlyArray<ApiItem>): void {
    const tocFile: IYamlTocFile = this.buildYamlTocFile(apiItems);

    const tocFilePath: string = path.join(outputFolder, 'toc.yml');
    console.log('Writing ' + tocFilePath);
    this._writeYamlFile(tocFile, tocFilePath, '', undefined);
  }

  /** @virtual */
  protected buildYamlTocFile(apiItems: ReadonlyArray<ApiItem>): IYamlTocFile {
    const tocFile: IYamlTocFile = {
      items: []
    };

    const rootItem: IYamlTocItem = this.onGetTocRoot();
    tocFile.items.push(rootItem);

    rootItem.items!.push(...this._buildTocItems(apiItems));
    return tocFile;
  }

  private _buildTocItems(apiItems: ReadonlyArray<ApiItem>): IYamlTocItem[] {
    const tocItems: IYamlTocItem[] = [];
    for (const apiItem of apiItems) {
      let tocItem: IYamlTocItem;
      if (apiItem.kind === ApiItemKind.Namespace && !this.newDocfxNamespaces) {
        tocItem = {
          name: this._getTocItemName(apiItem)
        };
      } else {
        if (this._shouldEmbed(apiItem.kind)) {
          // Don't generate table of contents items for embedded definitions
          continue;
        }

        tocItem = {
          name: this._getTocItemName(apiItem),
          uid: this._getUid(apiItem)
        };
      }

      tocItems.push(tocItem);

      const children: ApiItem[] = this._getLogicalChildren(apiItem);
      const childItems: IYamlTocItem[] = this._buildTocItems(children);
      if (childItems.length > 0) {
        tocItem.items = childItems;
      }
    }
    return tocItems;
  }

  /** @virtual */
  protected _getTocItemName(apiItem: ApiItem): string {
    let name: string;
    if (apiItem.kind === ApiItemKind.Package) {
      name = PackageName.getUnscopedName(apiItem.displayName);
    } else {
      name = this._getYamlItemName(apiItem);
    }

    if (name === apiItem.displayName && apiItem.getMergedSiblings().length > 1) {
      name += ` (${apiItem.kind})`;
    }

    return name;
  }

  protected _shouldEmbed(apiItemKind: ApiItemKind): boolean {
    switch (apiItemKind) {
      case ApiItemKind.Class:
      case ApiItemKind.Package:
      case ApiItemKind.Interface:
      case ApiItemKind.Enum:
      case ApiItemKind.TypeAlias:
        return false;
      case ApiItemKind.Namespace:
        return !this.newDocfxNamespaces;
    }
    return true;
  }

  protected _shouldInclude(apiItemKind: ApiItemKind): boolean {
    // Filter out known items that are not yet supported
    switch (apiItemKind) {
      case ApiItemKind.CallSignature:
      case ApiItemKind.ConstructSignature:
      case ApiItemKind.IndexSignature:
        return false;
    }
    return true;
  }

  private _generateYamlItem(apiItem: ApiDocumentedItem): IYamlItem | undefined {
    // Filter out known items that are not yet supported
    if (!this._shouldInclude(apiItem.kind)) {
      return undefined;
    }

    const uid: DeclarationReference = this._getUidObject(apiItem);
    const yamlItem: Partial<IYamlItem> = {
      uid: uid.toString()
    };

    if (apiItem.tsdocComment) {
      const tsdocComment: DocComment = apiItem.tsdocComment;
      if (tsdocComment.summarySection) {
        const summary: string = this._renderMarkdown(tsdocComment.summarySection, apiItem);
        if (summary) {
          yamlItem.summary = summary;
        }
      }

      if (tsdocComment.remarksBlock) {
        const remarks: string = this._renderMarkdown(tsdocComment.remarksBlock.content, apiItem);
        if (remarks) {
          yamlItem.remarks = remarks;
        }
      }

      if (tsdocComment) {
        // Write the @example blocks
        const exampleBlocks: DocBlock[] = tsdocComment.customBlocks.filter(
          (x) => x.blockTag.tagNameWithUpperCase === StandardTags.example.tagNameWithUpperCase
        );

        for (const exampleBlock of exampleBlocks) {
          const example: string = this._renderMarkdown(exampleBlock.content, apiItem);
          if (example) {
            yamlItem.example = [...(yamlItem.example || []), example];
          }
        }
      }

      if (tsdocComment.deprecatedBlock) {
        const deprecatedMessage: string = this._renderMarkdown(tsdocComment.deprecatedBlock.content, apiItem);
        if (deprecatedMessage.length > 0) {
          yamlItem.deprecated = { content: deprecatedMessage };
        }
      }
    }

    if (ApiReleaseTagMixin.isBaseClassOf(apiItem)) {
      if (apiItem.releaseTag === ReleaseTag.Alpha || apiItem.releaseTag === ReleaseTag.Beta) {
        yamlItem.isPreview = true;
      }
    }

    yamlItem.name = this._getYamlItemName(apiItem, {
      includeSignature: true,
      includeNamespace: !this.newDocfxNamespaces
    });
    yamlItem.fullName = this._getYamlItemName(apiItem, { includeSignature: true, includeNamespace: true });
    yamlItem.langs = ['typeScript'];

    // Add the namespace of the item if it is contained in one.
    // Do not add the namespace parent of a namespace as they are flattened in the documentation.
    if (
      apiItem.kind !== ApiItemKind.Namespace &&
      apiItem.parent &&
      apiItem.parent.kind === ApiItemKind.Namespace &&
      this.newDocfxNamespaces
    ) {
      yamlItem.namespace = apiItem.parent.canonicalReference.toString();
    }

    switch (apiItem.kind) {
      case ApiItemKind.Enum:
        yamlItem.type = 'enum';
        break;
      case ApiItemKind.EnumMember:
        yamlItem.type = 'field';
        const enumMember: ApiEnumMember = apiItem as ApiEnumMember;

        if (enumMember.initializerExcerpt && enumMember.initializerExcerpt.text.length > 0) {
          yamlItem.numericValue = enumMember.initializerExcerpt.text;
        }

        break;
      case ApiItemKind.Class:
        yamlItem.type = 'class';
        this._populateYamlClassOrInterface(uid, yamlItem, apiItem as ApiClass);
        break;
      case ApiItemKind.Interface:
        yamlItem.type = 'interface';
        this._populateYamlClassOrInterface(uid, yamlItem, apiItem as ApiInterface);
        break;
      case ApiItemKind.Method:
      case ApiItemKind.MethodSignature:
        yamlItem.type = 'method';
        this._populateYamlFunctionLike(uid, yamlItem, apiItem as ApiMethod | ApiMethodSignature);
        break;

      case ApiItemKind.Constructor:
        yamlItem.type = 'constructor';
        this._populateYamlFunctionLike(uid, yamlItem, apiItem as ApiConstructor);
        break;

      case ApiItemKind.Package:
        yamlItem.type = 'package';
        break;
      case ApiItemKind.Namespace:
        yamlItem.type = 'namespace';
        break;
      case ApiItemKind.Property:
      case ApiItemKind.PropertySignature:
        const apiProperty: ApiPropertyItem = apiItem as ApiPropertyItem;
        if (apiProperty.isEventProperty) {
          yamlItem.type = 'event';
        } else {
          yamlItem.type = 'property';
        }
        this._populateYamlProperty(uid, yamlItem, apiProperty);
        break;

      case ApiItemKind.Function:
        yamlItem.type = 'function';
        this._populateYamlFunctionLike(uid, yamlItem, apiItem as ApiFunction);
        break;

      case ApiItemKind.Variable:
        yamlItem.type = 'variable';
        this._populateYamlVariable(uid, yamlItem, apiItem as ApiVariable);
        break;

      case ApiItemKind.TypeAlias:
        yamlItem.type = 'typealias';
        this._populateYamlTypeAlias(uid, yamlItem, apiItem as ApiTypeAlias);
        break;

      default:
        throw new Error('Unimplemented item kind: ' + apiItem.kind);
    }

    if (apiItem.kind !== ApiItemKind.Package && !this._shouldEmbed(apiItem.kind)) {
      const associatedPackage: ApiPackage | undefined = apiItem.getAssociatedPackage();
      if (!associatedPackage) {
        throw new Error('Unable to determine associated package for ' + apiItem.displayName);
      }
      yamlItem.package = this._getUid(associatedPackage);
    }

    return yamlItem as IYamlItem;
  }

  private _populateYamlTypeParameters(
    contextUid: DeclarationReference,
    apiItem: ApiTypeParameterListMixin
  ): IYamlParameter[] {
    const typeParameters: IYamlParameter[] = [];
    for (const apiTypeParameter of apiItem.typeParameters) {
      const typeParameter: IYamlParameter = {
        id: apiTypeParameter.name
      };

      if (apiTypeParameter.tsdocTypeParamBlock) {
        typeParameter.description = this._renderMarkdown(
          apiTypeParameter.tsdocTypeParamBlock.content,
          apiItem
        );
      }

      if (!apiTypeParameter.constraintExcerpt.isEmpty) {
        typeParameter.type = [this._renderType(contextUid, apiTypeParameter.constraintExcerpt)];
      }

      typeParameters.push(typeParameter);
    }
    return typeParameters;
  }

  private _populateYamlClassOrInterface(
    uid: DeclarationReference,
    yamlItem: Partial<IYamlItem>,
    apiItem: ApiClass | ApiInterface
  ): void {
    if (apiItem instanceof ApiClass) {
      if (apiItem.extendsType) {
        yamlItem.extends = [this._renderType(uid, apiItem.extendsType.excerpt)];
        yamlItem.inheritance = this._renderInheritance(uid, [apiItem.extendsType]);
      }
      if (apiItem.implementsTypes.length > 0) {
        yamlItem.implements = [];
        for (const implementsType of apiItem.implementsTypes) {
          yamlItem.implements.push(this._renderType(uid, implementsType.excerpt));
        }
      }
    } else if (apiItem instanceof ApiInterface) {
      if (apiItem.extendsTypes.length > 0) {
        yamlItem.extends = [];
        for (const extendsType of apiItem.extendsTypes) {
          yamlItem.extends.push(this._renderType(uid, extendsType.excerpt));
        }
        yamlItem.inheritance = this._renderInheritance(uid, apiItem.extendsTypes);
      }
    }

    const typeParameters: IYamlParameter[] = this._populateYamlTypeParameters(uid, apiItem);
    if (typeParameters.length) {
      yamlItem.syntax = { typeParameters };
    }

    if (apiItem.tsdocComment) {
      if (apiItem.tsdocComment.modifierTagSet.isSealed()) {
        let sealedMessage: string;
        if (apiItem.kind === ApiItemKind.Class) {
          sealedMessage = 'This class is marked as `@sealed`. Subclasses should not extend it.';
        } else {
          sealedMessage = 'This interface is marked as `@sealed`. Other interfaces should not extend it.';
        }
        if (!yamlItem.remarks) {
          yamlItem.remarks = sealedMessage;
        } else {
          yamlItem.remarks = sealedMessage + '\n\n' + yamlItem.remarks;
        }
      }
    }
  }

  private _populateYamlFunctionLike(
    uid: DeclarationReference,
    yamlItem: Partial<IYamlItem>,
    apiItem: ApiMethod | ApiMethodSignature | ApiConstructor | ApiFunction
  ): void {
    const syntax: IYamlSyntax = {
      content: apiItem.getExcerptWithModifiers()
    };
    yamlItem.syntax = syntax;

    if (ApiReturnTypeMixin.isBaseClassOf(apiItem)) {
      const returnType: string = this._renderType(uid, apiItem.returnTypeExcerpt);

      let returnDescription: string = '';

      if (apiItem.tsdocComment && apiItem.tsdocComment.returnsBlock) {
        returnDescription = this._renderMarkdown(apiItem.tsdocComment.returnsBlock.content, apiItem);
        // temporary workaround for people who mistakenly add a hyphen, e.g. "@returns - blah"
        returnDescription = returnDescription.replace(/^\s*-\s+/, '');
      }

      if (returnType || returnDescription) {
        syntax.return = {
          type: [returnType],
          description: returnDescription
        };
      }
    }

    const parameters: IYamlParameter[] = [];
    for (const apiParameter of apiItem.parameters) {
      let parameterDescription: string = '';
      if (apiParameter.tsdocParamBlock) {
        parameterDescription = this._renderMarkdown(apiParameter.tsdocParamBlock.content, apiItem);
      }

      parameters.push({
        id: apiParameter.name,
        description: parameterDescription,
        type: [this._renderType(uid, apiParameter.parameterTypeExcerpt)],
        optional: apiParameter.isOptional
      } as IYamlParameter);
    }

    if (parameters.length) {
      syntax.parameters = parameters;
    }

    if (ApiTypeParameterListMixin.isBaseClassOf(apiItem)) {
      const typeParameters: IYamlParameter[] = this._populateYamlTypeParameters(uid, apiItem);
      if (typeParameters.length) {
        syntax.typeParameters = typeParameters;
      }
    }
  }

  private _populateYamlProperty(
    uid: DeclarationReference,
    yamlItem: Partial<IYamlItem>,
    apiItem: ApiPropertyItem
  ): void {
    const syntax: IYamlSyntax = {
      content: apiItem.getExcerptWithModifiers()
    };
    yamlItem.syntax = syntax;

    if (apiItem.propertyTypeExcerpt.text) {
      syntax.return = {
        type: [this._renderType(uid, apiItem.propertyTypeExcerpt)]
      };
    }
  }

  private _populateYamlVariable(
    uid: DeclarationReference,
    yamlItem: Partial<IYamlItem>,
    apiItem: ApiVariable
  ): void {
    const syntax: IYamlSyntax = {
      content: apiItem.getExcerptWithModifiers()
    };
    yamlItem.syntax = syntax;

    if (apiItem.variableTypeExcerpt.text) {
      syntax.return = {
        type: [this._renderType(uid, apiItem.variableTypeExcerpt)]
      };
    }
  }

  private _populateYamlTypeAlias(
    uid: DeclarationReference,
    yamlItem: Partial<IYamlItem>,
    apiItem: ApiTypeAlias
  ): void {
    const syntax: IYamlSyntax = {
      content: apiItem.getExcerptWithModifiers()
    };
    yamlItem.syntax = syntax;

    const typeParameters: IYamlParameter[] = this._populateYamlTypeParameters(uid, apiItem);
    if (typeParameters.length) {
      syntax.typeParameters = typeParameters;
    }

    if (apiItem.typeExcerpt.text) {
      syntax.return = {
        type: [this._renderType(uid, apiItem.typeExcerpt)]
      };
    }
  }

  private _renderMarkdown(docSection: DocSection, contextApiItem: ApiItem): string {
    const stringBuilder: StringBuilder = new StringBuilder();

    this._markdownEmitter.emit(stringBuilder, docSection, {
      contextApiItem,
      onGetFilenameForApiItem: (apiItem: ApiItem) => {
        // NOTE: GitHub's markdown renderer does not resolve relative hyperlinks correctly
        // unless they start with "./" or "../".

        // To ensure the xref is properly escaped, we first encode the entire xref
        // to handle escaping of reserved characters. Then we must replace '#' and '?'
        // characters so that they are not interpreted as a querystring or hash.
        // We must also backslash-escape unbalanced `(` and `)` characters as the
        // markdown spec insists that they are only valid when balanced. To reduce
        // the overhead we only support balanced parenthesis with a depth of 1.
        return encodeURI(`xref:${this._getUid(apiItem)}`)
          .replace(/[#?]/g, (s) => encodeURIComponent(s))
          .replace(/(\([^(]*\))|[()]/g, (s, balanced) => balanced || '\\' + s);
      }
    });

    return stringBuilder.toString().trim();
  }

  private _writeYamlFile(
    dataObject: {},
    filePath: string,
    yamlMimeType: string,
    schema: JsonSchema | undefined
  ): void {
    JsonFile.validateNoUndefinedMembers(dataObject);

    let stringified: string = yaml.safeDump(dataObject, {
      lineWidth: 120
    });

    if (yamlMimeType) {
      stringified = `### YamlMime:${yamlMimeType}\n` + stringified;
    }

    FileSystem.writeFile(filePath, stringified, {
      convertLineEndings: NewlineKind.CrLf,
      ensureFolderExists: true
    });

    if (schema) {
      schema.validateObject(dataObject, filePath);
    }
  }

  /**
   * Calculate the DocFX "uid" for the ApiItem
   * Example:  `node-core-library!JsonFile#load`
   */
  protected _getUid(apiItem: ApiItem): string {
    return this._getUidObject(apiItem).toString();
  }

  protected _getUidObject(apiItem: ApiItem): DeclarationReference {
    return apiItem.canonicalReference;
  }

  /**
   * Initialize the _apiItemsByCanonicalReference data structure.
   */
  private _initApiItems(): void {
    this._initApiItemsRecursive(this._apiModel);
  }

  /**
   * Helper for _initApiItems()
   */
  private _initApiItemsRecursive(apiItem: ApiItem): void {
    if (apiItem.canonicalReference && !apiItem.canonicalReference.isEmpty) {
      this._apiItemsByCanonicalReference.set(apiItem.canonicalReference.toString(), apiItem);
    }

    // Recurse container members
    if (ApiItemContainerMixin.isBaseClassOf(apiItem)) {
      for (const apiMember of apiItem.members) {
        this._initApiItemsRecursive(apiMember);
      }
    }
  }

  private _ensureYamlReferences(): IYamlReferences {
    if (!this._yamlReferences) {
      this._yamlReferences = {
        references: [],
        typeNameToUid: new Map(),
        uidTypeReferenceCounters: new Map()
      };
    }
    return this._yamlReferences;
  }

  private _renderInheritance(
    contextUid: DeclarationReference,
    heritageTypes: ReadonlyArray<HeritageType>
  ): IYamlInheritanceTree[] {
    const result: IYamlInheritanceTree[] = [];
    for (const heritageType of heritageTypes) {
      const type: string = this._renderType(contextUid, heritageType.excerpt);
      const yamlInheritance: IYamlInheritanceTree = { type };
      const apiItem: ApiItem | undefined = this._apiItemsByCanonicalReference.get(type);
      if (apiItem) {
        if (apiItem instanceof ApiClass) {
          if (apiItem.extendsType) {
            yamlInheritance.inheritance = this._renderInheritance(this._getUidObject(apiItem), [
              apiItem.extendsType
            ]);
          }
        } else if (apiItem instanceof ApiInterface) {
          if (apiItem.extendsTypes.length > 0) {
            yamlInheritance.inheritance = this._renderInheritance(
              this._getUidObject(apiItem),
              apiItem.extendsTypes
            );
          }
        }
      }
      result.push(yamlInheritance);
    }
    return result;
  }

  private _renderType(contextUid: DeclarationReference, typeExcerpt: Excerpt): string {
    const excerptTokens: ExcerptToken[] = [...typeExcerpt.spannedTokens]; // copy the read-only array

    if (excerptTokens.length === 0) {
      return '';
    }

    // Remove the last token if it consists only of whitespace
    const lastToken: ExcerptToken = excerptTokens[excerptTokens.length - 1];
    if (lastToken.kind === ExcerptTokenKind.Content && !lastToken.text.trim()) {
      excerptTokens.pop();
      if (excerptTokens.length === 0) {
        return '';
      }
    }

    const typeName: string = typeExcerpt.text.trim();

    // If there are no references to be used for a complex type, return the type name.
    if (!excerptTokens.some((tok) => tok.kind === ExcerptTokenKind.Reference && !!tok.canonicalReference)) {
      return typeName;
    }

    const yamlReferences: IYamlReferences = this._ensureYamlReferences();
    const existingUid: string | undefined = yamlReferences.typeNameToUid.get(typeName);

    // If this type has already been referenced for the current file, return its uid.
    if (existingUid) {
      return existingUid;
    }

    // If the excerpt consists of a single reference token, record the reference.
    if (
      excerptTokens.length === 1 &&
      excerptTokens[0].kind === ExcerptTokenKind.Reference &&
      excerptTokens[0].canonicalReference
    ) {
      const excerptRef: string = excerptTokens[0].canonicalReference.toString();
      const apiItem: ApiItem | undefined = this._apiItemsByCanonicalReference.get(excerptRef);
      return this._recordYamlReference(
        yamlReferences,
        excerptTokens[0].canonicalReference.toString(),
        apiItem ? this._getYamlItemName(apiItem) : typeName,
        apiItem ? this._getYamlItemName(apiItem, { includeNamespace: true }) : typeName
      );
    }

    // Otherwise, the type is complex and consists of one or more reference tokens. Record a reference
    // and return its uid.
    const baseUid: string = contextUid.withMeaning(undefined).withOverloadIndex(undefined).toString();

    // Keep track of the count for the base uid (without meaning or overload index) to ensure
    // that each complex type reference is unique.
    const counter: number = yamlReferences.uidTypeReferenceCounters.get(baseUid) || 0;
    yamlReferences.uidTypeReferenceCounters.set(baseUid, counter + 1);

    const uid: string = contextUid
      .addNavigationStep(Navigation.Locals, `${counter}`)
      .withMeaning(Meaning.ComplexType)
      .withOverloadIndex(undefined)
      .toString();

    return this._recordYamlReference(yamlReferences, uid, typeName, typeName, excerptTokens);
  }

  private _recordYamlReference(
    yamlReferences: IYamlReferences,
    uid: string,
    name: string,
    fullName: string,
    excerptTokens?: ExcerptToken[]
  ): string {
    if (yamlReferences.references.some((ref) => ref.uid === uid)) {
      return uid;
    }

    // Fill in the reference spec from the excerpt.
    const specs: IYamlReferenceSpec[] = [];
    if (excerptTokens) {
      for (const token of excerptTokens) {
        if (token.kind === ExcerptTokenKind.Reference) {
          const spec: IYamlReferenceSpec = {};
          const specUid: string | undefined = token.canonicalReference && token.canonicalReference.toString();
          const apiItem: ApiItem | undefined = specUid
            ? this._apiItemsByCanonicalReference.get(specUid)
            : undefined;
          if (specUid) {
            spec.uid = specUid;
          }
          spec.name = token.text;
          spec.fullName = apiItem
            ? apiItem.getScopedNameWithinPackage()
            : token.canonicalReference
              ? token.canonicalReference
                  .withSource(undefined)
                  .withMeaning(undefined)
                  .withOverloadIndex(undefined)
                  .toString()
              : token.text;
          specs.push(spec);
        } else {
          specs.push({
            name: token.text,
            fullName: token.text
          });
        }
      }
    }

    const yamlReference: IYamlReference = { uid };
    if (specs.length > 0) {
      yamlReference.name = specs
        .map((s) => s.name)
        .join('')
        .trim();
      yamlReference.fullName = specs
        .map((s) => s.fullName || s.name)
        .join('')
        .trim();
      yamlReference['spec.typeScript'] = specs;
    } else {
      if (name !== uid) {
        yamlReference.name = name;
      }
      if (fullName !== uid && fullName !== name) {
        yamlReference.fullName = fullName;
      }
    }

    yamlReferences.references.push(yamlReference);
    return uid;
  }

  private _getYamlItemName(apiItem: ApiItem, options: INameOptions = {}): string {
    const { includeSignature, includeNamespace } = options;
    const baseName: string = includeSignature ? Utilities.getConciseSignature(apiItem) : apiItem.displayName;
    if (
      (includeNamespace || apiItem.kind === ApiItemKind.Namespace) &&
      apiItem.parent &&
      apiItem.parent.kind === ApiItemKind.Namespace
    ) {
      // If the immediate parent is a namespace, then add the namespaces to the name.  For example:
      //
      //   // Name: "N1"
      //   export namespace N1 {
      //     // Name: "N1.N2"
      //     export namespace N2 {
      //       // Name: "N1.N2.f(x,y)"
      //       export function f(x: string, y: string): string {
      //         return x + y;
      //       }
      //
      //
      //       // Name: "N1.N2.C"
      //       export class C {
      //         // Name: "member(x,y)"  <===========
      //         public member(x: string, y: string): string {
      //           return x + y;
      //         }
      //       }
      //     }
      //   }
      //
      // In the above example, "member(x, y)" does not appear as "N1.N2.C.member(x,y)" because YamlDocumenter
      // embeds this entry in the web page for "N1.N2.C", so the container is obvious.  Whereas "N1.N2.f(x,y)"
      // needs to be qualified because the DocFX template doesn't make pages for namespaces.  Instead, they get
      // flattened into the package's page.
      const nameParts: string[] = [baseName];

      for (let current: ApiItem | undefined = apiItem.parent; current; current = current.parent) {
        if (current.kind !== ApiItemKind.Namespace) {
          break;
        }

        nameParts.unshift(current.displayName);
      }

      return nameParts.join('.');
    } else {
      return baseName;
    }
  }

  private _getYamlFilePath(outputFolder: string, apiItem: ApiItem): string {
    let result: string = '';

    for (const current of apiItem.getHierarchy()) {
      switch (current.kind) {
        case ApiItemKind.Model:
        case ApiItemKind.EntryPoint:
          break;
        case ApiItemKind.Package:
          result += Utilities.getSafeFilenameForName(PackageName.getUnscopedName(current.displayName));
          break;
        default:
          if (current.parent && current.parent.kind === ApiItemKind.EntryPoint) {
            result += '/';
          } else {
            result += '.';
          }
          result += Utilities.getSafeFilenameForName(current.displayName);
          break;
      }
    }

    let disambiguator: string = '';
    if (apiItem.getMergedSiblings().length > 1) {
      disambiguator = `-${apiItem.kind.toLowerCase()}`;
    }

    return path.join(outputFolder, result + disambiguator + '.yml');
  }

  private _deleteOldOutputFiles(outputFolder: string): void {
    console.log('Deleting old output from ' + outputFolder);
    FileSystem.ensureEmptyFolder(outputFolder);
  }
}
