import { Ast } from 'thingtalk';
interface SPARQLToThingTalkConverterOptions {
    cache: string;
    bootleg_db: string;
}
export default class SPARQLToThingTalkConverter {
    private _schema;
    private _parser;
    private _wikidata;
    private _tokenizer;
    private _keywords;
    private _tables;
    private _comparison;
    constructor(classDef: Ast.ClassDef, options: SPARQLToThingTalkConverterOptions);
    /**
     * Initialize a table (in ThingTalk) for a subject (in SPARQL)
     * @param subject the subject of the table, either a variable, or a Wikidata entity
     */
    private _initTable;
    /**
     * Add a filter to a able
     * @param subject the subject, a variable in SPARQL
     * @param filter a filter to add to the subject
     */
    private _addFilter;
    /**
     * Add a projection to a table
     * @param subject the subject, either a variable, or an entity
     * @param projection a projection to add to the subject
     */
    private _addProjection;
    /**
     * Add a verification (boolean question) to a table
     * @param subject the subject, either a variable, or an entity
     * @param verification a verification to add to the subject
     */
    private _addVerification;
    /**
     * Set the domain for a table
     * @param subject the subject, either a variable or an entity
     * @param domain the QID of the domain
     */
    private _setDomain;
    /**
     * Get the domain of a entity
     * @param entityId QID of an entity
     * @returns its domain, i.e., heuristically the best entity among values of P31 (instance of)
     */
    private _getDomain;
    /**
     * Convert a value in SPARQL into a ThingTalk value
     * @param value a value in the SPARQL triple
     * @param type the ThingTalk type of the value
     * @returns a ThingTalk value
     */
    private _toThingTalkValue;
    /**
     * Creat an atom filter
     * @param property the predicate derived from SPARQL (either a name or a Wikidata property)
     * @param value the value derived from SPARQL
     * @param operator operator, by default will be == or contains depending on the property type
     * @param valueType the type of the value
     * @returns a ThingTalk filter: "$property = $value"
     */
    private _atomFilter;
    private _aggregateFilter;
    private _convertSequencePathTriple;
    private _convertBasicTriple;
    /**
     * Convert RDF triples into thingtalk filters by subjects
     * @param triples RDF Triples derived from SPARQL
     * @returns a map from subjects to their ThingTalk filters converted from the triples
     */
    private _convertTriples;
    /**
     * Parse a union where clause
     * @param where a where clause
     */
    private _parseUnion;
    /**
     * Parse a filter expression where the operation is a binary operation
     * @param expression a filter expression
     * @param isVerification if it's a verification question or not
     * @param negate if the filter should be negated
     */
    private _parseBinaryOperation;
    /**
     * Parse a filter expression where the operation is a unary operation
     * @param expression a filter expression
     * @param isVerification if it's a verification question or not
     * @param negate if the filter should be negated
     */
    private _parseUnaryOperation;
    /**
     * Parse a filter expression (with SPARQL keyword "FILTER")
     * @param expression a filter expression
     * @param isVerification if it's a verification question or not
     * @param negate if the filter should be negated
     */
    private _parseFilter;
    /**
     * Parse a basic triple where clause
     * @param where a where clause
     */
    private _parseBasic;
    /**
     * Parse a where clause
     * @param where a where clause
     * @param isVerification if it's a verification question or not
     */
    private _parseWhereClause;
    private _parseHavingClause;
    /**
     * init tables used to track the conversion
     */
    private _init;
    /**
     * Convert SPARQL into ThingTalk
     * @param sparql a string of SPARQL query
     * @param utterance a string of the utterance
     * @param keywords a list of keywords in the utterance including the mentioned entities
     * @returns A ThingTalk Program
     */
    convert(sparql: string, utterance: string, keywords?: string[]): Promise<Ast.Program>;
}
export {};
