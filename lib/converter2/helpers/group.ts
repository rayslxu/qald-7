import assert from 'assert';
import { Ast } from 'thingtalk';
import { 
    Expression,
    Grouping 
} from 'sparqljs';

import {
    isLiteral,
    isVariable,
    isOperationExpression,
    isAggregateExpression
} from '../../utils/sparqljs-typeguard';
import SPARQLToThingTalkConverter from '../sparql2thingtalk';

export default class GroupConverter {
    private _converter : SPARQLToThingTalkConverter;

    constructor(converter : SPARQLToThingTalkConverter) {
        this._converter = converter;
    }

    private _aggregateFilter(aggregation : string, operands : string[], operator : string, value : number) {
        if (operator === '>' || operator === '<') 
            operator = operator + '=';
        return new Ast.ComputeBooleanExpression(
            null,
            new Ast.ComputationValue(aggregation, operands.map((op) => new Ast.Value.VarRef(op))),
            operator, 
            new Ast.Value.Number(value)
        );
    }

    async convert(having : Expression, group : Grouping)  {
        assert(isVariable(group.expression));
        const subject = group.expression.value;
        if (!(subject in this._converter.tables)) 
            throw new Error('Unsupported group by operation on object');
        if (isOperationExpression(having)) {
            assert(having.args.length === 2);
            const [lhs, rhs] = having.args;
            assert(isAggregateExpression(lhs, 'count') && isVariable(lhs.expression) && !lhs.distinct);
            const variable = lhs.expression.value;
            const projection = this._converter.tables[subject].projections.find((proj) => proj.variable === variable);
            if (!projection)
                throw new Error(`Can't find matching variable for the having clause`);
            if (typeof projection.property !== 'string')
                throw new Error(`Having clause not supported for property path`);
            assert(isLiteral(rhs) && Number(rhs.value));
            this._converter.updateTable(subject, this._aggregateFilter('count', [projection.property], having.operator, parseFloat(rhs.value)));
        } else {
            throw new Error(`Unsupported having clause ${JSON.stringify(having)}`);
        }
    }
}