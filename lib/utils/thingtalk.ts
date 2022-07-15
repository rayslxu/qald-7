import assert from 'assert';
import { Ast, Type } from 'thingtalk';

export function idArgument(entityType : string) : Ast.ArgumentDef {
    return new Ast.ArgumentDef(
        null,
        Ast.ArgDirection.OUT,
        'id', 
        new Type.Entity(`org.wikidata:${entityType}`),
        { nl: { canonical: { base: ['name'], passive_verb: ['named', 'called'] } } }
    );
}

export function isIdFilter(filter : Ast.BooleanExpression) : boolean {
    return filter instanceof Ast.AtomBooleanExpression && filter.name === 'id' && filter.operator === '==';
}

/**
 * A shortcut for quickly creating a basic query
 * @param domain the name of a domain
 * @return an invocation of a base domain query (no projection, no filter)
 */
export function baseQuery(domain : string) {
    return new Ast.InvocationExpression(
        null,
        new Ast.Invocation(null, new Ast.DeviceSelector(null, 'org.wikidata', null, null), domain, [], null),
        null
    );
}

/**
 * A shortcut for creating a program from an query expression
 * @param expression a ThingTalk query expression
 * @returns a ThingTalk program 
 */
export function makeProgram(expression : Ast.Expression) {
    if (!(expression instanceof Ast.ChainExpression))
        expression = new Ast.ChainExpression(null, [expression], expression.schema);
    return new Ast.Program(null, [], [], [new Ast.ExpressionStatement(null, expression)]);
}

/**
 * A shortcut for creating a program with a subquery
 * @param main the main query
 * @param subquery the subquery
 * @returns a ThingTalk program
 */
export function makeSubqueryProgram(main : Ast.Expression, subquery : Ast.BooleanExpression) {
    type ParentExpression  = Ast.ProjectionExpression|Ast.SortExpression|Ast.IndexExpression|Ast.BooleanQuestionExpression|Ast.AggregationExpression;
    let filterTable = main;
    let parent : ParentExpression|undefined;
    while (!(filterTable instanceof Ast.FilterExpression || filterTable instanceof Ast.InvocationExpression)) {
        parent = (filterTable as ParentExpression);
        filterTable = parent.expression;
    }
    if (filterTable instanceof Ast.FilterExpression)
        filterTable.filter = new Ast.AndBooleanExpression(null, [filterTable.filter, subquery]);
    else if (parent)
        parent.expression = new Ast.FilterExpression(null, filterTable, subquery, null);
    else
        main = new Ast.FilterExpression(null, filterTable, subquery, null);
    return new Ast.Program(null, [], [], [new Ast.ExpressionStatement(null, main)]);
}

/**
 * A shortcut for creating a program with subquery verification
 * @param main the main query
 * @param subqueries the boolean expressions to verify
 */
export function makeSubqueryVerificationProgram(main : Ast.Expression, subqueries : Ast.BooleanExpression[]) {
    assert(subqueries.length > 0);
    const verification = subqueries.length === 1 ? subqueries[0] : new Ast.AndBooleanExpression(null, subqueries);
    const expression = new Ast.BooleanQuestionExpression(null, main, verification, null);
    return new Ast.Program(null, [], [], [new Ast.ExpressionStatement(null, expression)]);
}

/**
 * Get the element type of a ThingTalk type
 * @param type a ThingTalk type
 * @param resolveCompound if true, return the `value` field type, otherwise, return the compound type
 */
export function elemType(type : Type, resolveCompound = true) : Type {
    if (type instanceof Type.Array)
        return elemType(type.elem as Type, resolveCompound);
    if (resolveCompound && type instanceof Type.Compound)
        return elemType(type.fields.value.type, resolveCompound);
    return type;
}