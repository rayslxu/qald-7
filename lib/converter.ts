import * as fs from 'fs';
import { promises as pfs } from 'fs';
import assert from 'assert';
import * as stream from 'stream';
import JSONStream from 'JSONStream';
import { Ast, Type } from 'thingtalk';
import * as ThingTalk from 'thingtalk';
import { 
    SelectQuery, 
    Parser, 
    SparqlParser, 
    AskQuery, 
    UnionPattern, 
    Triple
} from 'sparqljs';
import * as argparse from 'argparse';
import { waitFinish, closest, getSpans } from './utils/misc';
import WikidataUtils from './utils/wikidata';
import { ENTITY_PREFIX, PROPERTY_PREFIX, LABEL } from './utils/wikidata';
import { postprocessPropertyPath } from './utils/sparqljs';
import { I18n, DatasetStringifier, ThingTalkUtils, EntityUtils } from 'genie-toolkit';
import { ENTITY_SPAN_OVERRIDE } from './utils/qald';

/**
 * A shortcut for quickly creating a basic query
 * @param domain the name of a domain
 * @return an invocation of a base domain query (no projection, no filter)
 */
function baseQuery(domain : string) {
    return new Ast.InvocationExpression(
        null,
        new Ast.Invocation(null, new Ast.DeviceSelector(null, 'org.wikidata', null, null), domain, [], null),
        null
    );
}

/**
 * A shortcut for creating a program from an query expression
 * @param expression a ThingTalk query expression
 * @returns a ThingTalk program 
 */
function makeProgram(expression : Ast.Expression) {
    if (!(expression instanceof Ast.ChainExpression))
        expression = new Ast.ChainExpression(null, [expression], expression.schema);
    return new Ast.Program(null, [], [], [new Ast.ExpressionStatement(null, expression)]);
}

/**
 * A shortcut for creating a program with a subquery
 * @param main the main query
 * @param subquery the subquery
 * @returns a ThingTalk program
 */
function makeSubqueryProgram(main : Ast.Expression, subquery : Ast.BooleanExpression) {
    type ParentExpression  = Ast.ProjectionExpression|Ast.SortExpression|Ast.IndexExpression|Ast.BooleanQuestionExpression|Ast.AggregationExpression;
    let filterTable = main;
    let parent : ParentExpression|undefined;
    while (!(filterTable instanceof Ast.FilterExpression || filterTable instanceof Ast.InvocationExpression)) {
        parent = (filterTable as ParentExpression);
        filterTable = parent.expression;
    }
    if (filterTable instanceof Ast.FilterExpression)
        filterTable.filter = new Ast.AndBooleanExpression(null, [filterTable.filter, subquery]);
    else if (parent)
        parent.expression = new Ast.FilterExpression(null, filterTable, subquery, null);
    else
        main = new Ast.FilterExpression(null, filterTable, subquery, null);
    return new Ast.Program(null, [], [], [new Ast.ExpressionStatement(null, main)]);
}

/**
 * A shortcut for creating a program with subquery verification
 * @param main the main query
 * @param subqueries the boolean expressions to verify
 */
function makeSubqueryVerificationProgram(main : Ast.Expression, subqueries : Ast.BooleanExpression[]) {
    assert(subqueries.length > 0);
    const verification = subqueries.length === 1 ? subqueries[0] : new Ast.AndBooleanExpression(null, subqueries);
    const expression = new Ast.BooleanQuestionExpression(null, main, verification, null);
    return new Ast.Program(null, [], [], [new Ast.ExpressionStatement(null, expression)]);
}

/**
 * Get the element type of a ThingTalk type
 * @param type a ThingTalk type
 */
function elemType(type : Type) : Type {
    while (type instanceof Type.Array)
        type = type.elem as Type;
    return type;
}

/**
 * Handle a few special cases for union clause
 * case 1: { ?s ?p ?o } union { ?s ?p/P17 ?o } ==> { ?s ?p ?o }
 * @param predicate A predicate
 * @returns a parsed triple for the special cases, and false if not matched 
 */
function parseSpecialUnion(union : UnionPattern) : Triple|false {
    const SPECIAL_PREDICATE = [
        'P17' // country
    ];
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
    if (!('termType' in second.predicate.items[0] && second.predicate.items[0].termType === 'NamedNode' ))
        return false;
    if (!('termType' in second.predicate.items[1] && second.predicate.items[1].termType === 'NamedNode' ))
        return false;
    if (second.predicate.items[0].value !== first.predicate.value)
        return false;
    if (!SPECIAL_PREDICATE.includes(second.predicate.items[1].value.slice(PROPERTY_PREFIX.length)))
        return false;
    
    return first;
}
 
/**
 * A class to retrieve schema information from the schema
 */
class WikiSchema {
    private _tableMap : Record<string, string>;
    private _propertyMap : Record<string, string>;
    private _propertyTypeMap : Record<string, Type>;

    constructor(schema : Ast.ClassDef) {
        this._tableMap = {};
        this._propertyMap = {};
        this._propertyTypeMap = {};
        for (const [qname, query] of Object.entries(schema.queries)) {
            const qid = ((query.getImplementationAnnotation('wikidata_subject')) as any[])[0];
            this._tableMap[qid] = qname;
            for (const arg of query.iterateArguments()) {
                if (arg.name === 'id')
                    continue;
                const pid = arg.getImplementationAnnotation('wikidata_id') as string;
                this._propertyMap[pid] = arg.name;
                this._propertyTypeMap[arg.name] = arg.type;
            }
        }
    }

    /**
     * @param qid QID of a domain
     * @returns the table name (cleaned label of the QID)
     */
    getTable(qid : string) : string {
        return this._tableMap[qid];
    }

    /**
     * @param pid PID of a property
     * @returns the property name (cleaned label of the PID)
     */
    getProperty(pid : string) : string {
        return this._propertyMap[pid];
    }

    /**
     * @param property the name of the property
     * @returns the entity type of the property 
     */
    getPropertyType(property : string) : Type {
        return this._propertyTypeMap[property];
    }
}

interface Projection {
    property : string|Ast.PropertyPathSequence, 
    variable ?: string,
    type ?: string
}

interface Table {
    domain : string,
    projections : Projection[],
    filters : Ast.BooleanExpression[],
    verifications : Ast.BooleanExpression[]
}

interface SPARQLToThingTalkConverterOptions {
    cache : string;
    enablePropertyPath : boolean;
}

export default class SPARQLToThingTalkConverter {
    private _schema : WikiSchema;
    private _parser : SparqlParser;
    private _wikidata : WikidataUtils;
    private _tokenizer : I18n.BaseTokenizer;
    private _keywords : string[];
    private _tables : Record<string, Table>;
    private _variableCounter : number;
    private _enablePropertyPath : boolean;

    constructor(classDef : Ast.ClassDef, options : SPARQLToThingTalkConverterOptions) {
        this._schema = new WikiSchema(classDef);
        this._parser = new Parser();
        this._wikidata = new WikidataUtils(options.cache);
        this._tokenizer = new I18n.LanguagePack('en').getTokenizer();
        this._tables = {};
        this._keywords = [];
        this._variableCounter = 0;
        this._enablePropertyPath = !!options.enablePropertyPath;
    } 

    /**
     * Initialize a table (in ThingTalk) for a subject (in SPARQL)
     * @param subject the subject of the table, either a variable, or a Wikidata entity
     */
    private _initTable(subject : string) {
        if (!(subject in this._tables))
            this._tables[subject] = { domain: 'entity', projections: [], filters: [], verifications: [] };
    }

    /**
     * Add a filter to a able
     * @param subject the subject, a variable in SPARQL
     * @param filter a filter to add to the subject
     */
    private _addFilter(subject : string, filter : Ast.BooleanExpression) {
        this._initTable(subject);
        this._tables[subject].filters.push(filter);
    }

    /**
     * Add a projection to a table
     * @param subject the subject, either a variable, or an entity
     * @param projection a projection to add to the subject
     */
    private _addProjection(subject : string, projection : Projection) {
        this._initTable(subject);
        this._tables[subject].projections.push(projection);
    }

    /**
     * Add a verification (boolean question) to a table
     * @param subject the subject, either a variable, or an entity
     * @param verification a verification to add to the subject
     */
    private _addVerification(subject : string, verification : Ast.BooleanExpression) {
        this._initTable(subject);
        this._tables[subject].verifications.push(verification);
    }

    /**
     * Set the domain for a table
     * @param subject the subject, either a variable or an entity
     * @param domain the QID of the domain
     */
    private _setDomain(subject : string, domain : string) {
        this._initTable(subject);
        this._tables[subject].domain = this._schema.getTable(domain);
    }

    /**
     * @return a new sparqljs compatible variable
     */
    private _newVariable() {
        return {
            termType: "Variable",
            value: `v_${this._variableCounter ++}`
        };
    }
     
    /**
     * Convert a value in SPARQL into a ThingTalk value
     * @param value a value in the SPARQL triple
     * @param type the ThingTalk type of the value
     * @returns a ThingTalk value
     */
    private async _toThingTalkValue(value : any, type : Type) : Promise<Ast.Value> {
        if (type instanceof Type.Entity) {
            assert(typeof value === 'string' && value.startsWith(ENTITY_PREFIX));
            value = value.slice(ENTITY_PREFIX.length);
            if (ENTITY_SPAN_OVERRIDE[value]) 
                return new Ast.Value.Entity(value, type.type, ENTITY_SPAN_OVERRIDE[value]);
            const wikidataLabel = await this._wikidata.getLabel(value);
            assert(wikidataLabel);
            const display = closest(wikidataLabel, this._keywords);
            if (!display)
                throw new Error(`Failed find matching span for entity ${value} : ${wikidataLabel} among ${this._keywords}`);
            return new Ast.Value.Entity(value, type.type, display); 
        } 
        if (type instanceof Type.Enum) {
            assert(typeof value === 'string' && value.startsWith(ENTITY_PREFIX));
            value = value.slice(ENTITY_PREFIX.length);
            const wikidataLabel = await this._wikidata.getLabel(value);
            assert(wikidataLabel);
            return new Ast.Value.Enum(wikidataLabel); 
        }
        if (type === Type.Number)
            return new Ast.Value.Number(parseFloat(value));
        if (type === Type.String) 
            return new Ast.Value.String(value);

        throw new Error('Unsupported value type: ' + type);
    }

    /**
     * Creat an atom filter 
     * @param property the predicate derived from SPARQL (either a name or a Wikidata property)
     * @param value the value derived from SPARQL
     * @param operator operator, by default will be == or contains depending on the property type
     * @param valueType the type of the value
     * @returns a ThingTalk filter: "$property = $value"
     */
    private async _atomFilter(property : string, value : any, operator ?: string, valueType ?: Type) : Promise<Ast.AtomBooleanExpression> {
        let propertyLabel, propertyType;
        if (property === 'id') {
            propertyLabel = property;
            propertyType = valueType!;
        } else {
            if (property.startsWith(PROPERTY_PREFIX)) {
                property = property.slice(PROPERTY_PREFIX.length);
                propertyLabel = this._schema.getProperty(property);
            } else {
                propertyLabel = property;
            }
            propertyType = this._schema.getPropertyType(propertyLabel);
        }
        if (operator === '>' || operator === '<') 
            operator = operator + '=';
        return new Ast.AtomBooleanExpression(
            null,
            propertyLabel,
            operator ?? (propertyType instanceof Type.Array ? 'contains' : '=='),
            await this._toThingTalkValue(value, valueType ?? elemType(propertyType)),
            null
        );
    }

    private _aggregateFilter(aggregation : string, operands : string[], operator : string, value : number) {
        if (operator === '>' || operator === '<') 
            operator = operator + '=';
        return new Ast.ComputeBooleanExpression(
            null,
            new Ast.ComputationValue(aggregation, operands.map((op) => new Ast.Value.VarRef(op))),
            operator, 
            new Ast.Value.Number(value)
        );
    }

    private async _convertSequencePathTriple(triple : any, filtersBySubject : Record<string, Ast.BooleanExpression[]>) {
        // if we enable property path, and the triple is not a projection (currently not supported)
        if (this._enablePropertyPath) { 
            const subject = triple.subject.value;
            const predicate = triple.predicate;
            const object = triple.object.value;
            // if subject is an entity, create an id filter
            if (triple.subject.termType === 'NamedNode' && subject.startsWith(ENTITY_PREFIX)) {
                const domain = await this._wikidata.getDomain(subject.slice(ENTITY_PREFIX.length));
                assert(domain);
                const table = this._schema.getTable(domain);
                assert(table);
                this._addFilter(subject, await this._atomFilter('id', subject, '==', new Type.Entity(`org.wikidata:${table}`)));
                this._setDomain(subject, domain);
            }
            const sequence : Ast.PropertyPathSequence = [];
            for (const element of predicate.items) {
                if (element.termType === 'NamedNode' && element.value.startsWith(PROPERTY_PREFIX)) {
                    const property = this._schema.getProperty(element.value.slice(PROPERTY_PREFIX.length));
                    sequence.push(new Ast.PropertyPathElement(property));
                } else if (element.type === 'path' && ['+', '*', '?'].includes(element.pathType)) {
                    assert(element.items.length === 1 && element.items[0].termType === 'NamedNode');
                    const property = this._schema.getProperty(element.items[0].value.slice(PROPERTY_PREFIX.length));
                    sequence.push(new Ast.PropertyPathElement(property, element.pathType));
                }
            }
            const lastPropertyType = this._schema.getPropertyType(sequence[sequence.length - 1].property);
            if (triple.object.termType === 'Variable') {
                this._addProjection(subject, { property : sequence, variable : object });
            } else {
                const value = await this._toThingTalkValue(object, elemType(lastPropertyType));
                const filter = new Ast.PropertyPathBooleanExpression(
                    null, 
                    sequence, 
                    lastPropertyType instanceof Type.Array ? 'contains' : '==',
                    value, 
                    null
                );
                if (triple.subject.termType === 'NamedNode' && triple.object.termType === 'NamedNode') 
                    this._addVerification(subject, filter);
                else 
                    this._addFilter(subject, filter);
            }
            
        } else {
            const predicates = triple.predicate.items;  
            if (predicates.length > 2)
                throw new Error(`Unsupported triple with a 3+ length path:  ${JSON.stringify(triple)}`);
            const variable = this._newVariable();
            await this._convertBasicTriple({ subject: triple.subject, predicate: predicates[0], object: variable }, filtersBySubject);
            await this._convertBasicTriple({ subject: variable, predicate: predicates[1], object: triple.object }, filtersBySubject);
        }
    }

    private async _convertBasicTriple(triple : any, filtersBySubject : Record<string, Ast.BooleanExpression[]>) {
        const subject = triple.subject.value;
        const predicate = triple.predicate.value;
        const object = triple.object.value;

        if (!subject || !predicate || !object)
            throw new Error(`Unsupported triple: ${JSON.stringify(triple)}`);

        // if subject is an entity, create an id filter first
        if (triple.subject.termType === 'NamedNode' && subject.startsWith(ENTITY_PREFIX)) {
            const domain = await this._wikidata.getDomain(subject.slice(ENTITY_PREFIX.length));
            assert(domain);
            const table = this._schema.getTable(domain);
            assert(table);
            this._addFilter(subject, await this._atomFilter('id', subject, '==', new Type.Entity(`org.wikidata:${table}`)));
            this._setDomain(subject, domain);
        }

        // if subject is an variable and object is an entity, create a regular filter
        if (triple.subject.termType === 'Variable' && triple.object.termType === 'NamedNode') { 
            // for P31 triple, update the domain of the variable, do not add filter
            if (triple.predicate.termType === 'NamedNode' && predicate === `${PROPERTY_PREFIX}P31`) {
                this._setDomain(subject, object.slice(ENTITY_PREFIX.length));
                return;
            }
            if (!(subject in filtersBySubject))
                filtersBySubject[subject] = [];
            filtersBySubject[subject].push(await this._atomFilter(predicate, object));
        } 

        // if object is an variable, create a projection
        if (triple.object.termType === 'Variable') {
            // if predicate is label, add a new projection with suffix "Label" for the property
            if (predicate === LABEL) {
                for (const [subj, table] of Object.entries(this._tables)) {
                    const projection = table.projections.find((proj) => proj.variable === subject);
                    if (projection) {
                        this._addProjection(subj, { variable : object, property : projection.property + 'Label' });
                        break;
                    }
                }
            } else {
                const property = this._schema.getProperty(predicate.slice(PROPERTY_PREFIX.length));
                this._addProjection(subject, { variable: object, property });
            }
        }

        // if both subject and object are entities, create a "verification", for boolean question
        if (triple.subject.termType === 'NamedNode' && triple.object.termType === 'NamedNode') 
            this._addVerification(subject, await this._atomFilter(predicate, object));
    }

    /**
     * Convert RDF triples into thingtalk filters by subjects
     * @param triples RDF Triples derived from SPARQL
     * @returns a map from subjects to their ThingTalk filters converted from the triples
     */
    private async _convertTriples(triples : Triple[]) : Promise<Record<string, Ast.BooleanExpression>> {
        const filtersBySubject : Record<string, Ast.BooleanExpression[]> = {};
        for (const triple of triples) {
            triple.predicate = postprocessPropertyPath(triple.predicate);
            if ('type' in triple.predicate && triple.predicate.type === 'path')
                await this._convertSequencePathTriple(triple, filtersBySubject);
            else 
                await this._convertBasicTriple(triple, filtersBySubject);
            
        }
        const converted : Record<string, Ast.BooleanExpression> = {};
        for (const [subject, filters] of Object.entries(filtersBySubject)) 
            converted[subject] = filters.length === 1 ? filters[0] : new Ast.AndBooleanExpression(null, filters);
        return converted;
    }

    /**
     * Parse a union where clause
     * @param where a where clause
     */
    private async _parseUnion(where : any)  {
        const triple = parseSpecialUnion(where);
        if (triple) {
            await this._parseBasic( { triples: [triple] });
            return;
        }
        let existedSubject;
        const operands = [];
        for (const pattern of where.patterns) {
            assert(pattern.type === 'bgp');
            const filtersBySubject = await this._convertTriples(pattern.triples);
            for (const [subject, filter] of Object.entries(filtersBySubject)) {
                if (!existedSubject)
                    existedSubject = subject;
                else if (subject !== existedSubject)
                    throw new Error(`Multiple subject in filter ${where.patterns}`);
                operands.push(filter);
            }
        }
        this._addFilter(existedSubject as string, new Ast.OrBooleanExpression(null, operands));
    }

    /**
     * Parse a filter clause
     * @param filter a filter clause
     * @param isVerification if it's a verification question or not
     */
    private async _parseFilter(filter : any, isVerification : boolean) {
        const expression = filter.expression;
        assert(filter.type === 'filter' && expression.args.length === 2);
        const [lhs, rhs] = expression.args;
        assert(lhs.termType === 'Variable' && rhs.termType === 'Literal');
        for (const [subject, table] of Object.entries(this._tables)) {
            const projection = table.projections.find((proj) => proj.variable === lhs.value);
            if (!projection)
                continue;

            if (typeof projection.property !== 'string')
                throw new Error(`Join on property path not supported`);
            
            let booleanExpression;
            if (projection.property.endsWith('Label')) {
                assert(expression.operator === 'regex');
                const property = projection.property.slice(0, -'Label'.length);
                const propertyType = this._schema.getPropertyType(property);
                const operator = (propertyType instanceof Type.Array) ? 'contains~' : '=~';
                booleanExpression = await this._atomFilter(property, rhs.value, operator, Type.String);
            } else {
                booleanExpression = await this._atomFilter(projection.property, rhs.value, expression.operator, Type.Number);
            }
            
            if (isVerification)
                this._addVerification(subject, booleanExpression);
            else 
                this._addFilter(subject, booleanExpression);
        }
    }

    /**
     * Parse a basic triple where clause
     * @param where a where clause
     */
    private async _parseBasic(where : any) {
        const filtersBySubject = await this._convertTriples(where.triples);
        for (const [subject, filter] of Object.entries(filtersBySubject)) 
            this._addFilter(subject, filter);  
    }

    /**
     * Parse a where clause
     * @param where a where clause
     * @param isVerification if it's a verification question or not
     */
    private async _parseWhereClause(where : any, isVerification : boolean) {
        if (where.type === 'bgp') 
            await this._parseBasic(where);
        else if (where.type === 'union') 
            await this._parseUnion(where);
        else if (where.type === 'filter')
            await this._parseFilter(where, isVerification);
        else 
            throw new Error(`Unsupported filter ${JSON.stringify(where)}`);
    }

    private async _parseHavingClause(having : any, group : any) {
        assert(group.expression && group.expression.termType === 'Variable');
        const subject = group.expression.value;
        if (!(subject in this._tables)) 
            throw new Error('Unsupported group by operation on object');
        if (having.type === 'operation') {
            assert(having.args.length === 2);
            const [lhs, rhs] = having.args;
            assert(lhs.type === 'aggregate' && !lhs.distinct && lhs.aggregation === 'count' && lhs.expression.termType === 'Variable');
            const variable = lhs.expression.value;
            const projection = this._tables[subject].projections.find((proj) => proj.variable === variable);
            if (!projection)
                throw new Error(`Can't find matching variable for the having clause`);
            if (typeof projection.property !== 'string')
                throw new Error(`Having clause not supported for property path`);
            assert(rhs.termType === 'Literal' && !isNaN(rhs.value));
            this._addFilter(subject, this._aggregateFilter('count', [projection.property], having.operator, parseFloat(rhs.value)));
        } else {
            throw new Error(`Unsupported having clause ${JSON.stringify(having)}`);
        }
    }
    
    /**
     * init tables used to track the conversion
     */
    private _init(utterance : string, keywords : string[]) {
        this._tables = {};
        if (keywords.length === 0)
            this._keywords = getSpans(utterance);
        else 
            this._keywords = keywords.map((keyword) => this._tokenizer.tokenize(keyword).rawTokens.join(' '));
    }

    /**
     * Convert SPARQL into ThingTalk
     * @param sparql a string of SPARQL query 
     * @param utterance a string of the utterance
     * @param keywords a list of keywords in the utterance including the mentioned entities 
     * @returns A ThingTalk Program
     */
    async convert(sparql : string, utterance : string, keywords : string[] = []) : Promise<Ast.Program> {
        this._init(utterance, keywords);
        const parsed = this._parser.parse(sparql) as SelectQuery|AskQuery;
        if (parsed.where) {
            for (const clause of parsed.where) 
                await this._parseWhereClause(clause, parsed.queryType === 'ASK');
        }
        if ('having' in parsed && 'group' in parsed) {
            assert(parsed.group!.length === 1);
            for (const clause of parsed.having ?? []) 
                await this._parseHavingClause(clause, parsed.group![0]);
        }
        const queries : Record<string, Ast.Expression> = {}; // subject : query
        const aggregation : Record<string, string> = {}; // aggregation type : aggregation subject
        const variables : string[] = [];
        if ('variables' in parsed) {
            for (const variable of parsed.variables ?? []) {
                if ('value' in variable && variable.value !== '*') {
                    variables.push(variable.value);
                } else if ('expression' in variable && 'type' in variable.expression && variable.expression.type === 'aggregate') {
                    assert(variable.expression.aggregation === 'count');
                    const expression = variable.expression.expression;
                    assert('termType' in expression && expression.termType === 'Variable' );
                    aggregation.count = expression.value;
                } else {
                    throw new Error(`Unsupported variable type: ${variable}`);
                }
            }
        }

        // first check tables with only domain information, it can potentially be resolved with a type annotation
        // on another table's projection
        // only apply to selection not verification
        if (parsed.queryType === 'SELECT') {
            for (const [subject, table] of Object.entries(this._tables)) {
                if (subject.startsWith(ENTITY_PREFIX))
                    continue;
                let isProjected = false;
                if (table.domain !== 'entity' && 
                    table.filters.length === 0 && 
                    table.projections.length === 0 &&
                    table.verifications.length === 0) {
                    for (const table2 of Object.values(this._tables)) {
                        const proj = table2.projections.find((p) => p.variable === subject);
                        if (proj) {
                            isProjected = true;
                            proj.type = table.domain;
                        }
                    }
                }
                if (isProjected)
                    delete this._tables[subject];
            }
        }

        // parse all tables into thingtalk
        for (const [subject, table] of Object.entries(this._tables)) {
            // handle filters
            let query : Ast.Expression = baseQuery(table.domain);
            if (table.filters.length > 0)
                query = new Ast.FilterExpression(null, query, new Ast.BooleanExpression.And(null, table.filters), null);

            // handle aggregation count
            // if there is a count aggregation, projection/verification/sorting makes no sense
            // finish this table and continue
            if (aggregation.count && aggregation.count === subject) {
                query = new Ast.AggregationExpression(null, query, '*', 'count', null);
                queries[subject] = query;  
                continue;
            }

            // handle projections and verifications
            const projections : Projection[] = [];
            if (variables.includes(subject))
                projections.push({ property : 'id' });
            for (const projection of table.projections) {
                if (variables.includes(projection.variable!) || Object.keys(this._tables).includes(projection.variable!))
                    projections.push(projection);
            }
            if (parsed.queryType === 'ASK' && table.verifications.length > 0) {
                assert(projections.length === 0);
                const verification = table.verifications.length > 1 ? new Ast.AndBooleanExpression(null, table.verifications) : table.verifications[0];
                query = new Ast.BooleanQuestionExpression(null, query, verification, null);
            } else if (parsed.queryType === 'SELECT') {
                // if it's not a verification question, and there is no projection/verification 
                // for a table, skip the table - it's a helper table to generate filter
                if (projections.length === 0)
                    continue;
                if (!(projections.length === 1 && projections[0].property === 'id')) {
                    const projectionElements = projections.map((proj) => {
                        return new Ast.ProjectionElement(
                            proj.property,
                            null,
                            proj.type ? [new Type.Entity(`org.wikidata:${proj.type}`)] : []
                        );
                    });
                    query = new Ast.ProjectionExpression2(null, query, projectionElements, null);
                }
            }

            // handle sorting
            if ('order' in parsed) {
                assert(parsed.order!.length === 1);
                const expression = parsed.order![0].expression;
                assert('termType' in expression && expression.termType === 'Variable');
                const projection = table.projections.find((proj) => proj.variable === expression.value);
                if (projection) {
                    if (typeof projection.property !== 'string')
                        throw new Error(`Sort on property path not supported`);
                    const property = new Ast.Value.VarRef(projection.property);
                    const direction = parsed.order![0].descending ? 'desc' : 'asc';
                    query = new Ast.SortExpression(null, query, property, direction, null);
                    if (parsed.limit)
                        query = new Ast.IndexExpression(null, query, [new Ast.Value.Number(parsed.limit)], null);
                }
            }

            queries[subject] = query;  
        } 
        
        if (Object.values(queries).length === 1) {
            const query = Object.values(queries)[0];
            if (parsed.queryType === 'ASK' && !(query instanceof Ast.BooleanQuestionExpression))
                throw new Error(`Unsupported command: verification question on if the result is empty or not: ${sparql}`);
            return makeProgram(Object.values(queries)[0]); 
        }
        if (Object.values(queries).length === 2 && parsed.queryType === 'SELECT') {
            let [[mainSubject, main], [subquerySubject, subquery]] = Object.entries(queries);
            // the query without any projection in SPARQL variables should be the subquery
            // swap if necessary
            if (!this._tables[mainSubject].projections.some((proj) => variables.includes(proj.variable!)))
                [mainSubject, main, subquerySubject, subquery] = [subquerySubject, subquery, mainSubject, main];
            // verify 
            if (!this._tables[mainSubject].projections.some((proj) => variables.includes(proj.variable!)))
                throw new Error(`Failed to identify main query in ${sparql}`);
            if (this._tables[subquerySubject].projections.some((proj) => variables.includes(proj.variable!)))
                throw new Error(`Failed to identify subquery in ${sparql}.`);
                
            let subqueryFilter : Ast.ComparisonSubqueryBooleanExpression;
            if (this._tables[mainSubject].projections.some((proj) => proj.variable === subquerySubject)) {
                const projection = this._tables[mainSubject].projections.find((proj) => proj.variable === subquerySubject);
                const property = projection!.property;
                if (typeof property !== 'string')
                    throw new Error(`Subquery on property path not supported`);
                subqueryFilter = new Ast.ComparisonSubqueryBooleanExpression(
                    null,
                    new Ast.Value.VarRef(property),
                    this._schema.getPropertyType(property) instanceof Type.Array ? 'contains' : '==',
                    new Ast.ProjectionExpression(null, subquery, ['id'], [], [], null),
                    null
                );
            } else if (this._tables[subquerySubject].projections.some((proj) => proj.variable === mainSubject)) {
                const projection = this._tables[subquerySubject].projections.find((proj) => proj.variable === mainSubject);
                const property = projection!.property;
                if (typeof property !== 'string')
                    throw new Error(`Subquery on property path not supported`);
                subqueryFilter = new Ast.ComparisonSubqueryBooleanExpression(
                    null,
                    new Ast.Value.VarRef('id'),
                    this._schema.getPropertyType(property) instanceof Type.Array ? 'in_array' : '==',
                    subquery,
                    null
                );
            } else {
                throw new Error(`Failed to identify main & subquery in ${sparql}`);
            }
            
            return makeSubqueryProgram(main, subqueryFilter);
        }
        if (Object.values(queries).length >= 2 && parsed.queryType === 'ASK') {
            const mainSubject = Object.keys(queries).find((subject) => subject.startsWith(ENTITY_PREFIX));
            if (!mainSubject)
                throw new Error('No main function found');
            const main = queries[mainSubject];
            const subqueries = [];
            for (const [subject, query] of Object.entries(queries)) {
                if (subject === mainSubject)
                    continue;
                const proj = this._tables[mainSubject].projections.find((proj) => proj.variable === subject);
                if (!proj)
                    throw new Error(`No supported verification question: ${sparql}`);
                if (typeof proj.property !== 'string')
                    throw new Error(`Subquery on property path not supported`);
                subqueries.push(new Ast.ComparisonSubqueryBooleanExpression(
                    null,
                    new Ast.Value.VarRef(proj.property),
                    this._schema.getPropertyType(proj.property) instanceof Type.Array ? 'contains' : '==',
                    query, 
                    null
                ));
            }
            return makeSubqueryVerificationProgram(main, subqueries);
        }

        throw new Error(`Not supported by ThingTalk: ${sparql}`);
    }
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "A tool to convert QALD-7 SPARQL to ThingTalk"
    });
    parser.add_argument('-l', '--locale', {
        required: false,
        default: 'en-US',
        help: `BGP 47 locale tag of the language to evaluate (defaults to 'en-US', English)`
    });
    parser.add_argument('--timezone', {
        required: false,
        default: undefined,
        help: `Timezone to use to interpret dates and times (defaults to the current timezone).`
    });
    parser.add_argument('--manifest', {
        required: true,
        help: 'Path to ThingTalk file containing class definitions.'
    });
    parser.add_argument('--cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('-i', '--input', {
        required: true,
        type: fs.createReadStream
    });
    parser.add_argument('-o', '--output', {
        required: true,
        type: fs.createWriteStream
    });
    parser.add_argument('-d', '--drop', {
        required: false,
        type: fs.createWriteStream
    });
    parser.add_argument('--offset', {
        required: false,
        type: parseInt,
        default: 1,
        help: `Start from the nth example`
    });
    parser.add_argument('--include-entity-value', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--property-path', {
        action: 'store_true',
        default: false,
        help: `Enable property path filter/projection in ThingTalk`
    });
    const args = parser.parse_args();

    const manifest = await pfs.readFile(args.manifest, { encoding: 'utf8' });
    const library = ThingTalk.Syntax.parse(manifest, ThingTalk.Syntax.SyntaxType.Normal, { locale: args.locale, timezone: args.timezone });
    assert(library instanceof ThingTalk.Ast.Library && library.classes.length === 1);
    const classDef = library.classes[0];
    const converter = new SPARQLToThingTalkConverter(classDef, { cache: args.cache, enablePropertyPath: args.property_path });
    const tokenizer = new I18n.LanguagePack('en').getTokenizer();

    const input = args.input.pipe(JSONStream.parse('questions.*')).pipe(new stream.PassThrough({ objectMode: true }));
    const output = new DatasetStringifier();
    output.pipe(args.output);
    
    let counter = 0;
    for await (const item of input) {
        counter ++;
        if (counter < args.offset)
            continue;
        const preprocessed = tokenizer.tokenize(item.question[0].string).rawTokens.join(' ');
        try {
            const keywords = item.question[0].keywords;
            const program = await converter.convert(item.query.sparql, preprocessed, keywords ? keywords.split(', ') : []);
            const target_code = ThingTalkUtils.serializePrediction(
                program, 
                preprocessed,
                EntityUtils.makeDummyEntities(preprocessed),
                { locale: 'en', timezone: undefined, includeEntityValue: args.include_entity_value }
            ).join(' ');
            output.write({ id: item.id, preprocessed, target_code });
        } catch(e) {
            console.log(`Example ${item.id} failed`);
            if (args.drop)
                args.drop.write(`${item.id}\t${preprocessed}\t${item.query.sparql}\t${(e as Error).message.replace(/\s+/g, ' ')}\n`);
            else 
                console.log((e as Error).message);
        }
    }
    await waitFinish(input);
    await waitFinish(output);
    if (args.drop)
        await waitFinish(args.drop);
}

if (require.main === module)
    main();