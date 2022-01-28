"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractProperties = exports.extractTriples = void 0;
const wikidata_1 = require("./wikidata");
/**
 * Given a parsed object returned by sparqljs, extract rdf triples out of it
 * @param obj any object containing 'triples' field at any depth
 * @returns a flattened array of triples
 */
function extractTriples(obj) {
    const triples = [];
    function extract(obj) {
        if (obj instanceof Object) {
            for (const [key, value] of Object.entries(obj)) {
                if (key === 'triples') {
                    const flattened = value.flat(Infinity);
                    for (const triple of flattened)
                        triples.push(triple);
                }
                else {
                    extract(value);
                }
            }
        }
    }
    extract(obj);
    return triples;
}
exports.extractTriples = extractTriples;
/**
 * Extract Wikidata properties involved in a predicate
 * @param predicate A predicate form sparqljs
 * @returns a flattened array of Wikidata properties (E.g, [P31, P279, ...])
 */
function extractProperties(predicate) {
    const properties = [];
    function extract(predicate) {
        if (predicate.termType === 'NamedNode') {
            if (predicate.value.startsWith(wikidata_1.PROPERTY_PREFIX))
                properties.push(predicate.value.slice(wikidata_1.PROPERTY_PREFIX.length));
        }
        else {
            for (const item of predicate.items)
                extract(item);
        }
    }
    extract(predicate);
    return properties;
}
exports.extractProperties = extractProperties;
//# sourceMappingURL=sparqljs.js.map