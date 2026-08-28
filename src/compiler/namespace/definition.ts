import { ASTNode } from "../../ast/astNode.ts";
import {
  AtomicExpression,
  CallExpression,
  CallOrStartExpression,
  Expression,
} from "../../ast/expression.ts";
import { FunctionStatement } from "../../ast/statement.ts";
import { Action, GameValue, Tag } from "../../df/actiondump.ts";
import { Type } from "../../typeProcessor/type.ts";
import { TypeProcessor } from "../../typeProcessor/typeProcessor.ts";
import { CodeBlock } from "../codeBlock.ts";
import { EvaluationContext } from "../codeCompiler.ts";
import { CodeValue, TangibleValue } from "../codeValue.ts";
import { PCode } from "../../pcode/pcode.ts";

export enum DefinitionType {
  FUNCTION,
  VALUE,
  PROPERTY,
  /** A compiler-defined global variable exposed as a member of a source namespace. */
  NAMESPACE_VARIABLE,
}

export type Definition =
  | FunctionDefinition
  | ValueDefinition
  | PropertyDefinition
  | NamespaceVariableDefinition;

export interface ParameterSignatureEntry {
  type: Type;
  name: string;
  optional: boolean;
  plural: boolean;
  description?: string;
}

export interface ParameterSignature {
  params: ParameterSignatureEntry[];
  name?: string;
  disallowSkips?: boolean;
}

export interface FunctionCallExtraInfo {
  /** If present, insert this value at the start of the arguments list */
  methodCallOf?: TangibleValue;
  /** Fully composed backing name for a schema-backed namespace function. */
  runtimeNamespaceAccess?: {
    name: PCode[];
  };
}

export interface FunctionDefinition {
  definitionType: DefinitionType.FUNCTION;
  name: string;
  description?: string;
  signatures: ParameterSignature[];

  /**
   * If set to true, return value vars should be added to the end of the args list as opposed to the start
   */
  returnVarsAtEnd?: boolean;
  defaultReturnType: Type;
  getReturnType: (
    args: Expression[],
    types: TypeProcessor,
    methodCallOf?: Type,
  ) => Type;

  /**
   * If true, indicates that this named args should NOT be compiled into code values prior to
   * calling def.compile() as this function handles that itself
   *
   * If true, EmptyValue should be passed in for every CodeValue entry in the namedArgs map
   */
  manuallyCompilesNamedArgs?: boolean;
  /** This function definition is dispatched through a runtime namespace source path. */
  runtimeNamespaceFunction?: boolean;
  /**
   * Valid invocation syntax for a dynamically-resolved schema function.
   * Ordinary calls use Function; `start` uses Process.
   */
  runtimeNamespaceCallKind?: "function" | "process" | "either";
  compile(
    args: CodeValue[],
    namedArgs: Map<AtomicExpression, [CodeValue, Expression]>,
    ctx: EvaluationContext,
    callNode: CallExpression | CallOrStartExpression,
    extraInfo?: FunctionCallExtraInfo,
  ): [CodeValue, CodeBlock[]];

  /** Is only used for language server purposes, the compiler should never touch this */
  action?: Action;

  // language server specific stuff
  astNode?: FunctionStatement;
  autocompleteSortPrefix?: string;
}

/**
 * Normal compile() is what will be used in expressions and will output a number.
 * To get the raw if block, use compileIf()
 */
export interface ConditionDefinition extends FunctionDefinition {
  /** Will always be Type.num */
  defaultReturnType: Type;
  /** Should always return an EmptyValue */
  compileIf(
    args: CodeValue[],
    namedArgs: Map<AtomicExpression, [CodeValue, Expression]>,
    ctx: EvaluationContext,
    callNode: CallExpression | CallOrStartExpression,
    extraInfo?: FunctionCallExtraInfo,
  ): [CodeValue, CodeBlock[]];
}

export interface ValueDefinition {
  definitionType: DefinitionType.VALUE;
  returnType: Type;
  /** Is only used for language server purposes, the compiler should never touch this */
  gameValue?: GameValue;
  compile(ctx: EvaluationContext): [CodeValue, CodeBlock[]];
}

export interface PropertyDefinition {
  definitionType: DefinitionType.PROPERTY;
  type: Type;
  /**
   * If true, this property is only available on values whose type
   * matches with this namespace; the property will NOT be available
   * on the namespace itself.
   */
  valueExclusive?: boolean;
  compileGet(
    ctx: EvaluationContext,
    propertyOf: CodeValue,
  ): [CodeValue, CodeBlock[]];
  compileSet(
    newValue: TangibleValue,
    ctx: EvaluationContext,
    propertyOf: CodeValue,
  ): CodeBlock[];

  // language server specific stuff
  autocompleteSortPrefix?: string;
}

/**
 * Namespace variables behave like ordinary values when read, but also need a
 * dedicated setter when reached through a qualified namespace access.
 */
export interface NamespaceVariableDefinition {
  definitionType: DefinitionType.NAMESPACE_VARIABLE;
  name: string;
  returnType: Type;
  compile(ctx: EvaluationContext): [TangibleValue, CodeBlock[]];
  compileSet(newValue: TangibleValue, ctx: EvaluationContext): CodeBlock[];

  // language-server metadata
  astNode?: ASTNode;
}

export function isFunctionDefinition(obj): obj is FunctionDefinition {
  return (
    obj instanceof Object &&
    obj.definitionType == DefinitionType.FUNCTION
  );
}

export function isValueDefinition(obj): obj is ValueDefinition {
  return (
    obj instanceof Object &&
    obj.definitionType == DefinitionType.VALUE
  );
}

export function isPropertyDefinition(obj): obj is PropertyDefinition {
  return (
    obj instanceof Object &&
    obj.definitionType == DefinitionType.PROPERTY
  );
}

export function isNamespaceVariableDefinition(
  obj,
): obj is NamespaceVariableDefinition {
  return (
    obj instanceof Object &&
    obj.definitionType == DefinitionType.NAMESPACE_VARIABLE
  );
}

export function USE_DEFAULT_RETURN_TYPE(
  this: FunctionDefinition,
  args: Expression[],
  types: TypeProcessor,
) {
  return this.defaultReturnType;
}
