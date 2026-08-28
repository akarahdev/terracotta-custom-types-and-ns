import {
  AtomicExpression,
  CallExpression,
  CallOrStartExpression,
  Expression,
} from "../../ast/expression.ts";
import { DFCodeblockName } from "../../df/constants.ts";
import { NamespaceTypeData, Type } from "../../typeProcessor/type.ts";
import { expressionizeIfBlock } from "../../util/utils.ts";
import {
  ActionBlock,
  BracketBlock,
  BracketDirection,
  BracketType,
  CodeBlock,
} from "../codeBlock.ts";
import {
  CodeValue,
  EmptyValue,
  RuntimeNamespaceValue,
  StringValue,
  TangibleValue,
} from "../codeValue.ts";
import { EvaluationContext } from "../codeCompiler.ts";
import {
  ConditionDefinition,
  DefinitionType,
  FunctionCallExtraInfo,
  FunctionDefinition,
} from "./definition.ts";
import { Namespace } from "./namespace.ts";
import { SourceNamespace } from "./sourceNamespace.ts";

type SchemaNamespaceArgument = {
  value: RuntimeNamespaceValue;
  namespace: SourceNamespace;
};

function getSchemaNamespaceArgument(
  args: CodeValue[],
  callNode: CallExpression | CallOrStartExpression,
  ctx: EvaluationContext,
): SchemaNamespaceArgument | null {
  let value = ctx.compiler.getRuntimeSourceNamespaceValue(args[0]);
  if (value == null) {
    ctx.reportError(
      callNode,
      "Namespace reflection requires a schema-backed namespace value",
    );
    return null;
  }
  let namespace = value.namespace;
  if (
    !(namespace instanceof SourceNamespace) ||
    !namespace.supportsRuntimeReflection
  ) {
    ctx.reportError(
      callNode,
      "Namespace reflection requires a namespace with a schema",
    );
    return null;
  }
  return { value, namespace };
}

function namespaceValueType(
  args: Expression[],
  types: EvaluationContext["types"],
): Type {
  let argument = args[0];
  if (argument == null) return Type.any;
  let type = types.evaluateExpression(argument);
  if (!type.matches(Type.namespace)) return Type.any;
  let namespace = (type.data as NamespaceTypeData).namespace;
  if (!(namespace instanceof SourceNamespace)) return Type.any;
  return namespace.getDynamicMemberType?.() ?? Type.any;
}

/** Reflection consumes namespace paths at compile time, not as DF action items. */
function validateReflectionArguments(
  args: CodeValue[],
  namedArgs: Map<AtomicExpression, [CodeValue, Expression]>,
  expectedCount: number,
  callNode: CallExpression | CallOrStartExpression,
  ctx: EvaluationContext,
) {
  if (namedArgs.size != 0) {
    ctx.reportError(callNode, "Named arguments are not allowed here");
  }
  if (args.length != expectedCount) {
    ctx.reportError(
      callNode,
      `Expected ${expectedCount} argument${
        expectedCount == 1 ? "" : "s"
      }, got ${args.length}`,
    );
  }
}

const namespaceArgumentSignature = [{
  params: [{
    name: "namespace",
    type: Type.any,
    optional: false,
    plural: false,
  }],
}];

const getKeys: FunctionDefinition = {
  definitionType: DefinitionType.FUNCTION,
  name: "namespace.getKeys",
  signatures: namespaceArgumentSignature,
  defaultReturnType: Type.list(Type.str),
  getReturnType: () => Type.list(Type.str),
  compile(
    args,
    namedArgs,
    ctx,
    callNode,
    extraInfo = {},
  ): [CodeValue, CodeBlock[]] {
    validateReflectionArguments(args, namedArgs, 1, callNode, ctx);
    let namespaceArgument = getSchemaNamespaceArgument(args, callNode, ctx);
    if (namespaceArgument == null) return [new EmptyValue(callNode), []];
    let output = ctx.tvp.newTempVar(Type.list(Type.str));
    let keys = ctx.compiler.createSourceNamespaceKeyListValue(
      namespaceArgument.value,
      callNode,
    );
    return [output, [
      new ActionBlock(DFCodeblockName.SET_VARIABLE, {
        // Assignment intentionally produces a list copy for the caller.
        action: "=",
        args: [output, keys],
      }),
    ]];
  },
};

const getValues: FunctionDefinition = {
  definitionType: DefinitionType.FUNCTION,
  name: "namespace.getValues",
  signatures: namespaceArgumentSignature,
  defaultReturnType: Type.list(Type.any),
  getReturnType(args, types) {
    return Type.list(namespaceValueType(args, types));
  },
  compile(
    args,
    namedArgs,
    ctx,
    callNode,
    extraInfo = {},
  ): [CodeValue, CodeBlock[]] {
    validateReflectionArguments(args, namedArgs, 1, callNode, ctx);
    let namespaceArgument = getSchemaNamespaceArgument(args, callNode, ctx);
    if (namespaceArgument == null) return [new EmptyValue(callNode), []];
    let valueType = namespaceValueType(callNode.args.elements, ctx.types);
    let output = ctx.tvp.newTempVar(Type.list(valueType));
    let key = ctx.tvp.newTempVar(Type.str);
    let keys = ctx.compiler.createSourceNamespaceKeyListValue(
      namespaceArgument.value,
      callNode,
    );
    let [source, sourceCode] = ctx.compiler.compileSourceNamespaceMemberSource(
      namespaceArgument.value,
      key,
      ctx,
    );
    let dereferenced = ctx.compiler.createSourceNamespaceBackingValue(
      source,
      valueType,
      callNode,
    );
    let selector = new StringValue(
      ctx.compiler.createSourceNamespaceFunctionNameFromSource(source),
      callNode,
    );
    let nestedNamespace = ctx.compiler.createSourceNamespacePathValue(
      source,
      callNode,
    );
    return [output, [
      new ActionBlock(DFCodeblockName.SET_VARIABLE, {
        action: "CreateList",
        args: [output],
      }),
      new ActionBlock(DFCodeblockName.REPEAT, {
        action: "ForEach",
        args: [key, keys],
      }),
      new BracketBlock({
        type: BracketType.REPEAT,
        direction: BracketDirection.OPEN,
      }),
      ...sourceCode,
      ...ctx.compiler.compileSourceNamespaceMemberUse(
        namespaceArgument.namespace,
        key,
        ctx,
        [
          new ActionBlock(DFCodeblockName.SET_VARIABLE, {
            action: "AppendValue",
            args: [output, dereferenced],
          }),
        ],
        [
          new ActionBlock(DFCodeblockName.SET_VARIABLE, {
            action: "AppendValue",
            args: [output, selector],
          }),
        ],
        [
          new ActionBlock(DFCodeblockName.SET_VARIABLE, {
            action: "AppendValue",
            args: [output, nestedNamespace],
          }),
        ],
      ),
      new BracketBlock({
        type: BracketType.REPEAT,
        direction: BracketDirection.CLOSE,
      }),
    ]];
  },
};

const hasMember: ConditionDefinition = {
  definitionType: DefinitionType.FUNCTION,
  name: "namespace.has_member",
  signatures: [{
    params: [
      { name: "namespace", type: Type.any, optional: false, plural: false },
      { name: "key", type: Type.str, optional: false, plural: false },
    ],
  }],
  defaultReturnType: Type.num,
  getReturnType: () => Type.num,
  compileIf(
    args,
    namedArgs,
    ctx,
    callNode,
    extraInfo = {},
  ): [CodeValue, CodeBlock[]] {
    validateReflectionArguments(args, namedArgs, 2, callNode, ctx);
    let namespace = getSchemaNamespaceArgument(args, callNode, ctx);
    let key = args[1];
    if (namespace == null || !(key instanceof TangibleValue)) {
      return [new EmptyValue(callNode), []];
    }
    return [new EmptyValue(callNode), [
      new ActionBlock(DFCodeblockName.IF_VARIABLE, {
        action: "ListContains",
        args: [
          ctx.compiler.createSourceNamespaceKeyListValue(
            namespace.value,
            callNode,
          ),
          key,
        ],
      }),
    ]];
  },
  compile(
    args,
    namedArgs,
    ctx,
    callNode,
    extraInfo = {},
  ): [CodeValue, CodeBlock[]] {
    let [_, code] = this.compileIf(args, namedArgs, ctx, callNode, extraInfo);
    return expressionizeIfBlock(code, ctx);
  },
};

/**
 * `namespace` is a real built-in namespace, unlike source namespaces.  It only
 * exposes reflection helpers; calls themselves verify that their argument is a
 * schema-backed source namespace.
 */
export const NAMESPACE_REFLECTION_NAMESPACE = new Namespace("namespace", {
  getKeys,
  getValues,
  has_member: hasMember,
});
