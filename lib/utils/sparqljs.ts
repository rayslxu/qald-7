import assert from 'assert';
import { Triple, IriTerm, VariableTerm, PropertyPath, UnionPattern } from 'sparqljs';
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
        if ((predicate as IriTerm).termType === 'NamedNode') {
            if ((predicate as IriTerm).value.startsWith(PROPERTY_PREFIX)) 
                properties.push((predicate as IriTerm).value.slice(PROPERTY_PREFIX.length));
        } else {
            for (const item of (predicate as PropertyPath).items) 
                extract(item);
        }
    }
    extract(predicate);
    return properties;
}


/**
 * Some heuristics to simplify the property path
 * The simplified version should not have any difference in semantics in natural language
 */
export function postprocessPropertyPath(predicate : IriTerm|PropertyPath|VariableTerm) : IriTerm|PropertyPath|VariableTerm {
    // property path
    if ('type' in predicate && predicate.type === 'path') {
        if (predicate.pathType === '/') {
            // P31/P279* -> P31
            if (predicate.items.length === 2) {
                const [first, second] = predicate.items;
                if ('termType' in first && first.termType === 'NamedNode' && first.value === `${PROPERTY_PREFIX}P31` && 
                    'pathType' in second && second.pathType === '*' && 
                    'termType' in second.items[0] && second.items[0].termType === 'NamedNode' 
                    && second.items[0].value === `${PROPERTY_PREFIX}P279`)
                    return first;
            }

            
            predicate.items = predicate.items.map((item) => postprocessPropertyPath(item) as IriTerm|PropertyPath);
        } else if (predicate.pathType === '+') {
            assert(predicate.items.length === 1);
            const item = predicate.items[0];

            // P131+ -> P131
            if ('termType' in item) {
                if (item.termType === 'NamedNode' && item.value === `${PROPERTY_PREFIX}P131`) 
                    return item;
            }
        }     
    }
    return predicate;
}

/**
 * Handle a few special cases for union clause
 * case 1: { ?s ?p ?o } union { ?s ?p/P17 ?o } ==> { ?s ?p ?o }
 * case 2: { ?s P31 ?o } union { ?s P31/P279* ?o } ==> { ?s P31 ?o }
 * @param predicate A predicate
 * @returns a parsed triple for the special cases, and false if not matched 
 */
export function parseSpecialUnion(union : UnionPattern) : Triple|false {
    if (union.patterns.length !== 2)
        return false;
    if (union.patterns[0].type !== 'bgp' || union.patterns[1].type !== 'bgp')
        return false;
    if (union.patterns[0].triples.length !== 1 || union.patterns[1].triples.length !== 1)
        return false;
    const first = union.patterns[0].triples[0];
    const second = union.patterns[1].triples[0];
    if (!(first.subject.value && first.subject.value === second.subject.value))
        return false;
    if (!(first.object.value && first.object.value === second.object.value))
        return false;
    if (!('termType' in first.predicate && first.predicate.termType === 'NamedNode'))
        return false;
    if (!('type' in second.predicate && second.predicate.type === 'path' && second.predicate.pathType === '/'))
        return false;
    if (second.predicate.items.length !== 2)
        return false;
        
    // case 1: { ?s ?p ?o } union { ?s ?p/P17 ?o } ==> { ?s ?p ?o }
    if ('termType' in second.predicate.items[0] && second.predicate.items[0].termType === 'NamedNode' &&
        'termType' in second.predicate.items[1] && second.predicate.items[1].termType === 'NamedNode' &&
        second.predicate.items[0].value === first.predicate.value &&
        second.predicate.items[1].value.slice(PROPERTY_PREFIX.length) === 'P17') // country
        return first;
    // case 2: { ?s P31 ?o } union { ?s P31/P279* ?o } ==> { ?s P31 ?o }
    if ('termType' in second.predicate.items[0] && second.predicate.items[0].termType === 'NamedNode' &&
        'pathType' in second.predicate.items[1] && second.predicate.items[1].pathType === '*' &&
        second.predicate.items[0].value === first.predicate.value &&
        'termType' in second.predicate.items[1].items[0] && second.predicate.items[1].items[0].termType === 'NamedNode' &&
        second.predicate.items[1].items[0].value.slice(PROPERTY_PREFIX.length) === 'P279')
        return first;
    
    return false;
}