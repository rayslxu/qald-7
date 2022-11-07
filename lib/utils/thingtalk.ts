import assert from 'assert';
import { I18n } from 'genie-toolkit';
import { Ast, Type } from 'thingtalk';
import { TP_DEVICE_NAME } from './wikidata';

const tokenizer = new I18n.LanguagePack('en').getTokenizer();

export function idArgument(entityType : string) : Ast.ArgumentDef {
    return new Ast.ArgumentDef(
        null,
        Ast.ArgDirection.OUT,
        'id', 
        new Type.Entity(`${TP_DEVICE_NAME}:${entityType}`),
        { 
            nl: { canonical: { base: ['name'], passive_verb: ['named', 'called'] } },
            impl: {  
                projectable: new Ast.Value.Boolean(false), 
                nullable: new Ast.Value.Boolean(false)
            }
        }
    );
}

export function instanceOfArgument(entityType : string) : Ast.ArgumentDef {
    return new Ast.ArgumentDef(
        null,
        Ast.ArgDirection.OUT,
        'instance_of',
        new Type.Entity(`${TP_DEVICE_NAME}:${entityType}_subdomain`),
        { 
            nl: { canonical: { reverse_property: ['#'] } },
            impl: { 
                wikidata_id: new Ast.Value.String('P31'), 
                projectable: new Ast.Value.Boolean(false), 
                nullable: new Ast.Value.Boolean(false)
            }
        }
    );
}

// return a property just for representation, it won't get synthesized 
export function fakeProperty(qid : string, pname : string) : Ast.ArgumentDef {
    return new Ast.ArgumentDef(
        null,
        Ast.ArgDirection.OUT,
        pname,
        new Type.Array(new Type.Entity(`${TP_DEVICE_NAME}:entity`)),
        {
            impl: {
                wikidata_id: new Ast.Value.String(qid),
                projectable: new Ast.Value.Boolean(false), 
                filterable: new Ast.Value.Boolean(false), 
                nullable: new Ast.Value.Boolean(false)
            }
        }

    );
}

export function instanceOfFilter(domain : string, domainLabel : string|null, type : string, humanReadable = false) : Ast.BooleanExpression {
    assert(!(humanReadable && !domainLabel));
    const name = domainLabel ? tokenizer.tokenize(domainLabel).rawTokens.join(' ') : null;
    const value = humanReadable ? new Ast.Value.Entity(name, type, domainLabel) : new Ast.Value.Entity(domain, type, domainLabel);
    return new Ast.AtomBooleanExpression(
        null,
        'instance_of',
        '==',
        value,
        null
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
        new Ast.Invocation(null, new Ast.DeviceSelector(null, TP_DEVICE_NAME, null, null), domain, [], null),
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


/**
 * Given a filter return the properties used for the table
 * @param filter a filter
 */
export function getPropertiesInFilter(filter : Ast.BooleanExpression) : string[] {
    const properties = [];
    if (filter instanceof Ast.AtomBooleanExpression)
        properties.push(filter.name);
    else if (filter instanceof Ast.AndBooleanExpression || filter instanceof Ast.OrBooleanExpression)
        properties.push(...filter.operands.map(getPropertiesInFilter).flat());
    else if (filter instanceof Ast.NotBooleanExpression)
        properties.push(...getPropertiesInFilter(filter.expr));
    else if (filter instanceof Ast.PropertyPathBooleanExpression) 
        properties.push(filter.path[0].property);
    else if (filter instanceof Ast.ComparisonSubqueryBooleanExpression)
        properties.push((filter.lhs as Ast.VarRefValue).name);
    return properties;
}


export function mergeCanonicalAnnotations(a1 : Record<string, any>, a2 : Record<string, any>) {
    for (const [key, value] of Object.entries(a2)) {
        if (!(key in a1)) {
            a1[key] = value;
        } else {
            if (key === 'default')
                continue;
            assert(Array.isArray(a1[key]) && Array.isArray(a2[key]));
            a1[key] = [...a1[key], ...a2[key]];
        }
    } 
}