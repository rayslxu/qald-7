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
        else if (expression.args.length === 1)
            return this._parseUnaryOperation(expression, negate);
        else if (expression.args.length === 2)
            return this._parseBinaryOperation(expression, negate);

        throw new Error(`Unsupported: filters with more than two arguments`);
    }

    private _findProperty(variable : string) : [string, string|Ast.PropertyPathSequence]|null {
        for (const [subject, table] of Object.entries(this._converter.tables)) {
            const match = table.projections.find((proj) => proj.variable === variable);
            if (match)
                return [subject, match.property];
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
            const [subject, property] = match;
            let booleanExpression;
            if (typeof property === 'string') {
                const propertyType = this._converter.schema.getPropertyType(property);
                if (propertyType instanceof Type.Array) {
                    booleanExpression = new Ast.ComputeBooleanExpression(
                        null,
                        new Ast.Value.Computation('count', [new Ast.Value.VarRef(property)]),
                        '==',
                        new Ast.Value.Number(0)
                    );
                } else {
                    booleanExpression = new Ast.AtomBooleanExpression(null, property, '==', new Ast.Value.Null, null);
                }
            } else {
                booleanExpression = new Ast.PropertyPathBooleanExpression(null, property, '==', new Ast.Value.Null, null);
            }
            if (negate)
                booleanExpression = new Ast.NotBooleanExpression(null, booleanExpression);
            return new ArrayCollection<Ast.BooleanExpression>(subject, booleanExpression);
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
            const [subject, property] = match;
            if (typeof property !== 'string')
                throw new Error(`Join on property path not supported`);

            let booleanExpression;
            if (property.endsWith('Label')) {
                assert(operator === 'regex');
                const prop = property.slice(0, -'Label'.length);
                const propertyType = this._converter.schema.getPropertyType(prop);
                operator = (propertyType instanceof Type.Array) ? 'contains~' : '=~';
                booleanExpression = await this._converter.helper.makeAtomBooleanExpression(prop, rhs.value, operator, Type.String);
            } else {
                booleanExpression = await this._converter.helper.makeAtomBooleanExpression(property, rhs.value, operator);
            }
            if (negate)
                booleanExpression = new Ast.NotBooleanExpression(null, booleanExpression);
            filtersBySubject.add(subject, booleanExpression);
            return filtersBySubject;
        } 
        throw new Error(`Unsupported binary operation ${expression.operator} with value ${rhs}`);
    }

    async parse(filter : FilterPattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        const expression = filter.expression;
        return this._parseFilter(expression);
    }
}