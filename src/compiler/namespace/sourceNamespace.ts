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
 * Source namespaces use readable, segment-delimited backing names. `@` is not
 * valid in Terracotta identifiers, so static namespace paths remain injective
 * while dynamic segments can be inserted directly as `%var(...)` PCode.
 *
 * These prefixes deliberately remain outside the normal extension pattern:
 * extension methods use `__TC_EXT_<type>_<member>`, whereas namespace members
 * and reflection lists use a literal `@` after their distinct marker.
 */
export const SOURCE_NAMESPACE_MANGLE_PREFIX = "__TC_EXT_NS@";
export const SOURCE_NAMESPACE_KEY_LIST_MANGLE_PREFIX = "__TC_EXT_NK@";
export const SOURCE_NAMESPACE_PATH_DELIMITER = "@";

export function encodeSourceNamespacePath(path: readonly string[]): string {
  return path.join(SOURCE_NAMESPACE_PATH_DELIMITER);
}

export function getSourceNamespaceMemberBackendName(
  path: readonly string[],
  member: string,
): string {
  return `${SOURCE_NAMESPACE_MANGLE_PREFIX}${
    encodeSourceNamespacePath([
      ...path,
      member,
    ])
  }`;
}

export function getSourceNamespaceKeyListBackendName(
  path: readonly string[],
): string {
  return `${SOURCE_NAMESPACE_KEY_LIST_MANGLE_PREFIX}${
    encodeSourceNamespacePath(
      path,
    )
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
  /** Runtime member type used by `Type.namespace(...).getRuntimeType()`. */
  runtimeType: Type | null = null;
  /**
   * The shape represented by a runtime namespace value.  Shape prototypes
   * and concrete conformers both use this to distinguish function selectors
   * from value sources during reflection and iteration.
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

  get keyListBackendName(): string {
    return getSourceNamespaceKeyListBackendName(this.path);
  }

  get runtimeBacked(): boolean {
    return this.schema != null || this.effectiveSchema != null;
  }

  /**
   * Shape prototypes represent values returned by dynamic namespace access.
   * They do not own a concrete source path, but their configured runtime type
   * still supports key-list reflection and iteration.
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
 * `null` means every immediate member is a function selector.
 * A non-null set identifies the selector-valued fields of a namespace shape;
 * all remaining members resolve through their backing global-variable name.
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

/**
 * `null` means every immediate member is a nested namespace source. A
 * non-null set identifies nested namespace fields in a mixed shape; remaining
 * non-function fields are ordinary backing variables.
 */
export function getSourceNamespaceRuntimeNestedMembers(
  namespace: SourceNamespace,
): Set<string> | null {
  if (namespace.effectiveSchema == null && namespace.schema?.kind == "shape") {
    return null;
  }

  let shape = namespace.effectiveSchema?.kind == "shape"
    ? namespace.effectiveSchema
    : namespace.runtimeShape;
  if (shape == null) return new Set();

  return new Set(
    [...shape.fields.values()]
      .filter((field) => field.kind == "namespace")
      .map((field) => field.name),
  );
}
