import assert from 'assert';
import { Ast, Type } from 'thingtalk';
import { Expression, FilterPattern, OperationExpression } from 'sparqljs';
import {
    isVariable,
    isLiteral
} from '../../utils/sparqljs-typeguard';
import {
    ArrayCollection
} from '../../utils/misc';
import SPARQLToThingTalkConverter from '../sparql2thingtalk';
import { isOperationExpression } from '../../utils/sparqljs-typeguard';

// type 
// (1) basic: a standard thingtalk filter
// (2) qualifier : a qualifier over another filter 
// (3) predicate : a thingtalk filter with qualifier(s)
interface FilterInfo {
    table : string,
    property : string|Ast.PropertyPathSequence|Ast.FilterValue|Ast.ArrayFieldValue,
    type : 'basic'|'qualifier'|'predicate'
}

export default class FilterParser {
    private _converter : SPARQLToThingTalkConverter;

    constructor(converter : SPARQLToThingTalkConverter) {
        this._converter = converter;
    }

    private async _parseFilter(expression : Expression, negate = false) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        if (!isOperationExpression(expression))
            throw new Error(`Unsupported: non-operation type filter: ${expression}`);
        if (expression.operator === '!')
            return this._parseFilter(expression.args[0] as OperationExpression, !negate);
        else if (expression.operator === '||')
            return this._parseOrFilter(expression.args as OperationExpression[]);
        else if (expression.operator === '&&')
            return this._parseAndFilter(expression.args as OperationExpression[]);
        else if (expression.args.length === 1)
            return this._parseUnaryOperation(expression, negate);
        else if (expression.args.length === 2)
            return this._parseBinaryOperation(expression, negate);

        throw new Error(`Unsupported: filters with more than two arguments`);
    }

    private _findProperty(variable : string) : FilterInfo|null {
        for (const [subject, table] of Object.entries(this._converter.tables)) {
            const match = table.projections.find((proj) => proj.variable === variable);
            if (match)
                return { table:subject, property:match.property, type: 'basic' };
        } 
        for (const predicate of this._converter.helper.predicates) {
            if (predicate.value === variable)
                return { table:predicate.table!, property:predicate.property!, type: 'predicate' };
            for (const qualifier of predicate.qualifiers) {
                if (qualifier.value === variable)
                    return { table:predicate.table!, property:`${predicate.property!}.${qualifier.property}`, type: 'qualifier' };
            }
        }
        return null;
    }

    /**
     * Parse a filter expression where the operation is a unary operation
     * @param expression a filter expression
     * @param negate if the filter should be negated 
     */
    private async _parseUnaryOperation(expression : OperationExpression, negate : boolean) {
        const arg = expression.args[0];
        if (expression.operator === 'bound') {
            assert(isVariable(arg));
            const match = this._findProperty(arg.value);
            if (!match)
                throw new Error(`Cannot find projection ${arg.value}`);
            assert(match.type === 'basic');
            let booleanExpression;
            if (typeof match.property === 'string') {
                const propertyType = this._converter.schema.getPropertyType(match.property);
                if (propertyType instanceof Type.Array) {
                    booleanExpression = new Ast.ComputeBooleanExpression(
                        null,
                        new Ast.Value.Computation('count', [new Ast.Value.VarRef(match.property)]),
                        '==',
                        new Ast.Value.Number(0)
                    );
                } else {
                    booleanExpression = new Ast.AtomBooleanExpression(null, match.property, '==', new Ast.Value.Null, null);
                }
            } else if (match.property instanceof Ast.FilterValue || match.property instanceof Ast.ArrayFieldValue) {
                booleanExpression = new Ast.ComputeBooleanExpression(null, match.property, '==', new Ast.Value.Null, null);
            } else {
                booleanExpression = new Ast.PropertyPathBooleanExpression(null, match.property, '==', new Ast.Value.Null, null);
            }
            if (negate)
                booleanExpression = new Ast.NotBooleanExpression(null, booleanExpression);
            return new ArrayCollection<Ast.BooleanExpression>(match.table, booleanExpression);
        }
        throw new Error(`Unsupported operator ${expression.operator}`);
    }


    /**
     * Parse a filter expression where the operation is a binary operation
     * @param expression a filter expression
     * @param negate if the filter should be negated 
     */
    private async _parseBinaryOperation(expression : OperationExpression, negate : boolean) {
        const [lhs, rhs] = expression.args;
        assert(isVariable(lhs));

        let operator = expression.operator;
        if (operator === '>' || operator === '<')
            operator += '=';
        if (isVariable(rhs)) {
            this._converter.addCrossTableComparison({
                lhs: lhs.value,
                operator: operator,
                rhs: rhs.value
            });
            return new ArrayCollection<Ast.BooleanExpression>();
        } else if (isLiteral(rhs)) {
            const filtersBySubject = new ArrayCollection<Ast.BooleanExpression>();
            const match = this._findProperty(lhs.value);
            if (!match)
                throw new Error(`Cannot find projection ${lhs.value}`);
            if (typeof match.property !== 'string')
                throw new Error(`Join on property path not supported`);

            // handle qualifier related filter:
            // do not return it directly, add it the predicates to deal with it later
            if (match.type !== 'basic') {
                if (match.type === 'predicate') {
                    this._converter.helper.updatePredicate({
                        table: match.table,
                        property: match.property,
                        op: operator,
                        value: rhs.value,
                        isVariable: false,
                        qualifiers: []
                    });
                } else if (match.type === 'qualifier') {
                    const [property, qualifier] = match.property.split('.');
                    this._converter.helper.updatePredicate({
                        table: match.table,
                        property,
                        qualifiers: [{
                            property: qualifier,
                            op: operator,
                            value: rhs.value,
                            isVariable: false,
                        }]
                    });
                }
                return filtersBySubject;
            } 

            // handle regular filters 
            let booleanExpression;
            if (match.property.endsWith('Label')) {
                assert(operator === 'regex');
                const property = match.property.slice(0, -'Label'.length);
                const propertyType = this._converter.schema.getPropertyType(property);
                operator = (propertyType instanceof Type.Array) ? 'contains~' : '=~';
                booleanExpression = await this._converter.helper.makeAtomBooleanExpression(property, rhs.value, operator, Type.String);
            } else {
                booleanExpression = await this._converter.helper.makeAtomBooleanExpression(match.property, rhs.value, operator);
            }
            if (negate)
                booleanExpression = new Ast.NotBooleanExpression(null, booleanExpression);
            filtersBySubject.add(match.table, booleanExpression);
            return filtersBySubject;
        } 
        throw new Error(`Unsupported binary operation ${expression.operator} with value ${rhs}`);
    }

    async _parseOrFilter(expressions : OperationExpression[]) {
        const filters = new ArrayCollection<Ast.BooleanExpression>();
        for (const expression of expressions)
            filters.merge(await this._parseFilter(expression));
        const merged = new ArrayCollection<Ast.BooleanExpression>();
        for (const [key, value] of filters.iterate())
            merged.add(key, new Ast.OrBooleanExpression(null, value));
        return merged;
    }

    async _parseAndFilter(expressions : OperationExpression[]) {
        const filters = new ArrayCollection<Ast.BooleanExpression>();
        for (const expression of expressions)
            filters.merge(await this._parseFilter(expression));
        return filters;
    }

    async parse(filter : FilterPattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        const expression = filter.expression;
        return this._parseFilter(expression);
    }
}