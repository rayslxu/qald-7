import assert from 'assert';
import { 
    BgpPattern, 
    Triple
} from 'sparqljs';
import { Ast, Type } from 'thingtalk';
import { 
    isNamedNode, 
    isPropertyPath,
    isWikidataEntityNode,
    isWikidataPropertyNode,
    isLiteral,
    isVariable,
    isUnaryPropertyPath,
    isWikidataPredicateNode,
    isOrPropertyPath
} from '../../utils/sparqljs-typeguard';
import { 
    ENTITY_PREFIX,
    PROPERTY_PREFIX,
    LABEL,
    TP_DEVICE_NAME
} from '../../utils/wikidata';
import {
    ArrayCollection
} from '../../utils/misc';
import SPARQLToThingTalkConverter, { Projection } from "../sparql2thingtalk";
import {
    elemType
} from '../../utils/thingtalk';

export default class TripleParser {
    private _converter : SPARQLToThingTalkConverter;

    constructor(converter : SPARQLToThingTalkConverter) {
        this._converter = converter;
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
            const domain = (await this._converter.kb.getDomain(subject.slice(ENTITY_PREFIX.length))) ?? 'Q35120';
            const table = this._converter.schema.getTable(domain);
            assert(table);
            filters.push(new Ast.AtomBooleanExpression(
                null,
                'id',
                '==',
                await this._converter.helper.convertValue(subject, new Type.Entity(`${TP_DEVICE_NAME}:${table}`)),
                null
            ));
            this._converter.updateTable(subject, domain);
        }

        // Case 1: handle qualifier related triples
        if (isWikidataPredicateNode(triple.predicate)) {
            await this._converter.helper.parsePredicate(triple);
        // Case 2: if subject is an variable and object is an entity, create a regular filter
        } else if (isVariable(triple.subject) && (isLiteral(triple.object) || isWikidataEntityNode(triple.object))) { 
            // for P31 triple, update the domain of the variable, do not add filter
            if (isWikidataPropertyNode(triple.predicate, 'P31')) {
                this._converter.updateTable(subject, object.slice(ENTITY_PREFIX.length));
                return filtersBySubject;
            }
            if (predicate === LABEL) {
                filters.push(new Ast.AtomBooleanExpression(null, 'id', '=~', new Ast.Value.String(object), null));
            } else {  
                const valueType = isLiteral(triple.object) ? Type.String : undefined; 
                const filter = await this._converter.helper.makeAtomBooleanExpression(predicate, object, undefined, valueType);
                filters.push(filter);
            }

        // Case 3: if object is an variable, create a projection
        } else if (isVariable(triple.object)) {
            // if predicate is label, add a new projection with suffix "Label" for the property 
            if (predicate === LABEL) {
                for (const [subj, table] of Object.entries(this._converter.tables)) {
                    const projection = table.projections.find((proj) => proj.variable === subject);
                    if (projection) {
                        this._converter.updateTable(subj, new Projection({ variable : object, property : projection.property + 'Label' }));
                        break;
                    }
                }
            } else {
                const property = this._converter.schema.getProperty(predicate.slice(PROPERTY_PREFIX.length));
                this._converter.updateTable(subject, new Projection({ variable: object, property }));
            }
            
        // Case 4: if both subject and object are entities, create a filter, for verification
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
        const filtersBySubject = new ArrayCollection<Ast.BooleanExpression>();
        const filters : Ast.BooleanExpression[] = [];
        const subject = triple.subject.value;
        const predicate = triple.predicate;
        const object = triple.object.value;
        
        // if subject is an entity, create an id filter
        if (isWikidataEntityNode(triple.subject) && !(subject in this._converter.tables)) {
            const domain = await this._converter.kb.getDomain(subject.slice(ENTITY_PREFIX.length));
            assert(domain);
            const table = this._converter.schema.getTable(domain);
            assert(table);
            filters.push(new Ast.AtomBooleanExpression(
                null,
                'id',
                '==',
                await this._converter.helper.convertValue(subject, new Type.Entity(`${TP_DEVICE_NAME}:${table}`)),
                null
            ));
            this._converter.updateTable(subject, domain);
        }

        const sequence : Ast.PropertyPathSequence = [];
        if (predicate.items.length === 1) {
            assert(isNamedNode(predicate.items[0]));
            const property = this._converter.schema.getProperty(predicate.items[0].value.slice(PROPERTY_PREFIX.length));
            sequence.push(new Ast.PropertyPathElement(property, predicate.pathType as '*'|'+'));
        } else {
            // sequence property path
            assert(predicate.pathType === '/');
            for (const element of predicate.items) {
                if (isWikidataPropertyNode(element)) {
                    const property = this._converter.schema.getProperty(element.value.slice(PROPERTY_PREFIX.length));
                    sequence.push(new Ast.PropertyPathElement(property));
                } else if (isUnaryPropertyPath(element)) {
                    assert(element.items.length === 1 && isNamedNode(element.items[0]));
                    const property = this._converter.schema.getProperty(element.items[0].value.slice(PROPERTY_PREFIX.length));
                    sequence.push(new Ast.PropertyPathElement(property, element.pathType as '*'|'+'));
                }
            }
        }
        const lastPropertyType = this._converter.schema.getPropertyType(sequence[sequence.length - 1].property);
        if (isVariable(triple.object)) {
            this._converter.updateTable(subject, new Projection({ property : sequence, variable : object }));
        } else {
            const value = await this._converter.helper.convertValue(object, elemType(lastPropertyType));
            const filter = new Ast.PropertyPathBooleanExpression(
                null, 
                sequence, 
                lastPropertyType instanceof Type.Array ? 'contains' : '==',
                value, 
                null
            );
            filters.push(filter);
        }
        filtersBySubject.add(subject, ...filters);
        return filtersBySubject;
    }

    async _parseOrPathTriple(triple : Triple) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        assert(isOrPropertyPath(triple.predicate));
        const filtersBySubject = new ArrayCollection<Ast.BooleanExpression>();
        const predicate = triple.predicate;
        for (const elem of predicate.items) {
            assert(isWikidataPropertyNode(elem));
            triple.predicate = elem;
            filtersBySubject.merge(await this._parseBasicTriple(triple));
        }
        triple.predicate = predicate;
        return filtersBySubject;
    }
        
    async parse(pattern : BgpPattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        const filtersBySubject = new ArrayCollection<Ast.BooleanExpression>();
        for (const triple of pattern.triples) {
            if (isOrPropertyPath(triple.predicate))
                filtersBySubject.merge(await this._parseOrPathTriple(triple));
            else if (isPropertyPath(triple.predicate))
                filtersBySubject.merge(await this._parseSequencePathTriple(triple));
            else 
                filtersBySubject.merge(await this._parseBasicTriple(triple));
        }
        return filtersBySubject;
    }

}