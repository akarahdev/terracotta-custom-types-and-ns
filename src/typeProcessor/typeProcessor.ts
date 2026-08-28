import { ASTNode, RootNode } from "../ast/astNode.ts";
import {
  AccessExpression,
  AtomicExpression,
  BinaryExpression,
  BracketedAccessExpression,
  CallExpression,
  CallOrStartExpression,
  ChunkExpression,
  DictionaryEntryExpression,
  DictionaryExpression,
  DictionaryTypeExpression,
  Expression,
  GroupExpression,
  ListExpression,
  ParameterExpression,
  SelectionExpression,
  TypecastExpression,
  TypeExpression,
  UnaryPrefixExpression,
  VariableExpression,
} from "../ast/expression.ts";
import {
  AssignmentStatement,
  DeclareStatement,
  ExpressionStatement,
  ExtendStatement,
  ForStatement,
  FunctionSchemaTypeExpression,
  FunctionStatement,
  IfStatement,
  ImportStatement,
  NamespaceSchemaFieldStatement,
  NamespaceSchemaFunctionStatement,
  NamespaceSchemaReferenceExpression,
  NamespaceSchemaStatement,
  NamespaceShapeSchemaExpression,
  NamespaceStatement,
  NamespaceVariableStatement,
  PerSelectedStatement,
  RepeatStatement,
  Statement,
  TypeStatement,
  WhileStatement,
} from "../ast/statement.ts";
import { Token, TokenType } from "../ast/token.ts";
import { ErrorType, TCError, TCNodeError } from "../error/error.ts";
import { Operations } from "../compiler/operations.ts";
import {
  CUSTOM_TYPES,
  DictTypeData,
  FuncTypeData,
  getWidestType,
  ListTypeData,
  MultiValueTypeData,
  NamespaceTypeData,
  Type,
  TYPE_NAMESPACES,
  TypeConstructor,
  VarTypeData,
} from "./type.ts";
import { Namespace } from "../compiler/namespace/namespace.ts";
import { getTagsAndArgTypes, ps, tcParseNumber } from "../util/utils.ts";
import {
  FILTER_ACTIONS,
  REPEAT_ACTIONS,
  SELECT_ACTIONS,
} from "../compiler/namespace/builtins.ts";
import { isForLoopActionCall } from "../util/astUtils.ts";
import {
  Definition,
  DefinitionType,
  FunctionDefinition,
  isFunctionDefinition,
  isNamespaceVariableDefinition,
  isPropertyDefinition,
  isValueDefinition,
  NamespaceVariableDefinition,
  ParameterSignature,
  ParameterSignatureEntry,
  PropertyDefinition,
  USE_DEFAULT_RETURN_TYPE,
  ValueDefinition,
} from "../compiler/namespace/definition.ts";
import { GLOBAL_SCOPE_INJECTIONS } from "../compiler/namespace/globalScopeInjections.ts";
import {
  COMPILE_CALL_FUNCTION,
  COMPILE_START_PROCESS,
} from "../compiler/namespace/compileCallFunction.ts";
import { DFCodeblockName } from "../df/constants.ts";
import { BooleanOperation } from "../compiler/booleanOperation.ts";
import { actions } from "../df/actiondump.ts";
import { commentsToDocumentation } from "../ast/documenter.ts";
import {
  getSourceNamespaceMemberBackendName,
  isSourceNamespaceVariableDefinition,
  SourceNamespace,
  SourceNamespaceFunctionSchema,
  SourceNamespaceNestedShapeField,
  SourceNamespaceSchema,
  SourceNamespaceShapeField,
  SourceNamespaceShapeSchema,
  SourceNamespaceValueSchema,
  SourceNamespaceVariableDefinition,
} from "../compiler/namespace/sourceNamespace.ts";
import { ActionBlock, CodeBlock } from "../compiler/codeBlock.ts";
import {
  CodeValue,
  EmptyValue,
  NamespaceValue,
  StringValue,
  TangibleValue,
  VariableValue,
} from "../compiler/codeValue.ts";
import { validateArguments } from "../util/argValidation.ts";
import { handleSingleBlockReturnVars } from "../compiler/namespace/builtins.ts";
import "../compiler/namespace/namespaceReflection.ts";

export function getExtensionFunctionBackendName(
  typeName: string,
  functionName: string,
): string {
  let clean = (value: string) => value.replace(/[^A-Za-z0-9_]/g, "_");
  return `__TC_EXT_${clean(typeName)}_${clean(functionName)}`;
}

export enum VariableScope {
  SAVED,
  GLOBAL,
  LOCAL,
  LINE,
}
/** earlier in the array means higher priority */
const SCOPE_PRIORITY = [
  VariableScope.LINE,
  VariableScope.LOCAL,
  VariableScope.GLOBAL,
  VariableScope.SAVED,
];

type Requirement = { item: VariableId | string; atPos: number };

export interface VariableEntry {
  id: VariableId;
  solved: boolean;
  type: Type | null;
  requirements: Requirement[];
  valueExpression: Expression | null;
  forLoopVarPos?: number;
  assignmentVarPos?: number;
  /** Set this to -1 to be available regardless of position */
  effectiveBeyondPosition: number;
  description?: string;
  astNode?: ASTNode;
}

// this function is bad but i dont care
export function isVariableEntry(obj): obj is VariableEntry {
  return (
    obj instanceof Object &&
    "id" in obj &&
    "solved" in obj &&
    "type" in obj &&
    "requirements" in obj &&
    "valueExpression" in obj &&
    "effectiveBeyondPosition" in obj
  );
}

export class EnvironmentFrame {
  /** An empty environment frame with no variables for evaluating expressions in a vacuum */
  static readonly DUMMY = new EnvironmentFrame(null, null);

  // public knownTypes: Map<VariableId, Type[]> = new Map();
  // public unsolvedTypes: Map<VariableId, {requirements: Requirement[], expression: Expression}> = new Map();
  variables: Map<string, Map<VariableScope, VariableEntry[]>> = new Map();

  /** Currently, only the global frame will have this filled out */
  functions: Map<string, FunctionDefinition[]> = new Map();
  /** Currently, only the global frame will have this filled out */
  processes: Map<string, FunctionDefinition[]> = new Map();

  /** Import bindings are stored on the root-document frame and inherit normally. */
  imports: Map<string, Namespace | Definition> = new Map();

  children: Map<RootNode | ChunkExpression, EnvironmentFrame> = new Map();

  constructor(
    public astNode: RootNode | ChunkExpression | null,
    public parent: EnvironmentFrame | null,
  ) {}

  registerVariable({
    id,
    description,
    type = null,
    effectiveBeyondPosition,
    requirements = [],
    valueExpression = null,
    forLoopVarPos,
    assignmentVarPos,
    astNode,
  }: {
    id: VariableId;
    type?: Type | null;
    effectiveBeyondPosition: number;
    requirements?: Requirement[];
    valueExpression?: Expression | null;
    forLoopVarPos?: number;
    assignmentVarPos?: number;
    description?: string;
    astNode?: ASTNode;
  }) {
    // don't let line variables be registered to the global frame
    if (id.scope == VariableScope.LINE && this.parent == null) {
      return;
    }

    let entry: VariableEntry = {
      id: id,
      solved: type != null,
      type: type,
      requirements: requirements,
      valueExpression: valueExpression,
      forLoopVarPos: forLoopVarPos,
      assignmentVarPos: assignmentVarPos,
      effectiveBeyondPosition: effectiveBeyondPosition,
      description: description,
      astNode: astNode,
    };
    // TODO: update all these to use the new util function (im too lazy rn)
    if (!this.variables.has(id.name)) this.variables.set(id.name, new Map());
    let nameLayer = this.variables.get(id.name)!;
    if (!nameLayer.has(id.scope)) nameLayer.set(id.scope, []);
    let scopeLayer = nameLayer.get(id.scope)!;
    scopeLayer.push(entry);
  }

  /**
   * @param variable If a VariableID is passed in, only that scope will be considered.
   * If a string is passed in, all variables with that name and any scope will be considered
   * @returns VariableEntry if this variable is present and unconflicted on any scope at or above this frame
   */
  getVariableEntry(
    variable: VariableId | string,
    atPos: number,
    flags: { requireASTNode?: boolean; requireDescription?: boolean } = {},
  ): VariableEntry | null {
    let frame = this;
    let name: string;
    let scope: VariableScope | null;
    if (variable instanceof VariableId) {
      name = variable.name;
      scope = variable.scope;
    } else {
      name = variable;
      scope = null;
    }

    if (this.variables.has(name)) {
      let varLayer = this.variables.get(name)!;

      let tryEntries = (scope: VariableScope) => {
        let entries = varLayer.get(scope)!;
        if (!entries || entries.length == 0) return null;

        if (this.parent == null) {
          // if in the global context, consider all variables with multiple definitions unknown
          // and also don't take positions into account
          if (varLayer.get(scope)?.length == 1) {
            return varLayer.get(scope)![0];
          }
        } else {
          // otherwise, go through all definitions to get the latest one that fulfills atPos
          let i;
          for (i = entries.length - 1; i >= 0; i--) {
            if (
              entries[i].effectiveBeyondPosition < atPos &&
              !(flags.requireASTNode && entries[i].astNode == undefined) &&
              !(flags.requireDescription && entries[i].description == undefined)
            ) break;
          }

          if (
            i != -1
          ) {
            return entries[i];
          } else {
            return null;
          }
        }
        return null;
      };

      if (scope == null) {
        for (const scope of SCOPE_PRIORITY) {
          let entry = tryEntries(scope);
          if (entry) return entry;
        }
      } else {
        // let allEntries = varLayer.get(scope);
        // let i = 0;
        // while (allEntries[i].effectiveBeyondPosition < )
        let entry = tryEntries(scope);
        if (entry) return entry;
      }
    }
    // if this scope couldn't decide on a type, try the next scope up
    if (this.parent == null) {
      // if this is the global scope that means this
      // variable could not be evaluated on any level
      return null;
    } else {
      return this.parent.getVariableEntry(variable, atPos, flags);
    }
  }

  /**
   * @param variable If a VariableID is passed in, only that scope will be considered.
   * If a string is passed in, all variables with that name and any scope will be considered
   * @returns Type.unknown unless this variable is present and unconflicted on any scope at or above this frame
   */
  getVariableType(variable: VariableId | string, atPos: number): Type {
    let entry = this.getVariableEntry(variable, atPos);
    if (entry == null) return Type.unknown;
    return entry.type ?? Type.unknown;
  }

  getImport(name: string): Namespace | Definition | null {
    let frame: EnvironmentFrame | null = this;
    while (frame != null) {
      let imported = frame.imports.get(name);
      if (imported != undefined) return imported;
      frame = frame.parent;
    }
    return null;
  }

  /** Will return the entry list for every scope,name combination that exists WITHIN THIS FRAME!!
   *
   * This will NOT look in child or parent frames.
   */
  *entryLists(): IterableIterator<[VariableId, VariableEntry[]]> {
    for (const [name, scopeLayer] of this.variables.entries()) {
      for (const [scope, allEntries] of scopeLayer.entries()) {
        yield [VariableId.get(scope, name), allEntries];
      }
    }
  }

  addChild(astNode: RootNode | ChunkExpression): EnvironmentFrame {
    let child = new EnvironmentFrame(astNode, this);
    this.children.set(astNode, child);
    return child;
  }

  toString(): string {
    let vars: string[] = [];
    for (const [id, entries] of this.entryLists()) {
      let strEntries: string[] = entries.map((e) => {
        let requirements = e.requirements.map((r) => `${r.atPos}>${r.item}`)
          .join(", ");
        return `[${e.solved ? "√" : "X"} ${
          e.type?.toString() ?? "unknown"
        } @${e.effectiveBeyondPosition} req:(${requirements}) exp:${
          e.valueExpression ? e.valueExpression.constructor.name : ""
        } ${e.description != undefined ? "desc:'" + e.description + "'" : ""}]`;
      });
      vars.push(`${id} -> ${strEntries.join(",  ")}`);
    }

    let childrenString = "[]";
    if (this.children.size > 0) {
      let children: string[] = [];
      for (const [node, child] of this.children.entries()) {
        children.push(child.toString().split("\n").join("\n    "));
      }
      childrenString = "[\n    " + children.join("\n    ") + "\n  ]";
    }

    return `FRAME FOR ${
      this.astNode?.parent ?? "GLOBAL"
    } {\n  variables: {\n    ${
      vars.join("\n    ")
    }\n  }\n  children: ${childrenString}\n}`;
  }
}

export class VariableId {
  // TODO: when everything goes incremental, make sure this doesn't leak memory
  private static cache: Map<VariableScope, { [key: string]: VariableId }> =
    new Map();

  constructor(
    public scope: VariableScope,
    public name: string,
  ) {}

  public static get(scope: VariableScope, name: string): VariableId {
    let existingId = this.cache.get(scope)?.[name];
    if (existingId) return existingId;
    let newId = new VariableId(scope, name);
    if (!this.cache.has(scope)) this.cache.set(scope, {});
    this.cache.get(scope)![name] = newId;
    return newId;
  }

  public static fromExpression(expression: VariableExpression): VariableId {
    return this.get(
      VariableScope[TokenType[expression.scope.type]],
      expression.name.value,
    );
  }

  toString(): string {
    return `${VariableScope[this.scope]}'${this.name}'`;
  }
}

export class TypeProcessor {
  errors: TCError[] = [];
  globalFrame: EnvironmentFrame = new EnvironmentFrame(null, null);
  framesByASTNode: Map<ASTNode, EnvironmentFrame> = new Map();

  /** Boolean layer of this map: true = is process, false = is function*/
  // TODO: this probably slowly leaks memory in the language server
  fallbackCallOrStartDefs: Map<boolean, Map<string, FunctionDefinition>> =
    new Map([
      [true, new Map()],
      [false, new Map()],
    ]);

  expressionTypeCache: Map<Expression, Map<EnvironmentFrame, Type>> = new Map();

  /** Source namespaces are intentionally separate from globally available built-in namespaces. */
  sourceNamespaceRoots = new Map<string, SourceNamespace>();
  sourceNamespaces = new Set<SourceNamespace>();
  sourceNamespaceByDeclaration = new Map<NamespaceStatement, SourceNamespace>();
  sourceNamespaceByNode = new Map<ASTNode, SourceNamespace>();
  sourceNamespaceFunctionStatements = new Set<FunctionStatement>();
  sourceNamespaceVariables: SourceNamespaceVariableDefinition[] = [];
  private sourceNamespaceSchemasValidated = false;
  /** Schema-dependent initializer types are finalized after runtime shapes exist. */
  private deferSourceNamespaceVariableTypeValidation = false;
  private sourceNamespaceImportRoots: RootNode[] = [];

  constructor() {
    for (const name of Object.keys(CUSTOM_TYPES)) {
      delete CUSTOM_TYPES[name];
      delete TYPE_NAMESPACES[name];
      delete Namespace.registry[name];
      Type.assignableTypes.delete(name);
    }
  }

  reportError(node: ASTNode, error: string) {
    this.errors.push(
      new TCNodeError(
        node,
        ErrorType.TYPE_PROCESSOR,
        error,
      ),
    );
  }

  reportWarning(node: ASTNode, warning: string) {
    let diagnostic = new TCNodeError(node, ErrorType.TYPE_PROCESSOR, warning);
    diagnostic.isWarning = true;
    this.errors.push(diagnostic);
  }

  genericizeType(type: Type): Type {
    if (type.matches(Type.dict)) {
      return Type.dict(Type.any);
    } else if (type.matches(Type.list)) {
      return Type.list(Type.any);
    }
    return type;
  }

  private ensureSourceNamespace(path: readonly string[]): SourceNamespace {
    let current: SourceNamespace | null = null;
    for (let i = 0; i < path.length; i++) {
      let segment = path[i];
      let child = current == null
        ? this.sourceNamespaceRoots.get(segment)
        : current.children.get(segment);
      if (child == undefined) {
        child = new SourceNamespace(path.slice(0, i + 1), current);
        this.sourceNamespaces.add(child);
        if (current == null) {
          this.sourceNamespaceRoots.set(segment, child);
        } else {
          current.children.set(segment, child);
        }
      }
      current = child;
    }
    return current!;
  }

  private mapSourceNamespaceContext(node: ASTNode, namespace: SourceNamespace) {
    this.sourceNamespaceByNode.set(node, namespace);
    for (const child of node.children) {
      // The nested declaration owns its body, so do not give it the outer scope.
      if (child instanceof NamespaceStatement) continue;
      this.mapSourceNamespaceContext(child, namespace);
    }
  }

  private collectSourceNamespaceDeclaration(
    statement: NamespaceStatement,
    parent: SourceNamespace | null,
  ) {
    let path = [
      ...(parent?.path ?? []),
      ...statement.path.map((segment) => segment.value),
    ];
    let namespace = this.ensureSourceNamespace(path);
    namespace.declarations.push(statement);
    this.sourceNamespaceByDeclaration.set(statement, namespace);
    this.sourceNamespaceByNode.set(statement, namespace);

    if (
      namespace.path.length == 1 && (
        namespace.identifier in Namespace.registry ||
        namespace.identifier in CUSTOM_TYPES ||
        namespace.identifier in Type
      )
    ) {
      this.reportError(
        statement.path[0],
        `Namespace '${namespace.identifier}' conflicts with an existing global namespace or type`,
      );
    }

    if (!(statement.chunk instanceof ChunkExpression)) return;
    this.sourceNamespaceByNode.set(statement.chunk, namespace);
    for (const member of statement.chunk.statements) {
      if (member instanceof NamespaceStatement) {
        this.collectSourceNamespaceDeclaration(member, namespace);
      } else {
        this.mapSourceNamespaceContext(member, namespace);
      }
    }
  }

  private createSourceNamespaceVariableDefinitionFromParts(
    namespace: SourceNamespace,
    name: string,
    returnType: Type,
    declaration: NamespaceVariableStatement | null,
    initializer: Expression | null,
    explicitlyTyped: boolean,
    astNode: ASTNode,
    generated: boolean = false,
  ): SourceNamespaceVariableDefinition {
    let definition: SourceNamespaceVariableDefinition = {
      definitionType: DefinitionType.NAMESPACE_VARIABLE,
      name,
      returnType,
      namespace,
      declaration,
      initializer,
      explicitlyTyped,
      generated,
      astNode,
      compile: (ctx) => [
        new VariableValue(
          getSourceNamespaceMemberBackendName(namespace.path, name),
          VariableScope.GLOBAL,
          definition.returnType,
          astNode,
        ),
        [],
      ],
      compileSet: (newValue, ctx) => {
        let target = new VariableValue(
          getSourceNamespaceMemberBackendName(namespace.path, name),
          VariableScope.GLOBAL,
          definition.returnType,
          astNode,
        );
        return [
          new ActionBlock(DFCodeblockName.SET_VARIABLE, {
            action: "=",
            args: [target, newValue],
          }),
        ];
      },
    };
    return definition;
  }

  private createSourceNamespaceVariableDefinition(
    namespace: SourceNamespace,
    statement: NamespaceVariableStatement,
  ): SourceNamespaceVariableDefinition {
    return this.createSourceNamespaceVariableDefinitionFromParts(
      namespace,
      statement.name.value,
      statement.assignedType
        ? this.evaluateExplicitType(statement.assignedType.type, {
          reportErrors: true,
        })
        : Type.unknown,
      statement,
      statement.initialValue,
      statement.assignedType != null,
      statement,
    );
  }

  private createGeneratedSourceNamespaceVariable(
    namespace: SourceNamespace,
    name: string,
    type: Type,
    initializer: Expression | null,
    source: ASTNode,
  ): SourceNamespaceVariableDefinition {
    return this.createSourceNamespaceVariableDefinitionFromParts(
      namespace,
      name,
      type,
      null,
      initializer,
      true,
      source,
      true,
    );
  }

  private createSourceNamespaceLinkDefinition(
    namespace: SourceNamespace,
  ): ValueDefinition {
    return {
      definitionType: DefinitionType.VALUE,
      returnType: Type.namespace(namespace),
      compile: (ctx) => [this.getSourceNamespaceRuntimeValue(namespace), []],
    };
  }

  getSourceNamespaceRuntimeValue(
    namespace: SourceNamespace,
    astNode?: ASTNode,
  ): CodeValue {
    if (namespace.runtimeBacked) {
      return new VariableValue(
        namespace.dictionaryBackendName,
        VariableScope.GLOBAL,
        Type.namespace(namespace),
        astNode,
      );
    }
    return new NamespaceValue(namespace, astNode);
  }

  private registerSourceNamespaceMember(
    namespace: SourceNamespace,
    name: string,
    definition: Definition,
    node: ASTNode,
  ): boolean {
    let existing = namespace.members[name];
    if (existing != undefined) {
      this.reportError(
        node,
        `Namespace member '${namespace.fullPath}.${name}' is declared in multiple places`,
      );
      let existingNode = namespace.memberDeclarationNodes.get(name);
      if (existingNode) {
        this.reportError(
          existingNode,
          `Namespace member '${namespace.fullPath}.${name}' is declared in multiple places`,
        );
      }
      return false;
    }
    if (namespace.children.has(name)) {
      this.reportError(
        node,
        `Namespace member '${namespace.fullPath}.${name}' conflicts with a nested namespace of the same name`,
      );
      return false;
    }
    namespace.members[name] = definition;
    namespace.memberDeclarationNodes.set(name, node);
    return true;
  }

  private registerSourceNamespaceMembers() {
    for (const namespace of this.sourceNamespaces) {
      for (const declaration of namespace.declarations) {
        if (!(declaration.chunk instanceof ChunkExpression)) continue;
        for (const member of declaration.chunk.statements) {
          if (member instanceof NamespaceStatement) continue;
          if (member instanceof NamespaceSchemaStatement) {
            namespace.schemaDeclarations.push(member);
            continue;
          }
          if (member instanceof NamespaceVariableStatement) {
            let definition = this.createSourceNamespaceVariableDefinition(
              namespace,
              member,
            );
            if (
              this.registerSourceNamespaceMember(
                namespace,
                member.name.value,
                definition,
                member.name,
              )
            ) {
              this.sourceNamespaceVariables.push(definition);
            }
            continue;
          }
          if (member instanceof FunctionStatement) {
            member.backendName = getSourceNamespaceMemberBackendName(
              namespace.path,
              member.name.value,
            );
            let definition = this.createFunctionDefinition(
              member,
              this.globalFrame,
              member.backendName,
              { registerParameters: false },
            );
            if (
              definition &&
              this.registerSourceNamespaceMember(
                namespace,
                member.name.value,
                definition,
                member.name,
              )
            ) {
              this.sourceNamespaceFunctionStatements.add(member);
            }
            continue;
          }
          this.reportError(
            member,
            "Only namespace declarations, variables, functions, processes, and schemas are allowed inside a namespace",
          );
        }
      }
    }

    // Expose child namespaces as regular value definitions after all direct
    // members have been collected, so collisions are diagnosed independent of
    // declaration order and file order.
    for (const namespace of this.sourceNamespaces) {
      for (const [name, child] of namespace.children) {
        if (namespace.members[name] != undefined) continue;
        namespace.members[name] = this.createSourceNamespaceLinkDefinition(
          child,
        );
        let declaration = child.declarations[0];
        let segment = declaration?.path[declaration.path.length - 1] ??
          declaration?.keyword;
        if (segment) namespace.memberDeclarationNodes.set(name, segment);
      }
    }
  }

  private findSourceNamespace(path: readonly string[]): SourceNamespace | null {
    let current = this.sourceNamespaceRoots.get(path[0]);
    if (current == undefined) return null;
    for (let i = 1; i < path.length; i++) {
      current = current.children.get(path[i]);
      if (current == undefined) return null;
    }
    return current;
  }

  private resolveSourceImports(
    roots: RootNode[],
    reportUnknown: boolean = true,
    tolerateExistingSameTarget: boolean = false,
  ) {
    for (const root of roots) {
      let frame = this.framesByASTNode.get(root);
      if (!frame) continue;
      for (const statement of root.statements) {
        if (!(statement instanceof ImportStatement)) continue;
        let path = statement.path.map((segment) => segment.value);
        let target: Namespace | Definition | null = this.findSourceNamespace(
          path,
        );
        if (target == null && path.length > 1) {
          let namespace = this.findSourceNamespace(path.slice(0, -1));
          target = namespace?.members[path[path.length - 1]] ?? null;
        }
        if (target == null) {
          if (reportUnknown) {
            this.reportError(
              statement.path[0] ?? statement.keyword,
              `Cannot import unknown namespace or member '${path.join(".")}'`,
            );
          }
          continue;
        }
        let binding = statement.alias?.value ?? path[path.length - 1];
        let previous = frame.imports.get(binding);
        if (previous != undefined) {
          if (tolerateExistingSameTarget && previous == target) continue;
          this.reportError(
            statement.alias ?? statement.path[statement.path.length - 1],
            `Import '${binding}' conflicts with another import in this file`,
          );
          continue;
        }
        frame.imports.set(binding, target);
      }
    }
  }

  private validateSourceNamespaceShadowing() {
    for (const namespace of this.sourceNamespaces) {
      for (const [name] of Object.entries(namespace.members)) {
        let ancestor = namespace.parentSourceNamespace;
        while (ancestor != null && ancestor.members[name] == undefined) {
          ancestor = ancestor.parentSourceNamespace;
        }
        if (ancestor == null) continue;
        let node = namespace.memberDeclarationNodes.get(name);
        let ancestorNode = ancestor.memberDeclarationNodes.get(name);
        if (node) {
          this.reportWarning(
            node,
            `Namespace member '${namespace.fullPath}.${name}' shadows ancestor member '${ancestor.fullPath}.${name}'. Unqualified lookups use the nearer member.`,
          );
        }
        if (ancestorNode) {
          this.reportWarning(
            ancestorNode,
            `Ancestor member '${ancestor.fullPath}.${name}' is shadowed by '${namespace.fullPath}.${name}'.`,
          );
        }
      }
    }
  }

  private prepareSourceNamespaces(roots: RootNode[]) {
    for (const root of roots) {
      for (const statement of root.statements) {
        if (statement instanceof NamespaceStatement) {
          this.collectSourceNamespaceDeclaration(statement, null);
        }
      }
    }
    this.registerSourceNamespaceMembers();
    this.sourceNamespaceImportRoots = roots;
    // Bind imports that already exist so ordinary source expressions can be
    // typed before defaults are materialized. Imports of generated default
    // members are retried after schema validation.
    this.resolveSourceImports(roots, false);
    this.validateSourceNamespaceShadowing();
  }

  private createNamespaceSchemaSignature(
    params: ListExpression<ParameterExpression> | null,
  ): ParameterSignatureEntry[] {
    let entries: ParameterSignatureEntry[] = [];
    let seenNames = new Set<string>();
    for (const param of params?.elements ?? []) {
      if (seenNames.has(param.name.value)) {
        this.reportError(
          param.name,
          `Duplicate schema parameter '${param.name.value}'`,
        );
        continue;
      }
      seenNames.add(param.name.value);
      let type = param.assignedType
        ? this.evaluateExplicitType(param.assignedType.type, {
          reportErrors: true,
          allowVarType: true,
        })
        : Type.any;
      if (param.ellipses && type.matches(Type.var)) {
        this.reportError(
          param,
          "Schema parameters of type 'var' cannot be plural",
        );
      }
      if (param.optionalMarker && param.ellipses) {
        this.reportError(param, "Plural schema parameters cannot be optional");
      }
      entries.push({
        name: param.name.value,
        type,
        optional: param.optionalMarker != null ||
          (!param.ellipses && param.defaultValue != null),
        plural: param.ellipses != null,
        description: commentsToDocumentation(param.attachedComments),
      });
    }
    return entries;
  }

  private createRuntimeNamespaceFunctionDefinition(
    name: string,
    params: ListExpression<ParameterExpression> | null,
    returnTypeExpression: TypeExpression,
    declaration: ASTNode,
    callKind: "function" | "process" | "either" = "function",
  ): FunctionDefinition {
    let returnType = this.evaluateExplicitType(returnTypeExpression, {
      reportErrors: true,
    });
    if (callKind == "process" && !returnType.matches(Type.void)) {
      this.reportError(
        returnTypeExpression,
        "Process schema members must return 'void'",
      );
      returnType = Type.void;
    }
    let definition: FunctionDefinition;
    definition = {
      definitionType: DefinitionType.FUNCTION,
      name,
      signatures: [{ params: this.createNamespaceSchemaSignature(params) }],
      defaultReturnType: returnType,
      getReturnType: USE_DEFAULT_RETURN_TYPE,
      runtimeNamespaceFunction: true,
      runtimeNamespaceCallKind: callKind,
      action: actions.get(DFCodeblockName.CALL_FUNCTION)?.dynamic,
      compile: (args, namedArgs, ctx, callNode, extraInfo = {}) => {
        let access = extraInfo.runtimeNamespaceAccess;
        if (access == null) {
          ctx.reportError(
            callNode,
            "This schema function must be accessed through a schema-backed namespace",
          );
          return [new EmptyValue(callNode), []];
        }
        validateArguments(args, callNode, definition.signatures, ctx);
        let functionName = ctx.tvp.newTempVar(Type.str);
        let finalArgs = args.filter((arg) => arg instanceof TangibleValue);
        let lookup = new ActionBlock(DFCodeblockName.SET_VARIABLE, {
          action: "GetDictValue",
          args: [functionName, access.dictionary, access.key],
        });
        let startsProcess = callNode instanceof CallOrStartExpression &&
          callNode.keyword.type == TokenType.START;
        let requestedKind = startsProcess ? "process" : "function";
        if (
          definition.runtimeNamespaceCallKind != "either" &&
          definition.runtimeNamespaceCallKind != requestedKind
        ) {
          ctx.reportError(
            callNode,
            requestedKind == "process"
              ? "This namespace member is a function; call it without 'start'"
              : "This namespace member is a process; invoke it with 'start'",
          );
          return [new EmptyValue(callNode), []];
        }
        if (startsProcess && !definition.defaultReturnType.matches(Type.void)) {
          ctx.reportError(
            callNode,
            "A namespace process must use a schema that returns 'void'",
          );
          return [new EmptyValue(callNode), []];
        }
        if (startsProcess) {
          return [new EmptyValue(callNode), [
            lookup,
            new ActionBlock(DFCodeblockName.START_PROCESS, {
              action: `%var(${functionName.name})`,
              args: finalArgs,
            }),
          ]];
        }
        let [returnValue] = handleSingleBlockReturnVars(
          definition,
          ctx,
          extraInfo,
          callNode,
          finalArgs,
        );
        return [returnValue, [
          lookup,
          new ActionBlock(DFCodeblockName.CALL_FUNCTION, {
            action: `%var(${functionName.name})`,
            args: finalArgs,
          }),
        ]];
      },
    };
    return definition;
  }

  private createSchemaDictionaryProperty(
    name: string,
    type: Type,
    declaration: ASTNode,
  ): PropertyDefinition {
    return {
      definitionType: DefinitionType.PROPERTY,
      type,
      compileGet: (ctx, propertyOf) => {
        if (!(propertyOf instanceof TangibleValue)) {
          ctx.reportError(
            declaration,
            `Schema member '${name}' needs a runtime namespace value`,
          );
          return [new EmptyValue(declaration), []];
        }
        return ctx.compiler.compileSourceNamespaceReferenceGet(
          propertyOf,
          new StringValue(name, declaration),
          type,
          declaration,
          ctx,
        );
      },
      compileSet: (newValue, ctx, propertyOf) => {
        if (!(propertyOf instanceof TangibleValue)) {
          ctx.reportError(
            declaration,
            `Schema member '${name}' needs a runtime namespace value`,
          );
          return [];
        }
        let [target, code] = ctx.compiler.compileSourceNamespaceReferenceGet(
          propertyOf,
          new StringValue(name, declaration),
          type,
          declaration,
          ctx,
        );
        return [
          ...code,
          new ActionBlock(DFCodeblockName.SET_VARIABLE, {
            action: "=",
            args: [target, newValue],
          }),
        ];
      },
    };
  }

  private getSchemaFieldRuntimeType(field: SourceNamespaceShapeField): Type {
    if (field.kind == "value") return field.type;
    if (field.kind == "function") return Type.func(field.definition);
    let shape = field.shape ?? (
      field.target?.schema?.kind == "shape" ? field.target.schema : null
    );
    return shape ? Type.namespace(shape.prototype) : Type.unknown;
  }

  private buildSourceNamespaceShapeSchema(
    owner: SourceNamespace,
    expression: NamespaceShapeSchemaExpression,
    declaration: NamespaceSchemaStatement | NamespaceSchemaFieldStatement,
  ): SourceNamespaceShapeSchema {
    let prototype = new SourceNamespace([
      ...owner.path,
      `$schema${expression.startPos}`,
    ], null);
    let schema: SourceNamespaceShapeSchema = {
      kind: "shape",
      fields: new Map(),
      prototype,
      declaration,
    };

    for (const member of expression.members) {
      let name = member.name.value;
      if (schema.fields.has(name)) {
        this.reportError(
          member.name,
          `Schema member '${name}' is declared more than once`,
        );
        continue;
      }

      if (member instanceof NamespaceSchemaFunctionStatement) {
        let callKind: "function" | "process" =
          member.keyword.type == TokenType.PROCESS ? "process" : "function";
        let definition = this.createRuntimeNamespaceFunctionDefinition(
          `${owner.fullPath}.$schema.${name}`,
          member.params,
          member.returnType,
          member,
          callKind,
        );
        let field: SourceNamespaceShapeField = {
          kind: "function",
          name,
          optional: false,
          defaultValue: null,
          declaration: member,
          definition,
          processOnly: callKind == "process",
        };
        schema.fields.set(name, field);
        prototype.members[name] = definition;
        continue;
      }

      let fieldDeclaration = member as NamespaceSchemaFieldStatement;
      let optional = fieldDeclaration.optionalMarker != null;
      let defaultValue = fieldDeclaration.defaultValue;
      if (fieldDeclaration.schemaType instanceof TypeExpression) {
        let type = this.evaluateExplicitType(fieldDeclaration.schemaType, {
          reportErrors: true,
        });
        let field: SourceNamespaceShapeField = {
          kind: "value",
          name,
          optional,
          defaultValue,
          declaration: fieldDeclaration,
          type,
        };
        schema.fields.set(name, field);
        prototype.members[name] = this.createSchemaDictionaryProperty(
          name,
          type,
          fieldDeclaration,
        );
        continue;
      }
      if (fieldDeclaration.schemaType instanceof FunctionSchemaTypeExpression) {
        if (defaultValue != null) {
          this.reportError(
            defaultValue,
            "Function schema members cannot have default values",
          );
        }
        let definition = this.createRuntimeNamespaceFunctionDefinition(
          `${owner.fullPath}.$schema.${name}`,
          fieldDeclaration.schemaType.params,
          fieldDeclaration.schemaType.returnType,
          fieldDeclaration,
        );
        let field: SourceNamespaceShapeField = {
          kind: "function",
          name,
          optional,
          defaultValue: null,
          declaration: fieldDeclaration,
          definition,
        };
        schema.fields.set(name, field);
        prototype.members[name] = definition;
        continue;
      }

      let target: SourceNamespace | null = null;
      let targetPath: readonly string[] | null = null;
      let shape: SourceNamespaceShapeSchema | null = null;
      if (
        fieldDeclaration.schemaType instanceof
          NamespaceSchemaReferenceExpression
      ) {
        targetPath = fieldDeclaration.schemaType.path.map((token) =>
          token.value
        );
        target = this.findSourceNamespace(targetPath);
        if (target == null) {
          this.reportError(
            fieldDeclaration.schemaType,
            `Unknown namespace schema '${targetPath.join(".")}'`,
          );
        }
      } else if (
        fieldDeclaration.schemaType instanceof NamespaceShapeSchemaExpression
      ) {
        shape = this.buildSourceNamespaceShapeSchema(
          owner,
          fieldDeclaration.schemaType,
          fieldDeclaration,
        );
      }
      let field: SourceNamespaceNestedShapeField = {
        kind: "namespace",
        name,
        optional,
        defaultValue,
        declaration: fieldDeclaration,
        targetPath,
        target,
        shape,
      };
      schema.fields.set(name, field);
      prototype.members[name] = this.createSchemaDictionaryProperty(
        name,
        this.getSchemaFieldRuntimeType(field),
        fieldDeclaration,
      );
    }
    return schema;
  }

  private buildSourceNamespaceSchema(
    namespace: SourceNamespace,
    declaration: NamespaceSchemaStatement,
  ): SourceNamespaceSchema | null {
    let schemaType = declaration.schemaType;
    if (schemaType instanceof TypeExpression) {
      return {
        kind: "value",
        type: this.evaluateExplicitType(schemaType, { reportErrors: true }),
        declaration,
      };
    }
    if (schemaType instanceof FunctionSchemaTypeExpression) {
      return {
        kind: "function",
        definition: this.createRuntimeNamespaceFunctionDefinition(
          `${namespace.fullPath}.$schema`,
          schemaType.params,
          schemaType.returnType,
          declaration,
          "either",
        ),
        declaration,
        allowEitherKind: true,
      };
    }
    if (schemaType instanceof NamespaceShapeSchemaExpression) {
      return this.buildSourceNamespaceShapeSchema(
        namespace,
        schemaType,
        declaration,
      );
    }
    this.reportError(
      schemaType,
      "A namespace schema must be a value type, function signature, or namespace shape",
    );
    return null;
  }

  private resolveSourceNamespaceShapeReferences(
    shape: SourceNamespaceShapeSchema,
    visited: Set<SourceNamespaceShapeSchema> = new Set(),
  ) {
    if (visited.has(shape)) return;
    visited.add(shape);
    for (const field of shape.fields.values()) {
      if (field.kind != "namespace") continue;
      if (field.target != null) {
        let targetSchema = field.target.schema;
        if (targetSchema == null) {
          this.reportError(
            field.declaration,
            `Namespace '${field.target.fullPath}' does not declare a schema`,
          );
        } else if (targetSchema.kind != "shape") {
          this.reportError(
            field.declaration,
            `Namespace '${field.target.fullPath}' must use a namespace-shape schema here`,
          );
        } else {
          field.shape = targetSchema;
        }
      }
      if (field.shape != null) {
        this.resolveSourceNamespaceShapeReferences(field.shape, visited);
      }
      let property = shape.prototype.members[field.name];
      if (isPropertyDefinition(property)) {
        property.type = this.getSchemaFieldRuntimeType(field);
      }
    }
    this.configureShapeRuntime(shape.prototype, shape);
  }

  private createGeneratedSourceNamespaceChild(
    parent: SourceNamespace,
    name: string,
    source: ASTNode,
  ): SourceNamespace | null {
    if (parent.members[name] != undefined || parent.children.has(name)) {
      this.reportError(
        source,
        `Cannot generate default namespace member '${parent.fullPath}.${name}' because that name is already in use`,
      );
      return null;
    }
    let child = new SourceNamespace([...parent.path, name], parent);
    parent.children.set(name, child);
    parent.members[name] = this.createSourceNamespaceLinkDefinition(child);
    parent.memberDeclarationNodes.set(name, source);
    this.sourceNamespaces.add(child);
    return child;
  }

  private getSchemaDefaultDictionaryEntries(
    expression: Expression,
    field: SourceNamespaceNestedShapeField,
  ): Map<string, Expression> | null {
    let real = expression.getRealExpression();
    if (!(real instanceof DictionaryExpression)) {
      this.reportError(
        expression,
        `Default for namespace member '${field.name}' must be a dictionary literal`,
      );
      return null;
    }
    let entries = new Map<string, Expression>();
    for (const entry of real.entries) {
      if (
        !(entry.key instanceof Token) || !(
          entry.key.type == TokenType.IDENTIFIER ||
          entry.key.type == TokenType.STRING_LITERAL
        )
      ) {
        this.reportError(
          entry,
          "Namespace default dictionary keys must be identifiers or string literals",
        );
        continue;
      }
      if (entries.has(entry.key.value)) {
        this.reportError(
          entry.key,
          `Namespace default member '${entry.key.value}' is specified more than once`,
        );
        continue;
      }
      entries.set(entry.key.value, entry.value);
    }
    return entries;
  }

  private materializeDefaultNamespaceShape(
    namespace: SourceNamespace,
    shape: SourceNamespaceShapeSchema,
    entries: Map<string, Expression>,
    source: ASTNode,
  ) {
    for (const [name, value] of entries) {
      let field = shape.fields.get(name);
      if (field == null) {
        this.reportError(
          source,
          `Namespace default provides unknown member '${name}'`,
        );
        continue;
      }
      if (field.kind == "value") {
        let definition = this.createGeneratedSourceNamespaceVariable(
          namespace,
          name,
          field.type,
          value,
          value,
        );
        namespace.members[name] = definition;
        namespace.memberDeclarationNodes.set(name, value);
        this.sourceNamespaceVariables.push(definition);
        continue;
      }
      if (field.kind == "function") {
        this.reportError(
          value,
          `Function schema member '${name}' cannot be supplied by a dictionary default`,
        );
        continue;
      }
      this.materializeDefaultNamespaceField(namespace, field, value);
    }
  }

  private materializeDefaultNamespaceField(
    namespace: SourceNamespace,
    field: SourceNamespaceNestedShapeField,
    value: Expression,
  ) {
    let shape = field.shape;
    if (shape == null) {
      this.reportError(
        field.declaration,
        `Cannot materialize default for '${field.name}' because its namespace schema is invalid`,
      );
      return;
    }
    let child = this.createGeneratedSourceNamespaceChild(
      namespace,
      field.name,
      value,
    );
    if (child == null) return;
    child.effectiveSchema = shape;
    let entries = this.getSchemaDefaultDictionaryEntries(value, field);
    if (entries != null) {
      this.materializeDefaultNamespaceShape(child, shape, entries, value);
    }
    this.validateNamespaceAgainstShape(child, shape);
  }

  private materializeMissingShapeField(
    namespace: SourceNamespace,
    field: SourceNamespaceShapeField,
  ) {
    if (field.defaultValue == null) return;
    if (field.kind == "value") {
      let definition = this.createGeneratedSourceNamespaceVariable(
        namespace,
        field.name,
        field.type,
        field.defaultValue,
        field.defaultValue,
      );
      namespace.members[field.name] = definition;
      namespace.memberDeclarationNodes.set(field.name, field.defaultValue);
      this.sourceNamespaceVariables.push(definition);
      return;
    }
    if (field.kind == "function") {
      this.reportError(
        field.defaultValue,
        `Function schema member '${field.name}' cannot have a default value`,
      );
      return;
    }
    this.materializeDefaultNamespaceField(namespace, field, field.defaultValue);
  }

  private signaturesMatch(
    actual: FunctionDefinition,
    expected: FunctionDefinition,
  ): boolean {
    if (!actual.defaultReturnType.strictlyMatches(expected.defaultReturnType)) {
      return false;
    }
    return actual.signatures.some((actualSignature) =>
      expected.signatures.some((expectedSignature) => {
        if (actualSignature.params.length != expectedSignature.params.length) {
          return false;
        }
        return actualSignature.params.every((parameter, index) => {
          let expectedParameter = expectedSignature.params[index];
          return (
            parameter.optional == expectedParameter.optional &&
            parameter.plural == expectedParameter.plural &&
            parameter.type.strictlyMatches(expectedParameter.type)
          );
        });
      })
    );
  }

  private isProcessDefinition(definition: FunctionDefinition): boolean {
    return (
      definition.compile == COMPILE_START_PROCESS ||
      definition.astNode?.headerType == DFCodeblockName.PROCESS
    );
  }

  private validateSchemaFunctionMember(
    namespace: SourceNamespace,
    name: string,
    definition: Definition,
    expected:
      | SourceNamespaceFunctionSchema
      | Extract<SourceNamespaceShapeField, { kind: "function" }>,
  ) {
    let allowsEitherKind = "allowEitherKind" in expected &&
      expected.allowEitherKind == true;
    if (!isFunctionDefinition(definition)) {
      this.reportError(
        namespace.memberDeclarationNodes.get(name) ?? expected.declaration,
        `Namespace member '${namespace.fullPath}.${name}' must be a ${
          allowsEitherKind
            ? "function or process"
            : expected.processOnly
            ? "process"
            : "function"
        }`,
      );
      return;
    }
    let expectsProcess = expected.processOnly == true;
    if (
      !allowsEitherKind &&
      this.isProcessDefinition(definition) != expectsProcess
    ) {
      this.reportError(
        definition.astNode ?? expected.declaration,
        `Namespace member '${namespace.fullPath}.${name}' must be declared as a ${
          expectsProcess ? "process" : "function"
        }`,
      );
      return;
    }
    if (!this.signaturesMatch(definition, expected.definition)) {
      this.reportError(
        definition.astNode ?? expected.declaration,
        `Namespace member '${namespace.fullPath}.${name}' does not match its schema signature`,
      );
    }
  }

  private validateNamespaceAgainstShape(
    namespace: SourceNamespace,
    shape: SourceNamespaceShapeSchema,
  ) {
    if (namespace.schema != null) {
      this.reportError(
        namespace.schema.declaration,
        `Namespace '${namespace.fullPath}' cannot declare its own schema while conforming to a parent namespace shape`,
      );
    }
    if (
      namespace.effectiveSchema != null && namespace.effectiveSchema != shape
    ) {
      this.reportError(
        shape.declaration,
        `Namespace '${namespace.fullPath}' is required to conform to incompatible namespace schemas`,
      );
      return;
    }
    namespace.effectiveSchema = shape;

    for (const [name, definition] of Object.entries(namespace.members)) {
      let field = shape.fields.get(name);
      if (field == null) {
        this.reportError(
          namespace.memberDeclarationNodes.get(name) ?? shape.declaration,
          `Namespace member '${namespace.fullPath}.${name}' is not declared by its schema`,
        );
        continue;
      }
      if (field.kind == "value") {
        if (!isSourceNamespaceVariableDefinition(definition)) {
          this.reportError(
            namespace.memberDeclarationNodes.get(name) ?? field.declaration,
            `Namespace member '${namespace.fullPath}.${name}' must be a value of type '${field.type}'`,
          );
        } else if (
          !this.deferSourceNamespaceVariableTypeValidation &&
          !definition.returnType.matches(Type.unknown) &&
          !definition.returnType.isAssignableTo(field.type)
        ) {
          this.reportError(
            definition.astNode ?? field.declaration,
            `Namespace member '${namespace.fullPath}.${name}' has type '${definition.returnType}', expected '${field.type}'`,
          );
        }
        continue;
      }
      if (field.kind == "function") {
        this.validateSchemaFunctionMember(namespace, name, definition, field);
        continue;
      }
      let child = namespace.children.get(name);
      if (child == null) {
        this.reportError(
          namespace.memberDeclarationNodes.get(name) ?? field.declaration,
          `Namespace member '${namespace.fullPath}.${name}' must be a nested namespace`,
        );
      } else if (field.shape != null) {
        this.validateNamespaceAgainstShape(child, field.shape);
      }
    }

    for (const field of shape.fields.values()) {
      if (namespace.members[field.name] != undefined) continue;
      if (field.defaultValue != null) {
        this.materializeMissingShapeField(namespace, field);
      } else if (!field.optional) {
        this.reportError(
          field.declaration,
          `Namespace '${namespace.fullPath}' is missing required member '${field.name}'`,
        );
      }
    }
    this.configureShapeRuntime(namespace, shape);
  }

  private configureShapeRuntime(
    namespace: SourceNamespace,
    shape: SourceNamespaceShapeSchema,
  ) {
    let fieldTypes = [...shape.fields.values()].map((field) =>
      this.getSchemaFieldRuntimeType(field)
    );
    let genericType = getWidestType(...fieldTypes);
    namespace.runtimeShape = shape;
    namespace.runtimeType = Type.dict(genericType);
    namespace.getDynamicMemberType = (member) => {
      if (typeof member == "string") {
        let field = shape.fields.get(member);
        if (field != null) return this.getSchemaFieldRuntimeType(field);
      }
      return genericType;
    };
    namespace.getDynamicFunctionDefinition = (member) => {
      if (typeof member != "string") return null;
      let field = shape.fields.get(member);
      return field?.kind == "function" ? field.definition : null;
    };
  }

  private configureSourceNamespaceRuntime(namespace: SourceNamespace) {
    if (namespace.effectiveSchema?.kind == "shape") {
      this.configureShapeRuntime(namespace, namespace.effectiveSchema);
      return;
    }
    let schema = namespace.schema;
    if (schema == null) return;
    if (schema.kind == "shape") {
      let childType = Type.namespace(schema.prototype);
      namespace.runtimeType = Type.dict(childType);
      namespace.getDynamicMemberType = () => childType;
      namespace.getDynamicFunctionDefinition = () => null;
      return;
    }
    if (schema.kind == "value") {
      namespace.runtimeType = Type.dict(schema.type);
      namespace.getDynamicMemberType = () => schema.type;
      namespace.getDynamicFunctionDefinition = () => null;
      return;
    }
    namespace.runtimeType = Type.dict(Type.str);
    namespace.getDynamicMemberType = () => Type.func(schema.definition);
    namespace.getDynamicFunctionDefinition = () => schema.definition;
  }

  private validateSourceNamespaceSchemas() {
    if (this.sourceNamespaceSchemasValidated) return;
    this.sourceNamespaceSchemasValidated = true;

    for (const namespace of this.sourceNamespaces) {
      if (namespace.schemaDeclarations.length > 1) {
        for (const declaration of namespace.schemaDeclarations) {
          this.reportError(
            declaration.name,
            `Namespace '${namespace.fullPath}' declares more than one schema`,
          );
        }
        continue;
      }
      let declaration = namespace.schemaDeclarations[0];
      if (declaration != null) {
        namespace.schema = this.buildSourceNamespaceSchema(
          namespace,
          declaration,
        );
      }
    }

    for (const namespace of this.sourceNamespaces) {
      if (namespace.schema?.kind == "shape") {
        this.resolveSourceNamespaceShapeReferences(namespace.schema);
      }
    }

    for (const namespace of [...this.sourceNamespaces]) {
      let schema = namespace.schema;
      if (schema == null) continue;
      if (schema.kind == "value") {
        for (const [name, definition] of Object.entries(namespace.members)) {
          if (!isSourceNamespaceVariableDefinition(definition)) {
            this.reportError(
              namespace.memberDeclarationNodes.get(name) ?? schema.declaration,
              `Namespace '${namespace.fullPath}' has a value schema, so '${name}' must be a variable`,
            );
          } else if (
            !this.deferSourceNamespaceVariableTypeValidation &&
            !definition.returnType.matches(Type.unknown) &&
            !definition.returnType.isAssignableTo(schema.type)
          ) {
            this.reportError(
              definition.astNode ?? schema.declaration,
              `Namespace member '${namespace.fullPath}.${name}' has type '${definition.returnType}', expected '${schema.type}'`,
            );
          }
        }
      } else if (schema.kind == "function") {
        let memberKinds = new Set<"function" | "process">();
        for (const [name, definition] of Object.entries(namespace.members)) {
          this.validateSchemaFunctionMember(
            namespace,
            name,
            definition,
            schema,
          );
          if (isFunctionDefinition(definition)) {
            memberKinds.add(
              this.isProcessDefinition(definition) ? "process" : "function",
            );
          }
        }
        if (schema.allowEitherKind && memberKinds.size == 1) {
          schema.definition.runtimeNamespaceCallKind = [...memberKinds][0];
          schema.definition.action = actions.get(
            schema.definition.runtimeNamespaceCallKind == "process"
              ? DFCodeblockName.START_PROCESS
              : DFCodeblockName.CALL_FUNCTION,
          )?.dynamic;
        } else if (schema.allowEitherKind) {
          // Mixed namespaces use explicit source syntax: ordinary
          // calls target Functions and `start` targets Processes.
          schema.definition.runtimeNamespaceCallKind = "either";
          schema.definition.action = actions.get(DFCodeblockName.CALL_FUNCTION)
            ?.dynamic;
        }
      } else {
        for (const [name] of Object.entries(namespace.members)) {
          if (!namespace.children.has(name)) {
            this.reportError(
              namespace.memberDeclarationNodes.get(name) ?? schema.declaration,
              `Namespace '${namespace.fullPath}' has a namespace schema, so '${name}' must be a nested namespace`,
            );
          }
        }
        for (const child of namespace.children.values()) {
          this.validateNamespaceAgainstShape(child, schema);
        }
      }
      this.configureSourceNamespaceRuntime(namespace);
    }

    // Defaults may synthesize sub-namespaces which make a previously
    // unresolved import valid. Resolve those imports once the namespace tree
    // is complete, and only now report genuinely unknown paths.
    this.resolveSourceImports(this.sourceNamespaceImportRoots, true, true);
  }

  public resolveIdentifier(
    identifier: Token,
  ): Namespace | VariableEntry | Definition | null {
    let value: string = identifier.value;
    let frame: EnvironmentFrame = this.getNodeFrame(identifier);

    let varEntry = frame.getVariableEntry(value, identifier.startPos);
    if (varEntry != undefined) return varEntry;

    let sourceNamespace = this.sourceNamespaceByNode.get(identifier);
    let sourceMember = sourceNamespace?.findUnqualifiedMember(value);
    if (sourceMember != undefined) return sourceMember;

    let imported = frame.getImport(value);
    if (imported != null) return imported;

    if (this.globalFrame.functions.has(value)) {
      return this.globalFrame.functions.get(value)![0];
    }

    let namespace = Namespace.registry[value];
    if (namespace != undefined) return namespace;

    if (value in GLOBAL_SCOPE_INJECTIONS) return GLOBAL_SCOPE_INJECTIONS[value];

    return null;
  }

  getRequirements(expression: ASTNode, frame: EnvironmentFrame): Requirement[] {
    if (expression instanceof Expression) {
      expression = expression.getRealExpression();
    }
    if (expression instanceof TypecastExpression) {
      // if an expression is being recast by the AS operator,
      // nothing inside it is needed to evaluated higher up types
      return [];
    } else if (expression instanceof BinaryExpression) {
      let leftConstType = this.evaluateExpression(
        expression.left,
        EnvironmentFrame.DUMMY,
      );
      let rightConstType = this.evaluateExpression(
        expression.right,
        EnvironmentFrame.DUMMY,
      );

      // if the type of this operation can be evaluated without any context
      // (e.g. (s"styled text" + dingus) will always be type txt no matter what 'dingus' is)
      // then none of the variables inside of it matter so they can be ignored
      if (
        Operations.evaluateBinaryType(
          leftConstType,
          expression.operator.type,
          rightConstType,
        ) != Type.unknown
      ) {
        return [];
      } else {
        return [
          ...this.getRequirements(expression.left, frame),
          ...this.getRequirements(expression.right, frame),
        ];
      }
    } else if (expression instanceof VariableExpression) {
      return [{
        item: VariableId.fromExpression(expression),
        atPos: expression.startPos,
      }];
    } else if (expression instanceof AccessExpression) {
      return this.getRequirements(expression.accessee, frame);
    } else if (expression instanceof CallExpression) {
      // the return type of a function doesn't depend on its args so the args don't need to be known
      // some shenanigans are gonna need to be done for functions that depend on tags but
      // i wont worry about that rn
      return [];
    } else if (expression instanceof AtomicExpression) {
      if (
        expression.token.type == TokenType.IDENTIFIER ||
        expression.token.type == TokenType.NAMESPACE
      ) {
        let resolved = this.resolveIdentifier(expression.token);
        if (
          resolved instanceof Namespace ||
          isFunctionDefinition(resolved) ||
          isValueDefinition(resolved) ||
          isPropertyDefinition(resolved) ||
          isNamespaceVariableDefinition(resolved)
        ) {
          // Compiler-known namespace members are not variable inference requirements.
          return [];
        }
      }
      return this.getRequirements(expression.token, frame);
    } else if (expression instanceof DictionaryEntryExpression) {
      return this.getRequirements(expression.value, frame);
    } else if (
      expression instanceof Token && expression.type == TokenType.IDENTIFIER
    ) {
      return [{ item: expression.value, atPos: expression.startPos }];
    } else {
      let requirements: Requirement[] = [];
      for (const child of expression.children) {
        requirements.push(...this.getRequirements(child, frame));
      }
      return requirements;
    }
  }

  // TODO: get inferences from ORs, find overlap, and apply the overlap
  // TODO: apply inferences after the if block if it always returns
  // TODO: apply inverse of inferences in else blocks
  // TODO: apply inference within the condition itself
  applyConditionInferenceVariables(
    opr: BooleanOperation | Expression,
    frame: EnvironmentFrame,
  ) {
    const getVarIdOfExpr = (expr?: Expression): VariableId | null => {
      if (!expr) return null;
      if (
        expr instanceof AtomicExpression &&
        expr.token.type == TokenType.IDENTIFIER
      ) {
        let resolved = this.resolveIdentifier(expr.token);
        if (isVariableEntry(resolved)) return resolved.id;
      } else if (expr instanceof VariableExpression) {
        return expr.getVarId();
      }
      return null;
    };

    // console.log(opr.constructor.name);
    if (
      opr instanceof BooleanOperation && opr.operation == TokenType.BOOL_AND
    ) {
      this.applyConditionInferenceVariables(opr.a, frame);
      this.applyConditionInferenceVariables(opr.b!, frame);
    } // == comparison
    else if (
      (opr instanceof BinaryExpression &&
        opr.operator.type == TokenType.DOUBLE_EQUALS) ||
      (opr instanceof BooleanOperation && opr.operation == TokenType.BANG &&
        opr.a instanceof BinaryExpression &&
        opr.a.operator.type == TokenType.BANG_EQUALS)
    ) {
      let binary = opr instanceof BinaryExpression
        ? opr
        : opr.a as BinaryExpression;

      let varId = getVarIdOfExpr(binary.left);
      if (!varId) return;

      frame.registerVariable({
        id: varId,
        effectiveBeyondPosition: binary.endPos,
        requirements: this.getRequirements(binary.right, frame),
        valueExpression: binary.right,
      });
    } else if (opr instanceof CallExpression) {
      // it's okay that expressions are being evaluated before types have been analyzed since var
      // namespace methods have no requirements to call so it will always return the right definition
      let calleeType = this.evaluateExpression(opr.callee);
      if (!calleeType.matches(Type.func)) return;
      let def = (calleeType.data as FuncTypeData).definition;

      // var.isType();
      if (
        def.action == actions.get(DFCodeblockName.IF_VARIABLE)!["VarIsType"]
      ) {
        let [_, tags] = getTagsAndArgTypes(opr.args.elements, this);
        if (!tags.type) return;

        let varId = getVarIdOfExpr(opr.args.elements[0]);
        if (!varId) return;

        let type = tags.type == "Number"
          ? Type.num
          : tags.type == "String"
          ? Type.str
          : tags.type == "Styled Text"
          ? Type.txt
          : tags.type == "Location"
          ? Type.loc
          : tags.type == "Item"
          ? Type.item
          : tags.type == "List"
          ? Type.list(Type.any)
          : tags.type == "Potion effect"
          ? Type.pot
          : tags.type == "Particle"
          ? Type.par
          : tags.type == "Vector"
          ? Type.vec
          : tags.type == "Dictionary"
          ? Type.dict(Type.any)
          : null;
        if (type == null) return;

        frame.registerVariable({
          id: varId,
          effectiveBeyondPosition: opr.endPos,
          requirements: [],
          type,
        });
      }
    }
    // TODO: handle var.equals() block
  }

  applyStatementVariables(statement: Statement, frame: EnvironmentFrame) {
    if (statement instanceof TypeStatement) {
      if (!(frame.astNode instanceof RootNode)) {
        this.reportError(
          statement.keyword,
          `Type declarations can only appear at the top level of a file`,
        );
        return;
      }
      let name = statement.name.value;
      if (name in Type || name in CUSTOM_TYPES || name in Namespace.registry) {
        this.reportError(statement.name, `Type '${name}' is already defined`);
        return;
      }
      let baseType = this.evaluateExplicitType(statement.assignedType.type, {
        reportErrors: true,
      });
      if (
        baseType.matches(Type.unknown) || baseType.matches(Type.void) ||
        baseType.matches(Type.var) || baseType.matches(Type.func) ||
        baseType.matches(Type.namespace)
      ) {
        this.reportError(
          statement.assignedType.type,
          `Type '${baseType}' cannot be used as a custom type base`,
        );
        return;
      }
      let customType = Type.alias(name, baseType);
      CUSTOM_TYPES[name] = customType;
      Type.assignableTypes.add(name);
      TYPE_NAMESPACES[name] = new Namespace(name);
      return;
    } else if (statement instanceof ExtendStatement) {
      let targetType = this.evaluateExplicitType(statement.type, {
        reportErrors: true,
      });
      if (
        targetType.matches(Type.unknown) || targetType.matches(Type.void) ||
        targetType.matches(Type.var) || targetType.matches(Type.func) ||
        targetType.matches(Type.namespace)
      ) {
        this.reportError(
          statement.type,
          `Type '${targetType}' cannot be extended`,
        );
        return;
      }
      let namespace = TYPE_NAMESPACES[targetType.name] ??
        new Namespace(targetType.name);
      TYPE_NAMESPACES[targetType.name] = namespace;

      if (!(statement.chunk instanceof ChunkExpression)) return;
      for (const inner of statement.chunk.statements) {
        if (!(inner instanceof FunctionStatement)) {
          this.reportError(
            inner,
            `Only function declarations are allowed inside extend blocks`,
          );
          continue;
        }

        let isConstructor = inner.name.value == "constructor";
        let backendName = getExtensionFunctionBackendName(
          targetType.name,
          inner.name.value,
        );
        inner.backendName = backendName;
        let definition = this.createFunctionDefinition(
          inner,
          frame,
          backendName,
          { registerParameters: false },
        );
        if (!definition) continue;

        if (isConstructor) {
          if (namespace.nameFunction) {
            this.reportError(
              inner.name,
              `Type '${targetType.name}' already has a constructor defined`,
            );
            continue;
          }
          if (!definition.defaultReturnType.matches(targetType)) {
            this.reportError(
              inner.returnType ?? inner.name,
              `Constructors must declare a return type of '${targetType.name}' (e.g. 'constructor(...): ${targetType.name}')`,
            );
            continue;
          }
          namespace.nameFunction = definition;
        } else {
          namespace.members[inner.name.value] = definition;
        }
      }
      return;
    }
    // function/process parameters
    if (statement instanceof FunctionStatement) {
      let backendName = statement.backendName ?? statement.name.value;
      let definition = this.createFunctionDefinition(
        statement,
        frame,
        backendName,
      );
      // Source namespace functions have already been installed on their
      // namespace during the namespace collection pass.  We still create
      // this frame-local definition to register parameters, but they must
      // never leak into the ordinary top-level function namespace.
      if (this.sourceNamespaceFunctionStatements.has(statement)) return;
      if (definition && frame.parent?.astNode instanceof RootNode) {
        let isProcess = statement.headerType == DFCodeblockName.PROCESS;
        let map = this.globalFrame[isProcess ? "processes" : "functions"];
        map.getOrInsert(statement.name.value, []).push(definition);
      }
    } // repeat counter var
    else if (
      statement instanceof RepeatStatement && statement.countExpression &&
      statement.chunk
    ) {
      let countExpression = statement.countExpression.getRealExpression();
      if (
        countExpression instanceof BinaryExpression &&
        countExpression.operator.type == TokenType.TO
      ) {
        let varExpr = countExpression.left;
        if (varExpr instanceof VariableExpression) {
          frame.registerVariable({
            id: varExpr.getVarId(),
            type: Type.num,
            effectiveBeyondPosition: statement.chunk.startPos,
            astNode: countExpression,
          });
        }
      }
    } // for loop vars
    else if (
      statement instanceof ForStatement && statement.iteratorExpression &&
      statement.chunk
    ) {
      let varTypes: Type[] = [];
      let requirements: Requirement[];

      let varExprs = statement.variableList.elements;
      let iteratorExpr = statement.iteratorExpression?.getRealExpression();
      if (isForLoopActionCall(iteratorExpr)) {
        varTypes.push(
          REPEAT_ACTIONS[iteratorExpr.callee.token.value].returnType,
        );
        requirements = [];
      } else {
        requirements = this.getRequirements(
          statement.iteratorExpression,
          frame,
        );
      }
      for (let i = 0; i < varExprs.length; i++) {
        let varExpr = varExprs[i];
        let varId: VariableId | undefined;
        if (varExpr instanceof VariableExpression) {
          varId = varExpr.getVarId();
        } else if (
          varExpr instanceof AtomicExpression &&
          varExpr.token.type == TokenType.IDENTIFIER
        ) {
          let varEntry = frame.getVariableEntry(
            varExpr.token.value,
            varExpr.startPos,
          );
          if (varEntry) varId = varEntry.id;
        }
        if (!varId) continue;

        frame.registerVariable({
          id: varId,
          type: varTypes[i] ?? null,
          effectiveBeyondPosition: statement.chunk.startPos,
          requirements,
          valueExpression: statement.iteratorExpression,
          forLoopVarPos: i,
          astNode: varExpr,
        });
      }
    } // if statement type inference
    else if (
      statement instanceof IfStatement || statement instanceof WhileStatement
    ) {
      let booleanOpr = BooleanOperation.generateIfPossible(
        statement.condition.getRealExpression(),
      );
      if (booleanOpr instanceof BooleanOperation) {
        booleanOpr = BooleanOperation.simplify(booleanOpr);
      }
      this.applyConditionInferenceVariables(booleanOpr, frame);
    }
  }

  createFunctionDefinition(
    statement: FunctionStatement,
    frame: EnvironmentFrame,
    backendName: string,
    { registerParameters = true }: { registerParameters?: boolean } = {},
  ): FunctionDefinition | null {
    let signatureParams: ParameterSignatureEntry[] = [];

    if (statement.params) {
      let seenNames: Set<string> = new Set();
      for (const param of statement.params.elements) {
        if (seenNames.has(param.name.value)) continue;
        seenNames.add(param.name.value);

        let type: Type;
        let varType: Type;
        if (param.assignedType) {
          type = this.evaluateExplicitType(param.assignedType.type, {
            reportErrors: true,
            allowVarType: true,
          });
          if (param.ellipses) {
            varType = Type.list(type);
          } else if (type.matches(Type.var)) {
            varType = (type.data as VarTypeData).varType;
          } else {
            varType = type;
          }
        } else {
          type = Type.any;
          varType = Type.any;
        }
        let description = commentsToDocumentation(param.attachedComments);
        if (registerParameters) {
          frame.registerVariable({
            id: VariableId.get(VariableScope.LINE, param.name.value),
            type: varType,
            effectiveBeyondPosition: statement.chunk.startPos,
            astNode: param,
            description,
          });
        }
        signatureParams.push({
          name: param.name.value,
          type: type,
          optional: param.optionalMarker != null ||
            (param.ellipses == null && param.defaultValue != null),
          plural: param.ellipses != null,
          description,
        });
      }
    }

    let returnType: Type = Type.void;
    if (statement.returnType != null) {
      if (statement.returnType.types.length == 1) {
        returnType = this.evaluateExplicitType(statement.returnType.types[0], {
          reportErrors: true,
        });
      } else {
        returnType = Type.multivalue(
          statement.returnType.types.map((t) =>
            this.evaluateExplicitType(t, { reportErrors: true })
          ),
          Type.void,
        );
      }
    }

    // frame here will be the function's chunk's frame so the parent needs to be accessed
    let isProcess = statement.headerType == DFCodeblockName.PROCESS;
    return {
      definitionType: DefinitionType.FUNCTION,
      action: isProcess
        ? actions.get(DFCodeblockName.START_PROCESS)?.dynamic
        : actions.get(DFCodeblockName.CALL_FUNCTION)?.dynamic,
      name: backendName,
      description: commentsToDocumentation(statement.attachedComments),
      signatures: [{ params: signatureParams }],
      defaultReturnType: returnType,
      getReturnType: USE_DEFAULT_RETURN_TYPE,
      compile: isProcess ? COMPILE_START_PROCESS : COMPILE_CALL_FUNCTION,
      astNode: statement,
    };
  }

  /**
   * If a RootNode is passed in, an extra frame will be created to represent that RootNode's document
   * The RootNode's statements will then be collected
   */
  collectionStage(
    statements: RootNode[] | Statement[],
    defaultFrame: EnvironmentFrame = this.globalFrame,
  ) {
    // When given a full set of files, register every file's top-level 'type' declarations
    // FIRST, across all files, before collecting anything else. Otherwise things like a
    // 'declare' statement or an 'extend' block in one file would fail to resolve a type
    // that's declared in another file, purely because of the order files happen to be
    // processed in.
    if (
      statements.length > 0 && statements.every((s) => s instanceof RootNode)
    ) {
      let roots = statements as RootNode[];
      let rootFrames: EnvironmentFrame[] = [];
      for (const root of roots) {
        let rootFrame = this.framesByASTNode.get(root) ??
          defaultFrame.addChild(root);
        this.framesByASTNode.set(root, rootFrame);
        rootFrames.push(rootFrame);
        for (const statement of root.statements) {
          if (statement instanceof TypeStatement) {
            this.applyStatementVariables(statement, rootFrame);
          }
        }
      }
      this.prepareSourceNamespaces(roots);
      for (let i = 0; i < roots.length; i++) {
        this.collectionStage(roots[i].statements, rootFrames[i]);
      }
      return;
    }

    for (let statement of statements) {
      let frame = defaultFrame;
      // handle root nodes
      if (statement instanceof RootNode) {
        let rootFrame = this.framesByASTNode.get(statement) ??
          frame.addChild(statement);
        this.framesByASTNode.set(statement, rootFrame);
        this.collectionStage(statement.statements, rootFrame);
        continue;
      }

      // handle declaration statements
      let varPositionOverride: number | undefined = undefined;
      if (statement instanceof DeclareStatement) {
        statement = statement.subStatement;
        // declare statements always push things to the top of the global frame
        frame = this.globalFrame;
        varPositionOverride = -1;
      }

      if (statement instanceof TypeStatement) {
        // already registered by the cross-file pre-pass above; registering it again here
        // would make it look like a duplicate type declaration
        continue;
      }

      if (statement instanceof ImportStatement) {
        if (!(frame.astNode instanceof RootNode)) {
          this.reportError(
            statement.keyword,
            "Imports can only appear at the top level of a file",
          );
        }
        continue;
      }

      if (statement instanceof NamespaceStatement) {
        if (!this.sourceNamespaceByDeclaration.has(statement)) {
          this.reportError(
            statement.keyword,
            "Namespace declarations can only appear at the top level of a file or directly inside another namespace",
          );
          continue;
        }
        if (!(statement.chunk instanceof ChunkExpression)) continue;
        let namespaceFrame = this.framesByASTNode.get(statement.chunk) ??
          frame.addChild(statement.chunk);
        this.framesByASTNode.set(statement.chunk, namespaceFrame);
        this.collectionStage(statement.chunk.statements, namespaceFrame);
        continue;
      }

      if (
        statement instanceof NamespaceVariableStatement ||
        statement instanceof NamespaceSchemaStatement
      ) {
        continue;
      }

      // variable assignments
      if (
        statement instanceof AssignmentStatement &&
        statement.isErrorFree()
      ) {
        for (let i = 0; i < statement.leftValues.length; i++) {
          let variableExpr = statement.leftValues[i];
          if (!(variableExpr instanceof VariableExpression)) continue;

          // if this variable has already been declared and there's no explicit type
          // being specified, don't override the var's type with the inferred value type
          // also, "allow" having multiple declarations in the global frame since the compiler can
          // detect that and display a proper error
          if (!variableExpr.assignedType && frame != this.globalFrame) {
            let existingEntry = frame.getVariableEntry(
              variableExpr.getVarId(),
              variableExpr.startPos,
            );
            if (existingEntry) continue;
          }

          let varId = VariableId.fromExpression(variableExpr);
          let description = commentsToDocumentation(statement.attachedComments);
          if (variableExpr.assignedType) {
            frame.registerVariable({
              id: varId,
              type: this.evaluateExplicitType(variableExpr.assignedType.type, {
                reportErrors: true,
              }),
              effectiveBeyondPosition: varPositionOverride ?? statement.endPos,
              astNode: statement,
              description,
            });
          } else {
            let value = statement.rightValue;
            frame.registerVariable({
              id: varId,
              type: null,
              effectiveBeyondPosition: varPositionOverride ?? statement.endPos,
              requirements: this.getRequirements(value, frame),
              valueExpression: value,
              assignmentVarPos: i,
              astNode: statement,
              description,
            });
          }
        }
      } else if (
        statement instanceof ExpressionStatement &&
        statement.expression instanceof VariableExpression
      ) {
        let variableExpr = statement.expression;
        let varId = VariableId.fromExpression(variableExpr);
        let existingDeclaration = frame.getVariableEntry(
          varId,
          variableExpr.startPos,
        );

        // "allow" having multiple declarations in the global frame since the compiler can
        // detect that and display a proper error
        if (
          existingDeclaration && !variableExpr.assignedType &&
          frame != this.globalFrame
        ) continue;

        frame.registerVariable({
          id: varId,
          type: variableExpr.assignedType
            ? this.evaluateExplicitType(variableExpr.assignedType.type, {
              reportErrors: true,
            })
            : null,
          effectiveBeyondPosition: varPositionOverride ?? statement.endPos,
          astNode: variableExpr,
          description: commentsToDocumentation(statement.attachedComments),
        });
      } //=- stuff below here is for entering child frames -=\\
      else {
        for (let c of statement.children) {
          // fix else ifs not getting their own frames
          if (c instanceof IfStatement && c.chunk) {
            this.collectionStage([c], frame);
          }

          if (c instanceof ChunkExpression) {
            // console.log(c.parent.constructor.name)
            let subFrame: EnvironmentFrame;
            // consider contents of perselected statements to be on the same level as the statement's parent
            if (statement instanceof PerSelectedStatement) {
              subFrame = frame;
            } else {
              subFrame = frame.addChild(c);
              this.framesByASTNode.set(c, subFrame);
            }
            // these functions need to be called in this order since
            // `c.statements`'s variables could be influenced by the result of
            // applyStatementVariables (e.g. when `statement` is a function with params)
            this.applyStatementVariables(statement, subFrame);
            this.collectionStage(c.statements, subFrame);
          }
        }
      }
    }
  }

  private evaluateSourceNamespaceVariables(
    deferTypeValidation: boolean = false,
  ) {
    for (const definition of this.sourceNamespaceVariables) {
      let declaration = definition.declaration;
      let initializer = definition.initializer;
      if (initializer == null) {
        if (!definition.explicitlyTyped && declaration != null) {
          this.reportError(
            declaration.name,
            `Namespace variable '${definition.namespace.fullPath}.${definition.name}' requires a type annotation or an initializer`,
          );
        }
        continue;
      }

      let initializerType = this.evaluateExpression(initializer);
      if (!definition.explicitlyTyped) {
        definition.returnType = initializer instanceof DictionaryExpression ||
            initializer instanceof ListExpression
          ? this.genericizeType(initializerType)
          : initializerType;
      } else if (
        !deferTypeValidation &&
        !initializerType.isAssignableTo(definition.returnType)
      ) {
        this.reportError(
          initializer,
          `Type '${initializerType}' is not assignable to namespace variable type '${definition.returnType}'`,
        );
      }
    }
    this.expressionTypeCache.clear();
  }

  /**
   * Namespace runtime types may be needed to infer a variable initializer.
   * Validate source variables only after schemas have configured those types.
   */
  private validateFinalSourceNamespaceVariableTypes() {
    const validate = (
      namespace: SourceNamespace,
      name: string,
      definition: Definition | undefined,
      expected: Type,
    ) => {
      if (!isSourceNamespaceVariableDefinition(definition)) return;
      if (
        definition.returnType.matches(Type.unknown) ||
        definition.returnType.isAssignableTo(expected)
      ) return;
      this.reportError(
        definition.astNode ?? namespace.memberDeclarationNodes.get(name) ??
          namespace.declarations[0],
        `Namespace member '${namespace.fullPath}.${name}' has type '${definition.returnType}', expected '${expected}'`,
      );
    };

    for (const namespace of this.sourceNamespaces) {
      if (namespace.schema?.kind == "value") {
        for (const [name, definition] of Object.entries(namespace.members)) {
          validate(namespace, name, definition, namespace.schema.type);
        }
      }
      if (namespace.effectiveSchema?.kind == "shape") {
        for (const field of namespace.effectiveSchema.fields.values()) {
          if (field.kind == "value") {
            validate(
              namespace,
              field.name,
              namespace.members[field.name],
              field.type,
            );
          }
        }
      }
    }
  }

  evaluationStage(frame: EnvironmentFrame = this.globalFrame) {
    this.expressionTypeCache.clear();

    if (frame == this.globalFrame) {
      this.deferSourceNamespaceVariableTypeValidation = true;
      this.evaluateSourceNamespaceVariables(true);
      this.validateSourceNamespaceSchemas();
      this.deferSourceNamespaceVariableTypeValidation = false;
      // Schema defaults can add more namespace variables, and runtime
      // shapes now make schema-dependent initializer types resolvable.
      this.evaluateSourceNamespaceVariables();
      this.validateFinalSourceNamespaceVariableTypes();
    }

    let newSolves = -1;
    let hitWall = false;
    // keep going until no more progress is being made, then solve everything in one final pass using available information
    // this allows dicts/lists with unknown fields to sub in 'any' for those fields and still type everything else
    while (!hitWall) {
      if (newSolves == 0) {
        hitWall = true;
      }
      newSolves = 0;

      for (const [id, allEntries] of frame.entryLists()) {
        for (const entry of allEntries) {
          if (entry.solved) continue;

          // check if all requirements have been solved
          // unless we're in the final pass
          if (!hitWall) {
            let allRequirementsSolved = true;
            for (const requirement of entry.requirements) {
              let rEntry = frame.getVariableEntry(
                requirement.item,
                requirement.atPos,
              );
              // TODO: probably the null case should be handled in a special way
              if (rEntry == null || rEntry.solved == false) {
                allRequirementsSolved = false;
                break;
              }
            }
            if (!allRequirementsSolved) continue;
          }

          if (!entry.valueExpression) continue;

          let exprType = this.evaluateExpression(entry.valueExpression, frame);
          if (entry.forLoopVarPos != undefined) {
            // Schema namespaces are represented as dictionaries at
            // runtime, so their key/value loop variables need the
            // dictionary's runtime member types rather than the
            // compile-time-only `namespace` wrapper type.
            let runtimeExprType = exprType.getRuntimeType();
            if (
              runtimeExprType.matches(Type.list) && entry.forLoopVarPos == 0
            ) {
              entry.type = runtimeExprType.getMemberType();
            } else if (runtimeExprType.matches(Type.dict)) {
              entry.type = entry.forLoopVarPos == 0
                ? Type.str
                : runtimeExprType.getMemberType();
            } else {
              entry.type = Type.unknown;
            }
          } else if (entry.assignmentVarPos != undefined) {
            if (exprType.matches(Type.multivalue)) {
              let multiValueData = exprType.data as MultiValueTypeData;
              if (entry.assignmentVarPos < multiValueData.types.length) {
                entry.type = multiValueData.types[entry.assignmentVarPos];
              } else {
                entry.type = multiValueData.overflowType;
              }
            } else if (entry.assignmentVarPos == 0) {
              // genericize dict and list type inference
              if (
                entry.valueExpression instanceof DictionaryExpression ||
                entry.valueExpression instanceof ListExpression
              ) {
                entry.type = this.genericizeType(exprType);
              } else {
                entry.type = exprType;
              }
            } else {
              entry.type = Type.unknown;
            }
          } else {
            entry.type = exprType;
          }

          entry.solved = true;
          newSolves++;
        }
      }
    }

    // once this frame's been solved as far as it can go, process child frames
    for (const [astNode, child] of frame.children.entries()) {
      this.evaluationStage(child);
    }
  }

  private evaluateExpressionLogic(
    expression: Expression,
    frame: EnvironmentFrame = this.globalFrame,
  ): Type {
    expression = expression.getRealExpression();
    if (expression instanceof AtomicExpression) {
      let token = expression.token;
      switch (token.type) {
        case TokenType.IDENTIFIER:
        case TokenType.NAMESPACE: {
          let resolved = this.resolveIdentifier(token);
          if (resolved instanceof Namespace) {
            return Type.namespace(resolved);
          } else if (isFunctionDefinition(resolved)) {
            return Type.func(resolved);
          } else if (isValueDefinition(resolved)) {
            return resolved.returnType;
          } else if (isPropertyDefinition(resolved)) {
            return resolved.type;
          } else if (isNamespaceVariableDefinition(resolved)) {
            return resolved.returnType;
          } else if (isVariableEntry(resolved) && resolved.type != null) {
            return resolved.type;
          }
          return Type.unknown;
        }
        case TokenType.NUMERIC_LITERAL:
          return Type.num;
        case TokenType.NUMEXPR_LITERAL:
          return Type.num;
        case TokenType.STRING_LITERAL:
          return Type.str;
        case TokenType.STYLED_LITERAL:
          return Type.txt;
        default:
          return Type.unknown;
      }
    } else if (expression instanceof ListExpression) {
      let indexTypes = expression.elements.map((elm) =>
        this.evaluateExpression(elm, frame)
      );
      return Type.list(Type.void, indexTypes);
    } else if (expression instanceof DictionaryExpression) {
      let keyTypes: { [key: string]: Type } = {};
      let keyDescriptions: { [key: string]: string } = {};
      for (const entry of expression.entries) {
        if (!(entry.key instanceof Token)) continue;
        keyTypes[entry.key.value] = this.evaluateExpression(entry.value);
        let documentation = commentsToDocumentation(entry.attachedComments);
        if (documentation != undefined) {
          keyDescriptions[entry.key.value] = documentation;
        }
      }
      return Type.dict(Type.void, keyTypes, keyDescriptions);
    } else if (expression instanceof VariableExpression) {
      return frame.getVariableType(
        VariableId.fromExpression(expression),
        expression.startPos,
      );
    } else if (expression instanceof TypecastExpression) {
      return this.evaluateExplicitType(expression.type);
    } else if (expression instanceof AccessExpression) {
      return this.evaluateExpression(expression.accessee, frame)
        .getPropertyType(expression.propertyName.value);
    } else if (expression instanceof BracketedAccessExpression) {
      let propNameExpr = expression.propertyName.getRealExpression();
      let propName: number | string | undefined = undefined;
      if (propNameExpr instanceof AtomicExpression) {
        if (propNameExpr.token.type == TokenType.NUMERIC_LITERAL) {
          let parsed = tcParseNumber(propNameExpr.token.value);
          if (!isNaN(parsed)) {
            propName = parsed;
          }
        } else {
          propName = propNameExpr.token.value;
        }
      }
      return this.evaluateExpression(expression.accessee, frame).getMemberType(
        propName,
      );
    } else if (expression instanceof CallExpression) {
      let calleeType = this.evaluateExpression(expression.callee);
      let def: FunctionDefinition | null;
      if (calleeType.name == "func") {
        def = (calleeType.data as FuncTypeData).definition;
      } else if (calleeType.name == "namespace") {
        def = (calleeType.data as NamespaceTypeData).namespace.nameFunction!;
      } else {
        return Type.unknown;
      }
      let methodCallOf: Type | undefined;
      if (expression.callee instanceof AccessExpression) {
        methodCallOf = this.evaluateExpression(expression.callee.accessee);
      }
      return def.getReturnType(expression.args.elements, this, methodCallOf) ??
        Type.unknown;
    } else if (expression instanceof CallOrStartExpression) {
      let calleeType = this.evaluateExpression(expression.callee, frame);
      let definition: FunctionDefinition | null = null;
      if (calleeType.name == "func") {
        definition = (calleeType.data as FuncTypeData).definition;
      } else if (expression.callee instanceof AtomicExpression) {
        definition = this.getUserFuncDef(
          expression.keyword.type == TokenType.START,
          expression.callee.token.value,
          true,
        ) ?? null;
      }
      if (definition == null || expression.keyword.type == TokenType.START) {
        return Type.void;
      }
      return definition.getReturnType(expression.args.elements, this) ??
        Type.unknown;
    } else if (expression instanceof BinaryExpression) {
      return Operations.evaluateBinaryType(
        this.evaluateExpression(expression.left, frame),
        expression.operator.type,
        this.evaluateExpression(expression.right, frame),
      );
    } else if (expression instanceof UnaryPrefixExpression) {
      return Operations.evaluateUnaryType(
        expression.operator.type,
        this.evaluateExpression(expression.right, frame),
      );
    } else if (expression instanceof SelectionExpression) {
      let definitionBank = expression.keyword.type == TokenType.SELECT
        ? SELECT_ACTIONS
        : FILTER_ACTIONS;
      if (expression.name.value in definitionBank) {
        return Type.func(definitionBank[expression.name.value]);
      } else {
        return Type.unknown;
      }
    } else {
      return Type.unknown;
    }
  }

  evaluateExpression(
    expression: Expression,
    frame: EnvironmentFrame = this.globalFrame,
  ): Type {
    let cachedType = this.expressionTypeCache.get(expression)?.get(frame);
    if (cachedType) return cachedType;
    let type = this.evaluateExpressionLogic(expression, frame);
    this.expressionTypeCache.getOrInsert(expression, new Map()).set(
      frame,
      type,
    );
    return type;
  }

  evaluateExplicitType(
    expression: TypeExpression,
    { allowEllipses, allowVarType, reportErrors }: {
      allowEllipses?: boolean;
      allowVarType?: boolean;
      reportErrors?: boolean;
    } = {},
  ): Type {
    if (!allowEllipses && expression.ellipses) {
      if (reportErrors) {
        this.reportError(expression.ellipses, `Ellipses are not allowed here`);
      }
    }

    // special syntax handling
    if (expression.type instanceof ListExpression) {
      let elementTypes: Type[] = [];
      let genericType: Type | undefined;

      let nonEllipsesTypeFound = false;
      // iterate in reverse so ellipses error handling can be done in the same loop as type evaluation
      for (let i = expression.type.elements.length - 1; i >= 0; i--) {
        let element = expression.type.elements[i];
        if (element.ellipses) {
          if (nonEllipsesTypeFound) {
            if (reportErrors) {
              this.reportError(
                element,
                `Overflow type must come at the end of the list, after all positional types`,
              );
            }
          }
          if (genericType == undefined) {
            genericType = this.evaluateExplicitType(element, {
              allowEllipses: true,
              reportErrors,
            });
          } else {
            if (reportErrors) {
              this.reportError(
                element,
                `Lists may only specify one overflow type`,
              );
            }
          }
        } else {
          elementTypes.unshift(
            this.evaluateExplicitType(element, { reportErrors }),
          );
          nonEllipsesTypeFound = true;
        }
      }

      return Type.list(genericType ?? Type.void, elementTypes);
    } else if (expression.type instanceof DictionaryTypeExpression) {
      let elementTypes: { [key: string]: Type } = {};
      let elementDescriptions: { [key: string]: string } = {};
      let genericType: Type | undefined;

      // overflow type
      for (let i = expression.type.overflowTypes.length - 1; i >= 0; i--) {
        let type = expression.type.overflowTypes[i];
        if (!type.ellipses) {
          if (reportErrors) {
            this.reportError(
              type,
              "Expected key name before this type or ellipses after this type",
            );
          }
          continue;
        }

        if (genericType == undefined) {
          genericType = this.evaluateExplicitType(type, {
            allowEllipses: true,
            reportErrors,
          });
        } else {
          if (reportErrors) {
            this.reportError(
              type,
              "Dictionaries may only specify one overflow type",
            );
          }
        }
      }

      // key types
      for (let entry of expression.type.entries) {
        elementTypes[entry.key.value] = this.evaluateExplicitType(entry.value, {
          reportErrors,
        });
        let documentation = commentsToDocumentation(entry.attachedComments);
        if (documentation != undefined) {
          elementDescriptions[entry.key.value] = documentation;
        }
      }

      return Type.dict(
        genericType ?? Type.void,
        elementTypes,
        elementDescriptions,
      );
    }

    let name = expression.type.value;
    if (name == "var" && !allowVarType) {
      if (reportErrors) {
        this.reportError(
          expression.type,
          `Variable type is not allowed here`,
        );
      }
    }
    if (name in CUSTOM_TYPES) {
      if (expression.subType) {
        if (reportErrors) {
          this.reportError(
            expression.subType,
            `Type '${name}' is not generic and does not support subtypes`,
          );
        }
      }
      return CUSTOM_TYPES[name];
    }
    if (Type[name] && Type[name] instanceof Type) {
      if (expression.subType) {
        if (reportErrors) {
          this.reportError(
            expression.subType,
            `Type '${name}' is not generic and does not support subtypes`,
          );
        }
      }
      return Type[name];
    } else if (Type[name] && Type[name].constructsType) {
      let constructor = Type[name] as TypeConstructor<(...args: any[]) => Type>;
      if (constructor.subTypeCount == 0) {
        if (reportErrors) {
          this.reportError(
            expression,
            `Type '${name}' cannot be directly assigned`,
          );
        }
        return Type.unknown;
      }
      let argTypes: Type[] = [];
      if (expression.subType != undefined) {
        argTypes = expression.subType.elements.map((elm) => {
          return this.evaluateExplicitType(elm, { reportErrors });
        });
        if (argTypes.length > constructor.subTypeCount) {
          if (reportErrors) {
            this.reportError(
              expression.subType,
              `Type '${name}' expects ${constructor.subTypeCount} argument${
                ps(constructor.subTypeCount)
              }, ${argTypes.length} were provided.`,
            );
          }
          // strip off extra types before passing into constructor
          argTypes.length = constructor.subTypeCount;
        }
      }
      // fill in 'any' for non-specified types
      for (let i = argTypes.length; i < constructor.subTypeCount; i++) {
        argTypes.push(Type.any);
      }
      return constructor(...argTypes);
    } else {
      if (reportErrors) {
        this.reportError(
          expression,
          `Invalid type '${name}'`,
        );
      }
      return Type.unknown;
    }
  }

  getNodeFrame(node: ASTNode): EnvironmentFrame {
    let frame = this.framesByASTNode.get(node);
    if (frame) {
      return frame;
    } else if (node.parent == null) {
      return this.globalFrame;
    } else {
      return this.getNodeFrame(node.parent);
    }
  }

  /** Will generate it if it does not exist */
  private getFallbackCallOrStartDef(
    isProcess: boolean,
    name: string,
  ): FunctionDefinition {
    let def = this.fallbackCallOrStartDefs.get(isProcess)?.get(name);
    if (def) {
      return def;
    } else {
      def = {
        definitionType: DefinitionType.FUNCTION,
        name: name,
        action: isProcess
          ? actions.get(DFCodeblockName.START_PROCESS)?.dynamic
          : actions.get(DFCodeblockName.CALL_FUNCTION)?.dynamic,
        // TODO: allow declaring functions/parameter signatures with wildcards and hook into those declarations to find signatures
        signatures: [{
          params: [
            { name: "arguments", type: Type.any, optional: true, plural: true },
          ],
        }],
        defaultReturnType: Type.void,
        getReturnType: USE_DEFAULT_RETURN_TYPE,
        compile: isProcess ? COMPILE_START_PROCESS : COMPILE_CALL_FUNCTION,
      };
      this.fallbackCallOrStartDefs.get(isProcess)?.set(name, def);
      return def;
    }
  }

  getUserFuncDef(
    isProcess: boolean,
    name: string,
    allowFallback: boolean,
  ): FunctionDefinition | undefined {
    let normalDef = this.globalFrame[isProcess ? "processes" : "functions"].get(
      name,
    )?.[0];
    if (normalDef) {
      return normalDef;
    } else {
      if (allowFallback) {
        return this.getFallbackCallOrStartDef(isProcess, name);
      } else {
        return undefined;
      }
    }
  }
}
