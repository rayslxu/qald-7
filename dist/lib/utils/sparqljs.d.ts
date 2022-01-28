import { Triple, IriTerm, VariableTerm, PropertyPath } from 'sparqljs';
/**
 * Given a parsed object returned by sparqljs, extract rdf triples out of it
 * @param obj any object containing 'triples' field at any depth
 * @returns a flattened array of triples
 */
export declare function extractTriples(obj: any): Triple[];
/**
 * Extract Wikidata properties involved in a predicate
 * @param predicate A predicate form sparqljs
 * @returns a flattened array of Wikidata properties (E.g, [P31, P279, ...])
 */
export declare function extractProperties(predicate: IriTerm | PropertyPath | VariableTerm): string[];
