import assert from 'assert';
import { Triple, IriTerm, VariableTerm, PropertyPath, UnionPattern } from 'sparqljs';
import { isBasicGraphPattern, isNamedNode, isPropertyPath, isSequencePropertyPath, isUnaryPropertyPath, isWikidataEntityNode, isWikidataPredicateNode, isWikidataPropertyNode } from './sparqljs-typeguard';
import { PROPERTY_PREFIX } from './wikidata';

/**
 * Given a parsed object returned by sparqljs, extract rdf triples out of it
 * @param obj any object containing 'triples' field at any depth
 * @returns a flattened array of triples 
 */
export function extractTriples(obj : any) : Triple[] {
    const triples : Triple[] = [];
    function extract(obj : any) {
        if (obj instanceof Object) {
            for (const [key, value] of Object.entries(obj)) {
                if (key === 'triples') {
                    const flattened = (value as any[]).flat(Infinity);
                    for (const triple of flattened)
                        triples.push(triple); 

                } else {
                    extract(value);
                }
            }
        }
    }
    extract(obj);
    return triples;
}

/**
 * Extract Wikidata properties involved in a predicate 
 * @param predicate A predicate form sparqljs
 * @returns a flattened array of Wikidata properties (E.g, [P31, P279, ...]) 
 */
export function extractProperties(predicate : IriTerm|PropertyPath|VariableTerm) : string[] {
    const properties : string[]= [];
    function extract(predicate : IriTerm|PropertyPath|VariableTerm) {
        if (isNamedNode(predicate)) {
            if (predicate.value.startsWith(PROPERTY_PREFIX)) 
                properties.push(predicate.value.slice(PROPERTY_PREFIX.length));
        } else if (isPropertyPath(predicate)) {
            // only extract the first item in the property path
            extract(predicate.items[0]);
        }
    }
    extract(predicate);
    return properties;
}


/**
 * Some heuristics to simplify the property path
 * The simplified version should not have any difference in semantics in natural language
 */
export function preprocessPropertyPath(predicate : IriTerm|PropertyPath|VariableTerm) : IriTerm|PropertyPath|VariableTerm {
    // property path
    if (!isPropertyPath(predicate))
        return predicate;
    if (predicate.pathType === '/') {
        // P31/P279* -> P31
        if (predicate.items.length === 2) {
            const [first, second] = predicate.items;
            if (isWikidataPropertyNode(first, 'P31') && 
                isUnaryPropertyPath(second, '*') && 
                isWikidataPropertyNode(second.items[0], 'P279'))
                return first;
        }
        predicate.items = predicate.items.map((item) => preprocessPropertyPath(item) as IriTerm|PropertyPath);
    } else if (predicate.pathType === '+') {
        assert(predicate.items.length === 1);
        const item = predicate.items[0];

        // P131+ -> P131
        if ('termType' in item) {
            if (isWikidataPropertyNode(item, 'P131')) 
                return item;
        }
    } else if (predicate.pathType === '|') {
        if (predicate.items.length === 2) {
            const castMember = predicate.items.find((p) => isWikidataPropertyNode(p, 'P161') || isWikidataPredicateNode(p, 'P161'));
            const voiceActor = predicate.items.find((p) => isWikidataPropertyNode(p, 'P725') || isWikidataPredicateNode(p, 'P725'));
            if (castMember !== undefined && voiceActor !== undefined)
                return castMember;
        }
    }    
    return predicate;
}

function isInstanceOf(triple : Triple) : boolean {
    const predicate = triple.predicate;
    if (isWikidataPropertyNode(predicate, 'P31'))
        return true;
    
    if (isSequencePropertyPath(predicate)) {
        if (predicate.items.length !== 2)
            return false;
        if (!isWikidataPropertyNode(predicate.items[0], 'P31'))
            return false;
        if (isUnaryPropertyPath(predicate.items[1], '*') && isWikidataPropertyNode(predicate.items[1].items[0], 'P279'))
            return true;
        return false;
    }

    return false;
}

/**
 * Handle a few special cases for union clause
 * @param predicate A predicate
 * @returns a parsed triple for the special cases, and false if not matched 
 */
export function preprocessSpecialUnion(union : UnionPattern) : Triple|false {
    const result = _preprocessUSStateSpecialUnion(union);
    if (result)
        return result;

    if (union.patterns.length !== 2)
        return false;
    if (!isBasicGraphPattern(union.patterns[0]) || !isBasicGraphPattern(union.patterns[1]))
        return false;
    if (union.patterns[0].triples.length !== 1 || union.patterns[1].triples.length !== 1)
        return false;
    const first = union.patterns[0].triples[0];
    const second = union.patterns[1].triples[0];
    if (!(first.subject.value && first.subject.value === second.subject.value))
        return false;
    if (!(first.object.value && first.object.value === second.object.value))
        return false;
    if (!isNamedNode(first.predicate))
        return false;
    if (!isSequencePropertyPath(second.predicate))
        return false;
    if (second.predicate.items.length !== 2)
        return false;
        
    // case 1: { ?s ?p ?o } union { ?s ?p/P17 ?o } ==> { ?s ?p ?o }
    if (isNamedNode(second.predicate.items[0]) && isNamedNode(second.predicate.items[1]) &&
        second.predicate.items[0].value === first.predicate.value &&
        isWikidataPropertyNode(second.predicate.items[1], 'P17')) // country
        return first;
    // case 2: { ?s P31 ?o } union { ?s P31/P279* ?o } ==> { ?s P31 ?o }
    if (isNamedNode(second.predicate.items[0]) && isUnaryPropertyPath(second.predicate.items[1], '*') &&
        second.predicate.items[0].value === first.predicate.value &&
        isWikidataPropertyNode(second.predicate.items[1].items[0], 'P279'))
        return first;
    return false;
}


// { ?s P31/P279* Q475050. } union { ?s P31/P279* Q7275 } => { ?s P31 Q7275 } 
// this includes DC when talking about states in united states
function _preprocessUSStateSpecialUnion(union : UnionPattern) : Triple|false {
    if (union.patterns.length !== 2)
        return false;
    
    let stateTriple, federalDistrictTriple;
    for (const pattern of union.patterns) {
        if (!isBasicGraphPattern(pattern))
            return false;
        if (pattern.triples.length !== 1)
            return false;
        const triple = pattern.triples[0];
        if (isInstanceOf(triple) && isWikidataEntityNode(triple.object, 'Q7275')) 
            stateTriple = triple;
        if (isInstanceOf(triple) && isWikidataEntityNode(triple.object, 'Q475050'))
            federalDistrictTriple = triple;
    }
    if (!stateTriple || !federalDistrictTriple)
        return false;
    if (stateTriple.subject.value !== federalDistrictTriple.subject.value)
        return false;
    return stateTriple;
}