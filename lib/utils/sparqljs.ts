import { Triple, IriTerm, VariableTerm, PropertyPath } from 'sparqljs';
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
