import assert from 'assert';
import { Ast, Type } from 'thingtalk';
import { 
    BgpPattern,
    Expression,
    Grouping,
    FilterPattern,
    UnionPattern,
    Variable,
    Wildcard,
    Ordering
} from 'sparqljs';
import {
    isVariable,
    isBasicGraphPattern
} from '../../utils/sparqljs-typeguard';
import {
    PROPERTY_PREFIX
} from '../../utils/wikidata';
import {
    elemType
} from '../../utils/thingtalk';
import {
    ArrayCollection
} from '../../utils/misc';
import { parseSpecialUnion } from '../../utils/sparqljs';
import TripleParser from './triple';
import FilterParser from './filter';
import ValueConverter from './value';
import GroupParser from './group';
import {
    Table
} from '../sparql2thingtalk';
import SPARQLToThingTalkConverter from '../sparql2thingtalk';

export default class ConverterHelper {
    private _converter : SPARQLToThingTalkConverter;
    private _triple : TripleParser;
    private _filter : FilterParser;
    private _value : ValueConverter;
    private _group : GroupParser;

    constructor(converter : SPARQLToThingTalkConverter) {
        this._converter = converter;
        this._triple = new TripleParser(converter);
        this._filter = new FilterParser(converter);
        this._value = new ValueConverter(converter);
        this._group = new GroupParser(converter);
    }

    async convertValue(value : any, type : Type) {
        return this._value.toThingTalkValue(value, type);
    }

    async parseGroup(having : Expression, group : Grouping) {
        return this._group.parse(having, group);
    }

    async parseTriples(clause : BgpPattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        return this._triple.parse(clause);
    }

    async parseFilter(clause : FilterPattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        return this._filter.parse(clause);
    }

    async parseUnion(clause : UnionPattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        const triple = parseSpecialUnion(clause);
        if (triple) 
            return this.parseTriples({ type: 'bgp', triples: [triple] });
        
        const results : Array<ArrayCollection<Ast.BooleanExpression>> = [];
        for (const pattern of clause.patterns) {
            assert(isBasicGraphPattern(pattern));
            results.push(await this.parseTriples(pattern));
        }
        let existedSubject : string|null = null;
        const operands : Ast.BooleanExpression[] = [];
        for (const filtersBySubject of results) {
            if (filtersBySubject.size > 1)
                throw new Error('Unsupported: multiple subjects in a union');
            const subject = filtersBySubject.keys[0];
            const filters = filtersBySubject.get(subject);
            assert(filters.length > 0);
            const filter = filters.length === 1 ? filters[0] : new Ast.AndBooleanExpression(null, filters);
            if (!existedSubject)
                existedSubject = subject;
            else if (subject !== existedSubject)
                throw new Error('Unsupported: multiple subjects in a union');
            operands.push(filter);
        }
        return new ArrayCollection(existedSubject!, new Ast.OrBooleanExpression(null, operands));
    }

    async makeAtomBooleanExpression(property : string, 
                                    value : any, 
                                    operator ?: string, 
                                    valueType ?: Type) : Promise<Ast.AtomBooleanExpression> {
        let propertyLabel, propertyType;
        if (property === 'id') {
            propertyLabel = property;
            propertyType = valueType!;
        } else {
            if (property.startsWith(PROPERTY_PREFIX)) {
                property = property.slice(PROPERTY_PREFIX.length);
                propertyLabel = this._converter.schema.getProperty(property);
            } else {
                propertyLabel = property;
            }
            propertyType = this._converter.schema.getPropertyType(propertyLabel);
        }
        if (operator === '>' || operator === '<') 
            operator = operator + '=';
        if (valueType === Type.String) 
            operator = propertyType instanceof Type.Array ? 'contains~' : '=~';
        return new Ast.AtomBooleanExpression(
            null,
            propertyLabel,
            operator ?? (propertyType instanceof Type.Array ? 'contains' : '=='),
            await this._value.toThingTalkValue(value, valueType ?? elemType(propertyType)),
            null
        );
    }

    addFilters(base : Ast.Expression, filters : Ast.BooleanExpression[]) : Ast.Expression {
        if (filters.length === 0)
            return base;
        const filter = filters.length > 1 ? new Ast.AndBooleanExpression(null, filters) : filters[0];
        return new Ast.FilterExpression(null, base, filter, null);
        
    }

    addProjections(base : Ast.Expression, projections : Array<string|Ast.PropertyPathSequence>) {
        if ((projections.length === 1 && projections[0] === 'id') || projections.length === 0) {
            return base; 
        } else {
            return new Ast.ProjectionExpression2(
                null, 
                base, 
                projections.map((p) => new Ast.ProjectionElement(p, null, [])), 
                null
            );
        }
    }

    addOrdering(base : Ast.Expression, table : Table, ordering ?: Ordering[]) : Ast.Expression {
        if (!ordering || ordering.length === 0)
            return base;
        if (ordering.length > 1)
            throw new Error('Unsupported: ordering on multiple varialbles');
        
        const order = ordering[0];
        const expression = order.expression;
        assert(isVariable(expression));
        const projection = table.projections.find((proj) => proj.variable === expression.value);
        if (!projection)
            throw new Error('Failed to find the variable for sorting');
        if (typeof projection.property !== 'string')
            throw new Error('Unsupported: sort on property path');
        const property = new Ast.Value.VarRef(projection.property);
        const direction = order.descending ? 'desc' : 'asc';
        return new Ast.SortExpression(null, base, property, direction, null);
    }

    addLimit(base : Ast.Expression, limit ?: number) : Ast.Expression {
        if (limit)
            return  new Ast.IndexExpression(null, base, [new Ast.Value.Number(limit)], null);
        return base;
    }

    addVerification(base : Ast.Expression, filters : Ast.BooleanExpression[]) : Ast.Expression {
        let idFilter : Ast.AtomBooleanExpression|null = null;
        const operands = [];
        for (const filter of filters) {
            if (filter instanceof Ast.AtomBooleanExpression && filter.name === 'id')
                idFilter = filter;
            else 
                operands.push(filter);
        }
        if (idFilter)
            base = new Ast.FilterExpression(null, base, idFilter, null);
        const verification = operands.length > 1 ? new Ast.AndBooleanExpression(null, operands) : operands[0];
        return new Ast.BooleanQuestionExpression(null, base, verification, null);
    }

    parseVariables(variables : Variable[]|[Wildcard]) : ArrayCollection<string|Ast.PropertyPathSequence> {
        const projectionsBySubject = new ArrayCollection<string|Ast.PropertyPathSequence>();
        for (const variable of variables) {
            assert(isVariable(variable));
            for (const [subject, table] of Object.entries(this._converter.tables)) {
                if (subject === variable.value) 
                    projectionsBySubject.add(subject, 'id');
                for (const projection of table.projections) {
                    if (projection.variable === variable.value)
                        projectionsBySubject.add(subject, projection.property);
                }
            }
        }
        return projectionsBySubject;
    }
}