import assert from 'assert';
import { 
    BgpPattern, 
    Triple
} from 'sparqljs';
import { Ast, Type } from 'thingtalk';
import { postprocessPropertyPath } from '../../utils/sparqljs';
import { 
    isNamedNode, 
    isPropertyPath,
    isWikidataEntityNode,
    isWikidataPropertyNode,
    isLiteral,
    isVariable
} from '../../utils/sparqljs-typeguard';
import { 
    ENTITY_PREFIX,
    PROPERTY_PREFIX,
    LABEL
} from '../../utils/wikidata';
import {
    ArrayCollection
} from '../../utils/misc';
import SPARQLToThingTalkConverter from "../sparql2thingtalk";
import ValueConverter from './value';

export default class TripleParser {
    private _converter : SPARQLToThingTalkConverter;
    private _values : ValueConverter;

    constructor(converter : SPARQLToThingTalkConverter) {
        this._converter = converter;
        this._values = new ValueConverter(converter);
    }

    /**
     * Convert a basic triple to ThingTalk filter
     * @param triple a parsed Triple for SPARQL
     * @returns the subject and the ThingTalk filter
     */
    private async _parseBasicTriple(triple : Triple) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        assert(isNamedNode(triple.predicate));
        const filtersBySubject = new ArrayCollection<Ast.BooleanExpression>();
        const filters : Ast.BooleanExpression[] = [];
        const subject : string = triple.subject.value;
        const predicate : string = triple.predicate.value;
        const object : string = triple.object.value;

        if (!subject || !predicate || !object)
            throw new Error(`Unsupported triple: ${JSON.stringify(triple)}`);

        // Case 0: if subject is an entity, create an id filter first
        // if the subject is already in the tables, it means we already have the id filter, so no need to run this again
        if (isWikidataEntityNode(triple.subject) && !(subject in this._converter.tables)) {
            const domain = await this._converter.kb.getDomain(subject.slice(ENTITY_PREFIX.length));
            assert(domain);
            const table = this._converter.schema.getTable(domain);
            assert(table);
            filters.push(new Ast.AtomBooleanExpression(
                null,
                'id',
                '==',
                await this._values.toThingTalkValue(subject, new Type.Entity(`org.wikidata:${table}`)),
                null
            ));
            this._converter.updateTable(subject, domain);
        }

        // Case 1: if subject is an variable and object is an entity, create a regular filter
        if (isVariable(triple.subject) && (isLiteral(triple.object) || isWikidataEntityNode(triple.object))) { 
            // for P31 triple, update the domain of the variable, do not add filter
            if (isWikidataPropertyNode(triple.predicate, 'P31')) {
                this._converter.updateTable(subject, object.slice(ENTITY_PREFIX.length));
                return filtersBySubject;
            }
            const valueType = isLiteral(triple.object) ? Type.String : undefined;
            const filter = await this._converter.helper.makeAtomBooleanExpression(predicate, object, undefined, valueType);
            filters.push(filter);

        // Case 2: if object is an variable, create a projection
        } else if (isVariable(triple.object)) {
            // if predicate is label, add a new projection with suffix "Label" for the property 
            if (predicate === LABEL) {
                throw new Error('TODO: handle label projection');
            } else {
                const property = this._converter.schema.getProperty(predicate.slice(PROPERTY_PREFIX.length));
                this._converter.updateTable(subject, { variable: object, property });
            }
            
        // Case 3: if both subject and object are entities, create a filter, for verification
        } else if (isNamedNode(triple.subject) && isNamedNode(triple.object)) {
            const filter = await this._converter.helper.makeAtomBooleanExpression(predicate, object);
            this._converter.updateTable(subject, filter);
        } else {
            throw new Error('Unexpected triple: ' + triple);
        }
        filtersBySubject.add(subject, ...filters);
        return filtersBySubject;
    }

    private async _parseSequencePathTriple(triple : Triple) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        assert(isPropertyPath(triple.predicate));
        throw new Error('TODO: handle property path');
    }
        
    async parse(pattern : BgpPattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        const filtersBySubject = new ArrayCollection<Ast.BooleanExpression>();
        for (const triple of pattern.triples) {
            triple.predicate = postprocessPropertyPath(triple.predicate);
            if (isPropertyPath(triple.predicate))
                filtersBySubject.merge(await this._parseSequencePathTriple(triple));
            else 
                filtersBySubject.merge(await this._parseBasicTriple(triple));
        }
        return filtersBySubject;
    }

}