import assert from 'assert';
import { Ast, Type } from 'thingtalk';
import { 
    BgpPattern,
    FilterPattern,
    UnionPattern
} from 'sparqljs';
import {
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
import TripleConverter from './triple';
import FilterConverter from './filter';
import ValueConverter from './value';
import SPARQLToThingTalkConverter from '../sparql2thingtalk';

export default class ConverterHelper {
    private _converter : SPARQLToThingTalkConverter;
    private _triple : TripleConverter;
    private _filter : FilterConverter;
    private _value : ValueConverter;

    constructor(converter : SPARQLToThingTalkConverter) {
        this._converter = converter;
        this._triple = new TripleConverter(converter);
        this._filter = new FilterConverter(converter);
        this._value = new ValueConverter(converter);
    }

    async convertValue(value : any, type : Type) {
        return this._value.toThingTalkValue(value, type);
    }

    async convertTriples(clause : BgpPattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        return this._triple.convert(clause);
    }

    async convertFilter(clause : FilterPattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        return this._filter.convert(clause);
    }

    async convertUnion(clause : UnionPattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        const triple = parseSpecialUnion(clause);
        if (triple) 
            return this.convertTriples({ type: 'bgp', triples: [triple] });
        
        const results : Array<ArrayCollection<Ast.BooleanExpression>> = [];
        for (const pattern of clause.patterns) {
            assert(isBasicGraphPattern(pattern));
            results.push(await this.convertTriples(pattern));
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
        const filtersBySubject = new ArrayCollection<Ast.BooleanExpression>();
        filtersBySubject.add(existedSubject!, new Ast.OrBooleanExpression(null, operands));
        return filtersBySubject;
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
}