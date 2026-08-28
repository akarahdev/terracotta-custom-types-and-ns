import { HeaderType } from "../compiler/codeCompiler.ts";
import { DFCodeblockName } from "../df/constants.ts";
import { ASTNode } from "./astNode.ts";
import { CommentHolder } from "./documenter.ts";
import { ChunkExpression, Expression, GroupExpression, ListExpression, MissingExpression, MultiTypeAssignmentExpression, ParameterExpression, TypeAssignmentExpression, TypeExpression, VariableExpression } from "./expression.ts";
import { Token, TokenType } from "./token.ts";

export class Statement extends ASTNode implements CommentHolder {
    attachedComments: Token[] = [];
    /** Will only be set for statements that declare code lines (e.g. player event or function) */
    headerType: HeaderType | null = null;

    constructor(
        startPos: number, endPos: number,
    ) {super(startPos, endPos);}

    toString(): string {
        return this.constructor.name;
    }
}

export class ExpressionStatement extends Statement {
    constructor(
        public expression: Expression
    ) {
        super(expression.startPos,expression.endPos);
    }
}

/** NOTE: all comments that would be attached to this statement will instead be passed to its subStatement */
export class DeclareStatement extends Statement {
    constructor(
        public keyword: Token,
        public subStatement: ExpressionStatement | AssignmentStatement | IncrementStatement
    ) {super(keyword.startPos, subStatement.endPos);}
}

export class IncrementStatement extends Statement {
    constructor(
        public target: Expression,
        /** either a PLUS_PLUS or MINUS_MINUS token */
        public operator: Token,
    ) {super(target.startPos, operator.endPos);}
}

export class AssignmentStatement extends Statement {
    constructor(
        public leftValues: Expression[],
        public leftValueCommas: Token[],
        public operator?: Token,
        public rightValue?: Expression,
    ) {
        super(
            leftValues[0]?.startPos ??
            leftValueCommas[0].startPos ??
            operator!.startPos
            ,
            rightValue?.endPos ??
            operator?.endPos ??
            leftValues[leftValues.length-1]?.endPos ??
            leftValueCommas[leftValueCommas.length-1]?.endPos
        )
    }

    isErrorFree(): 
        this is AssignmentStatement&{
            leftValues: [Expression, ...Expression[]],
            operator: Token,
            rightValue: Expression,
        }
    {
        return (
            this.leftValues.length > 0
            && this.operator != undefined
            && this.rightValue != undefined
        )
    }
}

export class EventStatement extends Statement {
    override headerType: HeaderType;

    constructor(
        public modifiers: Token[],
        public type: Token,
        public eventName: Token,
        public chunk: ChunkExpression | MissingExpression
    ) {
        super(modifiers.length > 0 ? modifiers[0].startPos : type.startPos, chunk.endPos);
        this.headerType = DFCodeblockName[TokenType[type.type]];
    }
}

/** Also used for processes */
export class FunctionStatement extends Statement {
    override headerType: HeaderType;
    public backendName: string | null = null;

    constructor(
        public keyword: Token,
        public name: Token,
        public params: ListExpression<ParameterExpression> | null,
        public returnType: MultiTypeAssignmentExpression | null,
        public chunk: ChunkExpression | MissingExpression,
    ) {
        super(keyword.startPos, chunk.endPos);
        this.headerType = keyword.type == TokenType.FUNCTION ? DFCodeblockName.FUNCTION : DFCodeblockName.PROCESS;
    }
}

export class TypeStatement extends Statement {
    constructor(
        public keyword: Token,
        public name: Token,
        public assignedType: TypeAssignmentExpression,
    ) {super(keyword.startPos, assignedType.endPos);}
}

export class ExtendStatement extends Statement {
    constructor(
        public keyword: Token,
        public type: TypeExpression,
        public chunk: ChunkExpression | MissingExpression,
    ) {super(keyword.startPos, chunk.endPos);}
}

/** A compile-time namespace declaration. Its path is relative when nested in another namespace. */
export class NamespaceStatement extends Statement {
    constructor(
        public keyword: Token,
        public path: Token[],
        public dots: Token[],
        public chunk: ChunkExpression | MissingExpression,
    ) {
        super(keyword.startPos, chunk.endPos);
    }
}

/** A namespace variable declaration. Namespace variables deliberately have no source-level scope keyword. */
export class NamespaceVariableStatement extends Statement {
    constructor(
        public name: Token,
        public assignedType: TypeAssignmentExpression | null,
        public assignmentOperator: Token | null,
        public initialValue: Expression | null,
    ) {
        super(
            name.startPos,
            initialValue?.endPos ?? assignmentOperator?.endPos ?? assignedType?.endPos ?? name.endPos,
        );
    }
}

export type NamespaceSchemaTypeExpression =
    | TypeExpression
    | FunctionSchemaTypeExpression
    | NamespaceSchemaReferenceExpression
    | NamespaceShapeSchemaExpression;

/** `schema: ...;` within a namespace declaration. */
export class NamespaceSchemaStatement extends Statement {
    constructor(
        public name: Token,
        public colon: Token,
        public schemaType: NamespaceSchemaTypeExpression,
        public semicolon: Token,
    ) {
        super(name.startPos, semicolon.endPos);
    }
}

/** `function (arg: type) -> type` used by function schemas. */
export class FunctionSchemaTypeExpression extends ASTNode {
    constructor(
        public keyword: Token,
        public params: ListExpression<ParameterExpression> | null,
        public arrow: Token,
        public returnType: TypeExpression,
    ) {
        super(keyword.startPos, returnType.endPos);
    }
}

/** `namespace some.path` as a member type inside a namespace-shape schema. */
export class NamespaceSchemaReferenceExpression extends ASTNode {
    constructor(
        public keyword: Token,
        public path: Token[],
        public dots: Token[],
    ) {
        super(keyword.startPos, path[path.length - 1]?.endPos ?? keyword.endPos);
    }
}

/** A field declared inside `schema: namespace { ... }`. */
export class NamespaceSchemaFieldStatement extends Statement {
    constructor(
        public name: Token,
        public optionalMarker: Token | null,
        public colon: Token,
        public schemaType: NamespaceSchemaTypeExpression,
        public assignmentOperator: Token | null,
        public defaultValue: Expression | null,
        public semicolon: Token,
    ) {
        super(name.startPos, semicolon.endPos);
    }
}

/** A function or process signature declared inside `schema: namespace { ... }`. */
export class NamespaceSchemaFunctionStatement extends Statement {
    constructor(
        public keyword: Token,
        public name: Token,
        public params: ListExpression<ParameterExpression> | null,
        public arrow: Token,
        public returnType: TypeExpression,
        public semicolon: Token,
    ) {
        super(keyword.startPos, semicolon.endPos);
    }
}

/** `namespace { ... }` used as the value of a schema declaration. */
export class NamespaceShapeSchemaExpression extends ASTNode {
    constructor(
        public keyword: Token,
        public opener: Token,
        public members: (NamespaceSchemaFieldStatement | NamespaceSchemaFunctionStatement)[],
        public closer: Token,
    ) {
        super(keyword.startPos, closer.endPos);
    }
}

/** Imports either a namespace path or one member from a namespace. */
export class ImportStatement extends Statement {
    constructor(
        public keyword: Token,
        public path: Token[],
        public dots: Token[],
        public asKeyword: Token | null,
        public alias: Token | null,
        public semicolon: Token,
    ) {
        super(keyword.startPos, semicolon.endPos);
    }
}

export class RepeatStatement extends Statement {
    constructor(
        public keyword: Token,
        public countExpression: GroupExpression | null,
        public chunk: ChunkExpression | null,
    ) {super(keyword.startPos, chunk?.endPos ?? countExpression?.endPos ?? keyword.endPos);}
}

export class ForStatement extends Statement {
    constructor(
        public keyword: Token,
        public opener: Token,
        public variableList: ListExpression,
        public iteratorExpression: Expression | null,
        public closer: Token,
        public chunk: ChunkExpression | null,
    ) {
        super(
            keyword.startPos,
            chunk?.endPos ?? (closer.type == TokenType.MISSING ? null : closer.endPos) ?? iteratorExpression?.endPos ?? variableList.endPos
        );
    }
}

export class IfStatement extends Statement {
    constructor(
        public keyword: Token,
        public inverterToken: Token | null,
        public condition: GroupExpression,
        public chunk: ChunkExpression | null,
        public elseKeyword: Token | null = null,
        public elseContents: IfStatement | ChunkExpression | null = null,
    ) {super(keyword.startPos, elseContents ? elseContents.endPos : chunk ? chunk.endPos : condition.endPos);}
}

export class WhileStatement extends Statement {
    constructor(
        public keyword: Token,
        public inverterToken: Token | null,
        public condition: GroupExpression,
        public chunk: ChunkExpression | null,
    ) {super(keyword.startPos, chunk?.endPos ?? condition.endPos);}
}

export class DoStatement extends Statement {
    constructor(
        public doKeyword: Token,
        public chunk: ChunkExpression,
        public whileKeyword: Token | null = null,
        public whileInverterToken: Token | null = null,
        public whileCondition: Expression | null = null,
    ) {super(doKeyword.startPos, whileCondition?.endPos ?? whileInverterToken?.endPos ?? chunk.endPos);}
}

export class PerSelectedStatement extends Statement {
    constructor(
        public keyword: Token,
        public chunk: ChunkExpression,
    ) {super(keyword.startPos, chunk.endPos);}
}

export class SingleKeywordStatement extends Statement {
    constructor(
        public keyword: Token,
    ) {super(keyword.startPos, keyword.endPos);}
}

export class ReturnStatement extends Statement {
    constructor(
        public keyword: Token,
        public values: Expression[],
    ) {super(keyword.startPos, values.length > 0 ? values[values.length-1].endPos : keyword.endPos);}
}
