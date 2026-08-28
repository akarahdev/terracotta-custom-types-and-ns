import { ASTNode } from "../../ast/astNode.ts";
import { Expression } from "../../ast/expression.ts";
import {
  FunctionSchemaTypeExpression,
  NamespaceSchemaFieldStatement,
  NamespaceSchemaFunctionStatement,
  NamespaceSchemaStatement,
  NamespaceStatement,
  NamespaceVariableStatement,
} from "../../ast/statement.ts";
import type {
  Definition,
  FunctionDefinition,
  NamespaceVariableDefinition,
} from "./definition.ts";
import type { Type } from "../../typeProcessor/type.ts";
import { Namespace } from "./namespace.ts";

/**
 * Source namespaces share Terracotta's existing extension-name family while
 * remaining disjoint from extension methods. Extension methods always contain
 * an additional underscore between their type and member names; the encoded
 * namespace suffix deliberately contains none. Hex also keeps dotted paths
 * injective without imposing a depth limit.
 */
export const SOURCE_NAMESPACE_MANGLE_PREFIX = "__TC_EXT_NS";
export const SOURCE_NAMESPACE_DICTIONARY_MANGLE_PREFIX = "__TC_EXT_ND";

function encodePathSegment(segment: string): string {
  return [...segment]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
}

export function encodeSourceNamespacePath(path: readonly string[]): string {
  // Source identifiers are ASCII and cannot contain a NUL character, so the
  // byte delimiter preserves every segment boundary exactly.
  return path.map(encodePathSegment).join("00");
}

export function getSourceNamespaceMemberBackendName(
  path: readonly string[],
  member: string,
): string {
  return `${SOURCE_NAMESPACE_MANGLE_PREFIX}${
    encodeSourceNamespacePath([...path, member])
  }`;
}

export function getSourceNamespaceDictionaryBackendName(
  path: readonly string[],
): string {
  return `${SOURCE_NAMESPACE_DICTIONARY_MANGLE_PREFIX}${
    encodeSourceNamespacePath(path)
  }`;
}

/**
 * The source-language namespace tree. It intentionally stays out of
 * `Namespace.registry`, whose entries are globally available built-ins.
 */
export class SourceNamespace extends Namespace {
  readonly children = new Map<string, SourceNamespace>();
  readonly declarations: NamespaceStatement[] = [];
  readonly schemaDeclarations: NamespaceSchemaStatement[] = [];
  readonly memberDeclarationNodes = new Map<string, ASTNode>();

  /** Set during schema validation. */
  schema: SourceNamespaceSchema | null = null;
  /** A child namespace inherits the shape it conforms to at runtime. */
  effectiveSchema: SourceNamespaceSchema | null = null;
  /** Runtime representation used by `Type.namespace(...).getRuntimeType()`. */
  runtimeType: Type | null = null;
  /**
   * The shape represented by a runtime namespace value.  Shape prototypes
   * and concrete conformers both use this to distinguish function selectors
   * from variable-name references during reflection and iteration.
   */
  runtimeShape: SourceNamespaceShapeSchema | null = null;
  /** Used by bracket access on schema-backed namespaces. */
  getDynamicMemberType: ((member?: string | number) => Type) | null = null;
  /** Present when a schema-backed `[]` lookup resolves to a function value. */
  getDynamicFunctionDefinition:
    | ((member?: string | number) => FunctionDefinition | null)
    | null = null;

  constructor(
    public readonly path: readonly string[],
    public readonly parentSourceNamespace: SourceNamespace | null,
  ) {
    super(path[path.length - 1] ?? "", {}, null, { registerGlobally: false });
  }

  get fullPath(): string {
    return this.path.join(".");
  }

  get dictionaryBackendName(): string {
    return getSourceNamespaceDictionaryBackendName(this.path);
  }

  get runtimeBacked(): boolean {
    return this.schema != null || this.effectiveSchema != null;
  }

  /**
   * Shape prototypes represent values returned by dynamic namespace access.
   * They do not own a global dictionary variable, but their configured
   * runtime type still supports dictionary reflection and iteration.
   */
  get supportsRuntimeReflection(): boolean {
    return this.runtimeBacked || this.runtimeType != null;
  }

  getDirectMember(name: string): Definition | SourceNamespace | undefined {
    return this.members[name] ?? this.children.get(name);
  }

  findUnqualifiedMember(name: string): Definition | undefined {
    let current: SourceNamespace | null = this;
    while (current != null) {
      let member = current.members[name];
      if (member != undefined) return member;
      current = current.parentSourceNamespace;
    }
    return undefined;
  }
}

export interface SourceNamespaceVariableDefinition
  extends NamespaceVariableDefinition {
  namespace: SourceNamespace;
  declaration: NamespaceVariableStatement | null;
  initializer: Expression | null;
  explicitlyTyped: boolean;
  generated?: boolean;
}

export function isSourceNamespaceVariableDefinition(
  definition: unknown,
): definition is SourceNamespaceVariableDefinition {
  return (
    definition instanceof Object &&
    "namespace" in definition &&
    "declaration" in definition &&
    "initializer" in definition
  );
}

export type SourceNamespaceSchema =
  | SourceNamespaceValueSchema
  | SourceNamespaceFunctionSchema
  | SourceNamespaceShapeSchema;

export interface SourceNamespaceValueSchema {
  kind: "value";
  type: Type;
  declaration: NamespaceSchemaStatement | NamespaceSchemaFieldStatement;
}

export interface SourceNamespaceFunctionSchema {
  kind: "function";
  definition: FunctionDefinition;
  declaration:
    | NamespaceSchemaStatement
    | NamespaceSchemaFieldStatement
    | NamespaceSchemaFunctionStatement;
  /** When set, this schema specifically requires Process declarations. */
  processOnly?: boolean;
  /** Top-level function schemas accept functions and processes. */
  allowEitherKind?: boolean;
}

export interface SourceNamespaceShapeSchema {
  kind: "shape";
  fields: Map<string, SourceNamespaceShapeField>;
  prototype: SourceNamespace;
  declaration: NamespaceSchemaStatement | NamespaceSchemaFieldStatement;
}

export type SourceNamespaceShapeField =
  | SourceNamespaceValueShapeField
  | SourceNamespaceFunctionShapeField
  | SourceNamespaceNestedShapeField;

export interface SourceNamespaceShapeFieldBase {
  name: string;
  optional: boolean;
  defaultValue: Expression | null;
  declaration: NamespaceSchemaFieldStatement | NamespaceSchemaFunctionStatement;
}

export interface SourceNamespaceValueShapeField
  extends SourceNamespaceShapeFieldBase {
  kind: "value";
  type: Type;
}

export interface SourceNamespaceFunctionShapeField
  extends SourceNamespaceShapeFieldBase {
  kind: "function";
  definition: FunctionDefinition;
  processOnly?: boolean;
}

export interface SourceNamespaceNestedShapeField
  extends SourceNamespaceShapeFieldBase {
  kind: "namespace";
  targetPath: readonly string[] | null;
  target: SourceNamespace | null;
  /** Inline `namespace { ... }` schema, when this is not a named reference. */
  shape: SourceNamespaceShapeSchema | null;
}

/**
 * `null` means every immediate dictionary member is a function selector.
 * A non-null set identifies the selector-valued fields of a namespace shape;
 * all remaining dictionary members contain names of global value variables.
 */
export function getSourceNamespaceRuntimeFunctionMembers(
  namespace: SourceNamespace,
): Set<string> | null {
  if (namespace.schema?.kind == "function") return null;

  let shape = namespace.effectiveSchema?.kind == "shape"
    ? namespace.effectiveSchema
    : namespace.runtimeShape;
  if (shape == null) return new Set();

  return new Set(
    [...shape.fields.values()]
      .filter((field) => field.kind == "function")
      .map((field) => field.name),
  );
}
